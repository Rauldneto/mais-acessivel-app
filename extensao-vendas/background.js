// Service worker: faz a ponte entre o app (aba Cotações) e o Bling para a
// conferência em lote. O app fala com app-bridge.js, que abre uma porta
// "auditoria" aqui; daqui as consultas são feitas DENTRO de uma aba do Bling
// (usando a sessão já logada do usuário).

var BLING_URL = 'https://www.bling.com.br/orcamentos.php';
var APP_URL = 'https://rauldneto.github.io/mais-acessivel-app/';

function enviar(tabId, msg) {
  return new Promise(function(res, rej) {
    chrome.tabs.sendMessage(tabId, msg, function(r) {
      if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
      else res(r);
    });
  });
}
function esperar(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function pronta(tabId) {
  for (var i = 0; i < 3; i++) {
    try { var r = await enviar(tabId, { action: 'ping' }); if (r && r.ok) return true; } catch (e) {}
    try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] }); } catch (e) {}
    await esperar(800);
  }
  return false;
}

async function aguardarCarregar(tabId) {
  for (var i = 0; i < 40; i++) {
    var t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return t;
    await esperar(500);
  }
  return chrome.tabs.get(tabId);
}

async function obterAbaBling() {
  var abas = await chrome.tabs.query({ url: 'https://www.bling.com.br/*' });
  var aba = abas.find(function(t) { return !/login/i.test(t.url || ''); });
  var criada = false;
  if (!aba) {
    aba = await chrome.tabs.create({ url: BLING_URL, active: false });
    criada = true;
  }
  aba = await aguardarCarregar(aba.id);
  if (/login/i.test(aba.url || '')) throw new Error('SESSAO');
  if (!(await pronta(aba.id))) throw new Error('Não consegui conectar à aba do Bling. Recarregue o Bling (F5) e tente de novo.');
  return { id: aba.id, criada: criada };
}

chrome.runtime.onConnect.addListener(function(port) {
  if (port.name !== 'auditoria') return;
  var ativo = true;
  port.onDisconnect.addListener(function() { ativo = false; });
  function post(m) { if (ativo) try { port.postMessage(m); } catch (e) {} }

  port.onMessage.addListener(async function(msg) {
    if (msg.type === 'relacionados') {
      var ab = null;
      try {
        post({ type: 'status', texto: 'Conectando ao Bling...' });
        ab = await obterAbaBling();
        post({ type: 'status', texto: 'Lendo as vendas dos últimos 12 meses (pode levar alguns minutos)...' });
        var r = await enviar(ab.id, { action: 'calcRelacionados' });
        if (!r || r.erro) throw new Error((r && r.erro) || 'Falha ao calcular');
        post({ type: 'fim', resumo: r });
      } catch (e) {
        var m2 = String(e.message || e);
        post({ type: 'erro', msg: m2 === 'SESSAO' ? 'Você não está logado no Bling. Abra o Bling, faça login e tente de novo.' : m2 });
      } finally { if (ab && ab.criada) { try { chrome.tabs.remove(ab.id); } catch (e) {} } }
      return;
    }
    if (msg.type === 'perdas') { levantarPerdas(msg.filtro || {}, post, function() { return ativo; }); return; }
    if (msg.type === 'situacao') {
      var ab2 = null;
      try {
        ab2 = await obterAbaBling();
        var rr = await enviar(ab2.id, { action: 'mudarSituacao', id: msg.filtro.id, situacao: msg.filtro.situacao });
        if (!rr || rr.erro) throw new Error((rr && rr.erro) || 'Sem resposta do Bling');
        post({ type: 'fim', ok: true });
      } catch (e) { var m3 = String(e.message || e); post({ type: 'erro', msg: m3 === 'SESSAO' ? 'Você não está logado no Bling neste navegador.' : m3 }); }
      finally { if (ab2 && ab2.criada) { try { chrome.tabs.remove(ab2.id); } catch (e) {} } }
      return;
    }
    if (msg.type !== 'auditar') return;
    var aba = null;
    try {
      post({ type: 'status', texto: 'Conectando ao Bling...' });
      aba = await obterAbaBling();
      post({ type: 'status', texto: 'Buscando a lista de propostas...' });
      var lista = await enviar(aba.id, { action: 'listarPropostas', filtro: msg.filtro || {} });
      if (!lista || lista.erro) throw new Error((lista && lista.erro) || 'Falha ao listar propostas');
      post({ type: 'lista', total: lista.itens.length });
      // Cache: cotações fechadas (Concluído/Não aprovado/Aprovado) não mudam — reaproveita a conferência salva.
      var FECHADAS = ['Concluído', 'Não aprovado', 'Aprovado'];
      var meses = {};
      lista.itens.forEach(function(p) { if (p.data) meses[p.data.slice(0, 7)] = 1; });
      var cache = {};
      try { cache = (await enviar(aba.id, { action: 'cacheGet', meses: Object.keys(meses) })) || {}; } catch (e) {}
      var fila = [], feitos = 0, novosCache = {};
      lista.itens.forEach(function(p) {
        var c = cache[p.id];
        if (c && FECHADAS.indexOf(p.situacao) !== -1 && c.situacao === p.situacao) {
          feitos++;
          post({ type: 'item', feitos: feitos, item: Object.assign({}, p, c, { cache: true }) });
        } else fila.push(p);
      });
      async function trabalhador() {
        while (fila.length && ativo) {
          var p = fila.shift(), r;
          try { r = await enviar(aba.id, { action: 'auditarProposta', id: p.id }); }
          catch (e) { r = { id: p.id, falha: String(e.message || e) }; }
          feitos++;
          var item = Object.assign({}, p, r || {});
          if (r && !r.falha && FECHADAS.indexOf(item.situacao) !== -1 && p.data) {
            novosCache[p.data.slice(0, 7) + '/' + p.id] = { situacao: item.situacao, numero: item.numero, cliente: item.cliente, vendedor: item.vendedor,
              total: item.total, fone: item.fone || '', itens: item.itens || [], erros: item.erros || [], avisos: item.avisos || [] };
          }
          post({ type: 'item', feitos: feitos, item: item });
        }
      }
      await Promise.all([trabalhador(), trabalhador(), trabalhador(), trabalhador()]);
      if (Object.keys(novosCache).length) { try { await enviar(aba.id, { action: 'cacheSet', dados: novosCache }); } catch (e) {} }
      post({ type: 'fim' });
    } catch (e) {
      var m = String(e.message || e);
      post({ type: 'erro', msg: m === 'SESSAO' ? 'Você não está logado no Bling. Abra o Bling, faça login e tente de novo.' : m });
    } finally {
      if (aba && aba.criada) { try { chrome.tabs.remove(aba.id); } catch (e) {} }
    }
  });
});


// ====================== WHATSAPP (etiquetas e tempo de resposta) ======================
// Só roda nos computadores onde "Este computador sincroniza o WhatsApp" estiver ligado no popup.
// Lê APENAS a lista de conversas (etiquetas, hora da última mensagem do cliente e nossa). Não lê texto, não envia nada.
var FB = 'https://maisacessivel-1d0ad-default-rtdb.firebaseio.com';

function coletarWA() {
  try {
    var C = window.require('WAWebCollections');
    var labels = {};
    C.Label.getModelsArray().forEach(function(l) { labels[l.id] = l.name; });
    var SIS = { notification_template: 1, e2e_notification: 1, gp2: 1, revoked: 1, ciphertext: 1, protocol: 1, notification: 1, call_log: 1 };
    var out = [];
    C.Chat.getModelsArray().forEach(function(c) {
      if (c.isGroup || !c.id || c.id.server === 'broadcast' || c.id.server === 'newsletter' || c.id.server === 'g.us') return;
      var ct = c.contact || C.Contact.get(c.id);
      var pn = ct && ct.phoneNumber;
      pn = pn ? (pn.user || String(pn._serialized || pn).split('@')[0]) : (c.id.server === 'c.us' ? c.id.user : '');
      if (!pn) return;
      var uc = 0, un = 0;
      (c.msgs ? c.msgs.getModelsArray() : []).forEach(function(mm) {
        if (SIS[mm.type]) return;
        if (mm.id && mm.id.fromMe) { if (mm.t > un) un = mm.t; } else { if (mm.t > uc) uc = mm.t; }
      });
      out.push({ p: String(pn).replace(/\D/g, ''), n: (ct && (ct.name || ct.verifiedName || ct.pushname)) || c.formattedTitle || '',
        e: (c.labels || []).map(function(id) { return labels[id] || String(id); }), uc: uc, un: un, t: c.t || 0, nl: c.unreadCount || 0 });
    });
    return { ok: true, chats: out, labels: Object.keys(labels).map(function(k) { return labels[k]; }) };
  } catch (e) { return { ok: false, erro: String(e && e.message || e) }; }
}

async function sincronizarWA(manual) {
  var cfg = await chrome.storage.local.get(['waSync', 'waNome']);
  // v2.0.6: sempre ligado — todo computador com o WhatsApp Web aberto sincroniza sozinho (não precisa marcar nada)
  var abas = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!abas.length) return { ok: false, erro: 'WhatsApp Web não está aberto neste computador' };
  if (!cfg.waSync) chrome.storage.local.set({ waSync: true });
  var res = await chrome.scripting.executeScript({ target: { tabId: abas[0].id }, world: 'MAIN', func: coletarWA });
  var r = res && res[0] && res[0].result;
  if (!r || !r.ok) return { ok: false, erro: (r && r.erro) || 'Não consegui ler o WhatsApp Web (ele terminou de carregar?)' };
  var dados = {};
  r.chats.forEach(function(c) { if (c.p) dados[c.p] = { n: c.n, e: c.e, uc: c.uc, un: c.un, t: c.t, nl: c.nl }; });
  var x = await fetch(FB + '/waChats.json', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) });
  if (!x.ok) return { ok: false, erro: 'Firebase ' + x.status };
  var meta = { ts: Date.now(), conversas: r.chats.length, etiquetas: r.labels, maquina: cfg.waNome || '' };
  await fetch(FB + '/waMeta.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
  await chrome.storage.local.set({ waUltima: meta.ts, waUltimaQtd: meta.conversas });
  recalcularCobrancas().catch(function() {});
  return { ok: true, conversas: meta.conversas };
}

// Cria o alarme só se ele ainda não existir. Recriar toda vez que a extensão "acorda" (a cada minuto) zerava o relógio
// e a sincronização de 10 em 10 min nunca chegava a disparar.
function alarme(nome, min) { chrome.alarms.get(nome, function(a) { if (!a || a.periodInMinutes !== min) chrome.alarms.create(nome, { periodInMinutes: min }); }); }
alarme('waSync', 10);
// v2.0.8: sincroniza sozinho também quando o WhatsApp Web termina de abrir (ex.: ligou o computador), sem botão nenhum
var waAbriuEm = 0;
chrome.tabs.onUpdated.addListener(function(id, info, tab) {
  if (info.status !== 'complete' || !/^https:\/\/web\.whatsapp\.com/.test(tab.url || '') || Date.now() - waAbriuEm < 5 * 60000) return;
  waAbriuEm = Date.now();
  setTimeout(function() { sincronizarWA(false).catch(function() {}); }, 45000); // espera o WhatsApp carregar as conversas
});
chrome.alarms.onAlarm.addListener(function(a) { if (a.name === 'waSync') sincronizarWA(false).catch(function() {}); });
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg && msg.action === 'waSyncAgora') {
    sincronizarWA(true).then(sendResponse).catch(function(e) { sendResponse({ ok: false, erro: String(e.message || e) }); });
    return true;
  }
  return false;
});

// ====================== RESUMO DA CONVERSA (sob pedido do app) ======================
// O app pede em waResumoPedidos/{telefone}. Só os computadores com "sincroniza o WhatsApp" ligado atendem.
// As mensagens são lidas na hora, enviadas para a IA da empresa e SÓ o resumo é salvo (o texto das mensagens não fica guardado).
var IA_URL = 'https://soft-limit-b3a1.rauldias.workers.dev';

async function lerConversaWA(chave, dataCot) {
  try {
    var C = window.require('WAWebCollections');
    function k(t) { var d = String(t || '').replace(/\D/g, ''); if (d.length >= 12 && d.indexOf('55') === 0) d = d.slice(2); if (d.length < 8) return ''; return (d.length >= 10 ? d.slice(0, 2) : '62') + d.slice(-8); }
    var alvo = null;
    C.Chat.getModelsArray().some(function(c) {
      if (c.isGroup || !c.id) return false;
      var ct = c.contact || C.Contact.get(c.id);
      var pn = ct && ct.phoneNumber;
      pn = pn ? (pn.user || String(pn._serialized || pn).split('@')[0]) : (c.id.server === 'c.us' ? c.id.user : '');
      if (k(pn) === chave) { alvo = c; return true; }
      return false;
    });
    if (!alvo) return { ok: false, erro: 'Conversa não encontrada no WhatsApp' };
    var TIPOS = ['chat', 'document', 'image', 'ptt', 'audio', 'video', 'location', 'vcard'];
    // tenta carregar mensagens mais antigas até cobrir alguns dias antes da data da cotação (para achar o início da demanda)
    var limite = dataCot ? (new Date(dataCot + 'T00:00:00').getTime() / 1000) - 10 * 86400 : 0;
    try {
      var LM = window.require('WAWebChatLoadMessages');
      for (var v = 0; v < 6 && LM && LM.loadEarlierMsgs; v++) {
        var arr = alvo.msgs.getModelsArray();
        if (!arr.length || (limite && arr[0].t <= limite)) break;
        var antes = arr.length;
        await LM.loadEarlierMsgs(alvo);
        if (alvo.msgs.getModelsArray().length <= antes) break;
      }
    } catch (e) {}
    var ms = (alvo.msgs ? alvo.msgs.getModelsArray() : []).filter(function(m) { return TIPOS.indexOf(m.type) !== -1; });
    if (limite) { var desde = ms.filter(function(m) { return m.t >= limite; }); if (desde.length >= 5) ms = desde; }
    ms = ms.slice(-150);
    var linhas = ms.map(function(m) {
      var d = new Date(m.t * 1000);
      var quem = m.id && m.id.fromMe ? 'Mais Acessível' : 'Cliente';
      var txt = m.type === 'chat' ? (m.body || '') : m.type === 'document' ? '[documento: ' + (m.filename || m.caption || '') + ']' :
        (m.type === 'ptt' || m.type === 'audio') ? '[áudio]' : '[' + m.type + (m.caption ? ': ' + m.caption : '') + ']';
      return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' ' + quem + ': ' + String(txt).slice(0, 500);
    });
    return { ok: true, linhas: linhas };
  } catch (e) { return { ok: false, erro: String(e && e.message || e) }; }
}

var resumoRodando = false;
async function processarResumos() {
  if (resumoRodando) return;
  resumoRodando = true;
  try {
    var pend = await fetch(FB + '/waResumoPedidos.json').then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; });
    if (!pend) return;
    var abas = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (!abas.length) return;
    var chaves = Object.keys(pend);
    for (var i = 0; i < chaves.length; i++) {
      var chave = chaves[i], p = pend[chave] || {};
      await fetch(FB + '/waResumoPedidos/' + chave + '.json', { method: 'DELETE' }); // tira da fila (evita dois computadores fazendo o mesmo)
      var out;
      try {
        var res = await chrome.scripting.executeScript({ target: { tabId: abas[0].id }, world: 'MAIN', func: lerConversaWA, args: [chave, p.data || ''] });
        var r = res && res[0] && res[0].result;
        if (!r || !r.ok) out = { ts: Date.now(), erro: (r && r.erro) || 'Não consegui ler a conversa' };
        else if (!r.linhas.length) out = { ts: Date.now(), erro: 'Nenhuma mensagem carregada dessa conversa no WhatsApp Web' };
        else {
          var sug = Array.isArray(p.sug) ? p.sug.slice(0, 4) : [];
          var prompt = 'Você é gerente comercial da Mais Acessível (revenda de produtos de acessibilidade e materiais de construção em Goiânia). ' +
            'Abaixo estão mensagens de WhatsApp entre a empresa e um cliente' + (p.numero ? '. Elas se referem à cotação nº ' + p.numero : '') +
            (p.data ? ', criada no Bling em ' + p.data.split('-').reverse().join('/') : '') + (p.cliente ? ' (cliente: ' + p.cliente + ')' : '') + (p.total ? ', valor R$ ' + p.total : '') + '.\n' +
            'A conversa pode ter várias negociações antigas. Considere SÓ A DEMANDA MAIS RECENTE (a que levou a esta cotação).\n' +
            'Responda EXATAMENTE neste formato:\n' +
            'INICIO: dd/mm/aaaa  (data da mensagem em que o cliente pediu o orçamento desta demanda; se não der para saber, escreva INICIO: ?)\n' +
            '• Situação: em que pé está a negociação (1 frase)\n• Pedido/objeções: o que o cliente pediu ou questionou (preço, prazo, frete, produto)\n' +
            '• Pendência: quem está devendo resposta e desde quando\n• Próximo passo: o que o vendedor deve fazer\n' +
            (sug.length ? '• Produtos que costumam acompanhar (' + sug.join('; ') + '): para cada um, diga o que a conversa mostra — se o cliente RECUSOU, disse que JÁ TEM, que NÃO PRECISA, PEDIU PARA RETIRAR da cotação, ACEITOU, ou se NÃO FOI FALADO (com a data, se houver)\n' +
              'Na ÚLTIMA linha escreva exatamente: MOTIVOS: produto=motivo; produto=motivo  (um para cada produto sugerido; motivo é um destes: recusou, ja tem, nao precisa, retirou, aceitou, nao falado)\n' : '') +
            'Antes da linha MOTIVOS (ou no fim, se não houver), escreva exatamente: PROBABILIDADE: alta|media|baixa NN% — motivo curto (chance de o cliente fechar esta cotação, pelo tom e andamento da conversa)\n' +
            'Não invente nada que não esteja nas mensagens.\n\nMENSAGENS:\n' + r.linhas.join('\n');
          var j = await fetch(IA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }) }).then(function(x) { return x.json(); });
          var txt = (j && j.content && j.content.map(function(c) { return c.text || ''; }).join('').trim()) || '';
          var mi = txt.match(/INICIO:\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4}|\?)/i);
          // MOTIVOS: produto=motivo; ...  → o app usa para justificar por que o produto sugerido não está na cotação
          var mm = txt.match(/MOTIVOS:\s*(.*)$/im), motivos = [];
          if (mm) mm[1].split(';').forEach(function(x) { var q = x.split('='); if (q.length >= 2 && q[0].trim()) motivos.push({ p: q[0].trim(), m: q.slice(1).join('=').trim().toLowerCase() }); });
          var JUST = /recus|ja tem|já tem|nao precisa|não precisa|retir/;
          var recusados = motivos.filter(function(x) { return JUST.test(x.m); }).map(function(x) { return x.p; });
          // PROBABILIDADE: alta|media|baixa NN% — motivo
          var mp = txt.match(/PROBABILIDADE:\s*(alta|m[eé]dia|baixa)\s*(\d{1,3})?\s*%?\s*[—–-]?\s*(.*)$/im);
          var prob = mp ? { n: mp[1].toLowerCase().replace('é', 'e'), pct: mp[2] ? Math.min(100, parseInt(mp[2], 10)) : 0, m: (mp[3] || '').trim().slice(0, 160) } : null;
          var corpo = txt.replace(/^.*INICIO:.*\n?/im, '').replace(/^.*MOTIVOS:.*$/im, '').replace(/^.*PROBABILIDADE:.*$/im, '').trim();
          out = txt ? { ts: Date.now(), v: 4, prob: prob, resumo: corpo || txt, inicio: mi && mi[1] !== '?' ? mi[1] : '', recusados: recusados, motivos: motivos, sug: sug, n: r.linhas.length, desde: r.linhas[0].slice(0, 10), ate: r.linhas[r.linhas.length - 1].slice(0, 16) }
                    : { ts: Date.now(), erro: 'A IA não respondeu' };
        }
      } catch (e) { out = { ts: Date.now(), erro: String(e && e.message || e) }; }
      await fetch(FB + '/waResumos/' + chave + '.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
    }
  } finally { resumoRodando = false; }
}
alarme('waResumo', 1);
// processa a fila também logo depois de cada sincronização
chrome.alarms.onAlarm.addListener(function(a) { if (a.name === 'waResumo') processarResumos().catch(function() {}); });


// ====================== ALERTAS DE ATENDIMENTO ======================
// v2.1.0 — 100% pelo WhatsApp (nada do app):
// 1) 🚨 VERMELHO (todos os computadores):
//    a) IMEDIATO: o cliente escreveu HOJE e nenhum colaborador respondeu hoje (conversa nova só do cliente ou conversa do dia sem resposta);
//    b) conversa com movimento nas últimas 24h e SEM ETIQUETA há mais de 2 min (a mais importante).
// 2) ⏳ AMARELO: em qualquer conversa, a última mensagem é do cliente e passou de 8 min sem resposta.
//    Vai para o vendedor da etiqueta; se a conversa não tem etiqueta de vendedor, vai para todos.
// Os computadores que sincronizam o WhatsApp leem a cada 1 min e publicam em waSemEtiqueta / waAguardando.
// O vendedor é reconhecido pelo login dele no app (usuário "ricardocarrijo" ↔ etiqueta "Ricardo").
function coletarAlertasWA() {
  try {
    var C = window.require('WAWebCollections');
    var agora = Date.now() / 1000, sem = [], agu = [];
    var labels = {}; C.Label.getModelsArray().forEach(function(l) { labels[l.id] = l.name; });
    var SIS = { notification_template: 1, e2e_notification: 1, gp2: 1, revoked: 1, ciphertext: 1, protocol: 1, notification: 1, call_log: 1 };
    C.Chat.getModelsArray().forEach(function(c) {
      if (c.isGroup || !c.id || c.id.server === 'broadcast' || c.id.server === 'newsletter' || c.id.server === 'g.us') return;
      if (!c.t || agora - c.t > 86400) return;
      var ct = c.contact || C.Contact.get(c.id);
      var pn = ct && ct.phoneNumber;
      pn = pn ? (pn.user || String(pn._serialized || pn).split('@')[0]) : (c.id.server === 'c.us' ? c.id.user : '');
      if (!pn) return;
      var p = String(pn).replace(/\D/g, ''), n = (ct && (ct.name || ct.verifiedName || ct.pushname)) || c.formattedTitle || '';
      var et = (c.labels || []).map(function(id) { return labels[id] || String(id); });
      var uc = 0, un = 0, ini = 0, meia0 = new Date(); meia0.setHours(0, 0, 0, 0); meia0 = meia0.getTime() / 1000;
      (c.msgs ? c.msgs.getModelsArray() : []).forEach(function(m) {
        if (SIS[m.type]) return;
        if (m.id && m.id.fromMe) { if (m.t > un) un = m.t; } else { if (m.t > uc) uc = m.t; if (m.t >= meia0 && (!ini || m.t < ini)) ini = m.t; }
      });
      var semResp = uc >= meia0 && un < meia0, semEtq = !et.length;
      if (semResp || semEtq) sem.push({ p: p, n: n, t: c.t, e: et, ini: ini || uc, sr: semResp, se: semEtq });
      if (semResp) return; // ninguém respondeu hoje
      if (uc && uc > un && agora - uc >= 8 * 60 && agora - uc <= 86400) agu.push({ p: p, n: n, e: et, uc: uc });
    });
    // histórico de hoje: cada vez que o cliente escreveu e quanto tempo levou até nossa resposta + com quem falamos em cada hora
    var meia = new Date(); meia.setHours(0, 0, 0, 0); meia = meia.getTime() / 1000;
    var hist = {};
    C.Chat.getModelsArray().forEach(function(c) {
      if (c.isGroup || !c.id || c.id.server === 'broadcast' || c.id.server === 'newsletter' || c.id.server === 'g.us') return;
      if (!c.t || c.t < meia) return;
      var ct = c.contact || C.Contact.get(c.id);
      var pn = ct && ct.phoneNumber;
      pn = pn ? (pn.user || String(pn._serialized || pn).split('@')[0]) : (c.id.server === 'c.us' ? c.id.user : '');
      if (!pn) return;
      var p = String(pn).replace(/\D/g, ''), n = (ct && (ct.name || ct.verifiedName || ct.pushname)) || c.formattedTitle || '';
      var et = (c.labels || []).map(function(id) { return labels[id] || String(id); });
      var ms = (c.msgs ? c.msgs.getModelsArray() : []).filter(function(m) { return !SIS[m.type] && m.t >= meia; }).sort(function(x, y) { return x.t - y.t; });
      var ini = 0;
      ms.forEach(function(m) {
        var nosso = m.id && m.id.fromMe;
        if (!nosso) { if (!ini) ini = m.t; return; }
        if (ini) { hist['esperas/' + p + '_' + Math.floor(ini)] = { p: p, n: n, e: et, ini: ini, resp: m.t, min: Math.round((m.t - ini) / 6) / 10 }; ini = 0; }
        var hh = String(new Date(m.t * 1000).getHours()).padStart(2, '0');
        var k = 'atend/' + p + '/' + hh;
        if (!hist[k]) hist[k] = { n: n, e: et, q: 0 };
        hist[k].q++;
      });
      if (ini) hist['esperas/' + p + '_' + Math.floor(ini)] = { p: p, n: n, e: et, ini: ini, resp: 0, min: Math.round((agora - ini) / 6) / 10 };
    });
    var dt = new Date(); var dia = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    return { ok: true, sem: sem, agu: agu, hist: hist, dia: dia };
  } catch (e) { return { ok: false, erro: String(e && e.message || e) }; }
}

async function publicarAlertasWA() {
  var cfg = await chrome.storage.local.get(['waSync', 'waNome', 'waSemVisto']);
  var abas = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!abas.length) return;
  var res = await chrome.scripting.executeScript({ target: { tabId: abas[0].id }, world: 'MAIN', func: coletarAlertasWA });
  var r = res && res[0] && res[0].result;
  if (!r || !r.ok) return;
  var visto = cfg.waSemVisto || {}, novo = {}, sem = {}, agu = {}, agora = Date.now();
  r.sem.forEach(function(c) { var vis = visto[c.p] || agora; novo[c.p] = vis; var desde = c.sr ? (c.ini || c.t) * 1000 : vis; sem[c.p] = { n: c.n, desde: desde, t: c.t, e: c.e || [], sr: !!c.sr, se: !!c.se }; });
  r.agu.forEach(function(c) { agu[c.p] = { n: c.n, e: c.e, uc: c.uc }; });
  await chrome.storage.local.set({ waSemVisto: novo });
  var h = { 'Content-Type': 'application/json' };
  await fetch(FB + '/waSemEtiqueta.json', { method: 'PUT', headers: h, body: JSON.stringify({ ts: agora, maquina: cfg.waNome || '', chats: sem }) });
  await fetch(FB + '/waAguardando.json', { method: 'PUT', headers: h, body: JSON.stringify({ ts: agora, maquina: cfg.waNome || '', chats: agu }) });
  // histórico do atendimento (fica guardado por dia em waHist/AAAA-MM-DD) — PATCH com caminhos só soma/atualiza, nunca apaga
  if (r.hist && r.dia && Object.keys(r.hist).length) {
    await fetch(FB + '/waHist/' + r.dia + '.json', { method: 'PATCH', headers: h, body: JSON.stringify(r.hist) });
  }
}

function normTxt(t) { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim(); }
// a etiqueta é deste vendedor? (primeiro nome da etiqueta = começo do login do app, ex.: "Ricardo" ↔ "ricardocarrijo")
function etiquetaDoUsuario(etiquetas, usuario) {
  var u = normTxt(usuario).replace(/ /g, '');
  if (!u) return '';
  var achou = '';
  (etiquetas || []).some(function(e) { var w = normTxt(e).split(' ')[0]; if (w.length >= 3 && u.indexOf(w) === 0) { achou = e; return true; } return false; });
  return achou;
}

async function verificarAlertasWA() {
  var fb = function(n) { return fetch(FB + '/' + n + '.json').then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }); };
  var dados = await Promise.all([fb('waSemEtiqueta'), fb('waAguardando')]);
  var d = dados[0], dg = dados[1], lm = {}, ca = {}; // v2.1.0: avisos só pelo WhatsApp (sem lembretes/cobranças do app)
  var st = await chrome.storage.local.get(['waNotif', 'appUsuario', 'appRole', 'usuLogins', 'usuLoginsTs']);
  if (!st.usuLogins || Date.now() - (st.usuLoginsTs || 0) > 3600000) {
    var us = await fb('usuarios'); if (us) { st.usuLogins = Object.keys(us).map(function(k) { return (us[k] && us[k].usuario) || ''; }).filter(Boolean); await chrome.storage.local.set({ usuLogins: st.usuLogins, usuLoginsTs: Date.now() }); }
  }
  var temDono = function(et) { return (st.usuLogins || []).some(function(u) { return !!etiquetaDoUsuario(et, u); }); };
  var agora = Date.now(), lista = [], minhas = [];
  if (d && d.ts && agora - d.ts < 5 * 60000) {
    Object.keys(d.chats || {}).forEach(function(p) {
      var c = d.chats[p];
      if (c.sr || (c.se && agora - (c.desde || agora) >= 2 * 60000)) lista.push({ p: p, n: c.n || '', desde: c.desde || agora, sr: !!c.sr, se: !!c.se }); // sem resposta = imediato; sem etiqueta = 2 min
    });
  }
  if (dg && dg.ts && agora - dg.ts < 5 * 60000) {
    Object.keys(dg.chats || {}).forEach(function(p) {
      var c = dg.chats[p], et = etiquetaDoUsuario(c.e, st.appUsuario);
      if (et) minhas.push({ p: p, n: c.n || '', desde: c.uc * 1000, etq: et });
      else if (!temDono(c.e)) minhas.push({ p: p, n: c.n || '', desde: c.uc * 1000, etq: 'sem vendedor na etiqueta' });
    });
  }
  // ⏰ lembretes de retorno agendados no app (aparecem para TODOS os computadores na hora marcada)
  var lembs = [];
  Object.keys(lm).forEach(function(id) { var l = lm[id]; if (l && !l.feito && l.quando && l.quando <= agora && agora - l.quando < 3 * 86400000) lembs.push({ id: id, p: l.fone || '', n: l.cli || '', num: l.n || '', vend: l.vend || '', obs: l.obs || '', u: l.u || '', desde: l.quando }); });
  lista.sort(function(a, b) { return a.desde - b.desde; });
  minhas.sort(function(a, b) { return a.desde - b.desde; });
  lembs.sort(function(a, b) { return a.desde - b.desde; });
  // 📞 cobranças atrasadas: para o vendedor da cotação; administrador e gestor veem todas
  var chefe = st.appRole === 'admin' || st.appRole === 'gestor', atras = [];
  if (st.appUsuario && ca.ts && agora - ca.ts < 2 * 3600000) Object.keys(ca.itens || {}).forEach(function(id) {
    var c = ca.itens[id]; if (chefe || vendedorDoUsuario(c.vend, st.appUsuario)) atras.push({ id: id, p: c.fone || '', n: c.cli || '', num: c.n || '', vend: c.vend || '', tot: c.tot || 0, tipo: c.tipo, obs: c.obs || '', desde: c.prazo });
  });
  atras.sort(function(a, b) { return a.desde - b.desde; });
  await chrome.storage.local.set({ waAlertas: lista, waAguardo: minhas, waLembretes: lembs, waCobAtr: atras, waAlertasTs: agora });
  var tot = lista.length + minhas.length + lembs.length + atras.length;
  chrome.action.setBadgeBackgroundColor({ color: lista.length ? '#dc2626' : '#eab308' });
  chrome.action.setBadgeText({ text: tot ? String(tot) : '' });
  if (!tot) return;
  // notificação do Windows: repete a cada 15 min por cliente enquanto continuar
  var notif = st.waNotif || {}, avSem = [], avAgu = [], novo = {};
  lista.forEach(function(c) { var k = 's' + c.p, ult = notif[k] || 0; novo[k] = ult; if (agora - ult >= 15 * 60000) { avSem.push(c); novo[k] = agora; } });
  minhas.forEach(function(c) { var k = 'a' + c.p + c.desde, ult = notif[k] || 0; novo[k] = ult; if (agora - ult >= 15 * 60000) { avAgu.push(c); novo[k] = agora; } });
  var avCob = []; atras.forEach(function(c) { var k = 'c' + c.id + c.desde, ult = notif[k] || 0; novo[k] = ult; if (agora - ult >= 60 * 60000) { avCob.push(c); novo[k] = agora; } }); // repete de hora em hora
  var avLem = []; lembs.forEach(function(c) { var k = 'l' + c.id + c.desde, ult = notif[k] || 0; novo[k] = ult; if (agora - ult >= 15 * 60000) { avLem.push(c); novo[k] = agora; } });
  await chrome.storage.local.set({ waNotif: novo });
  await mostrarFaixaAbaAtiva();
  if (!chrome.notifications) return;
  var lin = function(c, txt) { return (c.n ? c.n + ' · ' : '') + foneFmt(c.p) + ' ' + txt.replace('{t}', tempoFmt(agora - c.desde)); };
  if (avSem.length) chrome.notifications.create('waSemEtq' + agora, {
    type: 'basic', iconUrl: 'icons/icon128.png', priority: 2, requireInteraction: true,
    title: '🚨 ATENÇÃO! Atenda o cliente',
    message: avSem.slice(0, 4).map(function(c) { return lin(c, c.sr ? 'está há {t} sem atendimento!' + (c.se ? ' (e sem etiqueta)' : '') : 'está SEM ETIQUETA há {t}!'); }).join('\n') + (avSem.length > 4 ? '\n+ ' + (avSem.length - 4) + ' outro(s)' : '')
  });
  if (avCob.length) chrome.notifications.create('waCobAtr' + agora, {
    type: 'basic', iconUrl: 'icons/icon128.png', priority: 2, requireInteraction: true,
    title: '📞 Cobrança atrasada',
    message: avCob.slice(0, 4).map(function(c) { return 'Nº ' + c.num + ' ' + c.n + ' — ' + (c.tipo === 'retorno' ? 'cliente pediu retorno em ' : 'cotação nova, cobrar desde ') + new Date(c.desde).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }).join('\n') + (avCob.length > 4 ? '\n+ ' + (avCob.length - 4) + ' outra(s)' : '')
  });
  if (avLem.length) chrome.notifications.create('waLembrete' + agora, {
    type: 'basic', iconUrl: 'icons/icon128.png', priority: 2, requireInteraction: true,
    title: '⏰ Hora de retornar ao cliente',
    message: avLem.slice(0, 4).map(function(c) { return 'Nº ' + c.num + ' ' + c.n + (c.p ? ' · ' + foneFmt(c.p) : '') + (c.obs ? ' — ' + c.obs : ''); }).join('\n') + (avLem.length > 4 ? '\n+ ' + (avLem.length - 4) + ' outro(s)' : '')
  });
  if (avAgu.length) chrome.notifications.create('waAguardo' + agora, {
    type: 'basic', iconUrl: 'icons/icon128.png', priority: 2, requireInteraction: true,
    title: '⏳ Cliente aguardando sua resposta',
    message: avAgu.slice(0, 4).map(function(c) { return lin(c, 'aguarda resposta há {t}'); }).join('\n') + (avAgu.length > 4 ? '\n+ ' + (avAgu.length - 4) + ' outro(s)' : '')
  });
}
function foneFmt(p) { var x = String(p).replace(/^55/, ''); return x.length >= 10 ? '(' + x.slice(0, 2) + ') ' + x.slice(2, -4) + '-' + x.slice(-4) : p; }
function tempoFmt(ms) { var m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h' + (m % 60 ? String(m % 60).padStart(2, '0') : ''); }

// Painel na tela (aba aberta): aparece aberto, depois de 15 s encolhe para um botãozinho no canto; clicando abre de novo.
// Se chegar um cliente novo na lista, abre sozinho outra vez. Cada pessoa fecha um aviso no X (volta em 15 min se continuar).
function faixaAtendimento() {
  if (window.__maFaixa) { window.__maFaixa(); return; }
  var st = document.createElement('style');
  st.textContent =
    '@keyframes maPul{0%{box-shadow:0 0 0 0 rgba(220,38,38,.6)}70%{box-shadow:0 0 0 7px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}' +
    '@keyframes maPulA{0%{box-shadow:0 0 0 0 rgba(202,138,4,.6)}70%{box-shadow:0 0 0 7px rgba(202,138,4,0)}100%{box-shadow:0 0 0 0 rgba(202,138,4,0)}}' +
    '#maAlerta,#maAlerta *{box-sizing:border-box;font-family:"Segoe UI",Arial,sans-serif}' +
    '#maAlerta{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647}' +
    '#maAlerta .pill{border-radius:0 0 10px 10px!important;padding:1px 10px 2px!important;font-size:11px!important;border-top:none!important;opacity:.6;transition:opacity .15s}#maAlerta .pill:hover,#maAlerta .pill.novo{opacity:1}' +
    '#maAlerta .painel{border-radius:0 0 14px 14px!important;border-top:none!important}' +
    '#maAlerta .pill{display:flex;align-items:center;gap:6px;padding:5px 10px 5px 8px;border-radius:999px;font-size:11.5px;font-weight:700;cursor:pointer;background:rgba(254,226,226,.78);border:1px solid rgba(220,38,38,.45);color:#991b1b;box-shadow:0 4px 14px rgba(0,0,0,.10);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}' +
    '#maAlerta .pill.soA{background:rgba(254,249,195,.85);border-color:rgba(202,138,4,.55);color:#854d0e}' +
    '#maAlerta .dot{width:8px;height:8px;border-radius:50%;background:#dc2626;animation:maPul 1.6s infinite;flex-shrink:0}' +
    '#maAlerta .dot.a{background:#ca8a04;animation-name:maPulA}' +
    '#maAlerta .cnt{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:9px;font-size:11px;padding:0 5px;color:#fff}' +
    '#maAlerta .painel{width:310px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;background:rgba(255,255,255,.86);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(0,0,0,.08);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.15)}' +
    '#maAlerta .ph{display:flex;align-items:center;justify-content:space-between;padding:6px 6px 6px 12px;border-bottom:1px solid rgba(0,0,0,.06);font-size:12px;font-weight:700;color:#1c1917}' +
    '#maAlerta .wb{width:30px;height:24px;border:none;background:transparent;color:#44403c;border-radius:5px;cursor:pointer;font-size:15px;line-height:24px;padding:0}' +
    '#maAlerta .wb:hover{background:rgba(0,0,0,.08)}#maAlerta .wb.fx:hover{background:#dc2626;color:#fff}' +
    '#maAlerta .av{position:relative;margin:8px;border-radius:10px;padding:10px 30px 10px 12px;font-size:12px;line-height:1.45}' +
    '#maAlerta .av.r{background:rgba(254,226,226,.8);border:1px solid rgba(220,38,38,.35);border-left:4px solid #dc2626;color:#7f1d1d}' +
    '#maAlerta .av.a{background:rgba(254,249,195,.9);border:1px solid rgba(202,138,4,.35);border-left:4px solid #eab308;color:#713f12}' +
    '#maAlerta .av.c{background:rgba(255,237,213,.92);border:1px solid rgba(234,88,12,.35);border-left:4px solid #ea580c;color:#7c2d12}' +
    '#maAlerta .av.l{background:rgba(219,234,254,.9);border:1px solid rgba(37,99,235,.35);border-left:4px solid #2563eb;color:#1e3a8a}' +
    '#maAlerta .ok{margin-top:6px;background:#16a34a;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:11.5px;font-weight:800;cursor:pointer}' +
    '#maAlerta .tt{font-size:10.5px;font-weight:800;letter-spacing:.5px;display:flex;align-items:center;gap:6px}' +
    '#maAlerta .nm{font-size:13px;font-weight:700;margin-top:4px;color:#1c1917}' +
    '#maAlerta .fn{display:inline-flex;align-items:center;gap:5px;margin-top:5px;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,.8);border:1px solid rgba(0,0,0,.1);font-weight:700;cursor:pointer;font-size:12px;color:#1c1917}' +
    '#maAlerta .fn:hover{border-color:rgba(0,0,0,.3)}' +
    '#maAlerta .tm{margin-top:5px;font-size:11.5px}' +
    '#maAlerta .x{position:absolute;top:7px;right:7px;width:20px;height:20px;border:none;border-radius:50%;background:rgba(0,0,0,.06);color:inherit;cursor:pointer;font-size:13px;line-height:20px;padding:0}' +
    '#maAlerta .x:hover{background:rgba(0,0,0,.15)}' +
    '#maAlerta .rod{padding:2px 12px 10px;font-size:10.5px;color:#78716c}' +
    '@media print{#maAlerta{display:none!important}}';
  document.documentElement.appendChild(st);
  var box = document.createElement('div'); box.id = 'maAlerta'; document.documentElement.appendChild(box);
  // minimizado vale para TODAS as abas: guarda em waMinKeys os avisos já minimizados; só reabre sozinho se chegar cliente novo
  var abertoLocal = false, timer = null;
  function esc(t) { return String(t).replace(/[&<>"]/g, function(x) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]; }); }
  function tempo(ms) { var m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h' + (m % 60 ? String(m % 60).padStart(2, '0') : ''); }
  function fone(p) { var x = String(p).replace(/^55/, ''); return x.length >= 10 ? '(' + x.slice(0, 2) + ') ' + x.slice(2, -4) + '-' + x.slice(-4) : p; }
  var atuais = [];
  function minimizarTodas() { clearTimeout(timer); timer = null; abertoLocal = false; chrome.storage.local.get(['waMinKeys'], function(c) { var mk = c.waMinKeys || {}, t = Date.now(); Object.keys(mk).forEach(function(k) { if (t - mk[k] > 2 * 86400000) delete mk[k]; }); atuais.forEach(function(k) { mk[k] = t; }); chrome.storage.local.set({ waMinKeys: mk }); }); }
  function encolherDepois() { clearTimeout(timer); timer = setTimeout(minimizarTodas, 15000); }
  function fechar(chaves) {
    chrome.storage.local.get(['waFechado'], function(c2) { var f = c2.waFechado || {}, t = Date.now(); chaves.forEach(function(k) { f[k] = t; }); chrome.storage.local.set({ waFechado: f }, function() { desenhar(); }); });
  }
  function desenhar() {
    if (!chrome.runtime || !chrome.runtime.id) { box.remove(); return; }
    chrome.storage.local.get(['waAlertas', 'waAguardo', 'waLembretes', 'waCobAtr', 'waFechado', 'waMinKeys'], function(c) {
      var fech = c.waFechado || {}, agora = Date.now();
      var ok = function(k) { return !(fech[k] && agora - fech[k] < 15 * 60000); };
      var R = (c.waAlertas || []).filter(function(a) { a._k = 's' + a.p; return ok(a._k); });
      var A = (c.waAguardo || []).filter(function(a) { a._k = 'a' + a.p + a.desde; return ok(a._k); });
      var Lm = (c.waLembretes || []).filter(function(a) { a._k = 'l' + a.id + a.desde; return ok(a._k); });
      var Ca = (c.waCobAtr || []).filter(function(a) { a._k = 'c' + a.id + a.desde; return ok(a._k); });
      if (!R.length && !A.length && !Lm.length && !Ca.length) { box.innerHTML = ''; return; }
      var mk = c.waMinKeys || {};
      atuais = R.concat(A).map(function(a) { return a.p + '|' + a.desde; }).concat(Lm.map(function(a) { return 'l' + a.id + '|' + a.desde; })).concat(Ca.map(function(a) { return 'c' + a.id + '|' + a.desde; }));
      var novo = atuais.some(function(k) { return !mk[k]; });
      if (novo && !timer) encolherDepois();
      var aberto = abertoLocal; // abre só quando a pessoa clica na faixinha do topo (não cobre a tela sozinho)
      if (!aberto) {
        box.innerHTML = '<div class="pill' + (R.length ? '' : ' soA') + (novo ? ' novo' : '') + '" title="Clique para ver os avisos">' +
          '<span class="dot' + (R.length ? '' : ' a') + '"></span>' +
          (R.length ? '<span class="cnt" style="background:#dc2626">' + R.length + '</span>sem atendimento' : '') +
          (R.length && A.length ? '<span style="opacity:.4">|</span>' : '') +
          (A.length ? '<span class="cnt" style="background:#ca8a04">' + A.length + '</span><span style="color:#854d0e">aguardando</span>' : '') +
          ((R.length || A.length) && Lm.length ? '<span style="opacity:.4">|</span>' : '') +
          (Lm.length ? '<span class="cnt" style="background:#2563eb">' + Lm.length + '</span><span style="color:#1e3a8a">retorno</span>' : '') +
          ((R.length || A.length || Lm.length) && Ca.length ? '<span style="opacity:.4">|</span>' : '') +
          (Ca.length ? '<span class="cnt" style="background:#ea580c">' + Ca.length + '</span><span style="color:#7c2d12">cobrança atrasada</span>' : '') + '</div>';
        box.querySelector('.pill').onclick = function() { abertoLocal = true; desenhar(); };
        return;
      }
      var item = function(a, tipo) {
        return '<div class="av ' + tipo + '"><button class="x" data-k="' + esc(a._k) + '" title="Fechar este aviso">×</button>' +
          (tipo === 'r' ? '<div class="tt"><span class="dot" style="width:7px;height:7px"></span>' + (a.sr === false ? 'ATENÇÃO! CONVERSA SEM ETIQUETA' : 'ATENÇÃO! ATENDA O CLIENTE') + '</div>' : '<div class="tt">⏳ CLIENTE AGUARDANDO SUA RESPOSTA</div>') +
          '<div class="nm">' + esc(a.n || '(sem nome)') + (a.etq ? ' <span style="font-weight:400;font-size:11px;color:#854d0e">· ' + esc(a.etq) + '</span>' : '') + '</div>' +
          '<div class="fn cp" data-n="' + esc(String(a.p).replace(/^55/, '')) + '" title="Clique para copiar o número">📋 ' + esc(fone(a.p)) + '</div>' +
          '<div class="tm">' + (tipo === 'r' ? (a.sr === false ? '🏷️ Sem etiqueta há <b>' + tempo(agora - a.desde) + '</b> — coloque a etiqueta' : 'Sem atendimento há <b>' + tempo(agora - a.desde) + '</b>' + (a.se ? ' · 🏷️ e sem etiqueta' : '')) : 'Cliente aguarda resposta há <b>' + tempo(agora - a.desde) + '</b>') + '</div></div>';
      };
      box.innerHTML = '<div class="painel"><div class="ph"><span>🔔 Avisos de atendimento</span><span><button class="wb mn" title="Minimizar">&#8211;</button><button class="wb fx" title="Fechar todos os avisos">×</button></span></div>' +
        R.slice(0, 5).map(function(a) { return item(a, 'r'); }).join('') +
        (R.length > 5 ? '<div class="rod">+ ' + (R.length - 5) + ' cliente(s) sem atendimento</div>' : '') +
        A.slice(0, 5).map(function(a) { return item(a, 'a'); }).join('') +
        (A.length > 5 ? '<div class="rod">+ ' + (A.length - 5) + ' cliente(s) aguardando</div>' : '') +
        Ca.slice(0, 5).map(function(a) {
          return '<div class="av c"><button class="x" data-k="' + esc(a._k) + '" title="Fechar este aviso">×</button><div class="tt">📞 COBRANÇA ATRASADA</div>' +
            '<div class="nm">' + esc(a.n || '(sem nome)') + ' <span style="font-weight:400;font-size:11px">· cotação nº ' + esc(a.num) + (a.vend ? ' · ' + esc(a.vend) : '') + '</span></div>' +
            (a.p ? '<div class="fn cp" data-n="' + esc(String(a.p).replace(/^55/, '').replace(/\D/g, '')) + '" title="Clique para copiar o número">📋 ' + esc(fone(String(a.p).replace(/\D/g, ''))) + '</div>' : '') +
            '<div class="tm">' + (a.tipo === 'retorno' ? 'O cliente pediu retorno em <b>' : 'Cotação nova — devia ter sido cobrada em <b>') + new Date(a.desde).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</b> e ninguém falou com o cliente depois disso' + (a.obs ? ' · ' + esc(a.obs) : '') + '</div>' +
            '<div class="tm">Mande mensagem para o cliente no WhatsApp (ou registre a cobrança no app): o aviso some em até 10 min.</div></div>';
        }).join('') +
        Lm.slice(0, 5).map(function(a) {
          return '<div class="av l"><button class="x" data-k="' + esc(a._k) + '" title="Fechar este aviso">×</button><div class="tt">⏰ HORA DE RETORNAR AO CLIENTE</div>' +
            '<div class="nm">' + esc(a.n || '(sem nome)') + ' <span style="font-weight:400;font-size:11px">· cotação nº ' + esc(a.num) + (a.vend ? ' · ' + esc(a.vend) : '') + '</span></div>' +
            (a.p ? '<div class="fn cp" data-n="' + esc(String(a.p).replace(/^55/, '')) + '" title="Clique para copiar o número">📋 ' + esc(fone(a.p)) + '</div>' : '') +
            (a.obs ? '<div class="tm">' + esc(a.obs) + '</div>' : '') +
            '<div class="tm">Agendado para ' + new Date(a.desde).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + (a.u ? ' por ' + esc(a.u) : '') + '</div>' +
            '<button class="ok" data-id="' + esc(a.id) + '">✔ Retorno feito (some para todos)</button></div>';
        }).join('') +
        '<div class="rod">Clique no número para copiar e buscar no WhatsApp</div></div>';
      box.querySelector('.mn').onclick = function() { minimizarTodas(); };
      box.querySelector('.fx').onclick = function() { clearTimeout(timer); fechar(R.concat(A).concat(Lm).concat(Ca).map(function(a) { return a._k; })); };
      box.querySelectorAll('.cp').forEach(function(sp) {
        sp.onclick = function() {
          var n = sp.getAttribute('data-n'), t = sp.innerHTML;
          encolherDepois();
          function feito() { sp.innerHTML = '✅ Copiado! Cole na busca do WhatsApp'; setTimeout(function() { sp.innerHTML = t; }, 2500); }
          function velho() { var ta = document.createElement('textarea'); ta.value = n; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); feito(); }
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(n).then(feito, velho); else velho();
        };
      });
      box.querySelectorAll('.x').forEach(function(b) { b.onclick = function() { fechar([b.getAttribute('data-k')]); }; });
      box.querySelectorAll('.ok').forEach(function(b) { b.onclick = function() { b.textContent = '⏳ ...'; chrome.runtime.sendMessage({ action: 'lembreteFeito', id: b.getAttribute('data-id') }, function() { desenhar(); }); }; });
    });
  }
  document.addEventListener('mousedown', function(ev) { if (abertoLocal && !box.contains(ev.target)) minimizarTodas(); }, true);
  window.__maFaixa = function() { desenhar(); };
  desenhar();
  setInterval(desenhar, 10000);
  chrome.storage.onChanged.addListener(function(ch) { if (ch.waAlertas || ch.waAguardo || ch.waLembretes || ch.waCobAtr || ch.waFechado || ch.waMinKeys) desenhar(); });
}
async function mostrarFaixaAbaAtiva() {
  var st = await chrome.storage.local.get(['waAlertas', 'waAguardo', 'waLembretes', 'waCobAtr']);
  if (!(st.waAlertas || []).length && !(st.waAguardo || []).length && !(st.waLembretes || []).length && !(st.waCobAtr || []).length) return;
  var abas = await chrome.tabs.query({ active: true });
  for (var k = 0; k < abas.length; k++) {
    try { await chrome.scripting.executeScript({ target: { tabId: abas[k].id }, func: faixaAtendimento }); } catch (e) {} // páginas do Chrome não aceitam
  }
}
chrome.tabs.onActivated.addListener(function() { mostrarFaixaAbaAtiva().catch(function() {}); });
chrome.tabs.onUpdated.addListener(function(id, info, tab) { if (info.status === 'complete' && tab.active) mostrarFaixaAbaAtiva().catch(function() {}); });

alarme('waAlerta', 1);
chrome.alarms.onAlarm.addListener(function(a) {
  if (a.name !== 'waAlerta') return;
  publicarAlertasWA().catch(function() {}).then(function() { return verificarAlertasWA(); }).catch(function() {});
  // garantia: se a sincronização das etiquetas está parada há mais de 10 min, roda agora
  chrome.storage.local.get(['waUltima'], function(c) { if (Date.now() - (c.waUltima || 0) > 10 * 60000) sincronizarWA(false).catch(function() {}); });
  manterAbasAcordadas().catch(function() {});
});
if (chrome.notifications) chrome.notifications.onClicked.addListener(function(id) {
  if (id.indexOf('waLembrete') === 0 || id.indexOf('waCobAtr') === 0) { chrome.tabs.create({ url: 'https://rauldneto.github.io/mais-acessivel-app/' }); chrome.notifications.clear(id); return; }
  if (id.indexOf('waSemEtq') !== 0 && id.indexOf('waAguardo') !== 0) return;
  chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, function(t) { if (t && t.length) { chrome.tabs.update(t[0].id, { active: true }); chrome.windows.update(t[0].windowId, { focused: true }); } });
  chrome.notifications.clear(id);
});


// v2.0.6: o Chrome "adormece" abas paradas para economizar memória e aí a sincronização parava.
// O WhatsApp Web e o Bling ficam marcados para nunca adormecer.
async function manterAbasAcordadas() {
  var abas = await chrome.tabs.query({ url: ['https://web.whatsapp.com/*', 'https://www.bling.com.br/*'] });
  abas.forEach(function(t) { if (t.autoDiscardable !== false) chrome.tabs.update(t.id, { autoDiscardable: false }).catch(function() {}); });
}
manterAbasAcordadas().catch(function() {});

// v2.0.6: atualização com um clique — o app grava os arquivos novos na pasta da extensão e pede para recarregar
chrome.runtime.onMessage.addListener(function(msg, sender, responder) {
  if (!msg || msg.action !== 'recarregarExt') return;
  if (!sender || !sender.url || sender.url.indexOf(APP_URL) !== 0) { responder({ ok: false }); return; }
  responder({ ok: true, versao: chrome.runtime.getManifest().version });
  setTimeout(function() { chrome.runtime.reload(); }, 300);
});

// ====================== FOTO DAS COTAÇÕES + PRODUTOS NÃO VENDIDOS ======================
// O vendedor costuma editar a própria cotação antes de concluir (tira o que o cliente não comprou) e o Bling não guarda
// a versão anterior. Por isso, a cada 30 min, um computador que sincroniza o WhatsApp "fotografa" as cotações em aberto
// (itens, quantidades e valores — guardando sempre a MAIOR quantidade já vista). Quando a cotação vira pedido, comparamos
// a foto com o pedido: o que ficou de fora é o que não vendemos.
function fbJ(caminho) { return fetch(FB + '/' + caminho + '.json').then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }); }
function fbW(caminho, metodo, dados) { return fetch(FB + '/' + caminho + '.json', { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }).catch(function() {}); }
function numB(s) { if (typeof s === 'number') return s; var t = String(s || '').trim(); if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t); return parseFloat(t.replace(/\./g, '').replace(',', '.')) || 0; } // aceita 2636.00 e 2.636,00
function chaveP(c) { return String(c || '').replace(/[.#$\/\[\]]/g, '_') || 'sem'; }
function isoDia(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function juntarFoto(old, r, p) {
  var its = (old && old.itens) || {};
  (r.itens || []).forEach(function(it, i) {
    var k = chaveP(it.codigo || ('item' + i)), o = its[k], q = numB(it.qtd);
    its[k] = { c: it.codigo || '', d: it.descricao || '', q: Math.max(q, o ? o.q : 0), v: numB(it.v) || (o && o.v) || 0 };
  });
  return { n: String(r.numero || p.numero || ''), cli: r.cliente || p.cliente || '', vend: r.vendedor || (old && old.vend) || '', data: p.data || (old && old.data) || '', fone: r.fone || (old && old.fone) || '',
    tot: Math.max(numB(p.total), (old && old.tot) || 0), ts: Date.now(), itens: its };
}

var fotoRodando = false;
async function fotografarCotacoes(forcar) {
  if (fotoRodando) return; fotoRodando = true;
  var ab = null;
  try {
    var cfg = await chrome.storage.local.get(['waSync', 'waNome']);
    if (!forcar && !(await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' })).length) return; // só o computador do WhatsApp
    var meta = await fbJ('cotSnapMeta');
    if (!forcar && meta && meta.ts && Date.now() - meta.ts < 25 * 60000) return; // outro computador já fez há pouco
    await fbW('cotSnapMeta', 'PUT', { ts: Date.now(), maquina: cfg.waNome || '', status: 'rodando' });
    ab = await obterAbaBling();
    var d = new Date(); d.setDate(d.getDate() - 90);
    var lista = await enviar(ab.id, { action: 'listarPropostas', filtro: { situacaoPesq: 'sit-EmAberto', desde: isoDia(d) } });
    if (!lista || lista.erro) throw new Error((lista && lista.erro) || 'lista');
    var idx = (await fbJ('cotSnapIdx')) || {};
    var fila = lista.itens.filter(function(p) { return String(idx[p.id]) !== String(p.total) + '|v2'; }), feitas = 0;
    async function w() {
      while (fila.length) {
        var p = fila.shift(), r;
        try { r = await enviar(ab.id, { action: 'auditarProposta', id: p.id }); } catch (e) { continue; }
        if (!r || r.falha) continue;
        var old = await fbJ('cotSnap/' + p.id);
        await fbW('cotSnap/' + p.id, 'PUT', juntarFoto(old, r, p));
        var o = {}; o[p.id] = String(p.total) + '|v2'; await fbW('cotSnapIdx', 'PATCH', o);
        feitas++;
      }
    }
    await Promise.all([w(), w()]);
    await calcularCobrancasAtrasadas(lista.itens);
    await fbW('cotSnapMeta', 'PUT', { ts: Date.now(), maquina: cfg.waNome || '', status: 'ok', abertas: lista.itens.length, atualizadas: feitas });
  } catch (e) {
    await fbW('cotSnapMeta', 'PUT', { ts: Date.now(), status: 'erro', erro: String(e && e.message || e) });
  } finally {
    fotoRodando = false;
    if (ab && ab.criada) { try { chrome.tabs.remove(ab.id); } catch (e) {} }
  }
}
alarme('cotSnap', 30);
chrome.alarms.onAlarm.addListener(function(a) { if (a.name === 'cotSnap') fotografarCotacoes(false).catch(function() {}); });

// Levantamento (pedido pelo app): pedidos do período x foto da cotação + cotações não aprovadas
async function levantarPerdas(filtro, post, vivo) {
  var ab = null;
  try {
    var hoje = new Date(), desde = filtro.desde, ate = filtro.ate || isoDia(hoje);
    post({ type: 'status', texto: 'Conectando ao Bling...' });
    ab = await obterAbaBling();
    post({ type: 'status', texto: 'Lendo os pedidos de venda do período...' });
    var vendas = await enviar(ab.id, { action: 'listarVendas', desde: desde, ate: ate });
    if (!vendas || vendas.erro) throw new Error((vendas && vendas.erro) || 'Falha ao listar pedidos');
    post({ type: 'status', texto: 'Lendo as fotos das cotações...' });
    var fotos = (await fbJ('cotSnap')) || {};
    post({ type: 'status', texto: 'Lendo as cotações não aprovadas...' });
    var nao = await enviar(ab.id, { action: 'listarPropostas', filtro: { situacaoPesq: 'sit-Não aprovado', desde: desde } });
    var naoAp = ((nao && nao.itens) || []).filter(function(p) { return !p.data || p.data <= ate; });
    var comFoto = vendas.itens.filter(function(v) { return v.idOrigem && fotos[v.idOrigem]; });
    var semFoto = vendas.itens.filter(function(v) { return v.idOrigem && !fotos[v.idOrigem]; }).length;
    var total = comFoto.length + naoAp.length, feitos = 0, salvar = {};
    post({ type: 'lista', total: total, pedidos: vendas.itens.length, semFoto: semFoto, naoAprovadas: naoAp.length });
    var fila = comFoto.map(function(v) { return { t: 'p', v: v }; }).concat(naoAp.map(function(p) { return { t: 'n', p: p }; }));
    async function w() {
      while (fila.length && vivo()) {
        var x = fila.shift(), res = null;
        try {
          if (x.t === 'p') {
            var f = fotos[x.v.idOrigem], iv = await enviar(ab.id, { action: 'itensVenda', id: x.v.id });
            if (iv && iv.itens) {
              var vend = {}; iv.itens.forEach(function(i) { var k = chaveP(i.c); vend[k] = (vend[k] || 0) + numB(i.q); });
              var perd = [];
              Object.keys(f.itens || {}).forEach(function(k) { var it = f.itens[k], falta = it.q - (vend[k] || 0); if (falta > 0.0001) perd.push({ c: it.c, d: it.d, q: +falta.toFixed(3), v: it.v, tot: +(falta * it.v).toFixed(2) }); });
              if (perd.length) res = { id: x.v.idOrigem, tipo: 'parcial', n: f.n, cli: f.cli, vend: f.vend, data: f.data, pedido: x.v.numero, dataPed: x.v.data, totCot: f.tot, totPed: x.v.total, perdidos: perd, total: +perd.reduce(function(a, b) { return a + b.tot; }, 0).toFixed(2) };
            }
          } else {
            var p = x.p, ff = fotos[p.id], itens;
            if (ff) itens = Object.keys(ff.itens || {}).map(function(k) { return ff.itens[k]; });
            else { var r = await enviar(ab.id, { action: 'auditarProposta', id: p.id }); itens = ((r && r.itens) || []).map(function(i) { return { c: i.codigo, d: i.descricao, q: numB(i.qtd), v: numB(i.v) }; }); ff = { n: r && r.numero, cli: r && r.cliente, vend: r && r.vendedor }; }
            var pd = itens.map(function(i) { return { c: i.c, d: i.d, q: i.q, v: i.v, tot: +(i.q * i.v).toFixed(2) }; });
            res = { id: p.id, tipo: 'naoAprovada', n: String(ff.n || p.numero || ''), cli: ff.cli || p.cliente || '', vend: ff.vend || '', data: p.data || '', perdidos: pd, total: +pd.reduce(function(a, b) { return a + b.tot; }, 0).toFixed(2) || numB(p.total) };
          }
        } catch (e) {}
        feitos++;
        if (res) { salvar[res.id] = res; }
        post({ type: 'item', feitos: feitos, item: res });
      }
    }
    await Promise.all([w(), w(), w()]);
    if (Object.keys(salvar).length) await fbW('perdasHist', 'PATCH', salvar); // fica guardado como histórico
    post({ type: 'fim', pedidos: vendas.itens.length, semFoto: semFoto });
  } catch (e) {
    var m = String(e.message || e);
    post({ type: 'erro', msg: m === 'SESSAO' ? 'Você não está logado no Bling. Abra o Bling, faça login e tente de novo.' : m });
  } finally { if (ab && ab.criada) { try { chrome.tabs.remove(ab.id); } catch (e) {} } }
}
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg && msg.action === 'fotografarAgora') { fotografarCotacoes(true).then(function() { sendResponse({ ok: true }); }); return true; }
  return false;
});

// "Retorno feito" no painel: marca o lembrete como feito para todos
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg || msg.action !== 'lembreteFeito') return false;
  chrome.storage.local.get(['appUsuario', 'waLembretes'], function(c) {
    var lista = (c.waLembretes || []).filter(function(x) { return String(x.id) !== String(msg.id); });
    chrome.storage.local.set({ waLembretes: lista });
    fbW('lembretes/' + msg.id + '/feito', 'PUT', { ts: Date.now(), u: c.appUsuario || '' }).then(function() { sendResponse({ ok: true }); });
  });
  return true;
});


// ====================== 📞 COBRANÇA ATRASADA ======================
// Prazo para cobrar: a data que o cliente pediu (lembrete de retorno) ou, se não houver, o próximo dia útil às 9h depois da cotação.
// Atrasada = passou 1 h do prazo e ninguém registrou cobrança. O computador que sincroniza calcula a cada 30 min (cobAtrasadas)
// e cada computador mostra para o vendedor da cotação (administrador e gestor veem todas).
function proximoDiaUtil9h(iso) {
  var d = new Date(String(iso) + 'T09:00:00'); if (isNaN(d)) return 0;
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d.getTime();
}
// v2.0.7: conta como cobrança a mensagem que NÓS mandamos para o cliente no WhatsApp depois do prazo (ou a cobrança registrada no app)
function chaveFone(t) { var d = String(t || '').replace(/\D/g, ''); if (d.length >= 12 && d.indexOf('55') === 0) d = d.slice(2); if (d.length < 8) return ''; return (d.length >= 10 ? d.slice(0, 2) : '62') + d.slice(-8); }
function chavesFone(t) { return String(t || '').split(/[\/,;|]| e /).map(chaveFone).filter(Boolean); }
async function calcularCobrancasAtrasadas(abertas, fotosIn) {
  var dd = await Promise.all([fbJ('vendaInfo'), fbJ('lembretes'), fotosIn ? Promise.resolve(fotosIn) : fbJ('cotSnap'), fbJ('waChats')]);
  var vi = dd[0] || {}, lm = dd[1] || {}, fotos = dd[2] || {}, wa = dd[3] || {}, agora = Date.now(), out = {}, unIdx = {};
  Object.keys(wa).forEach(function(p) { var k = chaveFone(p), u = (wa[p] && wa[p].un) || 0; if (k && u > (unIdx[k] || 0)) unIdx[k] = u; });
  var cache = [];
  abertas.forEach(function(p) {
    var f = fotos[p.id] || {}, fone = f.fone || p.fone || '', vend = f.vend || p.vend || '';
    cache.push({ id: p.id, numero: p.numero, cliente: p.cliente, total: p.total, data: p.data, fone: fone, vend: vend });
    var v = vi[p.id] || {};
    if (v.fech && v.fech.st) return; // já tem resultado
    var cobs = Object.keys(v.cob || {}).map(function(k) { return v.cob[k].ts || 0; });
    var l = lm[p.id], prazo, tipo;
    if (l && l.quando && !l.feito) { prazo = l.quando; tipo = 'retorno'; }
    else if (!cobs.length && !(l && l.feito)) { prazo = proximoDiaUtil9h(p.data); tipo = 'nova'; }
    else return;
    if (!prazo || agora < prazo + 3600000) return;
    var depois = cobs.some(function(t) { return t >= prazo - 12 * 3600000; });
    if (tipo === 'retorno' && depois) return;
    if (tipo === 'nova' && cobs.length) return;
    var waUlt = chavesFone(fone).reduce(function(m, k) { return Math.max(m, unIdx[k] || 0); }, 0) * 1000;
    if (waUlt >= prazo - 12 * 3600000) return; // já falamos com o cliente pelo WhatsApp depois do prazo
    out[p.id] = { n: String(p.numero || f.n || '').trim(), cli: p.cliente || f.cli || '', vend: vend || (v && v.vend) || '', tot: numB(p.total), fone: String(fone).split(/[\/,;|]/)[0].trim(), prazo: prazo, tipo: tipo, obs: (l && l.obs) || '' };
  });
  await fbW('cobAtrasadas', 'PUT', { ts: agora, itens: out });
  if (!fotosIn) await chrome.storage.local.set({ cobCache: { ts: agora, abertas: cache } });
}
// recalcula a cada sincronização do WhatsApp (10 min), sem ir ao Bling: usa a lista guardada na última foto das cotações
async function recalcularCobrancas() {
  var c = (await chrome.storage.local.get(['cobCache'])).cobCache;
  if (!c || !c.abertas || Date.now() - c.ts > 3 * 3600000) return;
  await calcularCobrancasAtrasadas(c.abertas, {});
}
function vendedorDoUsuario(vend, usuario) {
  var u = normTxt(usuario).replace(/ /g, ''), w = normTxt(vend).split(' ')[0];
  return !!(u && w && w.length >= 3 && (u.indexOf(w) === 0 || w.indexOf(u) === 0));
}

// ====================== FINANCEIRO: lançamento de despesas (v1.18.0) ======================
// O app (aba Financeiro) pede: buscar fornecedor, lançar conta a pagar ou ler as listas do Bling.
// Tudo roda DENTRO de uma aba do Bling, com a sessão já logada. Só aceita pedidos da página do app.
chrome.runtime.onMessage.addListener(function(msg, sender, responder) {
  if (!msg || msg.action !== 'finBling') return;
  if (!sender || !sender.url || sender.url.indexOf(APP_URL) !== 0) { responder({ ok: false, erro: 'Origem não autorizada' }); return; }
  (async function() {
    var aba = null;
    try {
      aba = await obterAbaBling();
      var r = await enviar(aba.id, { action: 'finBling', op: msg.op, dados: msg.dados || {} });
      responder(r || { ok: false, erro: 'A aba do Bling está com a versão antiga da extensão. Recarregue o Bling (F5) e tente de novo.' });
    } catch (e) {
      responder({ ok: false, erro: String(e.message || e) });
    } finally {
      if (aba && aba.criada) { try { chrome.tabs.remove(aba.id); } catch (x) {} }
    }
  })();
  return true;
});
