// Cloudflare Worker: "bling"
// Ponte entre o app (aba BLING) e a API oficial do Bling (v3), usando o aplicativo "JDFER Financeiro Sicoob".
// Nada de senha no app: o acesso ao Bling fica guardado SÓ aqui.
//
// Configuração no painel da Cloudflare (Workers → bling → Settings):
//   Bindings → KV namespace:  nome da variável  BLING_KV   (crie um namespace chamado "bling")
//   Variables and Secrets:
//     BLING_CLIENT_ID      = Client ID do app no Bling               (tipo Text)
//     BLING_CLIENT_SECRET  = Client Secret do app no Bling           (tipo Secret)
//   PIX pelo Sicoob (opcional; sem isso o botão Gerar PIX fica desligado):
//     Bindings → Certificado mTLS:  SICOOB_MTLS  (certificado A1 da JDFER enviado pela API da Cloudflare)
//     SICOOB_CLIENT_ID     = client_id do app no portal Sicoob        (tipo Text)
//     PIX_CHAVE            = chave PIX que recebe as cobranças (CNPJ) (tipo Text)
//   Avisos de TEF no celular (opcional): NTFY_TOPICO = nome do tópico no app ntfy (grátis). Sem isso, o aviso aparece só no app.
//
// Rotas (todas só aceitam chamadas vindas do app https://rauldneto.github.io):
//   GET  /status            → {ok, conectado, empresa?}
//   GET  /oauth/inicio      → {ok, url}  (o app abre essa URL; o Bling volta para o app com ?code=&state=)
//   POST /oauth/troca       {code, state} → guarda o acesso no KV
//   GET  /abertos[?forcar=1]→ pedidos de venda "Em aberto" e notas com conta a receber em aberto,
//                             só com pagamento PIX ou cartão de crédito (link). Cache de 60 s.
//   POST /pix {tipo,id,numero,valor,usuario,cliente,doc} → cria cobrança imediata no Sicoob e devolve o copia e cola
//   GET  /pix/status?txid=  → situação da cobrança no Sicoob (ATIVA / CONCLUIDA ...)
//   GET  /pagamentos         → PIX pagos e ações planejadas/feitas no Bling (para o administrador)
//   POST /pagamentos/verificar → roda a verificação agora (a mesma do gatilho cron a cada 5 min)
//   GET  /pedido-compra?numero=N → pedido de compra pelo número (itens, fornecedor, frete, impostos, parcelas)
//                             para a aba Compras › Cotação compra. Precisa do escopo "Pedidos de compra" no app do Bling.
//   GET  /produtos-fornecedores?ids=1,2,3 → códigos que cada fornecedor usa para esses produtos (cadastro do Bling),
//                             usados como pista para ligar a cotação do fornecedor aos itens do pedido. Cache de 1 dia.
//   GET  /boletos, POST /boletos/verificar|vincular|ignorar|simular|simular/passo → boletos Sicoob liquidados (ver o fim do arquivo)
//   Contas a Pagar: tarifas de boleto (múltiplos de R$ 1,60) lançadas e baixadas sozinhas todo dia às 13h e 18h (GET /pagar/auto = situação, POST = rodar agora).
//   GET /pagar/conciliar?mes=AAAA-MM (ou ?de=&ate=), GET /pagar/conta?id=, POST /pagar/baixar|lancar|marcar → extrato Sicoob × Contas a Pagar (fim do arquivo)
//     Precisa: escopo cco_extrato liberado no app do portal Sicoob (ou num 2º app: SICOOB_CLIENT_ID_CCO; o nº da conta é descoberto num boleto Sicoob; SICOOB_CONTA opcional) e permissão Contas a pagar (ler/gravar) no app do Bling.
//   Chat: POST /push/chat {para,de,nome,conv,txt,av} → notificação no Chrome só dos navegadores do destinatário (GET /push/ultimos?u= devolve as dele)
//   ECONF: GET /econf/pendentes|painel|diag|xml?k=, POST /econf/enviar|auto|certificado|registrar → evento de conciliação à Sefaz
// Gatilho (Settings → Trigger Events → Cron): */5 * * * *  (PIX a cada 5 min; boletos a cada 30 min)
// Modo: KV "modo" = "simulacao" (padrão: só anota o que faria) ou "real" (executa no Bling).

const ORIGENS = ['https://rauldneto.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];
const API = 'https://api.bling.com.br/Api/v3';
const TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const SIT_PEDIDO_ABERTO = 6;              // "Em aberto" (módulo Vendas)
const COD_PIX = 17, COD_CREDITO = 3;      // códigos fiscais da forma de pagamento (tPag da NF-e)
const DIAS_PEDIDOS = 120;                 // pedidos em aberto criados nos últimos N dias
const DIAS_CONTAS = 180;                  // contas a receber em aberto emitidas nos últimos N dias

export default {
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(verificarUso(env).catch(() => {}));   // de hora em hora: confere o consumo do plano grátis do Cloudflare
    // 13h e 18h: a rodada é do ECONF automático (envio à Sefaz); nas outras, conferência de PIX e boletos
    if (await econfAgendado(env).catch(e => { registrarErro(env, 'ECONF automático: ' + String(e.message || e)); return false; })) return;
    // 13h e 18h (logo depois do ECONF da mesma hora): tarifas de boleto do extrato Sicoob → Contas a Pagar (lança e baixa sozinho). Essa rodada faz só isso.
    const horaAgora = new Date(Date.now() - 3 * 3600e3).getUTCHours();
    if (env.SICOOB_CLIENT_ID_CCO && PAG_AUTO_HORAS.includes(horaAgora)) {
      const st = (await env.BLING_KV.get('pagar:auto', 'json')) || {};
      if (!(st.slot === hojeLocal() + '-' + horaAgora && st.fim)) { ctx.waitUntil(pagarTaxasAuto(env).catch(e => registrarErro(env, 'Tarifas automáticas: ' + String(e.message || e)))); return; }
    }
    ctx.waitUntil(verificarPagamentos(env).then(() => registrarErro(env, null)).catch(e => registrarErro(env, String(e.message || e)))
      .then(() => verificarBoletos(env)).catch(e => registrarErro(env, 'Boletos: ' + String(e.message || e))));
  },
  async fetch(req, env, ctx) {
    const origem = req.headers.get('Origin') || '';
    const okOrigem = ORIGENS.includes(origem);
    const cors = {
      'Access-Control-Allow-Origin': okOrigem ? origem : ORIGENS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8',
      'Vary': 'Origin',
    };
    const resp = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: cors });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    // Página pública de pagamento (link curto que vai para o cliente): /p/AB12CD
    { const m = new URL(req.url).pathname.match(/^\/p\/([A-Za-z0-9]{4,12})\/?$/); if (m && env.BLING_KV) return paginaPix(env, m[1]); }
    // Dados públicos do link (usados pelo site de pagamento maisacessivel.pages.dev): /p/AB12CD.json
    { const m = new URL(req.url).pathname.match(/^\/p\/([A-Za-z0-9]{4,12})\.json$/); if (m && env.BLING_KV) {
      const d = await pixPublico(env, m[1]);
      return new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    } }
    if (!okOrigem) return resp({ ok: false, erro: 'Origem não autorizada' }, 403);
    if (!env.BLING_KV || !env.BLING_CLIENT_ID || !env.BLING_CLIENT_SECRET)
      return resp({ ok: false, erro: 'Worker sem configuração (BLING_KV, BLING_CLIENT_ID, BLING_CLIENT_SECRET).' }, 500);

    const url = new URL(req.url);
    try {
      if (url.pathname === '/status') {
        const t = await env.BLING_KV.get('tokens', 'json');
        const pixAtivo = !!(env.SICOOB_MTLS && env.SICOOB_CLIENT_ID && env.PIX_CHAVE);
        if (!t) return resp({ ok: true, conectado: false, pixAtivo });
        try {
          const emp = await bling(env, '/empresas/me/dados-basicos');
          return resp({ ok: true, conectado: true, pixAtivo, empresa: emp && emp.data && emp.data.nome });
        } catch (e) { return resp({ ok: true, conectado: false, pixAtivo, erro: String(e.message || e) }); }
      }
      if (url.pathname === '/oauth/inicio') {
        const state = 'wb' + crypto.randomUUID().replace(/-/g, '');
        await env.BLING_KV.put('state:' + state, '1', { expirationTtl: 900 });
        return resp({ ok: true, url: AUTH_URL + '?response_type=code&client_id=' + encodeURIComponent(env.BLING_CLIENT_ID) + '&state=' + state });
      }
      if (url.pathname === '/oauth/troca' && req.method === 'POST') {
        const b = await req.json();
        if (!b || !b.code || !b.state) return resp({ ok: false, erro: 'Faltou code/state' }, 400);
        const st = await env.BLING_KV.get('state:' + b.state);
        if (!st) return resp({ ok: false, erro: 'Autorização expirada ou não iniciada por este app. Comece de novo.' }, 400);
        await env.BLING_KV.delete('state:' + b.state);
        await trocarToken(env, 'grant_type=authorization_code&code=' + encodeURIComponent(b.code));
        await abertosVelho(env);
        const emp = await bling(env, '/empresas/me/dados-basicos');
        return resp({ ok: true, empresa: emp && emp.data && emp.data.nome });
      }
      if (url.pathname === '/abertos') {
        // Responde na hora com a última lista montada; se ela tiver mais de 1 min, monta outra por trás (o app busca de novo em seguida).
        let c = ABERTOS_MEM;
        if (!c) { c = await env.BLING_KV.get('cache:abertos', 'json'); if (c && c.itens) ABERTOS_MEM = c; }
        if (c && c.itens && !url.searchParams.get('forcar')) {
          const idade = Date.now() - Number(c.ts || 0);
          if (idade > 60000 && ctx) ctx.waitUntil(reconstruirAbertos(env).catch(() => {}));
          return resp(Object.assign({ ok: true, cache: true, idade, atualizando: idade > 60000 }, c));
        }
        return resp(Object.assign({ ok: true }, await reconstruirAbertos(env, true)));
      }
      if (url.pathname === '/pix' && req.method === 'POST') {
        const b = await req.json();
        return resp(await gerarPix(env, b || {}));
      }
      if (url.pathname === '/cobranca/extra' && req.method === 'POST') return resp(await cobrancaExtra(env, (await req.json().catch(() => ({}))) || {}));
      if (url.pathname === '/pagamentos') {
        let acoes = (await env.BLING_KV.get('acoes', 'json')) || [];
        if (acoes.some(x => x.acao === 'erro')) { acoes = acoes.filter(x => x.acao !== 'erro'); await env.BLING_KV.put('acoes', JSON.stringify(acoes)); }
        const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
        const ult = await env.BLING_KV.get('pix:ultimaVerificacao');
        return resp({ ok: true, modo, ultimaVerificacao: ult ? Number(ult) : 0, acoes: acoes.slice(-100).reverse() });
      }
      if (url.pathname === '/modo' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) || {};
        const modo = b.modo === 'real' ? 'real' : 'simulacao';
        await env.BLING_KV.put('modo', modo);
        await logAcao(env, { acao: 'modo', modo, detalhe: 'Baixa automática no Bling: ' + (modo === 'real' ? 'MODO REAL (executa no Bling)' : 'SIMULAÇÃO') + (b.usuario ? ' — por ' + String(b.usuario).slice(0, 60) : '') });
        return resp({ ok: true, modo });
      }
      if (url.pathname === '/pagamentos/executar' && req.method === 'POST') {
        // executa no Bling as ações que ficaram só anotadas na simulação (de um pedido/nota)
        const b = (await req.json().catch(() => ({}))) || {};
        const acoes = (await env.BLING_KV.get('acoes', 'json')) || [];
        const alvo = acoes.filter(a => a.tipo === b.tipo && String(a.id) === String(b.id) && ['baixa', 'contas_pedido'].includes(a.acao) && ((a.modo === 'simulacao' && (!a.executado || /^ERRO/.test(a.executado))) || (a.modo === 'real' && /^ERRO/.test(String(a.resultado || '')) && (!a.executado || /^ERRO/.test(a.executado)))));
        if (!alvo.length) return resp({ ok: false, erro: 'Nada pendente de executar para este ' + (b.tipo === 'nota' ? 'nota' : 'pedido') + '.' });
        const res = [];
        for (const a of alvo) {
          const reg = { tipo: a.tipo, id: a.id, numero: a.numero, cliente: a.cliente, txid: a.txid || '' };
          let r;
          try { r = a.acao === 'baixa' ? await executarBaixa(env, a.contaId, a.valorBaixa, a.data, reg) : await executarContasPedido(env, reg, a.valorBaixa, a.data); }
          catch (e) { r = 'ERRO: ' + String(e.message || e).slice(0, 200); }
          a.executado = r; res.push(r);
          await logAcao(env, { modo: 'real', acao: a.acao, tipo: a.tipo, id: a.id, numero: a.numero, cliente: a.cliente, valor: a.valor, detalhe: a.detalhe + ' (executado depois, a partir da simulação' + (b.usuario ? ' — ' + String(b.usuario).slice(0, 60) : '') + ')', resultado: r });
        }
        const lista = (await env.BLING_KV.get('acoes', 'json')) || [];
        for (const a of alvo) { const x = lista.find(y => y.quando === a.quando && y.acao === a.acao && y.contaId === a.contaId && String(y.id) === String(a.id)); if (x) x.executado = a.executado; }
        await env.BLING_KV.put('acoes', JSON.stringify(lista.slice(-300)));
        await abertosVelho(env);
        return resp({ ok: true, resultados: res });
      }
      if (url.pathname === '/diag/bling-escrita') {
        // testa a permissão de escrita com IDs que não existem (não altera nada): 403 = falta permissão; 404/400 = permissão ok
        const tok = await tokenValido(env), out = {};
        for (const [nome, cam] of [['baixar_conta', '/contas/receber/1/baixar'], ['lancar_contas_pedido', '/pedidos/vendas/1/lancar-contas'], ['situacao_pedido', '/pedidos/vendas/1/situacoes/9']]) {
          const r = await fetch(API + cam, { method: nome === 'situacao_pedido' ? 'PATCH' : 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' }, body: nome === 'baixar_conta' ? '{}' : undefined });
          out[nome] = { status: r.status, corpo: (await r.text()).slice(0, 220) };
        }
        return resp({ ok: true, testes: out });
      }
      if (url.pathname === '/pagamentos/verificar' && req.method === 'POST') {
        const r = await verificarPagamentos(env);
        let boletos = null;
        try { boletos = await verificarBoletos(env, true); } catch (e) { boletos = { erro: String(e.message || e) }; }
        return resp(Object.assign({ ok: true, boletos }, r));
      }
      if (url.pathname === '/pagamentos/retroativo' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const dias = Math.min(Math.max(Number(b.dias || 10), 1), 30);
        let tot = { novos: 0, vistos: 0, pendentes: 0 };
        for (let d = dias; d > 0; d -= 4) {
          const ini = Date.now() - d * 86400e3, fim = Math.min(Date.now(), ini + 4 * 86400e3);
          const r = await verificarPagamentos(env, { inicio: ini, fim, semMarcar: true });
          tot.novos += r.novos; tot.vistos += r.vistos; tot.pendentes += r.pendentes || 0;
        }
        return resp(Object.assign({ ok: true, dias }, tot));
      }
      if (url.pathname === '/boletos') return resp(await boletosPainel(env));
      if (url.pathname === '/boletos/verificar' && req.method === 'POST') return resp(Object.assign({ ok: true }, await verificarBoletos(env, true)));
      if (url.pathname === '/boletos/vincular' && req.method === 'POST') return resp(await boletosVincular(env, (await req.json()) || {}));
      if (url.pathname === '/boletos/ignorar' && req.method === 'POST') {
        const b = (await req.json()) || {};
        const x = await env.BLING_KV.get('bolpend:' + b.nossoNumero, 'json');
        if (x) { x.resolvido = 'ignorado'; x.por = String(b.usuario || '').slice(0, 60); await env.BLING_KV.put('bolpend:' + b.nossoNumero, JSON.stringify(x), { expirationTtl: 180 * 86400 }); }
        return resp({ ok: true });
      }
      if (url.pathname === '/boletos/simular' && req.method === 'POST') return resp(await simularIniciar(env, (await req.json().catch(() => ({}))) || {}));
      if (url.pathname === '/boletos/simular/passo' && req.method === 'POST') return resp(await simularPasso(env));
      if (url.pathname === '/boletos/simular') {
        const sim = await env.BLING_KV.get('bolsim:estado', 'json');
        return resp({ ok: true, sim: sim ? resumoSim(sim) : null, rel: sim ? ((await env.BLING_KV.get('bolsim:rel', 'json')) || []) : [] });
      }
      // Conciliação contas a Pagar: débitos do extrato Sicoob × Contas a Pagar do Bling (ver o fim do arquivo)
      if (url.pathname === '/pagar/conciliar') return resp(await pagarConciliar(env, url.searchParams.get('de'), url.searchParams.get('ate'), url.searchParams.get('mes')));
      if (url.pathname === '/pagar/baixar' && req.method === 'POST') return resp(await pagarBaixar(env, (await req.json().catch(() => ({}))) || {}));
      if (url.pathname === '/pagar/lancar' && req.method === 'POST') return resp(await pagarLancar(env, (await req.json().catch(() => ({}))) || {}));
      // Conciliação DDA (celular/tablet): DDA do dia × contas a pagar do Bling; pagar pelo Sicoob e baixar no Bling
      if (url.pathname === '/dda/painel') return resp(await ddaPainel(env, url.searchParams.get('dia')));
      if (url.pathname === '/dda/diag') return resp(await ddaDiag(env));
      if (url.pathname === '/dda/pagar' && req.method === 'POST') return resp(await ddaPagar(env, (await req.json().catch(() => ({}))) || {}));
      if (url.pathname === '/dda/pendente' && req.method === 'POST') return resp(await ddaPendenteResolver(env, (await req.json().catch(() => ({}))) || {}));
      if (url.pathname === '/pagar/auto' && req.method === 'POST') return resp(await pagarTaxasAuto(env, { forcar: true }));
      if (url.pathname === '/pagar/auto') return resp(Object.assign({ ok: true }, (await env.BLING_KV.get('pagar:auto', 'json')) || {}));
      if (url.pathname === '/pagar/marcar' && req.method === 'POST') return resp(await pagarMarcar(env, (await req.json().catch(() => ({}))) || {}));
      if (url.pathname === '/pagar/conta') return resp(await pagarContaPorId(env, url.searchParams.get('id')));
      if (url.pathname === '/uso') return resp(Object.assign({ ok: true }, (await env.BLING_KV.get('uso:estado', 'json')) || { semToken: !env.CF_API_TOKEN }));
      if (url.pathname === '/uso/verificar' && req.method === 'POST') return resp(Object.assign({ ok: true }, await verificarUso(env, true)));
      if (url.pathname === '/push/chave') return resp({ ok: true, chave: (await vapid(env)).pub });
      if (url.pathname === '/push/inscrever' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) || {};
        const sub = b.sub || {};
        if (!/^https:\/\//.test(String(sub.endpoint || ''))) return resp({ ok: false, erro: 'Inscrição inválida' }, 400);
        const subs = ((await env.BLING_KV.get('push:subs', 'json')) || []).filter(x => x.endpoint !== sub.endpoint);
        subs.push({ endpoint: sub.endpoint, usuario: String(b.usuario || '').slice(0, 60), aparelho: String(b.aparelho || '').slice(0, 80), desde: Date.now() });
        await env.BLING_KV.put('push:subs', JSON.stringify(subs.slice(-300)));
        return resp({ ok: true });
      }
      if (url.pathname === '/push/sair' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) || {};
        const subs = ((await env.BLING_KV.get('push:subs', 'json')) || []).filter(x => x.endpoint !== b.endpoint);
        await env.BLING_KV.put('push:subs', JSON.stringify(subs));
        return resp({ ok: true });
      }
      if (url.pathname === '/push/ultimos') {
        const fila = (await env.BLING_KV.get('push:fila', 'json')) || [];
        const u = String(url.searchParams.get('u') || '');
        const chat = u ? ((await env.BLING_KV.get('push:chat', 'json')) || []).filter(a => a.para === u && Date.now() - a.quando < 2 * 86400e3).slice(0, 5) : [];
        return resp({ ok: true, avisos: fila.filter(a => Date.now() - a.quando < 30 * 60e3).slice(0, 5), chat });
      }
      // Chat do app (aba T.I. › Chat): avisa no Chrome SÓ os navegadores do destinatário, mesmo com o app fechado
      if (url.pathname === '/push/chat' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) || {};
        const para = String(b.para || '').slice(0, 60);
        if (!para) return resp({ ok: false, erro: 'Sem destinatário' }, 400);
        const fila = (await env.BLING_KV.get('push:chat', 'json')) || [];
        fila.unshift({ id: 'c' + Date.now() + Math.floor(Math.random() * 1000), quando: Date.now(), para, de: String(b.de || '').slice(0, 60),
          nome: String(b.nome || b.de || '').slice(0, 60), conv: String(b.conv || '').slice(0, 130), txt: String(b.txt || '').slice(0, 200), av: b.av ? 1 : 0 });
        await env.BLING_KV.put('push:chat', JSON.stringify(fila.filter(a => Date.now() - a.quando < 2 * 86400e3).slice(0, 60)));
        const todos = (await env.BLING_KV.get('push:subs', 'json')) || [];
        const dele = todos.filter(x => x.usuario === para);
        if (!dele.length) return resp({ ok: true, enviados: 0, total: 0 });
        const r = await pushTocar(env, dele);
        const vivos = r.vivos.map(x => x.endpoint);
        await env.BLING_KV.put('push:subs', JSON.stringify(todos.filter(x => x.usuario !== para || vivos.indexOf(x.endpoint) >= 0).map(x => r.vivos.find(v => v.endpoint === x.endpoint) || x)));
        return resp({ ok: true, enviados: r.ok, total: dele.length });
      }
      if (url.pathname === '/push/inscritos') {
        const subs = (await env.BLING_KV.get('push:subs', 'json')) || [];
        return resp({ ok: true, inscritos: subs.map(x => ({ usuario: x.usuario, aparelho: x.aparelho, desde: x.desde, ultimoOk: x.ultimoOk || 0, ultimoErro: x.ultimoErro || 0 })) });
      }
      if (url.pathname === '/push/teste' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) || {};
        return resp(Object.assign({ ok: true }, await pushAvisar(env, { teste: true, numero: '', valor: 0, cliente: 'Teste de aviso enviado por ' + String(b.usuario || '?').slice(0, 40), forma: '' })));
      }
      if (url.pathname === '/erros') {
        return resp(Object.assign({ ok: true }, (await env.BLING_KV.get('erros', 'json')) || {}));
      }
      if (url.pathname === '/diag/sicoob') {
        const n = Math.min(Number(url.searchParams.get('n') || 5), 10), out = [];
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          try {
            const r = await pedirTokenSicoob(env);
            const tx = await r.text();
            out.push({ status: r.status, ms: Date.now() - t0, server: r.headers.get('server'), tipo: r.headers.get('content-type'), corpo: r.ok ? '(token ok)' : tx.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) });
          } catch (e) { out.push({ erro: String(e.message || e), ms: Date.now() - t0 }); }
          await new Promise(x => setTimeout(x, 1500));
        }
        return resp({ ok: true, testes: out });
      }
      if (url.pathname === '/econf/pendentes') {
        return resp(Object.assign({ ok: true }, await econfPendentes(env)));
      }
      if (url.pathname === '/econf/certificado' && req.method === 'POST') return resp(await econfGuardarCertificado(env, await req.json().catch(() => null)));
      if (url.pathname === '/econf/painel') return resp(Object.assign({ ok: true }, await econfPainel(env)));
      if (url.pathname === '/tef/alertas') {
        const l = (await env.BLING_KV.get('tef:alertas', 'json')) || [];
        // aviso de um pagamento cujo TEF já foi aceito depois: some sozinho
        let mud = false;
        for (const a of l) {
          if (a.visto || !a.e2e || a.e2e === 'geral') continue;
          const r = await env.BLING_KV.get('econf:' + a.e2e, 'json');
          if (r && r.ok) { a.visto = Date.now(); a.resolvido = r.ignorado ? 'marcado como teste' : 'aceito depois (' + (r.cStat || 'ok') + ')'; mud = true; }
        }
        if (mud) await env.BLING_KV.put('tef:alertas', JSON.stringify(l));
        return resp({ ok: true, alertas: l.slice(0, 60), naoVistos: l.filter(a => !a.visto).length });
      }
      if (url.pathname === '/tef/alertas/visto' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) || {};
        const l = (await env.BLING_KV.get('tef:alertas', 'json')) || [];
        l.forEach(a => { if (b.todos || (b.ids || []).includes(a.id)) { a.visto = Date.now(); a.por = String(b.usuario || '').slice(0, 60); } });
        await env.BLING_KV.put('tef:alertas', JSON.stringify(l));
        return resp({ ok: true });
      }
      if (url.pathname === '/econf/enviar' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) || {};
        return resp(await econfEnviar(env, { ambiente: b.ambiente, origem: 'manual (app)', usuario: String(b.usuario || '').slice(0, 60), maxChamadas: 25, maxEnvios: 15 }));
      }
      if (url.pathname === '/econf/auto' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) || {};
        await env.BLING_KV.put('econf:auto', b.ligado ? 'ligado' : 'desligado');
        await logAcao(env, { acao: 'econf', modo: 'real', detalhe: 'ECONF automático ' + (b.ligado ? 'LIGADO' : 'DESLIGADO') + (b.usuario ? ' por ' + String(b.usuario).slice(0, 60) : '') });
        return resp({ ok: true, auto: !!b.ligado });
      }
      if (url.pathname === '/econf/xml') {
        const k = url.searchParams.get('k') || '';
        if (!k.startsWith('econfxml:')) return resp({ ok: false, erro: 'Chave inválida' }, 400);
        return resp(Object.assign({ ok: true }, (await env.BLING_KV.get(k, 'json')) || { erro: 'Não encontrado' }));
      }
      if (url.pathname === '/econf/diag') {
        const out = {};
        for (const amb of ['teste', 'producao']) {
          try { const r = await env.SICOOB_MTLS.fetch(ECONF_URL[amb] + '?wsdl'); out[amb] = { status: r.status, inicio: (await r.text()).slice(0, 80) }; }
          catch (e) { out[amb] = { erro: String(e.message || e) }; }
        }
        try { const a1 = await econfCarregarA1(env); out.certificado = a1 ? { ok: true, validade: a1.validade } : { ok: false }; } catch (e) { out.certificado = { erro: String(e.message || e) }; }
        return resp({ ok: true, diag: out });
      }
      if (url.pathname === '/econf/ignorar' && req.method === 'POST') {
        // pagamento de teste (ou que não é venda): nunca informar à Sefaz
        const b = (await req.json().catch(() => ({}))) || {};
        const lista = [].concat(b.e2e || []).filter(Boolean);
        for (const e2e of lista) {
          const atual = await env.BLING_KV.get('econf:' + e2e, 'json');
          if (atual && atual.ok && !atual.ignorado) continue; // já informado de verdade: não mexe
          await env.BLING_KV.put('econf:' + e2e, JSON.stringify({ ok: true, ignorado: true, motivo: String(b.motivo || 'teste').slice(0, 120), por: String(b.usuario || '').slice(0, 60), quando: Date.now() }), { expirationTtl: 5 * 365 * 86400 });
        }
        await abertosVelho(env);
        await logAcao(env, { acao: 'econf', modo: 'real', tipo: b.tipo, id: b.id, numero: b.numero, detalhe: 'TEF: ' + lista.length + ' pagamento(s) marcado(s) para NÃO informar à Sefaz (' + String(b.motivo || 'teste') + ')' + (b.usuario ? ' — ' + String(b.usuario).slice(0, 60) : '') });
        return resp({ ok: true, ignorados: lista.length });
      }
      if (url.pathname === '/econf/registrar' && req.method === 'POST') {
        const b = await req.json();
        return resp(await econfRegistrar(env, b || {}));
      }
      if (url.pathname === '/docs/ocultar' && req.method === 'POST') {
        // tira um pedido/nota da lista (ex.: teste). Não apaga nada no Bling; dá para desfazer com {desfazer:true}
        const b = (await req.json().catch(() => ({}))) || {};
        if (!b.tipo || !b.id) return resp({ ok: false, erro: 'Faltou tipo/id' }, 400);
        const k = 'oculto:' + b.tipo + ':' + b.id;
        if (b.desfazer) await env.BLING_KV.delete(k); else await env.BLING_KV.put(k, JSON.stringify({ por: String(b.usuario || '').slice(0, 60), quando: Date.now(), motivo: String(b.motivo || 'teste').slice(0, 120) }));
        await abertosVelho(env);
        await logAcao(env, { acao: 'ocultar', tipo: b.tipo, id: b.id, numero: b.numero || '', detalhe: (b.desfazer ? 'Voltou para a lista' : 'Excluído da lista (' + String(b.motivo || 'teste') + ')') + (b.usuario ? ' — ' + String(b.usuario).slice(0, 60) : '') });
        return resp({ ok: true });
      }
      if (url.pathname === '/pendentes/recasar' && req.method === 'POST') {
        // tenta de novo casar os PIX sem vínculo (com as regras novas: contas já baixadas à mão, pedidos faturados)
        const ids = (await env.BLING_KV.get('pendentes', 'json')) || [];
        const ctx = {}; let casados = 0, abertos = 0; const lista = [];
        for (const e of ids.slice(-80)) {
          const x = await env.BLING_KV.get('pend:' + e, 'json');
          if (!x || x.resolvido || (await env.BLING_KV.get('pago:' + e))) continue;
          const p = { endToEndId: x.e2e, valor: x.valor, horario: x.horario, pagador: { nome: x.pagador } };
          let reg = null;
          const itens = await itensAbertos(env, ctx);
          const restante = it => Math.round((Number(it.aReceber || 0) - Number(it.pago || 0)) * 100) / 100;
          const alias = x.doc ? await env.BLING_KV.get('alias:' + x.doc) : null;
          const ok = itens.filter(it => { const d = String(it.doc || '').replace(/\D/g, ''); return d && (d === x.doc || d === alias) && (it.formas || []).some(f => f === 'pix' || f === 'credito') && Math.abs(restante(it) - x.valor) <= 0.01; });
          if (ok.length) { reg = regDeItem(ok[0]); await registrarPagamento(env, reg, p, 'direto'); abertos++; }
          else reg = await casarRecebida(env, p, ctx, x.doc).catch(() => null);
          if (!reg) continue;
          if (!ok.length) casados++;
          x.resolvido = 'vinculado'; x.vinculo = { tipo: reg.tipo, id: reg.id, numero: reg.numero }; x.por = 'automático (recasar)';
          await env.BLING_KV.put('pend:' + e, JSON.stringify(x), { expirationTtl: 180 * 86400 });
          lista.push((reg.tipo === 'nota' ? 'NF ' : 'Pedido ') + reg.numero + ' — R$ ' + Number(x.valor).toFixed(2) + ' — ' + x.pagador);
        }
        await abertosVelho(env);
        return resp({ ok: true, vinculadosJaBaixados: casados, vinculadosEmAberto: abertos, lista });
      }
      if (url.pathname === '/pendentes') {
        const ids = (await env.BLING_KV.get('pendentes', 'json')) || [];
        const out = [];
        for (const e of ids.slice(-60).reverse()) { const x = await env.BLING_KV.get('pend:' + e, 'json'); if (x && !x.resolvido) out.push(x); }
        return resp({ ok: true, pendentes: out });
      }
      if (url.pathname === '/conciliar' && req.method === 'POST') {
        const b = await req.json();
        return resp(await conciliarManual(env, b || {}));
      }
      if (url.pathname === '/ignorar' && req.method === 'POST') {
        const b = await req.json();
        const x = await env.BLING_KV.get('pend:' + b.e2e, 'json');
        if (x) { x.resolvido = 'ignorado'; x.por = String(b.usuario || '').slice(0, 60); await env.BLING_KV.put('pend:' + b.e2e, JSON.stringify(x), { expirationTtl: 180 * 86400 }); }
        return resp({ ok: true });
      }
      if (url.pathname === '/pedido-compra') {
        const numero = String(url.searchParams.get('numero') || '').replace(/\D/g, '');
        if (!numero) return resp({ ok: false, erro: 'Informe o número do pedido de compra' }, 400);
        return resp(await pedidoCompra(env, numero));
      }
      if (url.pathname === '/produtos-fornecedores') {
        const ids = String(url.searchParams.get('ids') || '').split(',').map(x => x.replace(/\D/g, '')).filter(Boolean).slice(0, 60);
        if (!ids.length) return resp({ ok: false, erro: 'Faltou ids' }, 400);
        const out = {};
        for (const id of ids) {
          const c = await env.BLING_KV.get('pf:' + id, 'json');
          if (c) { out[id] = c; continue; }
          try {
            const j = await bling(env, '/produtos/fornecedores?idProduto=' + id + '&limite=100');
            const l = ((j && j.data) || []).filter(x => x.fornecedor && x.fornecedor.id && (x.codigo || x.descricao))
              .map(x => ({ fornecedorId: x.fornecedor.id, codigo: x.codigo || '', descricao: x.descricao || '' }));
            out[id] = l;
            await env.BLING_KV.put('pf:' + id, JSON.stringify(l), { expirationTtl: 86400 });
          } catch (e) { out[id] = []; }
        }
        return resp({ ok: true, produtos: out });
      }
      if (url.pathname === '/pix/cancelar' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) || {};
        return resp(await cancelarPix(env, String(b.txid || '').replace(/[^A-Za-z0-9]/g, ''), String(b.usuario || '').slice(0, 60)));
      }
      if (url.pathname === '/pix/status') {
        const txid = (url.searchParams.get('txid') || '').replace(/[^A-Za-z0-9]/g, '');
        if (!txid) return resp({ ok: false, erro: 'Faltou txid' }, 400);
        const c = await sicoob(env, 'GET', '/cob/' + txid);
        return resp({ ok: true, status: c.status, pix: c.pix || [] });
      }
      return resp({ ok: false, erro: 'Rota inexistente' }, 404);
    } catch (e) {
      return resp({ ok: false, erro: String((e && e.message) || e) }, 500);
    }
  },
};

// ---------------- acesso ao Bling ----------------
async function trocarToken(env, corpo) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '1.0',
      'Authorization': 'Basic ' + btoa(env.BLING_CLIENT_ID + ':' + env.BLING_CLIENT_SECRET),
    },
    body: corpo,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Bling recusou o acesso: ' + ((j.error && (j.error.description || j.error.message)) || j.error_description || r.status));
  const t = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (Number(j.expires_in || 21600) - 120) * 1000 };
  await env.BLING_KV.put('tokens', JSON.stringify(t));
  return t;
}

async function tokenValido(env) {
  let t = await env.BLING_KV.get('tokens', 'json');
  if (!t) throw new Error('Bling não conectado. Peça ao administrador para conectar na aba BLING.');
  if (Date.now() < t.exp) return t.access;
  t = await trocarToken(env, 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(t.refresh));
  return t.access;
}

let ultimaChamada = 0;
async function bling(env, caminho, tentativa) {
  // o Bling aceita ~3 chamadas por segundo
  const espera = ultimaChamada + 360 - Date.now();
  if (espera > 0) await new Promise(r => setTimeout(r, espera));
  ultimaChamada = Date.now();
  const tok = await tokenValido(env);
  const r = await fetch(API + caminho, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
  if (r.status === 429 && (tentativa || 0) < 3) { await new Promise(x => setTimeout(x, 1200)); return bling(env, caminho, (tentativa || 0) + 1); }
  if (r.status === 401 && !tentativa) { // token derrubado: força renovar uma vez
    const t = await env.BLING_KV.get('tokens', 'json');
    if (t) { t.exp = 0; await env.BLING_KV.put('tokens', JSON.stringify(t)); }
    return bling(env, caminho, 1);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Bling ' + r.status + ': ' + ((j.error && (j.error.description || j.error.message)) || caminho));
  return j;
}

async function paginas(env, base, max) {
  const out = [];
  for (let p = 1; p <= (max || 20); p++) {
    const j = await bling(env, base + (base.includes('?') ? '&' : '?') + 'limite=100&pagina=' + p);
    const d = (j && j.data) || [];
    out.push(...d);
    if (d.length < 100) break;
  }
  return out;
}

function isoDia(d) { return d.toISOString().slice(0, 10); }
function diasAtras(n) { return isoDia(new Date(Date.now() - n * 864e5)); }

// formas de pagamento (id → {nome, codigo}), guardadas por 6 h
async function formas(env) {
  const c = await env.BLING_KV.get('cache:formas', 'json');
  if (c && Date.now() - c.ts < 6 * 3600e3) return c.mapa;
  const lista = await paginas(env, '/formas-pagamentos', 5);
  const mapa = {};
  lista.forEach(f => { mapa[f.id] = { nome: f.descricao || '', codigo: Number(f.tipoPagamento || f.codigoFiscal || 0) }; });
  await env.BLING_KV.put('cache:formas', JSON.stringify({ ts: Date.now(), mapa }));
  return mapa;
}

async function vendedores(env) {
  const c = await env.BLING_KV.get('cache:vendedores', 'json');
  if (c && Date.now() - c.ts < 12 * 3600e3) return c.mapa;
  const mapa = {};
  try {
    const lista = await paginas(env, '/vendedores', 3);
    lista.forEach(v => { mapa[v.id] = (v.contato && v.contato.nome) || ''; });
  } catch (e) {}
  await env.BLING_KV.put('cache:vendedores', JSON.stringify({ ts: Date.now(), mapa }));
  return mapa;
}

function tipoForma(f) {
  if (!f) return '';
  if (f.codigo === COD_PIX || /pix/i.test(f.nome)) return 'pix';
  if (f.codigo === COD_CREDITO || /cr[eé]dito|link/i.test(f.nome)) return 'credito';
  if (f.codigo === 15 || /boleto/i.test(f.nome)) return 'boleto';
  return '';
}

// ---- lista de pedidos/notas em aberto: guardada no KV e remontada por trás ----
// A lista fica na memória do servidor (sem custo); no KV só uma cópia a cada 10 min (o plano grátis tem 1.000 gravações/dia).
let ABERTOS_MEM = null, ABERTOS_KV_TS = 0, ABERTOS_TRAVA = 0;
async function abertosVelho(env) {
  if (ABERTOS_MEM) ABERTOS_MEM = Object.assign({}, ABERTOS_MEM, { ts: 0 });
}
async function reconstruirAbertos(env, forcado) {
  if (!forcado && Date.now() - ABERTOS_TRAVA < 90000) return null;   // já tem uma montagem rodando
  ABERTOS_TRAVA = Date.now();
  try {
    const dados = await listarAbertos(env);
    const out = { ts: Date.now(), itens: dados.itens, faltaram: dados.faltaram };
    ABERTOS_MEM = dados.faltaram ? Object.assign({}, out, { ts: Date.now() - 55000 }) : out;
    if (Date.now() - ABERTOS_KV_TS > 10 * 60e3) { ABERTOS_KV_TS = Date.now(); await env.BLING_KV.put('cache:abertos', JSON.stringify(ABERTOS_MEM), { expirationTtl: 3 * 86400 }); }
    return out;
  } finally { ABERTOS_TRAVA = 0; }
}
// roda várias leituras do KV ao mesmo tempo (de 20 em 20) em vez de uma por uma
async function emLotes(lista, fn, n) {
  const out = [];
  for (let i = 0; i < lista.length; i += (n || 20)) out.push(...await Promise.all(lista.slice(i, i + (n || 20)).map(fn)));
  return out;
}

async function listarAbertos(env) {
  const fp = await formas(env);
  const vend = await vendedores(env);
  const itens = [];

  // 1) Pedidos de venda em aberto (o detalhe traz as parcelas com a forma de pagamento)
  const pedidos = await paginas(env, '/pedidos/vendas?idsSituacoes[]=' + SIT_PEDIDO_ABERTO + '&dataInicial=' + diasAtras(DIAS_PEDIDOS) + '&dataFinal=' + isoDia(new Date()), 5);
  // plano grátis da Cloudflare: no máx. 50 chamadas externas por vez → detalhe dos pedidos fica guardado 20 min
  let novasBuscas = 0, faltaram = 0;
  const cachePed = await emLotes(pedidos, p => env.BLING_KV.get('ped:' + p.id, 'json'));   // lê todos os guardados de uma vez
  for (let ip = 0; ip < pedidos.length; ip++) {
    const p = pedidos[ip];
    let d = null;
    const ck = 'ped:' + p.id;
    const c = cachePed[ip];
    // guardado há menos de 20 min, ou há menos de 2 h com o mesmo total → não precisa buscar de novo no Bling
    if (c && (Date.now() - c.ts < 20 * 60e3 || (Date.now() - c.ts < 2 * 3600e3 && Math.abs(Number(c.d && c.d.total) - Number(p.total)) < 0.01))) d = c.d;
    else if (novasBuscas < 30) {
      novasBuscas++;
      try { d = (await bling(env, '/pedidos/vendas/' + p.id)).data; } catch (e) { d = null; }
      if (d) await env.BLING_KV.put(ck, JSON.stringify({ ts: Date.now(), d }), { expirationTtl: 3 * 3600 });
    } else faltaram++;
    if (!d) continue;
    const parc = (d.parcelas || []).map(x => ({ valor: Number(x.valor || 0), venc: x.dataVencimento, forma: fp[x.formaPagamento && x.formaPagamento.id], formaId: (x.formaPagamento && x.formaPagamento.id) || 0 }));
    const tipos = [...new Set(parc.map(x => tipoForma(x.forma)).filter(Boolean))];
    if (!tipos.length) continue;
    itens.push({
      tipo: 'pedido', id: d.id, numero: String(d.numero || ''), data: d.data, prevista: d.dataPrevista || '',
      cliente: (d.contato && d.contato.nome) || '', doc: (d.contato && d.contato.numeroDocumento) || '',
      total: Number(d.total || 0), aReceber: parc.filter(x => tipoForma(x.forma)).reduce((s, x) => s + x.valor, 0),
      formas: tipos, formaNome: parc.map(x => x.forma && x.forma.nome).filter(Boolean)[0] || '',
      vendedor: vend[d.vendedor && d.vendedor.id] || '', situacao: 'Em aberto', loja: (d.loja && d.loja.id) || 0,
      nf: (d.notaFiscal && d.notaFiscal.id) ? true : false,
      venc: parc.filter(x => tipoForma(x.forma)).map(x => x.venc).filter(Boolean).sort()[0] || '',
      contatoId: (d.contato && d.contato.id) || 0,
      // cada parcela é uma cobrança separada (ex.: PIX hoje + PIX daqui a 10 dias)
      parcelas: parc.filter(x => tipoForma(x.forma)).map(x => ({ valor: r2(x.valor), venc: x.venc || '', t: tipoForma(x.forma), forma: (x.forma && x.forma.nome) || '' })).sort((a, b) => String(a.venc).localeCompare(String(b.venc))),
    });
  }

  // 2) Notas fiscais com conta a receber em aberto por PIX/crédito
  const contas = await paginas(env, '/contas/receber?situacoes[]=1&tipoFiltroData=E&dataInicial=' + diasAtras(DIAS_CONTAS) + '&dataFinal=' + isoDia(new Date()), 10);
  const porNota = {};
  for (const c of contas) {
    const o = c.origem || {};
    if (o.tipoOrigem !== 'notafiscal' && o.tipoOrigem !== 'venda') continue;
    const f = fp[c.formaPagamento && c.formaPagamento.id] || { codigo: Number(c.formaPagamento && c.formaPagamento.codigoFiscal), nome: '' };
    const t = tipoForma(f);
    if (!t) continue;
    if (o.tipoOrigem === 'venda' && itens.some(x => x.tipo === 'pedido' && String(x.id) === String(o.id))) continue; // pedido em aberto já está na lista
    const k = (o.tipoOrigem === 'venda' ? 'p' : '') + o.id;
    if (!porNota[k]) porNota[k] = {
      tipo: o.tipoOrigem === 'venda' ? 'pedido' : 'nota', id: o.id, numero: String(o.numero || ''), data: o.dataEmissao || c.dataEmissao, prevista: '',
      cliente: (c.contato && c.contato.nome) || '', doc: (c.contato && c.contato.numeroDocumento) || '',
      total: Number(o.valor || 0), aReceber: 0, formas: [], formaNome: f.nome || '', vendedor: '', situacao: 'Em aberto',
      contas: [], link: o.url || '', contatoId: (c.contato && c.contato.id) || 0,
    };
    const n = porNota[k];
    n.aReceber += Number(c.valor || 0);
    if (!n.formas.includes(t)) n.formas.push(t);
    n.contas.push({ id: c.id, valor: Number(c.valor || 0), venc: c.vencimento, pixBling: c.linkQRCodePix || '', t, forma: f.nome || '', boleto: c.linkBoleto || '' });
  }
  Object.values(porNota).forEach(n => { n.contas.sort((a, b) => String(a.venc).localeCompare(String(b.venc))); n.venc = n.contas.map(c => c.venc).filter(Boolean).sort()[0] || ''; });
  itens.push(...Object.values(porNota));

  // 3) Pedidos/notas já pagos pelo app que saíram do "em aberto" do Bling (ex.: conta baixada) — continuam na lista como "pago"
  const ja = new Set(itens.map(it => it.tipo + ':' + it.id));
  let acoesLog = null, cur;
  do {
    const l = await env.BLING_KV.list({ prefix: 'pagosdoc:', cursor: cur });
    const chaves = l.keys.filter(k => { const [, t, i] = k.name.split(':'); return !ja.has(t + ':' + i); });
    const lidos = await emLotes(chaves, async k => [k, await env.BLING_KV.get('docmeta:' + k.name.split(':')[1] + ':' + k.name.split(':')[2], 'json'), await env.BLING_KV.get(k.name, 'json')]);
    for (const [k, m0, pg0] of lidos) {
      const [, tipo, id] = k.name.split(':');
      let m = m0;
      if (!m) {
        if (!acoesLog) acoesLog = (await env.BLING_KV.get('acoes', 'json')) || [];
        const a = acoesLog.slice().reverse().find(x => x.tipo === tipo && String(x.id) === String(id) && x.numero);
        const nf = tipo === 'nota' ? await env.BLING_KV.get('nfdados:' + id, 'json') : null;
        m = { numero: (a && a.numero) || (nf && nf.numero) || String(id), cliente: (a && a.cliente) || '', doc: '', total: nf ? Number(nf.valor || 0) : 0, aReceber: 0, data: (nf && nf.emissao) || '' };
      }
      const pg = pg0 || [];
      const pago = Math.round(pg.reduce((t, x) => t + Number(x.valor || 0), 0) * 100) / 100;
      const ultimo = pg.map(x => diaLocal(x.horario)).sort().pop() || '';
      if (ultimo && ultimo < diasAtras(DIAS_CONTAS)) continue;
      itens.push({ tipo, id: Number(id), numero: String(m.numero || id), data: m.data || ultimo, prevista: '', cliente: m.cliente || (pg[0] && pg[0].pagador) || '', doc: m.doc || '',
        total: Number(m.total || pago), aReceber: Math.max(Number(m.aReceber || 0), pago), formas: [...new Set(pg.map(x => x.boleto ? 'boleto' : 'pix'))], formaNome: pg.some(x => x.boleto) ? 'Boleto' : 'PIX', vendedor: '', situacao: 'Pago', fora: true });
    }
    cur = l.list_complete ? null : l.cursor;
  } while (cur);

  // linhas tiradas da lista à mão (ex.: pedidos de teste)
  const ocultos = await emLotes(itens, it => env.BLING_KV.get('oculto:' + it.tipo + ':' + it.id));
  for (let i = itens.length - 1; i >= 0; i--) if (ocultos[i]) itens.splice(i, 1);

  const ctxTef = { alertas: (await env.BLING_KV.get('tef:alertas', 'json')) || [] };
  await emLotes(itens, async it => {
    // PIX gerados pelo app que continuam valendo (não pagos, não cancelados, dentro das 24 h): o app mostra de novo ao reabrir
    const pd = (await env.BLING_KV.get('pixdoc:' + it.tipo + ':' + it.id, 'json')) || [];
    const vivos = [];
    for (const x of pd) {
      if (x.cancelado || Date.now() > Number(x.expira || (Number(x.criado || 0) + 86400e3))) continue;
      const reg = await env.BLING_KV.get('pix:' + x.txid, 'json');
      if (!reg || reg.status === 'PAGO' || reg.status === 'CANCELADA') continue;
      if (!reg.curto) { reg.curto = await linkCurto(env, x.txid, Number(reg.expira || (Number(reg.criado || 0) + 86400e3))); await env.BLING_KV.put('pix:' + x.txid, JSON.stringify(reg), { expirationTtl: 90 * 86400 }); }
      vivos.push({ txid: x.txid, curto: reg.curto, valor: reg.valor, criado: reg.criado, copia: reg.copia, usuario: reg.usuario || '', validoAte: Number(reg.expira || (Number(reg.criado || 0) + 86400e3)),
        parcela: (reg.parcela && reg.parcela.chave) || '', extra: !!reg.extraConta });
    }
    if (vivos.length) it.pixAtivos = vivos.sort((a, b) => b.criado - a.criado);
    const ex = await env.BLING_KV.get('extras:' + it.tipo + ':' + it.id, 'json');
    if (ex && ex.length) it.extras = ex;
    const pg = (await env.BLING_KV.get('pagosdoc:' + it.tipo + ':' + it.id, 'json')) || [];
    if (pg.length) { it.pago = Math.round(pg.reduce((s, x) => s + Number(x.valor || 0), 0) * 100) / 100; it.pagos = pg; }
    // TEF/ECONF (evento 110750): quantos PIX recebidos deste pedido/nota já foram informados à Sefaz
    const pix = pg.filter(x => x.e2e);
    if (pix.length && !ctxTef.alertas) ctxTef.alertas = (await env.BLING_KV.get('tef:alertas', 'json')) || [];
    if (pix.length) {
      const t = { total: pix.length, informados: 0, erros: 0, protocolos: [], ultimoErro: '' };
      for (const x of pix) {
        const r = await env.BLING_KV.get('econf:' + x.e2e, 'json');
        if (r && r.ignorado) { t.total--; t.ignorados = (t.ignorados || 0) + 1; }
        else if (r && r.ok) { t.informados++; if (r.nProt) t.protocolos.push(r.nProt); }
        else if (r && r.ambiente === 'producao') { t.erros++; t.ultimoErro = ((r.cStat || '') + ' ' + (r.xMotivo || '')).trim(); }
        else { const al = ctxTef.alertas.find(a => a.e2e === x.e2e); if (al) { t.erros++; t.ultimoErro = al.motivo; } }
      }
      it.tef = t;
    }
  });
  // baixas automáticas feitas no Bling (para o filtro "Baixa automática" / dia da baixa)
  const log = (await env.BLING_KV.get('acoes', 'json')) || [];
  const baixas = {};
  for (const a of log) {
    if (a.modo !== 'real' || !['baixa', 'contas_pedido'].includes(a.acao) || !/^ok/.test(String(a.resultado || ''))) continue;
    (baixas[a.tipo + ':' + a.id] = baixas[a.tipo + ':' + a.id] || []).push({ quando: a.quando, dia: new Date(a.quando - 3 * 3600e3).toISOString().slice(0, 10), valor: Number(a.valorBaixa || a.valor || 0), resultado: a.resultado });
  }
  for (const it of itens) if (baixas[it.tipo + ':' + it.id]) it.baixasAuto = baixas[it.tipo + ':' + it.id];
  itens.sort((a, b) => String(b.data).localeCompare(String(a.data)) || Number(b.numero) - Number(a.numero));
  return { itens, faltaram };
}

// ---------------- PIX pelo Sicoob (cobrança imediata) ----------------
const SICOOB_TOKEN = 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token';
const SICOOB_PIX = 'https://api.sicoob.com.br/pix/api/v2';

const ESCOPO_PIX = 'cob.write cob.read pix.read';
const ESCOPO_BOLETOS = 'boletos_consulta';

// O extrato (Conta Corrente) pode vir de um 2º app do portal Sicoob: variável SICOOB_CLIENT_ID_CCO (opcional)
function clientSicoob(env, escopo) { return (/^(cco_|pagamentos_)/.test(escopo || '') && env.SICOOB_CLIENT_ID_CCO) || env.SICOOB_CLIENT_ID; }
function pedirTokenSicoob(env, escopo) {
  return env.SICOOB_MTLS.fetch(SICOOB_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(clientSicoob(env, escopo)) + '&scope=' + encodeURIComponent(escopo || ESCOPO_PIX),
  });
}

function chaveTokenSicoob(env, escopo) {
  escopo = escopo || ESCOPO_PIX;
  return escopo === ESCOPO_PIX ? 'sicoob:token' : escopo === ESCOPO_BOLETOS ? 'sicoob:token:boletos' : 'sicoob:token:' + escopo.replace(/\W+/g, '_') + ':' + String(clientSicoob(env, escopo)).slice(0, 8); // troca de app = token novo
}
const TOK_MEM = {};   // tokens do Sicoob na memória do servidor (economiza gravações do KV)
async function sicoobToken(env, escopo) {
  escopo = escopo || ESCOPO_PIX;
  const chave = chaveTokenSicoob(env, escopo);
  const c = TOK_MEM[chave];
  if (c && Date.now() < c.exp) return c.access;
  let r, txt = '', j = {};
  for (let t = 0; t < 2; t++) {
    r = await pedirTokenSicoob(env, escopo);
    txt = await r.text();
    try { j = JSON.parse(txt); } catch (e) { j = {}; }
    if (r.ok && j.access_token) break;
    if (t === 0) await new Promise(x => setTimeout(x, 2500));
  }
  if (!r.ok || !j.access_token) {
    const info = 'status ' + r.status + ' · servidor ' + (r.headers.get('server') || '?') + ' · ' + (j.error_description || j.error || txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160));
    throw new Error('Sicoob recusou o acesso (' + r.status + '): ' + info);
  }
  TOK_MEM[chave] = { access: j.access_token, exp: Date.now() + (Number(j.expires_in || 300) - 30) * 1000 };
  return j.access_token;
}

async function sicoob(env, metodo, caminho, corpo) {
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) throw new Error('PIX do Sicoob ainda não ativado no Worker.');
  const tok = await sicoobToken(env);
  const r = await env.SICOOB_MTLS.fetch(SICOOB_PIX + caminho, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + tok, client_id: env.SICOOB_CLIENT_ID, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Sicoob ' + r.status + ': ' + (j.detail || j.title || j.mensagem || JSON.stringify(j).slice(0, 200)));
  return j;
}

function txidNovo(tipo, id) {
  // 26 a 35 caracteres [A-Za-z0-9]: MA + P/N + id do Bling + sufixo aleatório
  const base = 'MA' + (tipo === 'nota' ? 'N' : 'P') + String(id).replace(/\D/g, '');
  const rnd = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  return (base + 'X' + rnd).slice(0, 35);
}

// ---- dias úteis (fim de semana + feriados nacionais, inclusive Carnaval, Sexta-feira Santa e Corpus Christi) ----
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia, 12));
}
function feriado(iso) {
  const md = iso.slice(5);
  if (['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].includes(md)) return true;
  const p = pascoa(Number(iso.slice(0, 4))), rel = n => new Date(p.getTime() + n * 864e5).toISOString().slice(0, 10);
  return [rel(-48), rel(-47), rel(-2), rel(60)].includes(iso);   // Carnaval (seg e ter), Sexta-feira Santa, Corpus Christi
}
function diaUtil(iso) { const w = new Date(iso + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6 && !feriado(iso); }
function proxDiaUtil(iso) { let d = iso; do { d = new Date(new Date(d + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10); } while (!diaUtil(d)); return d; }
// validade do PIX: vencimento do pedido/NF + 1 dia útil, até 23:59 (Brasília). Vencido ou sem vencimento: hoje + 1 dia útil.
function validadePix(venc) {
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(venc || '')) && venc >= hoje ? venc : hoje;
  const dia = proxDiaUtil(base);
  return { dia, ms: Date.parse(dia + 'T23:59:59-03:00') };
}

// ---------------- Link curto + página de pagamento para o cliente ----------------
const CURTO_LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sem 0/O, 1/I para não confundir
async function linkCurto(env, txid, expiraMs) {
  for (let t = 0; t < 5; t++) {
    const b = crypto.getRandomValues(new Uint8Array(6));
    const cod = Array.from(b, x => CURTO_LETRAS[x % CURTO_LETRAS.length]).join('');
    if (await env.BLING_KV.get('pixcurto:' + cod)) continue;
    await env.BLING_KV.put('pixcurto:' + cod, txid, { expirationTtl: Math.max(7 * 86400, Math.ceil(((expiraMs || Date.now()) - Date.now()) / 1000) + 30 * 86400) });
    return cod;
  }
  return '';
}
const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brlH = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// só o necessário para o cliente pagar (sem dados internos)
async function pixPublico(env, cod) {
  const txid = await env.BLING_KV.get('pixcurto:' + String(cod).toUpperCase());
  const reg = txid ? await env.BLING_KV.get('pix:' + txid, 'json') : null;
  if (!reg) return { ok: false, status: 'NAO_ENCONTRADO' };
  let status = reg.status || 'ATIVA';
  const expira = Number(reg.expira || (Number(reg.criado || 0) + 86400e3));
  if (status === 'ATIVA' && env.SICOOB_MTLS) {
    try { const c = await sicoob(env, 'GET', '/cob/' + txid); if (c.status === 'CONCLUIDA') status = 'PAGO'; else if (c.status && c.status !== 'ATIVA') status = 'CANCELADA'; } catch (e) {}
  }
  if (status === 'ATIVA' && Date.now() > expira) status = 'VENCIDA';
  if (status === 'PAGO' || status === 'CONCLUIDA') status = 'PAGO';
  return { ok: true, status, tipo: reg.tipo, numero: reg.numero, valor: reg.valor, cliente: reg.cliente || '', expira, copia: status === 'ATIVA' ? reg.copia : '' };
}

async function paginaPix(env, cod) {
  const LOGO = 'https://rauldneto.github.io/mais-acessivel-app/logo.jpg';
  const css = '*{box-sizing:border-box}body{margin:0;background:#eef2f1;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#1c1c1e;-webkit-font-smoothing:antialiased}' +
    '.top{background:linear-gradient(135deg,#0a7d6b,#075e51);color:#fff;padding:16px 18px 64px}.tl{display:flex;align-items:center;gap:12px;max-width:460px;margin:0 auto}' +
    '.tl img{height:46px;background:#fff;border-radius:12px;padding:5px 9px}.tl b{font-size:17px;display:block}.tl small{opacity:.9;font-size:12.5px}' +
    '.seg{display:flex;align-items:center;justify-content:center;gap:6px;max-width:460px;margin:12px auto 0;font-size:12.5px;background:rgba(255,255,255,.14);border-radius:999px;padding:6px 12px}' +
    '.wrap{padding:0 14px}.card{background:#fff;margin:-46px auto 14px;max-width:460px;border-radius:22px;padding:22px 18px;box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center}' +
    '.ref{font-size:14px;color:#636366}.val{font-size:42px;font-weight:800;color:#0a7d6b;margin:4px 0 2px;letter-spacing:-.5px}.vld{display:inline-block;font-size:13px;color:#92400e;background:#fef3c7;border-radius:999px;padding:4px 12px;font-weight:600}' +
    '.cli{font-size:13px;color:#636366;margin-top:8px}' +
    '.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;border:0;border-radius:14px;background:#16a34a;color:#fff;font:inherit;font-size:17px;font-weight:800;padding:16px;margin-top:16px;cursor:pointer;text-decoration:none}' +
    '.btn.sec{background:#fff;color:#0a7d6b;border:2px solid #0a7d6b;margin-top:10px}.btn.ok{background:#0a7d6b;color:#fff}' +
    '.msg{font-size:13px;color:#15803d;margin-top:8px;min-height:18px}' +
    '.passos{text-align:left;background:#f7f9f8;border-radius:14px;padding:12px 14px;margin-top:14px;font-size:14px;line-height:1.6}.passos b{color:#0a7d6b}' +
    '.conf{max-width:460px;margin:0 auto 14px;background:#fff;border-radius:18px;padding:16px 18px;box-shadow:0 6px 18px rgba(0,0,0,.05)}' +
    '.conf h3{margin:0 0 10px;font-size:15px;display:flex;align-items:center;gap:8px}.ln{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid #f0f0f3;font-size:13.5px}.ln span{color:#636366}.ln b{text-align:right}' +
    '.alerta{margin-top:10px;font-size:12.5px;color:#475569;background:#f1f5f9;border-radius:12px;padding:10px 12px;line-height:1.5}' +
    '.qr{margin:14px auto 4px;width:190px;min-height:190px}.qr svg{width:190px;height:190px}.ou{font-size:12px;color:#8e8e93}' +
    'details{margin-top:12px;text-align:left}summary{cursor:pointer;color:#0a7d6b;font-weight:700;font-size:14px}.cod{width:100%;margin-top:8px;font-size:11px;font-family:monospace;border:1px solid #e5e5ea;border-radius:10px;padding:8px;height:70px;resize:none;color:#555}' +
    '.st{font-size:22px;font-weight:800;margin:12px 0 6px}.st.pago{color:#16a34a}.st.off{color:#b91c1c}.rod{font-size:12px;color:#8e8e93;text-align:center;padding:4px 20px 26px;line-height:1.6}';
  const html = (corpo, titulo, desc) => new Response('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escH(titulo) + '</title><meta property="og:title" content="' + escH(titulo) + '"><meta property="og:description" content="' + escH(desc) + '">' +
    '<meta property="og:image" content="' + LOGO + '"><meta name="robots" content="noindex"><meta name="theme-color" content="#0a7d6b"><style>' + css + '</style></head><body>' +
    '<div class="top"><div class="tl"><img src="' + LOGO + '" alt="Mais Acessível"><div><b>Mais Acessível</b><small>JDFER Comércio e Serviços Ltda</small></div></div>' +
    '<div class="seg">🔒 Pagamento seguro via PIX · Banco Sicoob</div></div><div class="wrap">' + corpo + '</div>' +
    '<div class="rod">Mais Acessível · Goiânia/GO<br>Nunca pedimos senha, código de verificação ou dados de cartão.</div></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
  const txid = await env.BLING_KV.get('pixcurto:' + String(cod).toUpperCase());
  const reg = txid ? await env.BLING_KV.get('pix:' + txid, 'json') : null;
  if (!reg) return html('<div class="card"><div class="st off">Link não encontrado</div><p>Este link de pagamento não existe ou já expirou. Fale com quem te atendeu para receber um novo.</p></div>', 'Pagamento PIX · Mais Acessível', 'Link não encontrado');
  let status = reg.status || 'ATIVA';
  const expira = Number(reg.expira || (Number(reg.criado || 0) + 86400e3));
  if (status === 'ATIVA' && env.SICOOB_MTLS) {   // confere na hora se já foi pago ou cancelado
    try { const c = await sicoob(env, 'GET', '/cob/' + txid); if (c.status === 'CONCLUIDA') status = 'PAGO'; else if (c.status && c.status !== 'ATIVA') status = 'CANCELADA'; } catch (e) {}
  }
  const ref = (reg.tipo === 'nota' ? 'Nota fiscal nº ' : 'Pedido nº ') + escH(reg.numero);
  const vd = new Date(expira - 3 * 3600e3).toISOString();
  const validade = vd.slice(8, 10) + '/' + vd.slice(5, 7) + '/' + vd.slice(0, 4) + ' às ' + vd.slice(11, 16);
  const titulo = 'Pagamento PIX · Mais Acessível · ' + (reg.tipo === 'nota' ? 'NF ' : 'Pedido ') + reg.numero;
  const topo = '<div class="ref">' + ref + '</div><div class="val">R$ ' + brlH(reg.valor) + '</div>';
  if (status === 'PAGO') return html('<div class="card">' + topo + '<div class="st pago">✅ Pagamento recebido</div><p>Obrigado! Já recebemos este pagamento. Não é preciso pagar de novo.</p></div>', titulo, 'Pagamento recebido');
  if (status === 'CANCELADA') return html('<div class="card">' + topo + '<div class="st off">PIX cancelado</div><p>Este PIX foi cancelado. Fale com quem te atendeu para receber um novo link.</p></div>', titulo, 'PIX cancelado');
  if (Date.now() > expira) return html('<div class="card">' + topo + '<div class="st off">PIX vencido</div><p>Este PIX venceu em ' + validade + '. Fale com quem te atendeu para receber um novo link.</p></div>', titulo, 'PIX vencido');
  const corpo = '<div class="card">' + topo + '<div class="vld">⏰ Válido até ' + validade + '</div>' + (reg.cliente ? '<div class="cli">' + escH(reg.cliente) + '</div>' : '') +
    '<button class="btn" id="banco">🏦 Pagar no app do meu banco</button>' +
    '<button class="btn sec" id="cp">📋 Copiar código PIX</button><div class="msg" id="msg"></div>' +
    '<div class="passos"><b>1.</b> Toque em <b>Pagar no app do meu banco</b> (ou copie o código)<br><b>2.</b> No app do banco, entre em <b>PIX › Pix Copia e Cola</b><br><b>3.</b> Cole o código, <b>confira o recebedor</b> abaixo e confirme</div>' +
    '<details><summary>Ver o código PIX</summary><textarea class="cod" id="cod" readonly>' + escH(reg.copia) + '</textarea></details>' +
    '<div class="qr" id="qr"></div><div class="ou">No computador? Leia o QR Code com a câmera do app do banco.</div></div>' +
    '<div class="conf"><h3>🛡️ Confira antes de pagar</h3>' +
    '<div class="ln"><span>Recebedor</span><b>JDFER COMÉRCIO E SERVIÇOS LTDA</b></div>' +
    '<div class="ln"><span>CNPJ</span><b>35.017.646/0001-66</b></div>' +
    '<div class="ln"><span>Banco</span><b>Sicoob</b></div>' +
    '<div class="ln"><span>Valor</span><b>R$ ' + brlH(reg.valor) + '</b></div>' +
    '<div class="ln"><span>Referente a</span><b>' + ref + '</b></div>' +
    '<div class="alerta">No app do seu banco, antes de confirmar, o recebedor deve aparecer como <b>JDFER COMÉRCIO E SERVIÇOS LTDA</b> e o valor deve ser <b>R$ ' + brlH(reg.valor) + '</b>. Se algo for diferente, não pague e fale com a gente.</div></div>' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script><script>' +
    'var c=document.getElementById("cod").value,m=document.getElementById("msg");' +
    'function copiar(fim){var ok=function(){fim&&fim(true);};try{navigator.clipboard.writeText(c).then(ok).catch(function(){var t=document.getElementById("cod");t.parentNode.open=true;t.select();try{document.execCommand("copy");ok();}catch(e){fim&&fim(false);}});}catch(e){fim&&fim(false);}}' +
    'document.getElementById("cp").onclick=function(){var b=this;copiar(function(ok){if(ok){b.textContent="✓ Código copiado";b.className="btn ok";m.textContent="Agora abra o app do seu banco › PIX › Pix Copia e Cola e cole o código.";}else{document.querySelector("details").open=true;m.textContent="Selecione o código abaixo e copie.";}});};' +
    'document.getElementById("banco").onclick=function(){copiar(function(){' +
      'if(navigator.share){navigator.share({text:c}).catch(function(){});m.textContent="Código copiado. Escolha o app do seu banco na lista ou abra o banco e use Pix Copia e Cola.";}' +
      'else{m.textContent="Código copiado. Abra o app do seu banco › PIX › Pix Copia e Cola e cole.";}});};' +
    'try{var q=qrcode(0,"M");q.addData(c);q.make();document.getElementById("qr").innerHTML=q.createSvgTag({cellSize:4,margin:1});}catch(e){}</script>';
  return html(corpo, titulo, 'R$ ' + brlH(reg.valor) + ' · válido até ' + validade + ' · Recebedor JDFER Comércio e Serviços Ltda');
}

async function gerarPix(env, b) {
  const valor = Math.round(Number(b.valor) * 100) / 100;
  if (!(valor > 0) || valor > 1e7) return { ok: false, erro: 'Valor inválido.' };
  if (!b.id || !b.tipo) return { ok: false, erro: 'Faltou o pedido/nota.' };
  if (!env.PIX_CHAVE) return { ok: false, erro: 'Chave PIX não configurada no Worker.' };
  const txid = txidNovo(b.tipo, b.id);
  const doc = String(b.doc || '').replace(/\D/g, '');
  const nome = String(b.cliente || '').slice(0, 200);
  const parcela = b.parcela && typeof b.parcela === 'object' ? { chave: String(b.parcela.chave || '').slice(0, 60), venc: soData(b.parcela.venc), valor: r2(b.parcela.valor), contaId: b.parcela.contaId || 0 } : null;
  // PIX de uma parcela: vale até o vencimento DELA + 1 dia útil
  const vencs = (parcela && parcela.venc ? [parcela.venc] : [b.venc].concat(Array.isArray(b.contas) ? b.contas.map(c => c && c.venc) : [])).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))).sort();
  const val = validadePix(vencs[0]);
  const corpo = {
    calendario: { expiracao: Math.max(3600, Math.floor((val.ms - Date.now()) / 1000)) },
    valor: { original: valor.toFixed(2) },
    chave: env.PIX_CHAVE,
    solicitacaoPagador: ((b.tipo === 'nota' ? 'NF ' : 'Pedido ') + String(b.numero || '') + (b.extraConta ? ' - cobrança extra' : parcela && b.nParcelas > 1 ? ' - parcela venc. ' + brData(parcela.venc) : '')).slice(0, 140),
    infoAdicionais: [{ nome: b.tipo === 'nota' ? 'Nota fiscal' : 'Pedido', valor: String(b.numero || '').slice(0, 50) }],
  };
  if (nome && (doc.length === 11 || doc.length === 14)) corpo.devedor = doc.length === 14 ? { cnpj: doc, nome } : { cpf: doc, nome };
  const c = await sicoob(env, 'PUT', '/cob/' + txid, corpo);
  let contas = Array.isArray(b.contas) ? b.contas.slice(0, 24).map(x => ({ id: x.id, valor: Number(x.valor || 0), venc: x.venc || '' })) : [];
  if (parcela && parcela.contaId) contas = contas.filter(x => String(x.id) === String(parcela.contaId));   // baixa só a conta desta parcela
  const reg = { txid, tipo: b.tipo, id: b.id, numero: b.numero || '', valor, cliente: nome, doc, usuario: String(b.usuario || '').slice(0, 60),
    total: Number(b.total || 0), aReceber: Number(b.aReceber || 0), contas, parcela, extraConta: b.extraConta || 0,
    criado: Date.now(), expira: val.ms, venc: vencs[0] || '', copia: c.brcode || '', status: c.status || 'ATIVA' };
  await env.BLING_KV.put('pix:' + txid, JSON.stringify(reg), { expirationTtl: 90 * 86400 });
  // lista por pedido/nota, para mostrar no app e conciliar pagamentos parciais
  const k = 'pixdoc:' + b.tipo + ':' + b.id;
  const lista = (await env.BLING_KV.get(k, 'json')) || [];
  lista.push({ txid, valor, criado: reg.criado, expira: val.ms, parcela: (parcela && parcela.chave) || '' });
  await env.BLING_KV.put(k, JSON.stringify(lista.slice(-20)), { expirationTtl: 90 * 86400 });
  await abertosVelho(env);
  reg.curto = await linkCurto(env, txid, val.ms);
  await env.BLING_KV.put('pix:' + txid, JSON.stringify(reg), { expirationTtl: 90 * 86400 });
  return { ok: true, txid, curto: reg.curto, copiaECola: c.brcode || '', validade: val.dia.slice(8, 10) + '/' + val.dia.slice(5, 7) + '/' + val.dia.slice(0, 4) + ' 23:59', expira: val.ms };
}

// ---- Cobrança extra: despesa nova depois do pedido/nota (ex.: já pagou e surgiu outro item/frete) ----
// Cria a conta a receber no Bling (para a baixa automática ter onde cair) e gera a cobrança:
//  pix    → conta com forma PIX na conta Sicoob + PIX do Sicoob (baixa sozinha quando pagar)
//  boleto → conta com forma "Boleto - Bling Conta" (a Bling Conta emite o boleto e dá a baixa sozinha quando pagar)
const FORMA_EXTRA = { pix: { forma: 3901857, portador: 14890739452 }, boleto: { forma: 11272919, portador: 14893994469 } };
const CAT_VENDAS = 14634451775;   // Vendas de mercadorias
async function cobrancaExtra(env, b) {
  const valor = r2(b.valor);
  if (!(valor > 0) || valor > 1e6) return { ok: false, erro: 'Informe o valor da cobrança.' };
  const f = FORMA_EXTRA[b.forma];
  if (!f) return { ok: false, erro: 'Escolha PIX ou boleto (link de cartão entra com a nova maquininha).' };
  if (!b.contatoId) return { ok: false, erro: 'Cliente sem cadastro no Bling (falta o contato).' };
  const hoje = hojeLocal();
  const venc = soData(b.venc) && soData(b.venc) >= hoje ? soData(b.venc) : (b.forma === 'boleto' ? somaDias(hoje, 3) : hoje);
  const ref = (b.tipo === 'nota' ? 'NF nº ' : 'pedido de venda nº ') + String(b.numero || '');
  const motivo = String(b.motivo || '').trim().slice(0, 200);
  const historico = 'Ref. ao ' + ref + ' | ' + (b.forma === 'pix' ? 'PIX' : 'BOLETO') + ' - cobrança extra' + (motivo ? ': ' + motivo : '') + ' (app Mais Acessível' + (b.usuario ? ', ' + String(b.usuario).slice(0, 40) : '') + ')';
  const tok = await tokenValido(env);
  const r = await fetch(API + '/contas/receber', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ vencimento: venc, valor, contato: { id: Number(b.contatoId) }, formaPagamento: { id: f.forma }, portador: { id: f.portador }, categoria: { id: CAT_VENDAS },
      dataEmissao: hoje, competencia: hoje, historico, numeroDocumento: String(b.numero || '').slice(0, 20) + '-EXTRA' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, erro: 'O Bling não criou a conta a receber: ' + ((j.error && (j.error.description || j.error.message || JSON.stringify(j.error.fields || ''))) || r.status) };
  const contaId = (j.data && j.data.id) || j.id;
  await logAcao(env, { acao: 'cobranca_extra', tipo: b.tipo, id: b.id, numero: b.numero, cliente: b.cliente, valor, contaId, forma: b.forma, por: b.usuario || '',
    detalhe: 'Cobrança extra de R$ ' + valor.toFixed(2) + ' (' + (b.forma === 'pix' ? 'PIX' : 'boleto Bling Conta') + ', venc. ' + brData(venc) + ') criada no Contas a Receber do Bling' + (motivo ? ' — ' + motivo : '') + (b.usuario ? ' por ' + b.usuario : '') + '.' });
  const extras = (await env.BLING_KV.get('extras:' + b.tipo + ':' + b.id, 'json')) || [];
  extras.push({ contaId, valor, venc, forma: b.forma, motivo, criado: Date.now(), por: b.usuario || '' });
  await env.BLING_KV.put('extras:' + b.tipo + ':' + b.id, JSON.stringify(extras.slice(-20)), { expirationTtl: 180 * 86400 });
  if (b.forma === 'pix') {
    const px = await gerarPix(env, { tipo: b.tipo, id: b.id, numero: b.numero, valor, venc, cliente: b.cliente, doc: b.doc, total: valor, aReceber: valor,
      contas: [{ id: contaId, valor, venc }], extraConta: contaId, parcela: { chave: 'x' + contaId, venc, valor, contaId }, usuario: b.usuario });
    return Object.assign({}, px, { contaId, venc });
  }
  // boleto: a Bling Conta emite sozinha; confere se o link do boleto já saiu
  let link = '';
  for (let i = 0; i < 3 && !link; i++) {
    await new Promise(x => setTimeout(x, 2000 * (i + 1)));
    const c = ((await bling(env, '/contas/receber/' + contaId).catch(() => null)) || {}).data || {};
    link = c.linkBoleto || '';
  }
  await abertosVelho(env);
  return { ok: true, contaId, venc, boleto: link, aviso: link ? '' : 'Conta criada no Bling com a forma Boleto - Bling Conta. O boleto ainda não apareceu: abra a conta no Bling e clique em emitir boleto.' };
}

// cancela a cobrança no Sicoob (o QR Code para de aceitar pagamento). Padrão do Banco Central: PATCH /cob/{txid} status REMOVIDA_PELO_USUARIO_RECEBEDOR
async function cancelarPix(env, txid, usuario) {
  if (!txid) return { ok: false, erro: 'Faltou o txid.' };
  const atual = await sicoob(env, 'GET', '/cob/' + txid);
  if (atual.status === 'CONCLUIDA') return { ok: false, pago: true, erro: 'Este PIX já foi pago — não dá para cancelar.' };
  if (atual.status !== 'ATIVA') return { ok: true, status: atual.status, jaEstava: true };
  const c = await sicoob(env, 'PATCH', '/cob/' + txid, { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' });
  const reg = await env.BLING_KV.get('pix:' + txid, 'json');
  if (reg) {
    reg.status = 'CANCELADA'; reg.canceladoEm = Date.now(); reg.canceladoPor = usuario;
    await env.BLING_KV.put('pix:' + txid, JSON.stringify(reg), { expirationTtl: 90 * 86400 });
    const k = 'pixdoc:' + reg.tipo + ':' + reg.id;
    const lista = ((await env.BLING_KV.get(k, 'json')) || []).map(x => x.txid === txid ? Object.assign({}, x, { cancelado: Date.now() }) : x);
    await env.BLING_KV.put(k, JSON.stringify(lista), { expirationTtl: 90 * 86400 });
    await logAcao(env, { acao: 'pix_cancelado', tipo: reg.tipo, id: reg.id, numero: reg.numero, cliente: reg.cliente, txid, valor: reg.valor,
      detalhe: 'PIX de R$ ' + Number(reg.valor || 0).toFixed(2) + ' cancelado' + (usuario ? ' por ' + usuario : '') + ' (QR Code não aceita mais pagamento).' });
  }
  await abertosVelho(env);
  return { ok: true, status: c.status || 'REMOVIDA_PELO_USUARIO_RECEBEDOR' };
}

// ---------------- Pagamentos: confere PIX recebidos e planeja/executa as ações no Bling ----------------
const PORTADOR_SICOOB = 14890739452;   // conta "Sicoob" no Bling

async function registrarErro(env, msg) {
  const e = (await env.BLING_KV.get('erros', 'json')) || { total: 0, seguidos: 0, ultimos: [] };
  if (!msg) { if (e.seguidos) { e.seguidos = 0; e.ultimoOk = Date.now(); await env.BLING_KV.put('erros', JSON.stringify(e)); } else if (!e.ultimoOk || Date.now() - e.ultimoOk > 3600e3) { e.ultimoOk = Date.now(); await env.BLING_KV.put('erros', JSON.stringify(e)); } return; }
  // mesmo erro repetido em menos de 30 min: não grava de novo (economiza gravações do KV)
  const ult = (e.ultimos || [])[0];
  if (ult && ult.msg === msg.slice(0, 300) && Date.now() - ult.quando < 30 * 60e3) return;
  e.total++; e.seguidos++; e.ultimo = Date.now();
  e.ultimos = [{ quando: Date.now(), msg: msg.slice(0, 300) }].concat(e.ultimos || []).slice(0, 40);
  await env.BLING_KV.put('erros', JSON.stringify(e));
}

async function logAcao(env, a) {
  const lista = (await env.BLING_KV.get('acoes', 'json')) || [];
  lista.push(Object.assign({ quando: Date.now() }, a));
  await env.BLING_KV.put('acoes', JSON.stringify(lista.slice(-300)));
  // pagamento confirmado → notificação no Chrome de todos os inscritos (mesmo com o app fechado)
  if (a.acao === 'pix_pago' || a.acao === 'boleto_pago') {
    const t = Date.parse(a.horario || '');
    if (isNaN(t) || Date.now() - t < 2 * 86400e3) {   // não avisa pagamento antigo achado em conferência retroativa
      try { await pushAvisar(env, { tipo: a.tipo, numero: a.numero || '', valor: Number(a.valor || 0), cliente: a.cliente || a.pagador || '', forma: a.acao === 'boleto_pago' ? 'boleto' : 'PIX' }); } catch (e) {}
    }
  }
}

// ---------------- Consumo do plano grátis do Cloudflare (aviso antes de acabar) ----------------
// Lê as estatísticas do dia (o limite zera às 21h de Brasília = 00h UTC) pela API do Cloudflare e avisa quando passar de 70% / 90%.
// Precisa do segredo CF_API_TOKEN (token com permissão "Account Analytics: Read"). Sem ele, não faz nada.
const CF_CONTA = 'b1227592690312fc1ee86c5994980366';
const USO_LIMITES = { requisicoes: { nome: 'Chamadas ao servidor', max: 100000 }, leituras: { nome: 'Leituras do KV', max: 100000 },
  gravacoes: { nome: 'Gravações do KV', max: 1000 }, exclusoes: { nome: 'Exclusões do KV', max: 1000 }, listagens: { nome: 'Listagens do KV', max: 1000 } };
async function verificarUso(env, agora) {
  if (!env.CF_API_TOKEN) return { semToken: true };
  if (!agora) {   // no máximo 1 vez por hora, sem gastar gravação (guarda no cache do Cloudflare)
    const cache = caches.default, chave = new Request('https://uso.interno/ultimo');
    if (await cache.match(chave)) return { pulou: true };
    await cache.put(chave, new Response('1', { headers: { 'Cache-Control': 'max-age=3300' } }));
  }
  const hoje = new Date().toISOString().slice(0, 10);
  const q = 'query($c:String!,$d:Date!){viewer{accounts(filter:{accountTag:$c}){' +
    'kv:kvOperationsAdaptiveGroups(limit:20,filter:{date:$d}){sum{requests}dimensions{actionType}}' +
    'w:workersInvocationsAdaptive(limit:100,filter:{date:$d}){sum{requests}}}}}';
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { c: CF_CONTA, d: hoje } }) });
  const j = await r.json().catch(() => ({}));
  const conta = j && j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0];
  if (!conta) { const e = { quando: Date.now(), erro: 'Não consegui ler o consumo: ' + JSON.stringify((j && j.errors) || j).slice(0, 200) }; await env.BLING_KV.put('uso:estado', JSON.stringify(e)); return e; }
  const kv = {}; (conta.kv || []).forEach(g => { kv[g.dimensions.actionType] = (kv[g.dimensions.actionType] || 0) + Number(g.sum.requests || 0); });
  const uso = { requisicoes: (conta.w || []).reduce((t, g) => t + Number(g.sum.requests || 0), 0), leituras: kv.read || 0, gravacoes: kv.write || 0, exclusoes: kv.delete || 0, listagens: kv.list || 0 };
  const itens = Object.keys(USO_LIMITES).map(k => ({ k, nome: USO_LIMITES[k].nome, usado: uso[k], max: USO_LIMITES[k].max, pct: Math.round(100 * uso[k] / USO_LIMITES[k].max) }));
  const pior = itens.reduce((a, b) => (b.pct > a.pct ? b : a), itens[0]);
  const nivel = pior.pct >= 90 ? 90 : pior.pct >= 70 ? 70 : 0;
  const ant = (await env.BLING_KV.get('uso:estado', 'json')) || {};
  const est = { quando: Date.now(), dia: hoje, itens, nivel, avisado: ant.dia === hoje ? (ant.avisado || 0) : 0 };
  if (nivel && nivel > est.avisado) {   // avisa uma vez por nível por dia (70% e 90%)
    est.avisado = nivel;
    const txt = pior.nome + ' em ' + pior.pct + '% do limite grátis de hoje (' + pior.usado + ' de ' + pior.max + '). Zera às 21h.';
    try { await pushAvisar(env, { uso: true, cliente: txt, numero: '', valor: 0, forma: '' }, String(env.USO_AVISAR || 'raul').toLowerCase().split(',').map(x => x.trim())); } catch (e) {}
    await logAcao(env, { acao: 'uso_alerta', modo: 'real', detalhe: '⚠️ Consumo do servidor: ' + txt });
  }
  // grava só quando muda de nível ou a cada ~3 h (para não gastar gravação à toa)
  if (agora || nivel !== ant.nivel || est.avisado !== ant.avisado || ant.dia !== hoje || Date.now() - Number(ant.quando || 0) > 3 * 3600e3) await env.BLING_KV.put('uso:estado', JSON.stringify(est));
  return est;
}

// ---------------- Notificação no navegador (Web Push, sem custo) ----------------
// O servidor cria sozinho o par de chaves VAPID (guardado no KV) e manda um "toque" vazio para cada navegador inscrito;
// o sw.js do app busca /push/ultimos e mostra a notificação. Navegador inscrito que sumiu (404/410) sai da lista.
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function vapid(env) {
  let v = await env.BLING_KV.get('push:vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await env.BLING_KV.put('push:vapid', JSON.stringify(v));
  }
  return v;
}
async function vapidJwt(env, aud) {
  const v = await vapid(env);
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const corpo = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://rauldneto.github.io' });
  const chave = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const ass = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chave, new TextEncoder().encode(corpo));
  return { jwt: corpo + '.' + b64u(ass), pub: v.pub };
}
async function pushTocar(env, subs) {
  const vivos = [], porAud = {};
  let ok = 0;
  for (const s of subs) {
    try {
      const aud = new URL(s.endpoint).origin;
      if (!porAud[aud]) porAud[aud] = await vapidJwt(env, aud);
      const r = await fetch(s.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', Authorization: 'vapid t=' + porAud[aud].jwt + ', k=' + porAud[aud].pub, 'Content-Length': '0' } });
      if (r.status === 404 || r.status === 410) continue;
      if (r.ok) { ok++; s.ultimoOk = Date.now(); } else s.ultimoErro = r.status;
      vivos.push(s);
    } catch (e) { vivos.push(s); }
  }
  return { ok, vivos };
}
async function pushAvisar(env, aviso, so) {
  const fila = (await env.BLING_KV.get('push:fila', 'json')) || [];
  fila.unshift(Object.assign({ id: 'p' + Date.now() + Math.floor(Math.random() * 1000), quando: Date.now() }, aviso));
  await env.BLING_KV.put('push:fila', JSON.stringify(fila.slice(0, 30)));
  const todos = (await env.BLING_KV.get('push:subs', 'json')) || [];
  const subs = so ? todos.filter(x => so.includes(String(x.usuario || '').toLowerCase())) : todos;   // so = lista de usuários (ex.: só o admin)
  if (!subs.length) return { ok: 0, total: 0 };
  const r = await pushTocar(env, subs);
  const vivosEp = new Set(r.vivos.map(x => x.endpoint));
  await env.BLING_KV.put('push:subs', JSON.stringify(todos.filter(x => !subs.includes(x) || vivosEp.has(x.endpoint))));
  return { ok: r.ok, total: subs.length };
}

function isoSemMs(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); }

async function verificarPagamentos(env, opt) {
  opt = opt || {};
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) return { novos: 0, aviso: 'PIX não ativado' };
  const agora = Date.now();
  const ult = Number((await env.BLING_KV.get('pix:ultimaVerificacao')) || (agora - 6 * 3600e3));
  const inicio = isoSemMs(opt.inicio || Math.max(ult - 15 * 60e3, agora - 4 * 86400e3));
  const fim = isoSemMs(opt.fim || agora);
  let pagina = 0, novos = 0, vistos = 0, pendentes = 0;
  const ctx = {};
  while (pagina < 10) {
    const j = await sicoob(env, 'GET', '/pix?inicio=' + encodeURIComponent(inicio) + '&fim=' + encodeURIComponent(fim) + '&paginacao.paginaAtual=' + pagina + '&paginacao.itensPorPagina=100');
    const lista = (j && j.pix) || [];
    for (const p of lista) {
      vistos++;
      if (!p.endToEndId) continue;
      if (await env.BLING_KV.get('pago:' + p.endToEndId)) continue;
      const reg = p.txid ? await env.BLING_KV.get('pix:' + p.txid, 'json') : null;
      if (reg) { await registrarPagamento(env, reg, p, 'app'); novos++; continue; }
      // PIX direto na chave (ou cobrança que não foi do app): tenta casar por CNPJ/CPF + valor
      if (await env.BLING_KV.get('visto:' + p.endToEndId)) continue;
      const r = await conciliarDireto(env, p, ctx);
      if (r === 'auto') novos++; else if (r === 'pendente') pendentes++;
    }
    const tp = j && j.parametros && j.parametros.paginacao && j.parametros.paginacao.quantidadeDePaginas;
    pagina++;
    if (!tp || pagina >= tp || lista.length < 100) break;
  }
  if (!opt.semMarcar && agora - ult > 3600e3) await env.BLING_KV.put('pix:ultimaVerificacao', String(agora));   // 1x por hora (a janela de busca cobre a diferença)
  if (novos) await abertosVelho(env);
  return { novos, vistos, pendentes, inicio, fim };
}

function docPagador(p) { const g = p.pagador || {}; return String(g.cnpj || g.cpf || '').replace(/\D/g, ''); }
function diaLocal(horario) { const t = Date.parse(horario || ''); return isNaN(t) ? new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10) : new Date(t - 3 * 3600e3).toISOString().slice(0, 10); }

async function registrarPagamento(env, reg, p, origem) {
  const valor = Number(p.valor || 0);
  await env.BLING_KV.put('pago:' + p.endToEndId, reg.txid || ('direto:' + reg.tipo + ':' + reg.id), { expirationTtl: 365 * 86400 });
  if (reg.txid) {
    reg.pagamentos = (reg.pagamentos || []).concat([{ e2e: p.endToEndId, valor, horario: p.horario }]);
    reg.status = 'PAGO';
    await env.BLING_KV.put('pix:' + reg.txid, JSON.stringify(reg), { expirationTtl: 180 * 86400 });
  }
  const kd = 'pagosdoc:' + reg.tipo + ':' + reg.id;
  // dados do pedido/nota guardados para a lista continuar mostrando o documento depois de baixado no Bling
  await env.BLING_KV.put('docmeta:' + reg.tipo + ':' + reg.id, JSON.stringify({ numero: reg.numero || '', cliente: reg.cliente || '', doc: reg.doc || '', total: Number(reg.total || 0), aReceber: Number(reg.aReceber || reg.total || 0), data: reg.data || '' }), { expirationTtl: 365 * 86400 });
  const pd = (await env.BLING_KV.get(kd, 'json')) || [];
  pd.push({ txid: reg.txid || '', e2e: p.endToEndId, valor, horario: p.horario, pagador: (p.pagador && p.pagador.nome) || '', pagadorDoc: docPagador(p), origem });
  await env.BLING_KV.put(kd, JSON.stringify(pd), { expirationTtl: 365 * 86400 });
  await planejarAcoes(env, reg, valor, p, pd, origem);
}

async function itensAbertos(env, ctx) {
  if (ctx.itens) return ctx.itens;
  const c = ABERTOS_MEM || await env.BLING_KV.get('cache:abertos', 'json');
  if (c && Date.now() - c.ts < 30 * 60e3) ctx.itens = c.itens;
  else { const d = await listarAbertos(env); ctx.itens = d.itens; if (!d.faltaram) ABERTOS_MEM = { ts: Date.now(), itens: d.itens, faltaram: 0 }; }
  return ctx.itens;
}

function regDeItem(it) {
  return { txid: '', tipo: it.tipo, id: it.id, numero: it.numero, cliente: it.cliente, data: it.data || '', doc: it.doc || '', total: it.total, aReceber: it.aReceber,
    contas: (it.contas || []).map(c => ({ id: c.id, valor: c.valor, venc: c.venc })) };
}

// PIX que caiu para uma conta que alguém JÁ baixou à mão no Bling: casa pelo CNPJ/CPF + valor exato com as contas recebidas
// (últimos 45 dias) para o pagamento ficar vinculado ao pedido/nota — e o TEF (ECONF) ser informado. Não baixa nada de novo.
async function casarRecebida(env, p, ctx, docForcado) {
  const valor = Math.round(Number(p.valor || 0) * 100) / 100;
  const doc = docForcado || docPagador(p);
  if (!doc) return null;
  const alias = await env.BLING_KV.get('alias:' + doc);
  if (!ctx.recebidas) ctx.recebidas = await paginas(env, '/contas/receber?situacoes[]=2&tipoFiltroData=E&dataInicial=' + diasAtras(60) + '&dataFinal=' + isoDia(new Date()), 5).catch(() => []);
  // mesmo CNPJ/CPF; se não achar, mesma empresa (raiz do CNPJ: matriz paga a conta da filial e vice-versa)
  const raiz = d => d.length === 14 ? d.slice(0, 8) : d;
  const filtra = (cmp) => ctx.recebidas.filter(c => {
    const d = String((c.contato && c.contato.numeroDocumento) || '').replace(/\D/g, '');
    const o = c.origem || {};
    return d && cmp(d) && Math.abs(Number(c.valor || 0) - valor) <= 0.01 && (o.tipoOrigem === 'notafiscal' || o.tipoOrigem === 'venda');
  });
  let cands = filtra(d => d === doc || d === alias);
  if (!cands.length && doc.length === 14) cands = filtra(d => d.length === 14 && raiz(d) === raiz(doc));
  const livres = [];
  for (const c of cands) if (!(await env.BLING_KV.get('contapix:' + c.id))) livres.push(c);
  if (livres.length !== 1) return null;   // nenhuma ou mais de uma possível: fica para vincular à mão
  const c = livres[0], o = c.origem;
  const reg = { txid: '', tipo: o.tipoOrigem === 'venda' ? 'pedido' : 'nota', id: o.id, numero: String(o.numero || ''), cliente: (c.contato && c.contato.nome) || '', doc,
    total: Number(o.valor || 0), aReceber: Number(c.valor || 0), data: o.dataEmissao || '', contas: [{ id: c.id, valor: Number(c.valor || 0), venc: c.vencimento }] };
  await env.BLING_KV.put('contapix:' + c.id, p.endToEndId, { expirationTtl: 400 * 86400 });
  await registrarPagamento(env, reg, p, 'direto-recebida');
  return reg;
}

async function conciliarDireto(env, p, ctx) {
  const valor = Math.round(Number(p.valor || 0) * 100) / 100;
  const doc = docPagador(p);
  const alias = doc ? await env.BLING_KV.get('alias:' + doc) : null;
  const itens = await itensAbertos(env, ctx);
  const restante = it => Math.round((Number(it.aReceber || 0) - Number(it.pago || 0)) * 100) / 100;
  const docOk = it => { const d = String(it.doc || '').replace(/\D/g, ''); return d && (d === doc || d === alias); };
  const aceitaPix = it => (it.formas || []).some(f => f === 'pix' || f === 'credito');
  const exatos = itens.filter(it => aceitaPix(it) && docOk(it) && Math.abs(restante(it) - valor) <= 0.01)
    .sort((a, b) => String(a.data).localeCompare(String(b.data)));
  await env.BLING_KV.put('visto:' + p.endToEndId, '1', { expirationTtl: 365 * 86400 });
  if (exatos.length) {
    // mesma empresa e mesmo valor: baixa automática, não importa a data combinada
    const it = exatos[0];
    await registrarPagamento(env, regDeItem(it), p, alias && String(it.doc || '').replace(/\D/g, '') === alias ? 'direto-apelido' : 'direto');
    it.pago = Number(it.pago || 0) + valor;
    return 'auto';
  }
  const jaBaixada = await casarRecebida(env, p, ctx).catch(() => null);
  if (jaBaixada) return 'auto';
  const sug = [];
  itens.forEach(it => {
    const r = restante(it);
    if (r <= 0.009) return;
    if (docOk(it) && valor < r) sug.push({ tipo: it.tipo, id: it.id, numero: it.numero, cliente: it.cliente, restante: r, data: it.data, motivo: 'Mesma empresa, valor menor (pagamento parcial?)' });
    else if (!docOk(it) && Math.abs(r - valor) <= 0.01) sug.push({ tipo: it.tipo, id: it.id, numero: it.numero, cliente: it.cliente, restante: r, data: it.data, motivo: 'Mesmo valor, pagador diferente' });
  });
  const pend = { e2e: p.endToEndId, valor, horario: p.horario, dia: diaLocal(p.horario), pagador: (p.pagador && p.pagador.nome) || p.nomePagador || '', doc,
    info: p.infoPagador || '', sugestoes: sug.slice(0, 6), criado: Date.now() };
  await env.BLING_KV.put('pend:' + p.endToEndId, JSON.stringify(pend), { expirationTtl: 180 * 86400 });
  const ids = (await env.BLING_KV.get('pendentes', 'json')) || [];
  if (!ids.includes(p.endToEndId)) { ids.push(p.endToEndId); await env.BLING_KV.put('pendentes', JSON.stringify(ids.slice(-300))); }
  return 'pendente';
}

async function conciliarManual(env, b) {
  const x = await env.BLING_KV.get('pend:' + b.e2e, 'json');
  if (!x) return { ok: false, erro: 'PIX não encontrado.' };
  if (x.resolvido) return { ok: false, erro: 'Este PIX já foi tratado.' };
  if (await env.BLING_KV.get('pago:' + b.e2e)) return { ok: false, erro: 'Este PIX já foi vinculado.' };
  const itens = await itensAbertos(env, {});
  const it = itens.find(i => i.tipo === b.tipo && String(i.id) === String(b.id));
  if (!it) return { ok: false, erro: 'Pedido/nota não está mais em aberto.' };
  const p = { endToEndId: x.e2e, valor: x.valor, horario: x.horario, pagador: { nome: x.pagador } };
  await registrarPagamento(env, regDeItem(it), p, 'manual');
  const dItem = String(it.doc || '').replace(/\D/g, '');
  if (x.doc && dItem && x.doc !== dItem && b.aprender !== false) {
    await env.BLING_KV.put('alias:' + x.doc, dItem);   // da próxima vez esse pagador já cai sozinho neste cliente
    await logAcao(env, { acao: 'apelido', tipo: it.tipo, numero: it.numero, cliente: it.cliente, detalhe: 'Aprendido: PIX de "' + x.pagador + '" passa a ser do cliente ' + it.cliente + '.' });
  }
  x.resolvido = 'vinculado'; x.vinculo = { tipo: it.tipo, id: it.id, numero: it.numero }; x.por = String(b.usuario || '').slice(0, 60);
  await env.BLING_KV.put('pend:' + b.e2e, JSON.stringify(x), { expirationTtl: 180 * 86400 });
  await abertosVelho(env);
  return { ok: true };
}

async function planejarAcoes(env, reg, valor, p, pagosDoc, origem) {
  const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
  const totalPago = Math.round(pagosDoc.reduce((s, x) => s + Number(x.valor || 0), 0) * 100) / 100;
  const base = { modo, tipo: reg.tipo, id: reg.id, numero: reg.numero, cliente: reg.cliente, txid: reg.txid, valor, horario: p.horario, pagador: (p.pagador && p.pagador.nome) || '' };
  const data = diaLocal(p.horario);
  const dataBr = data.split('-').reverse().join('/');
  const como = origem === 'direto' ? ' (PIX direto na chave — CNPJ e valor conferem)' : origem === 'direto-apelido' ? ' (PIX direto — pagador já conhecido deste cliente)' : origem === 'manual' ? ' (vinculado manualmente)' : '';
  await logAcao(env, Object.assign({}, base, { acao: 'pix_pago', detalhe: 'PIX de R$ ' + valor.toFixed(2) + ' recebido em ' + dataBr + (base.pagador ? ' de ' + base.pagador : '') + como + (reg.extraConta ? ' — cobrança extra' : '') }));
  if (reg.extraConta) {
    // cobrança extra: a conta a receber foi criada pelo app no Bling — baixa exatamente ela
    const acao = { acao: 'baixa', contaId: reg.extraConta, valorBaixa: valor, data, detalhe: 'Baixa de R$ ' + valor.toFixed(2) + ' na conta da cobrança extra (' + reg.extraConta + '), conta Sicoob' };
    if (modo === 'real') acao.resultado = await executarBaixa(env, reg.extraConta, valor, data, reg).catch(e => 'ERRO: ' + (e.message || e));
    await logAcao(env, Object.assign({}, base, acao));
    return;
  }
  if (reg.tipo === 'nota') {
    // reparte o valor pelas parcelas em aberto da nota, da mais antiga para a mais nova
    let resto = valor;
    const contas = (reg.contas || []).slice().sort((a, b) => String(a.venc).localeCompare(String(b.venc)));
    for (const c of contas) {
      if (resto <= 0.009) break;
      const v = Math.min(resto, c.valor);
      resto = Math.round((resto - v) * 100) / 100;
      const acao = { acao: 'baixa', contaId: c.id, valorBaixa: Math.round(v * 100) / 100, data,
        detalhe: 'Baixa de R$ ' + v.toFixed(2) + ' na parcela ' + (c.venc ? 'venc. ' + c.venc.split('-').reverse().join('/') : c.id) + ' (conta Sicoob)' + (v < c.valor - 0.009 ? ' — parcial' : '') };
      if (modo === 'real') acao.resultado = await executarBaixa(env, c.id, v, data, reg).catch(e => 'ERRO: ' + (e.message || e));
      await logAcao(env, Object.assign({}, base, acao));
    }
    if (resto > 0.009) await logAcao(env, Object.assign({}, base, { acao: 'sobra', detalhe: 'Sobrou R$ ' + resto.toFixed(2) + ' sem parcela em aberto para baixar — conferir.' }));
  } else {
    const alvo = reg.aReceber || reg.total || 0;
    const sit = alvo && totalPago >= alvo - 0.009 ? 'Pago' : 'Parcialmente pago';
    await logAcao(env, Object.assign({}, base, { acao: 'situacao', situacao: sit,
      detalhe: 'Pedido ' + reg.numero + ' → situação "' + sit + '" (pago R$ ' + totalPago.toFixed(2) + (alvo ? ' de R$ ' + alvo.toFixed(2) : '') + ').' }));
    const acao = { acao: 'contas_pedido', data, valorBaixa: valor,
      detalhe: 'Lançar as contas do pedido ' + reg.numero + ' e dar baixa de R$ ' + valor.toFixed(2) + ' com data ' + dataBr + ' (conta Sicoob). A nota emitida depois herda as contas do pedido já baixadas.' };
    if (modo === 'real') acao.resultado = await executarContasPedido(env, reg, valor, data).catch(e => 'ERRO: ' + (e.message || e));
    await logAcao(env, Object.assign({}, base, acao));
  }
}

async function executarBaixa(env, contaId, valor, data, reg) {
  // ativado só no modo "real", depois de conferido na simulação
  const tok = await tokenValido(env);
  // se alguém já baixou essa conta no Bling (à mão), não baixa de novo
  const atual = ((await bling(env, '/contas/receber/' + contaId).catch(() => null)) || {}).data;
  if (atual && ![1, 3].includes(Number(atual.situacao))) return 'já estava baixada no Bling (nada feito)';
  // campos do Bling (API v3, ContasBaixarContaDTO): valorRecebido = parte da conta que está sendo quitada;
  // juros, acréscimo (multa) e desconto vão separados — igual ao recebimento que a Bling Conta grava.
  // A tarifa do boleto NÃO entra aqui: já é lançada sozinha como "Tarifa bancária" a partir do extrato (não duplica).
  const cent = v => Math.round(Number(v || 0) * 100) / 100;
  const hist = reg.historico ? ((reg.historicoConta && atual && atual.historico ? String(atual.historico).trim() + ' - ' : '') + reg.historico)
    : ('PIX ' + (reg.txid || 'direto') + ' - app Mais Acessível');
  const corpo = { data, usarDataVencimento: false, portador: { id: PORTADOR_SICOOB }, historico: hist.slice(0, 1990), valorRecebido: cent(valor),
    juros: cent(reg.juros != null ? reg.juros : reg.juro), acrescimo: cent(reg.acrescimo), desconto: cent(reg.desconto), tarifa: 0 };
  const cat = atual && atual.categoria && atual.categoria.id;
  if (cat) corpo.categoria = { id: cat };
  const r = await fetch(API + '/contas/receber/' + contaId + '/baixar', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(corpo),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('Bling ' + r.status + ': ' + t.slice(0, 200));
  if (!reg.conferir) return 'ok';
  // confere como ficou no Bling
  await new Promise(x => setTimeout(x, 1200));
  const dep = ((await bling(env, '/contas/receber/' + contaId).catch(() => null)) || {}).data;
  const sit = dep ? Number(dep.situacao) : 0;
  return 'ok — ' + (sit === 2 ? 'conta Recebida no Bling' : sit === 3 ? 'conta PARCIALMENTE recebida no Bling (conferir)' : 'situação no Bling: ' + (SIT_CONTA[sit] || sit || '?'))
    + (corpo.juros ? ' · juros R$ ' + corpo.juros.toFixed(2) : '') + (corpo.acrescimo ? ' · multa R$ ' + corpo.acrescimo.toFixed(2) : '') + (corpo.desconto ? ' · desconto R$ ' + corpo.desconto.toFixed(2) : '');
}

async function executarContasPedido(env, reg, valor, data) {
  // modo "real". Regras para nunca duplicar conta no Bling:
  //  1) pedido já virou nota → baixa as contas em aberto DA NOTA (não lança nada no pedido);
  //  2) pedido sem nota e já com contas lançadas → só baixa;
  //  3) pedido sem nota e sem contas → lança as contas do pedido e baixa.
  const ped = (await bling(env, '/pedidos/vendas/' + reg.id)).data || {};
  const idContato = ped.contato && ped.contato.id;
  let nfId = ped.notaFiscal && ped.notaFiscal.id;
  if (nfId) { // nota rejeitada/cancelada e reemitida: usa a nota nova do mesmo cliente e valor
    const nf = await nfDados(env, nfId).catch(() => null);
    if (nf && ![5, 6, 7].includes(Number(nf.situacao))) { const sub = await nfSubstituta(env, reg.id, nf).catch(() => null); if (sub) nfId = sub; }
  }
  // as contas podem estar na nota OU no próprio pedido (quando foram lançadas no pedido antes de faturar)
  const origens = [String(reg.id)].concat(nfId ? [String(nfId)] : []);
  const daOrigem = async () => (await paginas(env, '/contas/receber?dataInicial=' + diasAtras(360) + '&dataFinal=' + isoDia(new Date()) + (idContato ? '&idContato=' + idContato : ''), 3))
    .filter(c => origens.includes(String(c.idOrigem || (c.origem && c.origem.id))));
  let contas = await daOrigem();
  let lancou = false;
  if (!contas.length && !nfId) {
    const tok = await tokenValido(env);
    const r = await fetch(API + '/pedidos/vendas/' + reg.id + '/lancar-contas', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
    if (!r.ok && r.status !== 400) throw new Error('Bling ' + r.status + ' ao lançar contas: ' + (await r.text()).slice(0, 160));
    lancou = r.ok;
    for (let i = 0; i < 4 && !contas.length; i++) { await new Promise(x => setTimeout(x, 1500 * (i + 1))); contas = await daOrigem(); }
    if (!contas.length && !r.ok) throw new Error('Bling não lançou as contas do pedido (' + r.status + '): ' + (await r.text().catch(() => '')).slice(0, 160));
  }
  if (!contas.length) throw new Error(nfId ? 'Nem a nota nem o pedido têm contas a receber no Bling.' : 'Contas do pedido não encontradas depois de lançar.');
  // só parcelas de PIX (o pedido pode ter parte em boleto: essas não são baixadas por um PIX)
  const ehPix = c => [17, 18, 20].includes(Number(c.formaPagamento && c.formaPagamento.codigoFiscal));
  if (contas.some(ehPix)) contas = contas.filter(ehPix);
  else if (contas.length > 1 || Math.abs(Number(contas[0].valor || 0) - valor) > 0.01) throw new Error('Nenhuma parcela em PIX ' + (nfId ? 'na nota' : 'no pedido') + ' para baixar este PIX — conferir à mão.');
  const abertas = contas.filter(c => [1, 3].includes(Number(c.situacao))).sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)));
  // PIX de uma parcela: baixa primeiro a conta com o mesmo vencimento e valor dessa parcela
  if (reg.parcela && reg.parcela.venc) {
    const i = abertas.findIndex(c => soData(c.vencimento) === reg.parcela.venc && Math.abs(Number(c.valor || 0) - reg.parcela.valor) < 0.01);
    if (i > 0) abertas.unshift(abertas.splice(i, 1)[0]);
  }
  if (!abertas.length) return 'já estava baixada no Bling (nada feito)';
  let resto = valor, feitas = 0;
  for (const c of abertas) {
    if (resto <= 0.009) break;
    const v = Math.min(resto, Number(c.valor || 0));
    await executarBaixa(env, c.id, v, data, reg);
    resto = Math.round((resto - v) * 100) / 100; feitas++;
  }
  return 'ok (' + (lancou ? 'contas lançadas no pedido; ' : nfId ? 'na nota do pedido; ' : '') + feitas + ' parcela(s) baixada(s))';
}

// ---------------- pedido de compra (aba Compras › Cotação compra) ----------------
// A API do Bling não filtra pedido de compra pelo número (e o filtro de data dela não é confiável):
// varre a lista inteira (poucas páginas) e guarda o mapa número → id no KV. Só varre de novo quando o número não está no mapa.
async function acharPedidoCompra(env, numero) {
  const mapa = (await env.BLING_KV.get('pc:mapa', 'json')) || {};
  if (mapa[numero]) return mapa[numero];
  const novo = {};
  for (let p = 1; p <= 80; p++) {
    const j = await bling(env, '/pedidos/compras?limite=100&pagina=' + p);
    const d = (j && j.data) || [];
    for (const o of d) if (o && o.numero != null) novo[String(o.numero)] = o.id;
    if (d.length < 100) break;
  }
  await env.BLING_KV.put('pc:mapa', JSON.stringify(novo), { expirationTtl: 30 * 86400 });
  return novo[numero] || null;
}

async function pedidoCompra(env, numero) {
  const id = await acharPedidoCompra(env, numero);
  if (!id) return { ok: false, erro: 'Pedido de compra nº ' + numero + ' não encontrado no Bling.' };
  const pc = ((await bling(env, '/pedidos/compras/' + id)) || {}).data || {};
  let forn = { id: pc.fornecedor && pc.fornecedor.id, nome: '', doc: '', uf: '' };
  if (forn.id) {
    try {
      const c = ((await bling(env, '/contatos/' + forn.id)) || {}).data || {};
      forn.nome = c.nome || c.fantasia || '';
      forn.doc = c.numeroDocumento || '';
      forn.uf = (c.endereco && c.endereco.geral && c.endereco.geral.uf) || '';
      // Frete compra (app): endereço de coleta e contato do fornecedor
      const eg = (c.endereco && c.endereco.geral) || {};
      forn.fantasia = c.fantasia || '';
      forn.cep = eg.cep || ''; forn.cidade = eg.municipio || ''; forn.bairro = eg.bairro || '';
      forn.endereco = [eg.endereco, eg.numero, eg.complemento].filter(Boolean).join(', ');
      forn.fone = c.telefone || ''; forn.celular = c.celular || '';
    } catch (e) { forn.nome = 'Fornecedor ' + forn.id; }
  }
  const formas = {};
  for (const pa of pc.parcelas || []) {
    const fid = pa.formaPagamento && pa.formaPagamento.id;
    if (fid && !(fid in formas)) {
      try { const f = ((await bling(env, '/formas-pagamentos/' + fid)) || {}).data || {}; formas[fid] = f.descricao || ''; }
      catch (e) { formas[fid] = ''; }
    }
  }
  const dia = s => s ? Math.round((new Date(s) - new Date(pc.data)) / 864e5) : null;
  const tr = pc.transporte || {}, tb = pc.tributacao || {}, ds = pc.desconto || {};
  return {
    ok: true,
    pedido: {
      id: pc.id, numero: pc.numero, data: pc.data, dataPrevista: pc.dataPrevista || '',
      fornecedor: forn,
      itens: (pc.itens || []).map(i => ({
        produtoId: i.produto && i.produto.id, codigo: (i.produto && i.produto.codigo) || '', descricao: i.descricao || '', codigoFornecedor: i.codigoFornecedor || '',
        unidade: i.unidade || '', quantidade: Number(i.quantidade || 0), valor: Number(i.valor || 0), aliquotaIPI: Number(i.aliquotaIPI || 0),
      })),
      totalProdutos: Number(pc.totalProdutos || 0), total: Number(pc.total || 0),
      desconto: ds.unidade === 'PERCENTUAL' ? Number(pc.totalProdutos || 0) * Number(ds.valor || 0) / 100 : Number(ds.valor || 0),
      frete: Number(tr.frete || 0), transportador: tr.transportador || '',
      // Frete compra (app): volumes, medidas e peso ficam nas observações internas
      observacoesInternas: pc.observacoesInternas || '', observacoes: pc.observacoes || '',
      pesoBruto: Number(tr.pesoBruto || 0), volumes: Number(tr.volumes || 0), fretePorConta: tr.fretePorConta == null ? null : tr.fretePorConta,
      totalIPI: Number(tb.totalIPI || 0), totalICMS: Number(tb.totalICMS || 0),
      parcelas: (pc.parcelas || []).map(pa => ({ vencimento: pa.dataVencimento, dias: dia(pa.dataVencimento), valor: Number(pa.valor || 0),
        forma: formas[pa.formaPagamento && pa.formaPagamento.id] || '' })),
    },
  };
}

// ---------------- ECONF (evento 110750): PIX vinculados a NF-e já emitidas ----------------
// O servidor só monta a lista e guarda os protocolos; a assinatura e o envio à SVRS são feitos
// pelo programa ENVIAR-ECONF no computador (certificado A1 instalado no Windows).
const CNPJ_SICOOB_IF = '02038232000164';   // Banco Cooperativo Sicoob S.A. (participante PIX)

async function nfDados(env, nfId) {
  const ck = 'nfdados:' + nfId;
  const c = await env.BLING_KV.get(ck, 'json');
  if (c && c.chave && Date.now() - c.ts < 7 * 86400e3 && (c.emissaoHora || c.emissao < hojeLocal())) return c;
  const d = (await bling(env, '/nfe/' + nfId)).data || {};
  const out = { ts: Date.now(), id: nfId, numero: String(d.numero || ''), chave: String(d.chaveAcesso || '').replace(/\D/g, ''), situacao: d.situacao, emissao: String(d.dataEmissao || '').slice(0, 10), emissaoHora: String(d.dataEmissao || ''),
    contatoId: (d.contato && d.contato.id) || null, valor: Number(d.valorNota || d.total || 0) };
  if (out.chave.length === 44) await env.BLING_KV.put(ck, JSON.stringify(out), { expirationTtl: 30 * 86400 });
  return out;
}

// Pedido cuja NF foi rejeitada/cancelada e reemitida: acha a NF autorizada do mesmo cliente emitida depois,
// com o mesmo valor do pedido (ou a única candidata). Guarda a escolha.
async function nfSubstituta(env, pedId, nfVelha) {
  const ck = 'pednfsubst:' + pedId;
  const c = await env.BLING_KV.get(ck);
  if (c) return c;
  let contatoId = nfVelha.contatoId;
  const nv = await nfDados(env, nfVelha.id).catch(() => null);
  if (nv && nv.contatoId) contatoId = nv.contatoId;
  if (!contatoId) return null;
  const ped = (await bling(env, '/pedidos/vendas/' + pedId)).data || {};
  const totalPed = Number(ped.total || 0);
  const desde = nfVelha.emissao || String(ped.data || '').slice(0, 10);
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const lista = await paginas(env, '/nfe?tipo=1&dataEmissaoInicial=' + encodeURIComponent(desde + ' 00:00:00') + '&dataEmissaoFinal=' + encodeURIComponent(hoje + ' 23:59:59'), 3);
  const cands = lista.filter(n => n.contato && String(n.contato.id) === String(contatoId) && [5, 6, 7].includes(Number(n.situacao)) && String(n.id) !== String(nfVelha.id));
  let escolha = null;
  for (const n of cands.slice(0, 6)) {
    const d = await nfDados(env, n.id);
    if (totalPed && Math.abs(Number(d.valor || 0) - totalPed) <= 0.05) { escolha = n.id; break; }
  }
  if (!escolha && cands.length === 1) escolha = cands[0].id;
  if (escolha) await env.BLING_KV.put(ck, String(escolha), { expirationTtl: 365 * 86400 });
  return escolha;
}

async function nfDoPedido(env, pedId) {
  const ck = 'pednf:' + pedId;
  const c = await env.BLING_KV.get(ck);
  if (c) return c;
  const d = (await bling(env, '/pedidos/vendas/' + pedId)).data || {};
  const nf = d.notaFiscal && d.notaFiscal.id;
  if (nf) await env.BLING_KV.put(ck, String(nf), { expirationTtl: 90 * 86400 });
  return nf || null;
}

async function econfPendentes(env, maxChamadas) {
  const LIM = maxChamadas || 35;
  const out = [];
  let cursor, chamadas = 0, faltaram = 0;
  do {
    const l = await env.BLING_KV.list({ prefix: 'pagosdoc:', cursor });
    for (const k of l.keys) {
      const [, tipo, id] = k.name.split(':');
      const lista = (await env.BLING_KV.get(k.name, 'json')) || [];
      for (const p of lista) {
        if (!p.e2e) continue;
        const reg = (await env.BLING_KV.get('econf:' + p.e2e, 'json')) || null;
        if (reg && reg.ok) continue;
        const dia = diaLocal(p.horario);
        if (dia < ECONF_DESDE) continue;   // TEF/ECONF só para pagamentos a partir do início da obrigação
        const item = { e2e: p.e2e, valor: Number(p.valor || 0), dia, horario: p.horario, pagador: p.pagador || '', tipo, docId: id, tPag: p.txid ? '17' : '20',
          ultimaTentativa: reg };
        try {
          let nfId = tipo === 'nota' ? id : null;
          if (tipo === 'pedido') { if (chamadas >= LIM) { faltaram++; continue; } chamadas++; nfId = await nfDoPedido(env, id); }
          if (!nfId) { item.status = 'aguardando_nf'; out.push(item); continue; }
          if (chamadas >= LIM) { faltaram++; continue; }
          const cache = await env.BLING_KV.get('nfdados:' + nfId); if (!cache) chamadas++;
          const nf = await nfDados(env, nfId);
          item.nf = nf;
          // Bling: 5 Autorizada, 6 Emitida DANFE, 7 Registrada. Outras (1 pendente, 2 cancelada, 4 rejeitada, 9 denegada...) não recebem ECONF
          const sitNF = Number(nf.situacao);
          const SIT_NOME = { 1: 'pendente', 2: 'cancelada', 3: 'aguardando recibo', 4: 'rejeitada', 8: 'aguardando protocolo', 9: 'denegada', 10: 'em consulta', 11: 'bloqueada' };
          if (nf.chave.length !== 44) item.status = 'nf_sem_chave';
          else if (![5, 6, 7].includes(sitNF) && tipo === 'pedido' && (item.subst = await nfSubstituta(env, id, nf))) {
            const nova = await nfDados(env, item.subst);
            item.nf = nova; item.obs = 'NF ' + nf.numero + ' não autorizada; usando a NF ' + nova.numero + ' emitida depois para o mesmo cliente';
            item.status = 'pronto';
            item.momento = nova.emissao && dia < nova.emissao ? 'anterior' : 'posterior';
            item.nSeq = Number((await env.BLING_KV.get('econfseq:' + nova.chave)) || 0) + 1;
          }
          else if (![5, 6, 7].includes(sitNF)) { item.status = 'nf_nao_autorizada'; item.erro = 'NF ' + nf.numero + ' está ' + (SIT_NOME[sitNF] || ('situação ' + sitNF)) + ' no Bling'; await env.BLING_KV.delete('nfdados:' + nfId); if (tipo === 'pedido') await env.BLING_KV.delete('pednf:' + id); }
          else item.status = 'pronto';
          if (item.status === 'pronto') {
            const nfx = item.nf, t = Date.parse(String(nfx.emissaoHora || '').replace(' ', 'T') + '-03:00');
            if (!isNaN(t) && Date.now() - t < 60 * 60e3) { item.status = 'aguardando_sefaz'; item.erro = 'NF ' + nfx.numero + ' emitida às ' + String(nfx.emissaoHora).slice(11, 16) + ' — espera 1 hora para a nota chegar no ambiente nacional da Sefaz'; }
          }
          if (item.status === 'pronto' && !item.subst) item.momento = nf.emissao && dia < nf.emissao ? 'anterior' : 'posterior';
          if (!item.subst) item.nSeq = Number((await env.BLING_KV.get('econfseq:' + nf.chave)) || 0) + 1;
        } catch (e) { item.status = 'erro'; item.erro = String(e.message || e); }
        out.push(item);
      }
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  out.sort((a, b) => String(a.dia).localeCompare(String(b.dia)));
  return { cnpj: '35017646000166', uf: 'GO', cnpjIF: CNPJ_SICOOB_IF, itens: out, faltaram };
}

async function econfRegistrar(env, b) {
  if (!b.e2e || !b.chave) return { ok: false, erro: 'Faltou e2e/chave' };
  const ant = await env.BLING_KV.get('econf:' + b.e2e, 'json');
  if (ant && ant.ignorado) return { ok: true, registrado: false, ignorado: true };
  const reg = { quando: Date.now(), chave: b.chave, nSeq: b.nSeq, ambiente: b.ambiente, cStat: String(b.cStat || ''), xMotivo: String(b.xMotivo || '').slice(0, 300), nProt: b.nProt || '' };
  // 135 = evento registrado e vinculado; 136 = registrado sem vínculo; 573 = duplicidade (já existe)
  reg.ok = b.ambiente === 'producao' && ['135', '136', '573'].includes(reg.cStat);
  await env.BLING_KV.put('econf:' + b.e2e, JSON.stringify(reg), { expirationTtl: 5 * 365 * 86400 });
  if (reg.ok) {
    const al = (await env.BLING_KV.get('tef:alertas', 'json')) || [];
    let mud = false; al.forEach(a => { if (a.e2e === b.e2e && !a.visto) { a.visto = Date.now(); a.resolvido = 'aceito depois (' + reg.cStat + ')'; mud = true; } });
    if (mud) await env.BLING_KV.put('tef:alertas', JSON.stringify(al));
  }
  if (b.ambiente === 'producao' && ['135', '136'].includes(reg.cStat)) await env.BLING_KV.put('econfseq:' + b.chave, String(b.nSeq || 1), { expirationTtl: 5 * 365 * 86400 });
  if (b.ambiente === 'producao') await logAcao(env, { acao: 'econf', modo: 'real', detalhe: 'ECONF da chave ' + b.chave.slice(25, 34) + ' (R$ ' + Number(b.valor || 0).toFixed(2) + '): ' + reg.cStat + ' ' + reg.xMotivo + (reg.nProt ? ' · protocolo ' + reg.nProt : '') });
  return { ok: true, registrado: reg.ok };
}

// ======================================================================================================
// ---------------- Boletos Sicoob liquidados → baixa no Contas a Receber do Bling ----------------
// Mesma conciliação dos PIX: o que entra na conta Sicoob vira baixa (valor cheio, data em que o dinheiro entrou)
// e a tarifa do boleto vira despesa separada em "Tarifa bancária".
//
// Fluxo da API de Cobrança Bancária v3 do Sicoob (1 dia por pedido):
//   POST /boletos/movimentacoes {numeroCliente, tipoMovimento:5 (liquidação), dataInicial=dataFinal}
//   GET  /boletos/movimentacoes?numeroCliente&codigoSolicitacao      → quando pronto, traz os ids dos arquivos
//   GET  /boletos/movimentacoes/download?numeroCliente&codigoSolicitacao&idArquivo → base64 (zip com JSON)
// Cada boleto liquidado é completado com GET /boletos?numeroCliente&codigoModalidade=1&nossoNumero=
// (vencimento, seuNumero e CPF/CNPJ do pagador) e casado com a conta a receber do Bling:
//   seuNumero (nº da NF ou id da conta) ou CPF/CNPJ do pagador  +  mesmo valor  +  mesmo vencimento → baixa sozinho
//   só uma pista bate                                                                                 → "Boletos sem vínculo"
//
// Rotas novas (aba Financeiro › Conciliação contas a Receber):
//   GET  /boletos                    → boletos já tratados (log), pendentes e situação da leitura diária
//   POST /boletos/verificar          → roda agora o passo diário (o mesmo do cron, a cada 30 min)
//   POST /boletos/vincular {nossoNumero, contaId, usuario} / POST /boletos/ignorar {nossoNumero, usuario}
//   POST /boletos/simular {de, ate}  → prepara a SIMULAÇÃO com boletos antigos (não mexe no Bling nem no log real)
//   POST /boletos/simular/passo      → avança a simulação um pedaço (o app chama em sequência)
//   GET  /boletos/simular            → andamento + relatório da simulação

const SICOOB_COB = 'https://api.sicoob.com.br/cobranca-bancaria/v3';
const SICOOB_NUM_CLIENTE = 2547538;
const BOL_POR_PASSO = 10;          // boletos tratados por chamada (limite de 50 chamadas externas do plano grátis)
const BOL_INTERVALO = 30 * 60e3;   // leitura diária pelo cron: a cada 30 min

async function sicoobCob(env, metodo, caminho, corpo) {
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) throw new Error('Sicoob ainda não ativado no Worker.');
  const tok = await sicoobToken(env, ESCOPO_BOLETOS);
  const r = await env.SICOOB_MTLS.fetch(SICOOB_COB + caminho, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + tok, client_id: env.SICOOB_CLIENT_ID, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (r.status === 204) return { _vazio: true };
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _texto: txt.slice(0, 300) }; }
  if (!r.ok) {
    const m = (j.mensagens && j.mensagens.map(x => x.mensagem).join('; ')) || j.message || j.mensagem || j.detail || j._texto || JSON.stringify(j).slice(0, 200);
    const e = new Error('Sicoob ' + r.status + ': ' + m); e.status = r.status; e.msg = String(m); throw e;
  }
  return j;
}

// ---- utilidades ----
const r2 = v => Math.round(Number(v || 0) * 100) / 100;
const dig = s => String(s == null ? '' : s).replace(/\D/g, '');
function brData(iso) { return iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : ''; }
function soData(v) {
  // aceita 2026-07-08, 2026-07-08T00:00:00-03:00, 08/07/2026
  const s = String(v || '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return m[3] + '-' + m[2] + '-' + m[1];
  return '';
}
function hojeLocal() { return new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); }
function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fimDeSemana(iso) { const w = new Date(iso + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; }
function acharCampo(o, nomes) { // procura um campo pelo nome em qualquer nível (respostas do Sicoob variam entre versões)
  if (!o || typeof o !== 'object') return undefined;
  for (const n of nomes) if (o[n] != null) return o[n];
  for (const k of Object.keys(o)) { const v = acharCampo(o[k], nomes); if (v != null) return v; }
  return undefined;
}
function acharLista(o) { // primeira lista de objetos que tenha nossoNumero/seuNumero
  if (Array.isArray(o)) {
    if (o.length && typeof o[0] === 'object' && o[0] && ('nossoNumero' in o[0] || 'seuNumero' in o[0])) return o;
    for (const x of o) { const l = acharLista(x); if (l) return l; }
    return o.length === 0 ? null : null;
  }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) { const l = acharLista(o[k]); if (l) return l; }
  return null;
}

// zip simples (central directory; aceita "stored" e "deflate") — o arquivo da movimentação vem zipado
async function deszipar(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || dv.getUint32(0, true) !== 0x04034b50) return [new TextDecoder().decode(bytes)];
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Zip da movimentação inválido.');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const saida = [];
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(p + 10, true), tamC = dv.getUint32(p + 20, true);
    const lNome = dv.getUint16(p + 28, true), lExtra = dv.getUint16(p + 30, true), lCom = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const nome = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + lNome));
    p += 46 + lNome + lExtra + lCom;
    if (nome.endsWith('/')) continue;
    const ini = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const dados = bytes.subarray(ini, ini + tamC);
    let plano;
    if (metodo === 0) plano = dados;
    else if (metodo === 8) plano = new Uint8Array(await new Response(new Blob([dados]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('Zip com compressão não suportada (' + metodo + ').');
    saida.push(new TextDecoder().decode(plano));
  }
  return saida;
}

// os nomes dos campos do arquivo de movimentação do Sicoob variam: procura por vários nomes (e um nível dentro de objetos)
function campoMov(x, nomes, re) {
  for (const n of nomes) if (x[n] != null && x[n] !== '') return x[n];
  const planos = [];
  for (const [k, v] of Object.entries(x)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) planos.push([k + '.' + k2, v2]);
    else planos.push([k, v]);
  }
  for (const n of nomes) { const a = planos.find(([k]) => k.toLowerCase().endsWith(n.toLowerCase())); if (a && a[1] != null && a[1] !== '') return a[1]; }
  if (re) { const a = planos.find(([k, v]) => re.test(k) && v != null && v !== '' && typeof v !== 'object'); if (a) return a[1]; }
  return '';
}
function normalizarLiquidacao(x) {
  const num = (nomes, re) => r2(Number(String(campoMov(x, nomes, re) || 0).replace(',', '.')) || 0);
  const valorTitulo = num(['valorTitulo', 'valorBoleto', 'valorNominal', 'valor']);
  const juros = r2(num(['valorMora', 'valorJurosMora']) + num(['valorJuros']));
  const multa = num(['valorMulta']), mora = r2(juros + multa);
  const desconto = r2(num(['valorDesconto']) + num(['valorAbatimento']));
  const tarifa = num(['valorTarifaMovimento', 'valorTarifa', 'valorTarifaBancaria'], /tarifa/i);
  const pago = r2(num(['valorPago', 'valorLiquidado', 'valorRecebido', 'valorLiquidacao']) || (valorTitulo + mora - desconto));
  const bruto = {};
  for (const [k, v] of Object.entries(x)) bruto[k] = v && typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v;
  return {
    nossoNumero: String(campoMov(x, ['nossoNumero', 'numeroNossoNumero', 'numeroTitulo', 'numeroTituloBanco', 'identificacaoBoletoBanco'], /nosso/i) || '').trim(),
    seuNumero: String(campoMov(x, ['seuNumero', 'numeroSeuNumero', 'numeroDocumento'], /seu/i) || '').trim(),
    dataLiquidacao: soData(campoMov(x, ['dataLiquidacao', 'dataPagamento', 'dataMovimento', 'dataMovimentacao'], /liquida|pagamento/i)),
    dataCredito: soData(campoMov(x, ['dataPrevisaoCredito', 'dataCredito', 'dataEfetivacaoCredito'], /credito/i)),
    dataVencimento: soData(campoMov(x, ['dataVencimento', 'dataVencimentoTitulo', 'vencimento'], /venc/i)), valorTitulo, juros, multa, mora, desconto, tarifa, pago, valorLiquido: num(['valorLiquido']),
    pagadorDoc: dig(campoMov(x, ['numeroCpfCnpjPagador', 'cpfCnpjPagador', 'numeroCpfCnpj', 'cpfCnpj'], /cpf|cnpj/i)),
    pagadorNome: String(campoMov(x, ['nomePagador', 'nome', 'nomeRazaoSocialPagador'], /nome/i) || '').trim(),
    bruto,
  };
}

// completa com os dados do boleto (vencimento, seuNumero, pagador). Guardado 1 ano.
async function completarBoleto(env, b) {
  if (!b.nossoNumero || /^S/.test(b.nossoNumero) || (b.dataVencimento && b.pagadorDoc && b.seuNumero)) return b;
  const ck = 'bolinfo:' + b.nossoNumero;
  let info = await env.BLING_KV.get(ck, 'json');
  if (!info) {
    try {
      const j = await sicoobCob(env, 'GET', '/boletos?numeroCliente=' + SICOOB_NUM_CLIENTE + '&codigoModalidade=1&nossoNumero=' + encodeURIComponent(b.nossoNumero));
      const bo = (j && j.resultado) || j || {};
      const pg = bo.pagador || {};
      info = { venc: soData(bo.dataVencimento), seu: String(bo.seuNumero || ''), doc: dig(pg.numeroCpfCnpj || pg.cpfCnpj), nome: String(pg.nome || ''),
        valor: r2(bo.valor || bo.valorTitulo), emissao: soData(bo.dataEmissao) };
      await env.BLING_KV.put(ck, JSON.stringify(info), { expirationTtl: 365 * 86400 });
    } catch (e) { info = { erro: String(e.message || e).slice(0, 160) }; }
  }
  return Object.assign({}, b, {
    dataVencimento: b.dataVencimento || info.venc || '', seuNumero: b.seuNumero || info.seu || '',
    pagadorDoc: b.pagadorDoc || info.doc || '', pagadorNome: b.pagadorNome || info.nome || '',
    valorTitulo: b.valorTitulo || info.valor || 0, infoErro: info.erro || '',
  });
}

// contas a receber do Bling com o mesmo vencimento do boleto (em aberto, parcial e — na simulação — recebidas)
async function contasPorVencimento(env, venc, ctx, incluirRecebidas) {
  const k = venc + (incluirRecebidas ? ':t' : ':a');
  ctx.venc = ctx.venc || {};
  if (ctx.venc[k]) return ctx.venc[k];
  const ck = 'bolcand:' + k;
  const c = await env.BLING_KV.get(ck, 'json');
  if (c && Date.now() - c.ts < (ctx.historico ? 6 * 3600e3 : 10 * 60e3)) return (ctx.venc[k] = c.l);
  const sits = '&situacoes[]=1&situacoes[]=3' + (incluirRecebidas ? '&situacoes[]=2' : '');
  const lista = await paginas(env, '/contas/receber?tipoFiltroData=V&dataInicial=' + venc + '&dataFinal=' + venc + sits, 3);
  const l = lista.map(x => ({ id: x.id, valor: r2(x.valor), venc: x.vencimento, situacao: Number(x.situacao),
    cliente: (x.contato && x.contato.nome) || '', doc: dig(x.contato && x.contato.numeroDocumento),
    origemTipo: (x.origem && x.origem.tipoOrigem) || '', origemId: (x.origem && x.origem.id) || 0, numero: String((x.origem && x.origem.numero) || ''),
    boleto: !!x.linkBoleto, forma: Number(x.formaPagamento && x.formaPagamento.codigoFiscal) || 0 }));
  await env.BLING_KV.put(ck, JSON.stringify({ ts: Date.now(), l }), { expirationTtl: 6 * 3600 });
  return (ctx.venc[k] = l);
}

const SIT_CONTA = { 1: 'Em aberto', 2: 'Recebido', 3: 'Parcialmente recebido', 4: 'Devolvido', 5: 'Cancelado' };

// decide a conta do Bling para um boleto liquidado
// contas a receber de uma janela larga de vencimentos (para achar pelo nº da NF quando o arquivo não traz o vencimento)
async function contasJanela(env, ctx, incluirRecebidas) {
  const k = incluirRecebidas ? 'janT' : 'janA';
  if (ctx[k]) return ctx[k];
  const ck = 'bolJanela:' + k, c = await env.BLING_KV.get(ck, 'json');
  if (c && Date.now() - c.ts < 30 * 60e3) return (ctx[k] = c.l);
  const hoje = hojeLocal();
  const sits = '&situacoes[]=1&situacoes[]=3' + (incluirRecebidas ? '&situacoes[]=2' : '');
  const lista = await paginas(env, '/contas/receber?tipoFiltroData=V&dataInicial=' + somaDias(hoje, -150) + '&dataFinal=' + somaDias(hoje, 90) + sits, 15);
  ctx[k] = lista.map(x => ({ id: x.id, valor: r2(x.valor), venc: x.vencimento, situacao: Number(x.situacao),
    cliente: (x.contato && x.contato.nome) || '', doc: dig(x.contato && x.contato.numeroDocumento),
    origemTipo: (x.origem && x.origem.tipoOrigem) || '', origemId: (x.origem && x.origem.id) || 0, numero: String((x.origem && x.origem.numero) || ''),
    boleto: !!x.linkBoleto, forma: Number(x.formaPagamento && x.formaPagamento.codigoFiscal) || 0 }));
  await env.BLING_KV.put(ck, JSON.stringify({ ts: Date.now(), l: ctx[k] }), { expirationTtl: 3600 });
  return ctx[k];
}
// seuNumero "003849/02" = NF 3849, parcela 2
async function casarPorNf(env, b, ctx, simulacao) {
  const m = String(b.seuNumero || '').match(/^\s*0*(\d{1,9})\s*[\/-]\s*0*(\d{1,3})\s*$/) || String(b.seuNumero || '').match(/^\s*0*(\d{1,9})\s*$/);
  if (!m) return null;
  const nf = String(Number(m[1])), parc = m[2] ? Number(m[2]) : 0;
  const todas = (await contasJanela(env, ctx, true)).filter(c => c.numero && String(Number(c.numero)) === nf);
  if (!todas.length) return { tipo: 'sem', motivo: 'Nenhuma conta a receber da NF ' + nf + ' no Bling (seu nº ' + b.seuNumero + ').', candidatos: [] };
  const ord = todas.slice().sort((a, c) => String(a.venc).localeCompare(String(c.venc)));
  const valorOk = c => Math.abs(c.valor - b.valorTitulo) <= 0.01;
  let c = parc && ord[parc - 1] && valorOk(ord[parc - 1]) ? ord[parc - 1] : null;
  if (!c) { const v = ord.filter(valorOk); if (v.length === 1) c = v[0]; }
  if (c) return { tipo: 'auto', conta: c, motivo: 'seuNumero ' + b.seuNumero + ' = NF ' + nf + (parc ? ' parcela ' + parc : '') + ' + mesmo valor', pontos: 2 };
  return { tipo: 'sem', motivo: 'NF ' + nf + ' encontrada, mas nenhuma parcela com o valor R$ ' + b.valorTitulo.toFixed(2) + '.',
    candidatos: ord.slice(0, 6).map(a => ({ contaId: a.id, numero: a.numero, origemTipo: a.origemTipo, cliente: a.cliente, valor: a.valor, situacao: a.situacao, motivo: 'mesma NF' })) };
}

async function casarBoleto(env, b, ctx, simulacao) {
  const vinculo = await env.BLING_KV.get('bolvinc:' + b.nossoNumero, 'json');
  if (!b.dataVencimento && !vinculo) {
    const pn = await casarPorNf(env, b, ctx, simulacao).catch(e => ({ tipo: 'sem', motivo: 'Erro ao procurar pela NF: ' + (e.message || e), candidatos: [] }));
    if (pn) return pn;
    return { tipo: 'sem', motivo: 'Sem vencimento do boleto (consulta ao Sicoob falhou' + (b.infoErro ? ': ' + b.infoErro : '') + ').', candidatos: [] };
  }
  const cands = b.dataVencimento ? await contasPorVencimento(env, b.dataVencimento, ctx, simulacao) : [];
  if (vinculo) {
    const c = cands.find(x => String(x.id) === String(vinculo.contaId)) || vinculo.conta;
    if (c) return { tipo: 'auto', conta: c, motivo: 'Vinculado manualmente por ' + (vinculo.por || '?'), pontos: 9 };
  }
  const tokens = (b.seuNumero.match(/\d+/g) || []).map(t => String(Number(t)));
  const avalia = c => {
    const valor = Math.abs(c.valor - b.valorTitulo) <= 0.01;
    const doc = !!(b.pagadorDoc && c.doc && b.pagadorDoc === c.doc);
    const seuConta = tokens.includes(String(c.id));
    const seuNf = !!(c.numero && tokens.length && tokens[0] === String(Number(c.numero)));
    return { c, valor, doc, seu: seuConta || seuNf, seuConta, seuNf };
  };
  const av = cands.map(avalia);
  const fortes = av.filter(a => a.valor && (a.doc || a.seu));
  // prefere quem bate tudo; depois quem tem boleto/forma boleto (código fiscal 15)
  fortes.sort((a, b2) => (Number(b2.doc) + Number(b2.seu) - Number(a.doc) - Number(a.seu)) || (Number(b2.c.forma === 15) - Number(a.c.forma === 15)));
  if (fortes.length === 1 || (fortes.length > 1 && (fortes[0].doc && fortes[0].seu) && !(fortes[1].doc && fortes[1].seu))) {
    const a = fortes[0];
    const m = [a.seu ? (a.seuConta ? 'seuNumero = id da conta' : 'seuNumero = nº da NF') : '', a.doc ? 'mesmo CPF/CNPJ' : '', 'mesmo valor e vencimento'].filter(Boolean).join(' + ');
    return { tipo: 'auto', conta: a.c, motivo: m, pontos: 1 + Number(a.doc) + Number(a.seu) };
  }
  if (!fortes.length) { const pn = await casarPorNf(env, b, ctx, simulacao).catch(() => null); if (pn && pn.tipo === 'auto') return pn; }
  const sug = av.filter(a => a.valor || a.doc || a.seu).slice(0, 6).map(a => ({
    contaId: a.c.id, numero: a.c.numero, origemTipo: a.c.origemTipo, cliente: a.c.cliente, valor: a.c.valor, situacao: a.c.situacao,
    motivo: [a.valor ? 'valor' : '', a.doc ? 'CPF/CNPJ' : '', a.seu ? 'seuNumero' : ''].filter(Boolean).join(' + ') + ' conferem' }));
  return { tipo: 'sem', motivo: fortes.length > 1 ? 'Mais de uma conta com o mesmo valor e pagador — escolha qual.' : (cands.length ? 'Nenhuma conta com o mesmo valor e pagador nesse vencimento.' : 'Nenhuma conta a receber no Bling com vencimento ' + brData(b.dataVencimento) + '.'), candidatos: sug };
}

// o que a automação faria/fará com um boleto casado
function planoBoleto(b, conta) {
  const data = b.dataCredito || b.dataLiquidacao;   // data em que o dinheiro entrou na conta
  const principal = r2(Math.min(r2(b.pago - b.mora + b.desconto), conta.valor));
  const parcial = principal < conta.valor - 0.009;
  // multa separada quando o Sicoob informa; senão tudo vai como juros
  const multa = r2(b.multa || 0), juros = r2(b.mora - multa);
  const venc = b.dataVencimento || conta.venc || '';
  const atraso = venc && b.dataLiquidacao > venc ? Math.round((Date.parse(b.dataLiquidacao) - Date.parse(venc)) / 864e5) : 0;
  const historico = 'Boleto Sicoob nº ' + b.nossoNumero + ' pago em ' + brData(b.dataLiquidacao) + (atraso ? ' com ' + atraso + (atraso === 1 ? ' dia' : ' dias') + ' de atraso (venc. ' + brData(venc) + ')' : '') +
    (b.mora ? ' - juros/multa R$ ' + b.mora.toFixed(2).replace('.', ',') : '') + (b.desconto ? ' - desconto R$ ' + b.desconto.toFixed(2).replace('.', ',') : '') + ' - total pago R$ ' + b.pago.toFixed(2).replace('.', ',') +
    (b.tarifa ? ' (tarifa R$ ' + b.tarifa.toFixed(2).replace('.', ',') + ' lançada à parte)' : '') + ' - baixa automática app Mais Acessível';
  const acoes = [{ acao: 'baixa', contaId: conta.id, data, valorBaixa: principal, juros, acrescimo: multa, desconto: b.desconto, atraso, historico,
    detalhe: (atraso ? 'PAGO COM ' + atraso + (atraso === 1 ? ' DIA' : ' DIAS') + ' DE ATRASO — ' : '') + 'Baixa de R$ ' + principal.toFixed(2) + (juros ? ' + juros R$ ' + juros.toFixed(2) : '') + (multa ? ' + multa R$ ' + multa.toFixed(2) : '') + (b.desconto ? ' − desconto R$ ' + b.desconto.toFixed(2) : '') +
      ' na conta ' + conta.id + (conta.numero ? ' (' + (conta.origemTipo === 'notafiscal' ? 'NF ' : 'pedido ') + conta.numero + ')' : '') + ', data ' + brData(data) + ', conta Sicoob' + (parcial ? ' — PARCIAL' : '') }];
  if (b.tarifa > 0) acoes.push({ acao: 'tarifa', data, valor: b.tarifa,
    detalhe: 'Tarifa R$ ' + b.tarifa.toFixed(2) + ' do boleto ' + b.nossoNumero + ': entra sozinha em "Tarifa bancária" (Contas a Pagar) pelo extrato Sicoob, às 13h/18h.' });
  return { data, principal, parcial, acoes };
}

// ---- leitura de um dia de movimentação (máquina de estados: solicitar → aguardar → baixar → tratar) ----
// job = {dia, cod, pedidoEm, tentativas, etapa, itens, idx, msg}
async function passoDia(env, job) {
  const nc = SICOOB_NUM_CLIENTE;
  if (job.etapa === 'novo') {
    try {
      const j = await sicoobCob(env, 'POST', '/boletos/movimentacoes', { numeroCliente: nc, tipoMovimento: 5, dataInicial: job.dia, dataFinal: job.dia });
      job.cod = acharCampo(j, ['codigoSolicitacao']);
      if (!job.cod) { job.etapa = 'vazio'; job.msg = 'Sicoob não devolveu código de solicitação.'; return job; }
      job.etapa = 'aguardando'; job.pedidoEm = Date.now(); job.tentativas = 0;
    } catch (e) {
      if (/nenhum|n[aã]o (foram )?encontrad|sem movimenta/i.test(e.msg || e.message)) { job.etapa = 'vazio'; job.msg = 'Sem liquidações neste dia.'; }
      // o Sicoob só aceita um pedido de movimentação por vez: espera e tenta de novo na próxima rodada
      else if (/solicita[cç][aã]o em processamento/i.test(e.msg || e.message)) { job.etapa = 'novo'; job.msg = 'Na fila: o Sicoob ainda está preparando outro dia.'; }
      else { job.etapa = 'erro'; job.msg = String(e.message || e).slice(0, 200); }
    }
    return job;
  }
  if (job.etapa === 'aguardando') {
    job.tentativas = (job.tentativas || 0) + 1;
    let j;
    try { j = await sicoobCob(env, 'GET', '/boletos/movimentacoes?numeroCliente=' + nc + '&codigoSolicitacao=' + encodeURIComponent(job.cod)); }
    catch (e) {
      if (/nenhum|n[aã]o (foram )?encontrad/i.test(e.msg || e.message) && e.status !== 500) { job.etapa = 'vazio'; job.msg = 'Sem liquidações neste dia.'; return job; }
      job.msg = 'Aguardando o Sicoob preparar o arquivo (' + String(e.msg || e.message).slice(0, 120) + ')';
      if (job.tentativas > 12) { job.etapa = 'erro'; }
      return job;
    }
    const qtd = acharCampo(j, ['quantidadeTotalRegistros', 'quantidadeRegistros']);
    let ids = acharCampo(j, ['idArquivos', 'idsArquivos', 'arquivos']);
    if (ids != null && !Array.isArray(ids)) ids = [ids];
    if (Number(qtd) === 0) { job.etapa = 'vazio'; job.msg = 'Sem liquidações neste dia.'; return job; }
    if (!ids || !ids.length) { job.msg = 'Aguardando o Sicoob preparar o arquivo.'; if (job.tentativas > 12) { job.etapa = 'erro'; job.msg = 'Sicoob não liberou o arquivo: ' + JSON.stringify(j).slice(0, 160); } return job; }
    job.arquivos = ids.map(x => (x && typeof x === 'object') ? (x.idArquivo || x.id) : x); job.etapa = 'baixar';
    return job;
  }
  if (job.etapa === 'baixar') {
    const itens = [];
    for (const id of job.arquivos) {
      const j = await sicoobCob(env, 'GET', '/boletos/movimentacoes/download?numeroCliente=' + nc + '&codigoSolicitacao=' + encodeURIComponent(job.cod) + '&idArquivo=' + encodeURIComponent(id));
      let b64 = acharCampo(j, ['arquivo', 'conteudo', 'arquivoBase64']);
      if (!b64 && typeof j._texto === 'string') b64 = j._texto;
      if (!b64) throw new Error('Download da movimentação sem arquivo: ' + JSON.stringify(j).slice(0, 160));
      let bytes;
      const s = String(b64).trim();
      if (s[0] === '{' || s[0] === '[') bytes = new TextEncoder().encode(s);
      else bytes = Uint8Array.from(atob(s.replace(/\s/g, '')), ch => ch.charCodeAt(0));
      for (const txt of await deszipar(bytes)) {
        let o; try { o = JSON.parse(txt); } catch (e) { continue; }
        const l = acharLista(o) || [];
        l.forEach(x => itens.push(normalizarLiquidacao(x)));
      }
    }
    job.itens = itens.filter(x => x.nossoNumero || x.seuNumero); job.idx = 0; job.etapa = job.itens.length ? 'tratar' : 'vazio';
    if (!job.itens.length) job.msg = 'Arquivo sem boletos liquidados.';
    return job;
  }
  return job;
}

// ---- simulação com boletos antigos (não grava nada no log real nem no Bling) ----
async function simularIniciar(env, b) {
  const de = soData(b.de) || '2026-07-01', ate = soData(b.ate) || '2026-08-31';
  if (ate < de) return { ok: false, erro: 'Período inválido.' };
  const dias = [];
  for (let d = de; d <= ate && dias.length < 200; d = somaDias(d, 1)) if (!fimDeSemana(d)) dias.push(d);
  const sim = { de, ate, dias, i: 0, job: null, iniciado: Date.now(), por: String(b.usuario || '').slice(0, 60), fim: false, resumo: { boletos: 0, auto: 0, sem: 0, jaRecebidas: 0, valor: 0, tarifas: 0, erros: 0 } };
  await env.BLING_KV.put('bolsim:estado', JSON.stringify(sim));
  await env.BLING_KV.put('bolsim:rel', '[]');
  return { ok: true, dias: dias.length };
}

async function simularPasso(env) {
  const sim = await env.BLING_KV.get('bolsim:estado', 'json');
  if (!sim) return { ok: false, erro: 'Nenhuma simulação iniciada.' };
  if (sim.fim) return { ok: true, fim: true, sim };
  const rel = (await env.BLING_KV.get('bolsim:rel', 'json')) || [];
  const ctx = { historico: true };
  if (!sim.job) sim.job = { dia: sim.dias[sim.i], etapa: 'novo' };
  const job = sim.job;
  if (job.etapa === 'aguardando' && job.pedidoEm && Date.now() - (job.ultimaConsulta || 0) < 4000) {
    return { ok: true, esperar: 4, sim: resumoSim(sim) };
  }
  if (job.etapa === 'tratar') {
    const fatia = job.itens.slice(job.idx, job.idx + BOL_POR_PASSO);
    for (const x0 of fatia) {
      const x = await completarBoleto(env, x0);
      const m = await casarBoleto(env, x, ctx, true);
      const linha = { dia: job.dia, nossoNumero: x.nossoNumero, seuNumero: x.seuNumero, pagador: x.pagadorNome, doc: x.pagadorDoc,
        vencimento: x.dataVencimento, liquidacao: x.dataLiquidacao, credito: x.dataCredito, valorTitulo: x.valorTitulo, mora: x.mora, desconto: x.desconto,
        pago: x.pago, tarifa: x.tarifa, liquido: x.valorLiquido, tipo: m.tipo, motivo: m.motivo, bruto: x.bruto };
      sim.resumo.boletos++; sim.resumo.valor = r2(sim.resumo.valor + x.pago); sim.resumo.tarifas = r2(sim.resumo.tarifas + x.tarifa);
      if (m.tipo === 'auto' && m.conta.boleto) { linha.tipo = 'bling'; linha.motivo = 'Conta de boleto da Bling Conta (NF ' + m.conta.numero + ') — a Bling dá a baixa sozinha, o app não mexe.'; linha.contaId = m.conta.id; sim.resumo.blingConta = (sim.resumo.blingConta || 0) + 1; }
      else if (m.tipo === 'auto') {
        const pl = planoBoleto(x, m.conta);
        Object.assign(linha, { contaId: m.conta.id, nf: m.conta.numero, origemTipo: m.conta.origemTipo, cliente: m.conta.cliente, valorConta: m.conta.valor,
          situacaoBling: SIT_CONTA[m.conta.situacao] || m.conta.situacao, dataBaixa: pl.data, valorBaixa: pl.principal, parcial: pl.parcial, acoes: pl.acoes.map(a => a.detalhe) });
        sim.resumo.auto++; if (m.conta.situacao === 2) sim.resumo.jaRecebidas++;
      } else { linha.sugestoes = m.candidatos; sim.resumo.sem++; }
      rel.push(linha);
    }
    job.idx += fatia.length;
    if (job.idx >= job.itens.length) { job.etapa = 'feito'; job.itens = []; }
  } else {
    try { await passoDia(env, job); } catch (e) { job.etapa = 'erro'; job.msg = String(e.message || e).slice(0, 200); }
    job.ultimaConsulta = Date.now();
  }
  if (job.etapa === 'erro') { sim.resumo.erros++; rel.push({ dia: job.dia, tipo: 'erro', motivo: job.msg }); }
  if (['feito', 'vazio', 'erro'].includes(job.etapa)) {
    sim.i++; sim.job = null;
    if (sim.i >= sim.dias.length) { sim.fim = true; sim.terminado = Date.now(); }
  }
  await env.BLING_KV.put('bolsim:estado', JSON.stringify(sim));
  await env.BLING_KV.put('bolsim:rel', JSON.stringify(rel));
  return { ok: true, fim: sim.fim, sim: resumoSim(sim), esperar: job.etapa === 'aguardando' ? 4 : 0 };
}

function resumoSim(sim) {
  const j = sim.job || {};
  return { de: sim.de, ate: sim.ate, totalDias: sim.dias.length, diaAtual: j.dia || sim.dias[Math.min(sim.i, sim.dias.length - 1)], feitos: sim.i,
    etapa: j.etapa || '', msg: j.msg || '', fim: sim.fim, resumo: sim.resumo, iniciado: sim.iniciado, terminado: sim.terminado || 0 };
}

// ---- leitura diária (cron) — mesmo log de ações dos PIX ----
async function verificarBoletos(env, forcar) {
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) return { aviso: 'Sicoob não ativado' };
  const st = (await env.BLING_KV.get('bol:estado', 'json')) || { jobs: {}, ultimo: 0 };
  if (!forcar && Date.now() - (st.ultimo || 0) < BOL_INTERVALO && !Object.values(st.jobs).some(j => j.etapa === 'aguardando' || j.etapa === 'tratar' || j.etapa === 'baixar')) return { pulou: true };
  const hoje = hojeLocal();
  // hoje, ontem e anteontem: liquidações entram no dia e às vezes só aparecem no dia seguinte
  const dias = [hoje, somaDias(hoje, -1), somaDias(hoje, -2), somaDias(hoje, -3)].filter(d => !fimDeSemana(d));
  for (const k of Object.keys(st.jobs)) if (!dias.includes(k)) delete st.jobs[k];
  const ctx = {};
  let novos = 0, pendentes = 0, passos = 0;
  for (const dia of dias) {
    let job = st.jobs[dia];
    // dia ainda "vivo": pede de novo a cada leitura (hora em hora) para pegar liquidações novas
    // dia com erro: tenta de novo depois de 30 min (qualquer dia da janela)
    if (!job || (['feito', 'vazio'].includes(job.etapa) && Date.now() - (job.pedidoEm || 0) > 60 * 60e3 && dia >= somaDias(hoje, -1))
        || (job.etapa === 'erro' && Date.now() - (job.pedidoEm || 0) > 30 * 60e3))
      job = st.jobs[dia] = { dia, etapa: 'novo', pedidoEm: Date.now() };
    if (passos >= 2) break;
    // o Sicoob só processa um pedido por vez: não abre outro dia enquanto um está aguardando o arquivo
    if (job.etapa === 'novo' && Object.values(st.jobs).some(j => j !== job && j.etapa === 'aguardando')) continue;
    if (job.etapa === 'tratar') {
      const fatia = job.itens.slice(job.idx, job.idx + BOL_POR_PASSO);
      for (const x0 of fatia) {
        const r = await tratarBoletoReal(env, x0, ctx);
        if (r === 'auto') novos++; else if (r === 'pendente') pendentes++;
      }
      job.idx += fatia.length;
      if (job.idx >= job.itens.length) { job.etapa = 'feito'; job.itens = []; }
      passos++;
    } else if (!['feito', 'vazio', 'erro'].includes(job.etapa)) {
      try { await passoDia(env, job); } catch (e) { job.etapa = 'erro'; job.msg = String(e.message || e).slice(0, 200); }
      if (job.etapa === 'novo' || job.etapa === 'aguardando') job.pedidoEm = job.pedidoEm || Date.now();
      passos++;
    }
  }
  st.ultimo = Date.now();
  await env.BLING_KV.put('bol:estado', JSON.stringify(st));
  if (novos) await abertosVelho(env);
  return { novos, pendentes, dias: Object.values(st.jobs).map(j => ({ dia: j.dia, etapa: j.etapa, msg: j.msg || '', qtd: (j.itens || []).length })) };
}

async function tratarBoletoReal(env, x0, ctx) {
  if (!x0.nossoNumero && x0.seuNumero) x0 = Object.assign({}, x0, { nossoNumero: 'S' + x0.seuNumero.replace(/\W/g, '') + '-' + Math.round(x0.valorTitulo * 100) });
  if (!x0.nossoNumero) return 'ignorado';
  if (await env.BLING_KV.get('bolpago:' + x0.nossoNumero)) return 'ja';
  const x = await completarBoleto(env, x0);
  const m = await casarBoleto(env, x, ctx, true);
  // conta de boleto da Bling Conta: a própria Bling dá a baixa — o app não mexe (decisão do Raul, 13/11/2026)
  if (m.tipo === 'auto' && (m.conta.boleto || Number(m.conta.portador) === 14893994469)) {
    await env.BLING_KV.put('bolpago:' + x.nossoNumero, 'bling-conta', { expirationTtl: 400 * 86400 });
    return 'ja';
  }
  if (m.tipo === 'auto' && m.conta.situacao === 2) {
    // já estava recebida no Bling (baixa manual): só registra, nada a fazer
    await env.BLING_KV.put('bolpago:' + x.nossoNumero, 'ja-recebida', { expirationTtl: 400 * 86400 });
    await logAcao(env, { modo: (await env.BLING_KV.get('modo')) || 'simulacao', origem: 'boleto', acao: 'boleto_pago', tipo: 'nota', numero: m.conta.numero, cliente: m.conta.cliente, valor: x.pago,
      detalhe: 'Boleto ' + x.nossoNumero + ' de R$ ' + x.pago.toFixed(2) + ' liquidado em ' + brData(x.dataLiquidacao) + ' — a conta já estava Recebida no Bling (nada a fazer).' });
    return 'ja';
  }
  if (m.tipo === 'auto') { await executarPlanoBoleto(env, x, m); return 'auto'; }
  const pend = { nossoNumero: x.nossoNumero, seuNumero: x.seuNumero, pagador: x.pagadorNome, doc: x.pagadorDoc, vencimento: x.dataVencimento,
    liquidacao: x.dataLiquidacao, credito: x.dataCredito, valorTitulo: x.valorTitulo, pago: x.pago, mora: x.mora, desconto: x.desconto, tarifa: x.tarifa,
    motivo: m.motivo, sugestoes: m.candidatos, criado: Date.now(), dados: x };
  await env.BLING_KV.put('bolpend:' + x.nossoNumero, JSON.stringify(pend), { expirationTtl: 180 * 86400 });
  await env.BLING_KV.put('bolpago:' + x.nossoNumero, 'pendente', { expirationTtl: 400 * 86400 });
  const ids = (await env.BLING_KV.get('bolpendentes', 'json')) || [];
  if (!ids.includes(x.nossoNumero)) { ids.push(x.nossoNumero); await env.BLING_KV.put('bolpendentes', JSON.stringify(ids.slice(-300))); }
  return 'pendente';
}

async function executarPlanoBoleto(env, x, m, como) {
  const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
  const conta = m.conta;
  const pl = planoBoleto(x, conta);
  const base = { modo, origem: 'boleto', tipo: conta.origemTipo === 'venda' ? 'pedido' : 'nota', id: conta.origemId, numero: conta.numero, cliente: conta.cliente,
    nossoNumero: x.nossoNumero, valor: x.pago, pagador: x.pagadorNome };
  await env.BLING_KV.put('bolpago:' + x.nossoNumero, String(conta.id), { expirationTtl: 400 * 86400 });
  await logAcao(env, Object.assign({}, base, { acao: 'boleto_pago',
    detalhe: 'Boleto Sicoob ' + x.nossoNumero + (x.seuNumero ? ' (seu nº ' + x.seuNumero + ')' : '') + ' de R$ ' + x.pago.toFixed(2) + ' liquidado em ' + brData(x.dataLiquidacao) +
      (x.dataCredito && x.dataCredito !== x.dataLiquidacao ? ', crédito em ' + brData(x.dataCredito) : '') + (x.pagadorNome ? ' — ' + x.pagadorNome : '') + ' · ' + (como || m.motivo) }));
  for (const a of pl.acoes) {
    const reg = Object.assign({}, a);
    if (modo === 'real') {
      if (a.acao === 'baixa') reg.resultado = await executarBaixa(env, a.contaId, a.valorBaixa, a.data, { historico: a.historico, historicoConta: true, conferir: true, juros: a.juros, acrescimo: a.acrescimo, desconto: a.desconto }).catch(e => 'ERRO: ' + (e.message || e));
      else if (a.acao === 'tarifa') reg.resultado = 'fica com a automação de tarifas do extrato';
    }
    await logAcao(env, Object.assign({}, base, reg));
  }
  const kd = 'pagosdoc:' + base.tipo + ':' + base.id;
  const pd = (await env.BLING_KV.get(kd, 'json')) || [];
  pd.push({ boleto: x.nossoNumero, valor: x.pago, horario: x.dataCredito || x.dataLiquidacao, pagador: x.pagadorNome, origem: 'boleto' });
  await env.BLING_KV.put(kd, JSON.stringify(pd), { expirationTtl: 365 * 86400 });
}

async function boletosVincular(env, b) {
  const nn = String(b.nossoNumero || '');
  const p = await env.BLING_KV.get('bolpend:' + nn, 'json');
  if (!p) return { ok: false, erro: 'Boleto não encontrado.' };
  if (p.resolvido) return { ok: false, erro: 'Este boleto já foi tratado.' };
  const cands = p.vencimento ? await contasPorVencimento(env, p.vencimento, {}, true) : [];
  let conta = cands.find(c => String(c.id) === String(b.contaId));
  if (!conta) {
    const j = await bling(env, '/contas/receber/' + encodeURIComponent(b.contaId));
    const x = (j && j.data) || {};
    if (!x.id) return { ok: false, erro: 'Conta a receber não encontrada no Bling.' };
    conta = { id: x.id, valor: r2(x.valor), venc: x.vencimento, situacao: Number(x.situacao), cliente: (x.contato && x.contato.nome) || '', doc: dig(x.contato && x.contato.numeroDocumento),
      origemTipo: (x.origem && x.origem.tipoOrigem) || '', origemId: (x.origem && x.origem.id) || 0, numero: String((x.origem && x.origem.numero) || '') };
  }
  if (conta.situacao === 2) return { ok: false, erro: 'Essa conta já está Recebida no Bling.' };
  const por = String(b.usuario || '').slice(0, 60);
  await env.BLING_KV.put('bolvinc:' + nn, JSON.stringify({ contaId: conta.id, conta, por, em: Date.now() }), { expirationTtl: 400 * 86400 });
  await executarPlanoBoleto(env, p.dados, { conta, motivo: 'vinculado manualmente' }, 'vinculado manualmente por ' + por);
  p.resolvido = 'vinculado'; p.vinculo = { contaId: conta.id, numero: conta.numero }; p.por = por;
  await env.BLING_KV.put('bolpend:' + nn, JSON.stringify(p), { expirationTtl: 180 * 86400 });
  return { ok: true };
}

async function boletosPainel(env) {
  const ids = (await env.BLING_KV.get('bolpendentes', 'json')) || [];
  const pendentes = [];
  for (const nn of ids.slice(-60).reverse()) { const x = await env.BLING_KV.get('bolpend:' + nn, 'json'); if (x && !x.resolvido) { delete x.dados; pendentes.push(x); } }
  const acoes = ((await env.BLING_KV.get('acoes', 'json')) || []).filter(a => a.origem === 'boleto').slice(-150).reverse();
  const st = (await env.BLING_KV.get('bol:estado', 'json')) || { jobs: {} };
  const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
  return { ok: true, modo, ultimo: st.ultimo || 0, dias: Object.values(st.jobs || {}).map(j => ({ dia: j.dia, etapa: j.etapa, msg: j.msg || '' })), pendentes, acoes };
}

// ======================================================================================================
// ---------------- ECONF automático: o servidor assina e envia o evento à Sefaz (SVRS) ----------------
// O certificado A1 é guardado uma vez pelo script CONFIGURAR-ECONF-AUTOMATICO (no PC do Raul): a chave privada
// fica no KV CRIPTOGRAFADA (AES-GCM) com uma chave derivada de um segredo do Worker (BLING_CLIENT_SECRET) —
// quem lê o KV não consegue usar o certificado. A conexão com a Sefaz usa o mesmo certificado do binding SICOOB_MTLS.
// Rodadas automáticas: 13h e 18h (horário de Brasília), em produção, só itens "pronto" de /econf/pendentes.
const ECONF_URL = { producao: 'https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx', teste: 'https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx' };
const ECONF_WSDL = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4';
const ECONF_NS = 'http://www.portalfiscal.inf.br/nfe';
const ECONF_DS = 'http://www.w3.org/2000/09/xmldsig#';
const ECONF_C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ECONF_HORAS = [13, 18];
const ECONF_DESDE = '2026-11-01';   // pagamentos antes disso não entram no TEF automático
const ECONF_SETUP_HASH = 'c01677557bd0bf979d52c8382407c8731637f628c9dcdd10b52082c508c4a2d8'; // sha256 do código do script de configuração
const ECONF_CNPJ = '35017646000166', ECONF_UF = 'GO';

const b64de = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64em = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const pemsDer = (pem, tipo) => [...String(pem || '').matchAll(new RegExp('-----BEGIN ' + tipo + '-----([\\s\\S]*?)-----END ' + tipo + '-----', 'g'))].map(m => b64de(m[1].replace(/\s+/g, '')));
function derLen(n) { if (n < 128) return [n]; const b = []; while (n > 0) { b.unshift(n & 255); n >>= 8; } return [0x80 + b.length, ...b]; }
function derTLV(tag, conteudo) { return Uint8Array.from([tag, ...derLen(conteudo.length), ...conteudo]); }
// RSA PKCS#1 → PKCS#8 (WebCrypto só importa PKCS#8)
function pkcs1para8(p1) {
  const alg = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return derTLV(0x30, [0x02, 0x01, 0x00, ...alg, ...derTLV(0x04, p1)]);
}
// leitura mínima de DER: devolve os filhos de um SEQUENCE
function derFilhos(u, ini, fim) {
  const out = []; let i = ini;
  while (i < fim) {
    const tag = u[i]; let len = u[i + 1], h = 2;
    if (len & 0x80) { const nb = len & 0x7f; len = 0; for (let k = 0; k < nb; k++) len = len * 256 + u[i + 2 + k]; h = 2 + nb; }
    out.push({ tag, ini: i, cIni: i + h, fim: i + h + len }); i = i + h + len;
  }
  return out;
}
// certificado X.509 → { spki (DER), validade (Date), subjectTexto }
function lerCertificado(der) {
  const cert = derFilhos(der, 0, der.length)[0];
  const tbs = derFilhos(der, cert.cIni, cert.fim)[0];
  let f = derFilhos(der, tbs.cIni, tbs.fim); if (f[0].tag === 0xa0) f = f.slice(1);
  const validade = derFilhos(der, f[3].cIni, f[3].fim)[1];
  const t = new TextDecoder().decode(der.subarray(validade.cIni, validade.fim));
  const ano = validade.tag === 0x17 ? 2000 + Number(t.slice(0, 2)) : Number(t.slice(0, 4)), r = validade.tag === 0x17 ? t.slice(2) : t.slice(4);
  const vence = new Date(Date.UTC(ano, Number(r.slice(0, 2)) - 1, Number(r.slice(2, 4)), Number(r.slice(4, 6)), Number(r.slice(6, 8)), Number(r.slice(8, 10) || 0)));
  const subj = Array.from(der.subarray(f[4].cIni, f[4].fim), c => (c >= 32 && c < 127) ? String.fromCharCode(c) : '|').join('').replace(/\|+/g, ' | ');
  return { spki: der.slice(f[5].ini, f[5].fim), validade: vence, subject: subj };
}
async function econfKek(env) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BLING_CLIENT_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('econf-a1-jdfer'), info: new TextEncoder().encode('chave-certificado') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function sha256hex(s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join(''); }

async function econfGuardarCertificado(env, b) {
  if (!b || (await sha256hex(String(b.codigo || ''))) !== ECONF_SETUP_HASH) return { ok: false, erro: 'Código de configuração inválido.' };
  const p1 = pemsDer(b.chave, 'RSA PRIVATE KEY')[0], certs = pemsDer(b.cert, 'CERTIFICATE');
  if (!p1 || !certs.length) return { ok: false, erro: 'Faltou a chave ou o certificado.' };
  const info = lerCertificado(certs[0]);
  if (info.subject.indexOf(ECONF_CNPJ) < 0) return { ok: false, erro: 'O certificado não é da JDFER (CNPJ ' + ECONF_CNPJ + ').' };
  if (info.validade < new Date()) return { ok: false, erro: 'Certificado vencido.' };
  const p8 = pkcs1para8(p1);
  // confere se a chave é do certificado: assina um teste e verifica com a chave pública do certificado
  const priv = await crypto.subtle.importKey('pkcs8', p8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['sign']);
  const pub = await crypto.subtle.importKey('spki', info.spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['verify']);
  const teste = new TextEncoder().encode('econf-teste-' + Date.now());
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, teste), teste)))
    return { ok: false, erro: 'A chave não corresponde ao certificado.' };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await econfKek(env), p8);
  await env.BLING_KV.put('econf:a1', JSON.stringify({ iv: b64em(iv), ct: b64em(ct), cert: b64em(certs[0]), validade: info.validade.toISOString(), quando: Date.now() }));
  ECONF_A1 = null;
  await logAcao(env, { acao: 'econf', modo: 'real', detalhe: 'Certificado A1 configurado para o ECONF automático (válido até ' + info.validade.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ')' });
  return { ok: true, validade: info.validade.toISOString() };
}
let ECONF_A1 = null;
async function econfCarregarA1(env) {
  if (ECONF_A1) return ECONF_A1;
  const g = await env.BLING_KV.get('econf:a1', 'json');
  if (!g) return null;
  const p8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64de(g.iv) }, await econfKek(env), b64de(g.ct));
  const key = await crypto.subtle.importKey('pkcs8', p8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['sign']);
  ECONF_A1 = { key, cert: g.cert, validade: g.validade };
  return ECONF_A1;
}

function econfSignedInfo(id, digest, comNs) {
  return '<SignedInfo' + (comNs ? ' xmlns="' + ECONF_DS + '"' : '') + '><CanonicalizationMethod Algorithm="' + ECONF_C14N + '"></CanonicalizationMethod>' +
    '<SignatureMethod Algorithm="' + ECONF_DS + 'rsa-sha1"></SignatureMethod><Reference URI="#' + id + '"><Transforms>' +
    '<Transform Algorithm="' + ECONF_DS + 'enveloped-signature"></Transform><Transform Algorithm="' + ECONF_C14N + '"></Transform></Transforms>' +
    '<DigestMethod Algorithm="' + ECONF_DS + 'sha1"></DigestMethod><DigestValue>' + digest + '</DigestValue></Reference></SignedInfo>';
}
// monta e assina o evento (mesmo XML do enviar-econf.ps1; canonicalização conferida contra os XMLs aceitos pela Sefaz)
async function econfMontarAssinado(a1, o) {
  const id = 'ID110750' + o.chave + String(o.nSeq).padStart(2, '0');
  const corpo = '<cOrgao>92</cOrgao><tpAmb>' + o.tpAmb + '</tpAmb><CNPJ>' + ECONF_CNPJ + '</CNPJ><chNFe>' + o.chave + '</chNFe>' +
    '<dhEvento>' + o.dhEvento + '</dhEvento><tpEvento>110750</tpEvento><nSeqEvento>' + o.nSeq + '</nSeqEvento><verEvento>1.00</verEvento>' +
    '<detEvento versao="1.00"><descEvento>ECONF</descEvento><verAplic>MaisAcessivel-1.0</verAplic>' +
    '<detPag><indPag>0</indPag><tPag>' + o.tPag + '</tPag><vPag>' + o.vPag + '</vPag><dPag>' + o.dPag + '</dPag>' +
    '<CNPJPag>' + ECONF_CNPJ + '</CNPJPag><UFPag>' + ECONF_UF + '</UFPag><CNPJIF>' + o.cnpjIF + '</CNPJIF><cAut>' + o.cAut + '</cAut>' +
    '<CNPJReceb>' + ECONF_CNPJ + '</CNPJReceb><UFReceb>' + ECONF_UF + '</UFReceb></detPag></detEvento>';
  const enc = new TextEncoder();
  const digest = b64em(await crypto.subtle.digest('SHA-1', enc.encode('<infEvento xmlns="' + ECONF_NS + '" Id="' + id + '">' + corpo + '</infEvento>')));
  const sig = b64em(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', a1.key, enc.encode(econfSignedInfo(id, digest, true))));
  return '<evento xmlns="' + ECONF_NS + '" versao="1.00"><infEvento Id="' + id + '">' + corpo + '</infEvento>' +
    '<Signature xmlns="' + ECONF_DS + '">' + econfSignedInfo(id, digest, false) + '<SignatureValue>' + sig + '</SignatureValue>' +
    '<KeyInfo><X509Data><X509Certificate>' + a1.cert + '</X509Certificate></X509Data></KeyInfo></Signature></evento>';
}
function horaBrasilia(ms) { return new Date((ms || Date.now()) - 3 * 3600e3).toISOString().slice(0, 19) + '-03:00'; }
const tagXml = (x, t) => { const m = String(x).match(new RegExp('<(?:\\w+:)?' + t + '>([^<]*)<')); return m ? m[1] : ''; };

async function econfSoap(env, ambiente, envEvento) {
  const soap = '<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>' +
    '<nfeDadosMsg xmlns="' + ECONF_WSDL + '">' + envEvento + '</nfeDadosMsg></soap12:Body></soap12:Envelope>';
  const r = await env.SICOOB_MTLS.fetch(ECONF_URL[ambiente], { method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8; action="' + ECONF_WSDL + '/nfeRecepcaoEvento"' }, body: soap });
  const t = (await r.text()).replace(/^﻿/, '').trim();
  return { status: r.status, texto: t };
}

// envia os ECONF "prontos". opt: {ambiente, origem, usuario, pular:[e2e], maxChamadas, maxEnvios}
async function econfEnviar(env, opt) {
  opt = opt || {};
  const ambiente = opt.ambiente === 'producao' ? 'producao' : 'teste';
  if (!env.SICOOB_MTLS) return { ok: false, erro: 'Sem o certificado de conexão (SICOOB_MTLS) no servidor.' };
  const a1 = await econfCarregarA1(env);
  if (!a1) return { ok: false, erro: 'O certificado para assinar o ECONF ainda não foi configurado (rode CONFIGURAR-ECONF-AUTOMATICO no PC).' };
  const trava = await env.BLING_KV.get('econf:trava');
  if (trava && Date.now() - Number(trava) < 240000) return { ok: false, ocupado: true, erro: 'Já tem um envio de ECONF rodando. Tente em 1 minuto.' };
  await env.BLING_KV.put('econf:trava', String(Date.now()), { expirationTtl: 300 });
  const res = [];
  let pend;
  try {
    pend = await econfPendentes(env, opt.maxChamadas || 25);
    const pular = opt.pular || [];
    const prontos = pend.itens.filter(i => i.status === 'pronto' && !pular.includes(i.e2e));
    const lote = prontos.slice(0, opt.maxEnvios || 15);
    for (const p of lote) {
      const item = { e2e: p.e2e, nf: p.nf.numero, chave: p.nf.chave, valor: p.valor, dia: p.dia, pagador: p.pagador, momento: p.momento, nSeq: p.nSeq || 1 };
      try {
        const evento = await econfMontarAssinado(a1, { chave: p.nf.chave, nSeq: item.nSeq, tpAmb: ambiente === 'producao' ? '1' : '2', dhEvento: horaBrasilia(Date.now() - 30000),
          tPag: p.tPag, vPag: Number(p.valor).toFixed(2), dPag: p.dia, cnpjIF: CNPJ_SICOOB_IF, cAut: p.e2e });
        const idLote = (horaBrasilia().slice(0, 19).replace(/\D/g, '') + String(Math.floor(Math.random() * 10))).slice(0, 15);
        const envio = '<envEvento xmlns="' + ECONF_NS + '" versao="1.00"><idLote>' + idLote + '</idLote>' + evento + '</envEvento>';
        const r = await econfSoap(env, ambiente, envio);
        const ret = (r.texto.match(/<retEvento[\s\S]*?<\/retEvento>/) || [r.texto])[0];
        item.cStat = tagXml(ret, 'cStat'); item.xMotivo = tagXml(ret, 'xMotivo'); item.nProt = tagXml(ret, 'nProt');
        if (!item.cStat) { item.cStat = 'http' + r.status; item.xMotivo = r.texto.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); }
        item.xml = 'econfxml:' + ambiente + ':' + Date.now() + ':' + p.e2e;
        await env.BLING_KV.put(item.xml, JSON.stringify({ envio, retorno: r.texto, nf: p.nf.numero, chave: p.nf.chave, valor: p.valor, cStat: item.cStat, nProt: item.nProt }),
          { expirationTtl: ambiente === 'producao' ? 5 * 365 * 86400 : 30 * 86400 });
        await econfRegistrar(env, { e2e: p.e2e, chave: p.nf.chave, nSeq: item.nSeq, ambiente, cStat: item.cStat, xMotivo: item.xMotivo, nProt: item.nProt, valor: p.valor });
      } catch (e) { item.cStat = 'erro'; item.xMotivo = String(e.message || e).slice(0, 300); }
      res.push(item);
      const recente494 = item.cStat === '494' && (() => { const t = Date.parse(String(p.nf.emissaoHora || '').replace(' ', 'T') + '-03:00'); return isNaN(t) || Date.now() - t < 24 * 3600e3; })();
      if (recente494) item.xMotivo = (item.xMotivo || '') + ' — a nota ainda não tinha chegado ao ambiente nacional; reenvia sozinho na próxima rodada';
      if (ambiente === 'producao' && !['135', '136', '573'].includes(item.cStat) && !recente494)
        await tefAlerta(env, { e2e: p.e2e, chave: item.cStat, tipo: /^\d+$/.test(item.cStat) ? 'recusado' : 'falha', nf: item.nf, valor: p.valor, pagador: p.pagador, dia: p.dia,
          motivo: (/^\d+$/.test(item.cStat) ? 'Sefaz recusou (' + item.cStat + '): ' : 'Não consegui enviar: ') + (item.xMotivo || '') });
    }
    // PIX que não dá para enviar (NF rejeitada/cancelada, sem chave, erro ao ler a NF): avisa uma vez por motivo
    if (ambiente === 'producao') for (const i of pend.itens.filter(x => ['nf_nao_autorizada', 'nf_sem_chave', 'erro'].includes(x.status)))
      await tefAlerta(env, { e2e: i.e2e, chave: i.status, tipo: 'nao_enviado', nf: (i.nf && i.nf.numero) || '', valor: i.valor, pagador: i.pagador, dia: i.dia,
        motivo: 'TEF não enviado: ' + (i.erro || (i.status === 'nf_sem_chave' ? 'a nota não tem chave de acesso' : i.status)) });
    const resumo = { quando: Date.now(), ambiente, origem: opt.origem || 'manual', usuario: opt.usuario || '',
      aceitos: res.filter(x => ['135', '136', '573'].includes(x.cStat)).length, recusados: res.filter(x => !['135', '136', '573'].includes(x.cStat)).length,
      aguardandoNF: pend.itens.filter(i => i.status === 'aguardando_nf').length, problemas: pend.itens.filter(i => !['pronto', 'aguardando_nf'].includes(i.status)).length,
      restantes: prontos.length - lote.length + (pend.faltaram || 0), resultados: res };
    const hist = (await env.BLING_KV.get('econf:execucoes', 'json')) || [];
    hist.unshift(resumo);
    await env.BLING_KV.put('econf:execucoes', JSON.stringify(hist.slice(0, 80)));
    return Object.assign({ ok: true }, resumo);
  } finally {
    await env.BLING_KV.delete('econf:trava');
  }
}

// chamada pelo cron (a cada 5 min): nas janelas das 13h e 18h roda o ECONF em produção até esvaziar a fila.
// Devolve true quando usou a rodada (aí a conferência de PIX/boletos fica para os 5 min seguintes).
async function econfAgendado(env) {
  const agora = new Date(Date.now() - 3 * 3600e3), hora = agora.getUTCHours();
  if (!ECONF_HORAS.includes(hora)) return false;
  if ((await env.BLING_KV.get('econf:auto')) === 'desligado') return false;
  if (!(await env.BLING_KV.get('econf:a1'))) return false;
  const chave = 'econfslot:' + agora.toISOString().slice(0, 10) + '-' + hora;
  const st = (await env.BLING_KV.get(chave, 'json')) || { tentados: [], rodadas: 0 };
  if (st.fim) return false;
  st.rodadas++;
  try {
    const r = await econfEnviar(env, { ambiente: 'producao', origem: 'automático ' + hora + 'h', pular: st.tentados, maxChamadas: 25, maxEnvios: 12 });
    if (!r.ok && r.ocupado) return true;
    if (!r.ok) { st.erro = r.erro; st.fim = st.rodadas >= 3; if (st.fim) await tefAlerta(env, { e2e: 'geral', chave: chave, tipo: 'falha', motivo: 'O envio automático do ECONF das ' + hora + 'h não rodou: ' + r.erro }); }
    else { st.tentados.push(...r.resultados.map(x => x.e2e)); st.fim = !r.resultados.length || !r.restantes || st.rodadas >= 8; }
  } catch (e) { st.erro = String(e.message || e); st.fim = st.rodadas >= 3; await registrarErro(env, 'ECONF automático: ' + st.erro); if (st.fim) await tefAlerta(env, { e2e: 'geral', chave: chave, tipo: 'falha', motivo: 'O envio automático do ECONF das ' + hora + 'h falhou: ' + st.erro }); }
  await env.BLING_KV.put(chave, JSON.stringify(st), { expirationTtl: 3 * 86400 });
  return true;
}

// Aviso de TEF não enviado/recusado: fica na lista "tef:alertas" (o app mostra e notifica o admin).
// Um aviso por PIX + motivo (não repete a cada rodada). Se NTFY_TOPICO estiver configurado no Worker, também manda push no celular (app ntfy).
async function tefAlerta(env, a) {
  const id = String(a.e2e || '') + '|' + String(a.chave || a.tipo || '');
  const l = (await env.BLING_KV.get('tef:alertas', 'json')) || [];
  if (l.some(x => x.id === id)) return;
  const al = { id, quando: Date.now(), tipo: a.tipo, e2e: a.e2e || '', nf: a.nf || '', valor: Number(a.valor || 0), pagador: a.pagador || '', dia: a.dia || '', motivo: String(a.motivo || '').slice(0, 300), visto: 0 };
  l.unshift(al);
  await env.BLING_KV.put('tef:alertas', JSON.stringify(l.slice(0, 200)));
  await logAcao(env, { acao: 'tef_alerta', modo: 'real', numero: al.nf, cliente: al.pagador, valor: al.valor, detalhe: '⚠️ ' + al.motivo });
  if (env.NTFY_TOPICO) {
    try {
      await fetch('https://ntfy.sh/' + encodeURIComponent(env.NTFY_TOPICO), { method: 'POST',
        headers: { Title: (a.tipo === 'recusado' ? 'TEF recusado pela Sefaz' : 'TEF nao enviado') + (al.nf ? ' - NF ' + al.nf : ''), Priority: 'high', Tags: 'warning', Click: 'https://rauldneto.github.io/mais-acessivel-app/#bling' },
        body: al.motivo + (al.valor ? ' (R$ ' + al.valor.toFixed(2) + (al.pagador ? ', ' + al.pagador : '') + ')' : '') });
    } catch (e) {}
  }
}

async function econfPainel(env) {
  const a1 = await env.BLING_KV.get('econf:a1', 'json');
  const hist = (await env.BLING_KV.get('econf:execucoes', 'json')) || [];
  return { configurado: !!a1, validade: a1 ? a1.validade : null, auto: (await env.BLING_KV.get('econf:auto')) !== 'desligado', horas: ECONF_HORAS, execucoes: hist.slice(0, 40) };
}

// ======================================================================================================
// ---------------- Conciliação contas a Pagar: débitos do extrato Sicoob × Contas a Pagar do Bling ----------------
// Lê o extrato da conta corrente Sicoob (API Conta Corrente v3, escopo cco_extrato), separa os DÉBITOS em
// PIX / Boleto / Crédito (fatura do cartão) / Taxas e tarifas / Outros e procura a conta a pagar correspondente no Bling.
// Nada é baixado nem lançado sozinho: o app mostra a sugestão e o Raul confirma (POST /pagar/baixar e /pagar/lancar).
// Configuração extra no Worker: SICOOB_CONTA = número da conta corrente (só dígitos, sem o dígito da cooperativa).
const SICOOB_CCO = 'https://api.sicoob.com.br/conta-corrente/v4';      // app novo (v4, escopo cco_consulta); v3/cco_extrato fica de reserva
const SICOOB_CCO_V3 = 'https://api.sicoob.com.br/conta-corrente/v3';
const ESCOPO_EXTRATO = 'cco_consulta';
const PAG_CAT = { tarifa: 14634451823, juros: 14634451825, taxas: 14634451828 };   // Tarifa bancária, Juros pagos, Taxas pagas
const PAG_FORMA = { pix: 3639534, boleto: 3639541, credito: 6642716, taxa: 3457303, outro: 3457303 }; // PIX Info - Sicoob, Boleto Info Sicoob, Cartão Créd. Sicoob, Transferencia
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
function numBR(v) { // "1234.56", "-1234.56", "1.234,56"
  let s = String(v == null ? '' : v).trim(); if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Math.abs(Number(s.replace(/[^\d.-]/g, '')) || 0);
}
function tipoDebito(desc) {
  const d = semAcento(desc);
  // dinheiro que só muda de conta (não é despesa): saque, transferência entre contas próprias, aplicação/resgate
  if (/SAQUE|\bSAQ\b|ENTRE CONTAS|MESMA TITUL|MESMA TIT|CONTA PROPRIA|APLICACAO|APLIC\.|RESGATE|POUPANCA/.test(d)) return 'transf';
  if (/^TAR\b|^TAR\.|TARIFA|\bIOF\b|JUROS|ENCARGO|\bMORA\b|ANUIDADE|CESTA|PACOTE|MANUT|CUSTAS|\bTAXA/.test(d)) return 'taxa';
  if (/FATURA|CARTAO|CREDICARD|SIPAG|MASTERCARD|\bVISA\b|ELO\b/.test(d)) return 'credito';
  if (/\bPIX\b|PIX\.|PIX /.test(d)) return 'pix';
  if (/TIT|BOLETO|COMPE|CONV|PAGTO|PAGAMENTO|PAG\.|DARF|\bGPS\b|\bDAS\b|FGTS|TRIBUTO|GUIA|IPTU|IPVA|DETRAN/.test(d)) return 'boleto';
  return 'outro';
}
function categoriaTaxa(desc) {
  const d = semAcento(desc);
  if (/JUROS|ENCARGO|\bMORA\b/.test(d)) return PAG_CAT.juros;
  if (/\bIOF\b|SIPAG|CARTAO|CARTOES|MDR|ANTECIP|DESC/.test(d)) return PAG_CAT.taxas;   // IOF e taxa/desconto de cartão
  return PAG_CAT.tarifa;
}
async function chaveDebito(t) { return (await sha256hex([t.data, t.valor.toFixed(2), t.doc, t.desc, t.ndoc, t.seq].join('|'))).slice(0, 20); }

async function sicoobExtrato(env, mes, ano, d1, d2, semAgrupar) {
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) throw new Error('Sicoob ainda não ativado no Worker.');
  const conta = await contaSicoob(env);
  let tok, base = SICOOB_CCO, escopo = ESCOPO_EXTRATO;
  try { tok = await sicoobToken(env, escopo); }
  catch (e) {
    try { escopo = 'cco_extrato'; base = SICOOB_CCO_V3; tok = await sicoobToken(env, escopo); }
    catch (e2) { throw new Error((env.SICOOB_CLIENT_ID_CCO ? 'O app "JDFER Extrato" do Sicoob ainda não está liberado (aprovação no Sicoobnet pendente?). ' : 'Falta o app do Sicoob com a API Conta Corrente (variável SICOOB_CLIENT_ID_CCO). ') + 'Detalhe: ' + (e.message || e)); }
  }
  const q = '?' + (conta ? 'numeroContaCorrente=' + encodeURIComponent(conta) + '&' : '') + 'diaInicial=' + d1 + '&diaFinal=' + d2 + '&agruparCNAB=' + (semAgrupar ? 'false' : 'true');
  let r = await env.SICOOB_MTLS.fetch(base + '/extrato/' + mes + '/' + ano + q, {
    headers: { Authorization: 'Bearer ' + tok, client_id: clientSicoob(env, escopo), Accept: 'application/json' },
  });
  if (r.status === 429) { // limite de consultas do Sicoob: espera um pouco e tenta uma vez
    await new Promise(x => setTimeout(x, 2500));
    r = await env.SICOOB_MTLS.fetch(base + '/extrato/' + mes + '/' + ano + q, { headers: { Authorization: 'Bearer ' + tok, client_id: clientSicoob(env, escopo), Accept: 'application/json' } });
  }
  if (r.status === 401) { // token guardado foi invalidado pelo Sicoob (ex.: virada do dia): pede um novo e tenta de novo
    await env.BLING_KV.delete(chaveTokenSicoob(env, escopo));
    tok = await sicoobToken(env, escopo);
    r = await env.SICOOB_MTLS.fetch(base + '/extrato/' + mes + '/' + ano + q, {
      headers: { Authorization: 'Bearer ' + tok, client_id: clientSicoob(env, escopo), Accept: 'application/json' },
    });
  }
  if ((r.status === 404 || r.status === 403) && base !== SICOOB_CCO_V3) r = await env.SICOOB_MTLS.fetch(SICOOB_CCO_V3 + '/extrato/' + mes + '/' + ano + q, {
    headers: { Authorization: 'Bearer ' + tok, client_id: clientSicoob(env, escopo), Accept: 'application/json' },
  });
  if (r.status === 204) return [];
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _texto: txt.slice(0, 300) }; }
  if (!r.ok && !conta) throw new Error('Não achei o número da conta Sicoob sozinho (nenhum boleto Sicoob lido ainda) e o Sicoob exigiu o número (' + r.status + '). Crie a variável SICOOB_CONTA no Worker. Detalhe: ' + ((j.mensagens && j.mensagens.map(x => x.mensagem).join('; ')) || j.message || j._texto || '').slice(0, 160));
  if (r.status === 403 && /plan/i.test(txt)) throw new Error('O Sicoob ainda não ligou o app "JDFER Extrato" à API Conta Corrente (403 "Not registered to plan"). Isso costuma liberar algumas horas depois da aprovação; se passar de 1 dia, falar com a cooperativa/Alice.');
  if (r.status === 429) throw new Error('O Sicoob limitou as consultas por alguns minutos (muitas seguidas). Espere 1–2 minutos e clique em Conferir de novo.');
  if (!r.ok) throw new Error('Extrato Sicoob ' + r.status + ': ' + ((j.mensagens && j.mensagens.map(x => x.mensagem).join('; ')) || j.message || j.mensagem || j._texto || JSON.stringify(j).slice(0, 200)));
  const res = j.resultado || j;
  return res.transacoes || acharCampo(res, ['transacoes', 'lancamentos']) || [];
}

// Número da conta corrente: variável SICOOB_CONTA, ou descoberto sozinho num boleto Sicoob já lido
// (a API de cobrança devolve numeroContaCorrente do beneficiário). Guardado no KV "sicoob:conta".
async function contaSicoob(env) {
  if (env.SICOOB_CONTA) return dig(env.SICOOB_CONTA);
  const salvo = await env.BLING_KV.get('sicoob:conta'); if (salvo) return salvo;
  const nns = new Set();
  ((await env.BLING_KV.get('bolpendentes', 'json')) || []).slice(-10).forEach(n => nns.add(String(n)));
  ((await env.BLING_KV.get('acoes', 'json')) || []).filter(a => a.nossoNumero).slice(-10).forEach(a => nns.add(String(a.nossoNumero)));
  ((await env.BLING_KV.get('bolsim:rel', 'json')) || []).filter(a => a && a.nossoNumero).slice(-10).forEach(a => nns.add(String(a.nossoNumero)));
  // sem boleto lido ainda: os primeiros nossoNumero emitidos pela empresa (numeração sequencial do Sicoob)
  if (nns.size < 4) for (let i = 1; i <= 6; i++) nns.add(String(i));
  let tent = 0;
  for (const nn of nns) {
    if (!nn || ++tent > 8) break;
    const j = await sicoobCob(env, 'GET', '/boletos?numeroCliente=' + SICOOB_NUM_CLIENTE + '&codigoModalidade=1&nossoNumero=' + encodeURIComponent(nn)).catch(() => null);
    const c = dig(acharCampo(j, ['numeroContaCorrente', 'contaCorrente']));
    if (c) { await env.BLING_KV.put('sicoob:conta', c); return c; }
  }
  return ''; // sem conta: tenta o extrato assim mesmo (o Sicoob pode usar a conta ligada ao certificado)
}

// lista contas a pagar do Bling por um filtro de datas (todas as situações)
async function pagarListar(env, filtro, de, ate, maxPag) {
  return paginas(env, '/contas/pagar?' + filtro + 'Inicial=' + de + '&' + filtro + 'Final=' + ate, maxPag || 4).catch(e => { throw new Error('Contas a pagar do Bling: ' + e.message + ' (o app do Bling precisa da permissão "Contas a pagar").'); });
}
// nome e CPF/CNPJ dos fornecedores (cache no KV; busca no máx. N por chamada para não estourar o limite de chamadas do Worker)
async function contatosInfo(env, ids, max) {
  const cache = (await env.BLING_KV.get('cache:contatos', 'json')) || {};
  const falta = [...new Set(ids.map(String))].filter(id => id && id !== '0' && !cache[id]);
  let novos = 0;
  for (const id of falta.slice(0, max || 12)) {
    const c = ((await bling(env, '/contatos/' + id).catch(() => null)) || {}).data;
    if (c) { cache[id] = { n: c.nome || c.fantasia || '', d: dig(c.numeroDocumento) }; novos++; }
  }
  if (novos) await env.BLING_KV.put('cache:contatos', JSON.stringify(cache));
  return { cache, faltam: Math.max(0, falta.length - novos) };
}

// Débitos do extrato Sicoob no período, já com chave estável, tipo e marcas (ignorado/vínculo/lançado)
async function lerDebitos(env, de, ate) {
  const transacoes = [];
  let cur = de;
  while (cur <= ate) {
    const [a, m] = cur.split('-');
    const fimMes = new Date(Date.UTC(+a, +m, 0)).toISOString().slice(0, 10);
    const fim = fimMes < ate ? fimMes : ate;
    let lista = await sicoobExtrato(env, +m, +a, +cur.slice(8), +fim.slice(8));
    // Linhas agrupadas pelo Sicoob ("@2 registro(s)" / Doc. AGRUPADO) escondem para quem foi cada PIX/pagamento:
    // busca o extrato sem agrupar e troca cada grupo pelos lançamentos dele (mesmo dia e mesma descrição, soma igual).
    // Tarifas continuam agrupadas como sempre (é assim que já foram lançadas no Bling).
    const ehGrupo = t => /registro\(s\)/i.test(String(t.descInfComplementar || '')) || /AGRUPADO/i.test(String(t.numeroDocumento || ''));
    const grupos = lista.filter(t => ehGrupo(t) && tipoDebito(String(t.descricao || '') + ' ' + String(t.descInfComplementar || '')) !== 'taxa');
    if (grupos.length) {
      const det = await sicoobExtrato(env, +m, +a, +cur.slice(8), +fim.slice(8), true).catch(() => null);
      if (det && det.length) {
        const usados = new Set();
        const trocas = new Map();
        for (const g of grupos) {
          const dia = soData(g.data || g.dataLote), desc = String(g.descricao || '').trim(), alvo = r2(numBR(g.valor));
          const filhos = det.filter((d, i) => !usados.has(i) && !ehGrupo(d) && soData(d.data || d.dataLote) === dia && String(d.descricao || '').trim() === desc && String(d.tipo || '') === String(g.tipo || ''))
            .map(d => ({ d, i: det.indexOf(d) }));
          const soma = r2(filhos.reduce((a2, f) => a2 + numBR(f.d.valor), 0));
          if (filhos.length > 1 && Math.abs(soma - alvo) < 0.01) { filhos.forEach(f => usados.add(f.i)); trocas.set(g, filhos.map(f => f.d)); }
        }
        if (trocas.size) lista = lista.flatMap(t => trocas.get(t) || [t]);
      }
    }
    lista.forEach(t => transacoes.push(t));
    cur = somaDias(fimMes, 1);
  }
  const marcas = (await env.BLING_KV.get('pagar:marcas', 'json')) || {};
  const debitos = [], vistos = {};
  for (const t of transacoes) {
    const ehDeb = /DEB/i.test(String(t.tipo || '')) || Number(String(t.valor).replace(',', '.')) < 0;
    if (!ehDeb) continue;
    const x = { data: soData(t.data || t.dataLote), valor: r2(numBR(t.valor)), desc: String(t.descricao || '').trim(), compl: String(t.descInfComplementar || '').trim(),
      doc: dig(t.cpfCnpj), ndoc: String(t.numeroDocumento || '').trim() };
    if (!x.data || x.data < de || x.data > ate || !x.valor) continue;
    const base = [x.data, x.valor, x.desc, x.ndoc].join('|'); x.seq = vistos[base] = (vistos[base] || 0) + 1;
    x.chave = await chaveDebito(x);
    // O Sicoob costuma mandar o CPF/CNPJ e o favorecido dentro do texto complementar ("Pagamento Pix|@11.146.393 0001-62|@ped 5422",
    // "FAV.: BARUC INDUSTRIAL LTDA|@...|@JDFER...|@35.017.646 0001-66"): lê de lá (ignora o próprio CNPJ, que é o pagador). Depois da chave, para ela não mudar.
    if (!x.doc) {
      const docs = (x.compl.match(/\d{2}\.?\d{3}\.?\d{3}[\s\/]?\d{4}-?\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}/g) || []).map(dig).filter(d => (d.length === 14 || d.length === 11) && d !== ECONF_CNPJ);
      if (docs.length) x.doc = docs[0];
    }
    const fav = x.compl.match(/FAV\.?:\s*([^|@]+)/i);
    if (fav) x.nome = fav[1].trim();
    x.tipoAuto = x.doc === ECONF_CNPJ ? 'transf' : tipoDebito(x.desc + ' ' + x.compl);   // PIX/TED para o próprio CNPJ = transferência
    const mk = marcas[x.chave] || {};
    x.tipo = mk.tipo || x.tipoAuto;
    if (mk.ign) x.ignorado = { por: mk.por || '', em: mk.em };
    if (mk.contaId) x.vinculo = mk.contaId;
    if (mk.lancado) x.lancado = mk.lancado;
    debitos.push(x);
  }
  return { debitos, marcas };
}

async function pagarConciliar(env, de, ate, mes) {
  const hoje = hojeLocal();
  // Visão por mês: contas do Bling que vencem no mês; o extrato vai de 10 dias antes a 10 dias depois (pagamento adiantado/atrasado)
  let mesIni = '', mesFim = '';
  if (/^\d{4}-\d{2}$/.test(String(mes || ''))) {
    mesIni = mes + '-01'; mesFim = new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7), 0)).toISOString().slice(0, 10);
    if (mesIni > hoje) return { ok: false, erro: 'Esse mês ainda não começou.' };
    de = somaDias(mesIni, -10); ate = somaDias(mesFim, 10);
  }
  de = soData(de) || hoje.slice(0, 8) + '01'; ate = soData(ate) || hoje;
  if (ate > hoje) ate = hoje;
  if (de > ate) return { ok: false, erro: 'Período inválido.' };
  if ((Date.parse(ate) - Date.parse(de)) / 864e5 > 62) return { ok: false, erro: 'Escolha no máximo 2 meses por vez.' };
  // 1) extrato Sicoob, mês a mês
  const { debitos, marcas } = await lerDebitos(env, de, ate);
  // 2) contas a pagar do Bling: por vencimento (janela larga) + pagas dentro do período
  const porVenc = await pagarListar(env, 'dataVencimento', somaDias(de, -40), somaDias(ate, 20), 8);
  const porPag = await pagarListar(env, 'dataPagamento', somaDias(de, -3), somaDias(ate, 3), 3).catch(() => []);
  const fp = await formas(env);
  const contas = {}, pagasNoPeriodo = new Set(porPag.map(c => String(c.id)));
  porVenc.concat(porPag).forEach(c => {
    const f = fp[c.formaPagamento && c.formaPagamento.id] || null;
    contas[c.id] = { id: c.id, valor: r2(c.valor), venc: soData(c.vencimento), situacao: Number(c.situacao), contatoId: String((c.contato && c.contato.id) || ''),
      forma: f ? f.nome : '', formaId: (c.formaPagamento && c.formaPagamento.id) || 0, tipoForma: tipoForma(f) || (/sicoob.*d[eé]bito|debito/i.test(f && f.nome || '') ? 'outro' : ''),
      pagaNoPeriodo: pagasNoPeriodo.has(String(c.id)) };
  });
  const lc = Object.values(contas).filter(c => c.situacao !== 5 && c.situacao !== 4);
  const info = await contatosInfo(env, (mesIni ? lc.filter(c => [1, 3].includes(c.situacao) && c.venc >= mesIni && c.venc <= mesFim) : lc).map(c => c.contatoId).concat(lc.map(c => c.contatoId)), 18);
  lc.forEach(c => { const k = info.cache[c.contatoId] || {}; c.fornecedor = k.n || (c.contatoId ? 'Fornecedor #' + c.contatoId : '(sem fornecedor)'); c.doc = k.d || ''; });
  const usadas = new Set();
  Object.values(marcas).forEach(m => { if (m.contaId) usadas.add(String(m.contaId)); if (m.lancado) usadas.add(String(m.lancado)); });

  // 3) casamento débito → conta (um para um). Crédito (fatura) é tratado em grupo mais abaixo.
  const pontuar = (x, c) => {
    const dv = x.valor - c.valor;
    const exato = Math.abs(dv) <= 0.01, comJuros = dv > 0.01 && dv <= c.valor * 0.15;
    if (!exato && !comJuros) return null;
    let p = exato ? 50 : 15;
    const docOk = x.doc && c.doc && (x.doc === c.doc || (x.doc.length === 14 && c.doc.slice(0, 8) === x.doc.slice(0, 8)));
    if (docOk) p += 40;
    if (!exato && !docOk) return null;                        // juros só com mesmo CNPJ/CPF
    const dias = Math.abs((Date.parse(x.data) - Date.parse(c.venc || x.data)) / 864e5);
    p += dias <= 1 ? 15 : dias <= 5 ? 8 : dias <= 15 ? 2 : -10;
    if (c.tipoForma && c.tipoForma === x.tipo) p += 10;
    if (c.situacao === 2 && c.pagaNoPeriodo) p += 5;
    if (c.situacao === 2 && !c.pagaNoPeriodo) p -= 30;         // paga em outra data: provavelmente outra conta
    return { p, exato, docOk, juro: exato ? 0 : r2(dv), dias };
  };
  debitos.filter(x => !x.ignorado && x.tipo === 'transf').forEach(x => { x.status = 'transf'; x.motivo = 'saque/transferência entre contas próprias (não é despesa)'; });
  const ordem = debitos.filter(x => !x.ignorado && x.tipo !== 'credito' && x.tipo !== 'transf').sort((a, b) => (b.doc ? 1 : 0) - (a.doc ? 1 : 0));
  for (const x of ordem) {
    if (x.vinculo) {
      const c = contas[x.vinculo]; usadas.add(String(x.vinculo));
      x.conta = c || { id: x.vinculo, fornecedor: 'Conta ' + x.vinculo, situacao: 0 };
      x.status = c && c.situacao === 2 ? 'ok' : c && [1, 3].includes(c.situacao) ? 'baixar' : 'ok';
      x.motivo = 'vinculado no app'; continue;
    }
    if (x.lancado) { x.status = 'ok'; x.motivo = 'lançado pelo app (conta ' + x.lancado + ')'; continue; }
    const cands = lc.filter(c => !usadas.has(String(c.id))).map(c => ({ c, s: pontuar(x, c) })).filter(o => o.s && o.s.p >= 40).sort((a, b) => b.s.p - a.s.p);
    x.cands = cands.slice(0, 5).map(o => Object.assign({}, o.c, { pontos: o.s.p, juro: o.s.juro, docOk: o.s.docOk }));
    const m = cands[0];
    const unico = m && (cands.length === 1 || m.s.p - cands[1].s.p >= 15);
    if (m && unico && (m.s.docOk || m.s.p >= 65)) {
      usadas.add(String(m.c.id)); x.conta = x.cands[0];
      x.status = m.c.situacao === 2 ? 'ok' : 'baixar';
      x.motivo = (m.s.exato ? 'mesmo valor' : 'valor + juros R$ ' + m.s.juro.toFixed(2).replace('.', ',')) + (m.s.docOk ? ' e mesmo CNPJ/CPF' : '') + (m.s.dias <= 5 ? ', vencimento próximo' : '');
    } else if (cands.length) { x.status = 'escolher'; x.motivo = cands.length + ' contas possíveis'; }
    else { x.status = x.tipo === 'taxa' ? 'lancar' : 'sem_conta'; x.motivo = x.tipo === 'taxa' ? 'tarifa/taxa sem lançamento no Bling' : 'nenhuma conta a pagar com esse valor'; x.catSug = x.tipo === 'taxa' ? categoriaTaxa(x.desc + ' ' + x.compl) : 0; }
  }
  // 4) Crédito: cada débito de fatura × contas do cartão com vencimento perto da data da fatura
  const faturas = debitos.filter(x => !x.ignorado && x.tipo === 'credito');
  for (const x of faturas) {
    const doCartao = lc.filter(c => c.tipoForma === 'credito' && !usadas.has(String(c.id)) && c.venc && Math.abs((Date.parse(c.venc) - Date.parse(x.data)) / 864e5) <= 6);
    doCartao.forEach(c => usadas.add(String(c.id)));
    const soma = r2(doCartao.reduce((s, c) => s + c.valor, 0));
    const abertas = doCartao.filter(c => [1, 3].includes(c.situacao));
    x.cartao = { contas: doCartao.sort((a, b) => String(a.venc).localeCompare(String(b.venc))), soma, dif: r2(x.valor - soma), abertas: abertas.length };
    x.status = x.lancado ? 'ok' : !doCartao.length ? 'sem_conta' : Math.abs(x.cartao.dif) > 0.01 ? 'diferenca' : abertas.length ? 'baixar' : 'ok';
    x.motivo = !doCartao.length ? 'nenhuma compra no cartão com vencimento perto desta data' : Math.abs(x.cartao.dif) > 0.01 ? 'fatura ≠ soma das contas do cartão (diferença R$ ' + x.cartao.dif.toFixed(2).replace('.', ',') + ')' : 'fatura = soma das contas do cartão';
  }
  // 5) contas do Bling vencidas no período, em aberto, que nenhum débito explicou
  const emAberto = lc.filter(c => [1, 3].includes(c.situacao) && !usadas.has(String(c.id)) && c.venc >= de && c.venc <= ate)
    .sort((a, b) => String(a.venc).localeCompare(String(b.venc)));
  const resumo = {};
  debitos.forEach(x => { const t = x.tipo; resumo[t] = resumo[t] || { qtd: 0, total: 0, pend: 0 }; resumo[t].qtd++; resumo[t].total = r2(resumo[t].total + x.valor); if (!x.ignorado && x.status !== 'ok' && x.status !== 'transf') resumo[t].pend++; });
  // 6) Visão por mês (Bling → Sicoob): toda conta em aberto que vence no mês, com a sugestão do extrato ao lado
  let contasMes = null;
  if (mesIni) {
    const forte = {}, possiveis = {};
    const resumoDeb = x => ({ chave: x.chave, data: x.data, valor: x.valor, desc: x.desc, compl: x.compl, doc: x.doc, tipo: x.tipo, motivo: x.motivo });
    debitos.filter(x => !x.ignorado).forEach(x => {
      if (x.conta && x.conta.id && (x.status === 'baixar' || x.status === 'ok')) forte[x.conta.id] = Object.assign(resumoDeb(x), { juro: x.conta.juro || 0, como: 'debito' });
      if (x.status === 'escolher') (x.cands || []).forEach(c => (possiveis[c.id] = possiveis[c.id] || []).push(Object.assign(resumoDeb(x), { juro: c.juro || 0, pontos: c.pontos })));
      if (x.cartao) x.cartao.contas.forEach(c => { forte[c.id] = Object.assign(resumoDeb(x), { juro: 0, como: 'fatura', fatTotal: x.valor, fatSoma: x.cartao.soma, fatDif: x.cartao.dif }); });
    });
    contasMes = lc.filter(c => [1, 3].includes(c.situacao) && c.venc >= mesIni && c.venc <= mesFim)
      .sort((a, b) => String(a.venc).localeCompare(String(b.venc)) || b.valor - a.valor)
      .map(c => Object.assign({}, c, { sug: forte[c.id] || null, possiveis: forte[c.id] ? [] : (possiveis[c.id] || []).sort((a, b) => b.pontos - a.pontos).slice(0, 3), aVencer: c.venc > hoje }));
  }
  return { ok: true, de, ate, mes: mesIni ? mesIni.slice(0, 7) : '', mesIni, mesFim, contasMes, debitos: debitos.sort((a, b) => b.data.localeCompare(a.data)), emAberto, resumo, faltamNomes: info.faltam,
    totalDebitos: r2(debitos.reduce((s, x) => s + x.valor, 0)) };
}

async function pagarContaPorId(env, id) {
  const c = ((await bling(env, '/contas/pagar/' + encodeURIComponent(id || '')).catch(() => null)) || {}).data;
  if (!c || !c.id) return { ok: false, erro: 'Conta a pagar não encontrada no Bling.' };
  const info = await contatosInfo(env, [String((c.contato && c.contato.id) || '')], 1);
  const k = info.cache[String((c.contato && c.contato.id) || '')] || {};
  return { ok: true, conta: { id: c.id, valor: r2(c.valor), venc: soData(c.vencimento), situacao: Number(c.situacao), fornecedor: k.n || '', doc: k.d || '', historico: c.historico || '' } };
}

async function blingPost(env, caminho, corpo) {
  const tok = await tokenValido(env);
  const r = await fetch(API + caminho, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(corpo || {}) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) {
    const det = j.error && (j.error.fields ? j.error.fields.map(f => f.msg || f.message).join('; ') : (j.error.description || j.error.message));
    throw new Error('Bling ' + r.status + ': ' + (det || t.slice(0, 200)));
  }
  return j;
}
async function baixarContaPagar(env, contaId, valor, data, historico, juro) {
  const atual = ((await bling(env, '/contas/pagar/' + contaId).catch(() => null)) || {}).data;
  if (atual && ![1, 3].includes(Number(atual.situacao))) return 'já estava paga no Bling (nada feito)';
  await blingPost(env, '/contas/pagar/' + contaId + '/baixar', { data, usarDataVencimento: false, portador: { id: PORTADOR_SICOOB }, historico: historico || 'Pago pelo Sicoob - conciliado no app',
    valorPago: r2(valor), juro: r2(juro || 0), desconto: 0, acrescimo: 0, taxa: 0 });
  return 'ok';
}
async function salvarMarca(env, chave, dados) {
  const m = (await env.BLING_KV.get('pagar:marcas', 'json')) || {};
  m[chave] = Object.assign({}, m[chave] || {}, dados, { em: Date.now() });
  const ks = Object.keys(m); if (ks.length > 3000) ks.sort((a, b) => (m[a].em || 0) - (m[b].em || 0)).slice(0, ks.length - 3000).forEach(k => delete m[k]);
  await env.BLING_KV.put('pagar:marcas', JSON.stringify(m));
}

// POST /pagar/baixar {itens:[{chave?, contaId, valor, data, juro?, historico?}], usuario}
async function pagarBaixar(env, b) {
  const itens = (b.itens || []).slice(0, 20), out = [];
  for (const it of itens) {
    try {
      const res = await baixarContaPagar(env, it.contaId, Number(it.valor), soData(it.data), (it.historico || '').slice(0, 200), Number(it.juro || 0));
      if (it.chave) await salvarMarca(env, it.chave, { contaId: String(it.contaId), por: String(b.usuario || '').slice(0, 60) });
      out.push({ contaId: it.contaId, ok: true, res });
      await logAcao(env, { origem: 'pagar', acao: 'baixa_pagar', contaId: it.contaId, valor: it.valor, data: it.data, resultado: res, por: b.usuario || '' });
    } catch (e) { out.push({ contaId: it.contaId, ok: false, erro: String(e.message || e) }); }
  }
  return { ok: out.every(x => x.ok), itens: out };
}

// fornecedor pelo CPF/CNPJ; sem documento (tarifas) usa o contato do próprio banco
async function contatoPorDoc(env, doc) {
  doc = dig(doc); if (!doc) return 0;
  const k = 'cache:contatodoc:' + doc, c = await env.BLING_KV.get(k);
  if (c) return Number(c);
  const l = ((await bling(env, '/contatos?numeroDocumento=' + doc).catch(() => null)) || {}).data || [];
  const id = l.length ? l[0].id : 0;
  if (id) await env.BLING_KV.put(k, String(id), { expirationTtl: 90 * 86400 });
  return id;
}
async function contatoBanco(env) {
  const c = await env.BLING_KV.get('cache:contatobanco'); if (c) return Number(c);
  let id = await contatoPorDoc(env, '02038232000164');  // Bancoob / Banco Sicoob
  if (!id) { const l = ((await bling(env, '/contatos?pesquisa=SICOOB').catch(() => null)) || {}).data || []; id = l.length ? l[0].id : 0; }
  if (id) await env.BLING_KV.put('cache:contatobanco', String(id), { expirationTtl: 180 * 86400 });
  return id;
}

// Cadastra o fornecedor no Bling pelo CPF/CNPJ do extrato (só quando a busca pelo documento não achou: nunca duplica)
async function criarFornecedor(env, doc, nome) {
  doc = dig(doc); if (!doc) return 0;
  const ja = await contatoPorDoc(env, doc); if (ja) return ja;
  const n = String(nome || '').replace(/\s+/g, ' ').trim().slice(0, 120) || ('Fornecedor ' + doc);
  const j = await blingPost(env, '/contatos', { nome: n, tipo: doc.length === 14 ? 'J' : 'F', numeroDocumento: doc, situacao: 'A' });
  const id = (j.data && j.data.id) || j.id || 0;
  if (id) await env.BLING_KV.put('cache:contatodoc:' + doc, String(id), { expirationTtl: 90 * 86400 });
  await logAcao(env, { origem: 'pagar', acao: 'fornecedor_criado', contato: id, doc, nome: n });
  return id;
}

// POST /pagar/lancar {itens:[{chave, data, valor, categoriaId, formaId?, historico, doc?, contatoId?, tipo}], usuario}
// Cria a conta a pagar (emissão e vencimento = dia do débito) e já baixa como paga no Sicoob.
async function pagarLancar(env, b) {
  const itens = (b.itens || []).slice(0, 8), out = [];
  for (const it of itens) {
    try {
      if (!it.categoriaId) throw new Error('Escolha a categoria.');
      const m = ((await env.BLING_KV.get('pagar:marcas', 'json')) || {})[it.chave] || {};
      if (m.lancado) { out.push({ chave: it.chave, ok: true, contaId: m.lancado, res: 'já lançado antes' }); continue; }
      let contato = Number(it.contatoId || 0) || await contatoPorDoc(env, it.doc);
      if (!contato && (it.tipo === 'taxa' || !dig(it.doc))) contato = await contatoBanco(env);
      if (!contato && it.criarContato && dig(it.doc)) contato = await criarFornecedor(env, it.doc, it.nome);
      if (!contato) throw new Error(dig(it.doc) ? 'Fornecedor ' + it.doc + ' não está cadastrado no Bling. Cadastre e tente de novo (ou informe o id do contato).' : 'Informe o fornecedor (id do contato no Bling).');
      const data = soData(it.data), valor = r2(it.valor);
      const j = await blingPost(env, '/contas/pagar', { vencimento: data, dataEmissao: data, competencia: data, valor, contato: { id: contato },
        formaPagamento: { id: Number(it.formaId || PAG_FORMA[it.tipo] || PAG_FORMA.outro) }, categoria: { id: Number(it.categoriaId) }, portador: { id: PORTADOR_SICOOB },
        historico: String(it.historico || 'Débito Sicoob').slice(0, 200), ocorrencia: { tipo: '1' } });
      const id = (j.data && j.data.id) || j.id;
      if (!id) throw new Error('Bling não devolveu o id da conta criada.');
      await salvarMarca(env, it.chave, { lancado: String(id), por: String(b.usuario || '').slice(0, 60) });
      let res = 'lançada';
      try { res += ' e ' + ((await baixarContaPagar(env, id, valor, data, 'Débito Sicoob - lançado pelo app')) === 'ok' ? 'baixada' : 'já paga'); }
      catch (e) { res += ', mas a BAIXA falhou: ' + (e.message || e); }
      out.push({ chave: it.chave, ok: true, contaId: id, res });
      await logAcao(env, { origem: 'pagar', acao: 'lancar_pagar', contaId: id, valor, data, categoria: it.categoriaId, resultado: res, por: b.usuario || '' });
    } catch (e) { out.push({ chave: it.chave, ok: false, erro: String(e.message || e) }); }
  }
  return { ok: out.every(x => x.ok), itens: out };
}

// ---------------- Tarifas e taxas automáticas (todo dia) ----------------
// Tarifas de boleto (débito tipo "taxa" com valor múltiplo de R$ 1,60) dos últimos 35 dias que não existem
// no Contas a Pagar do Bling são lançados SOZINHOS (contato = Sicoob, categoria sugerida, conta Sicoob) e baixados na data do extrato.
// Decisão do Raul (10/11/2026): não depende de autorização. Nunca lança duas vezes: marca a chave do débito e confere no Bling
// se já existe conta com o mesmo vencimento e o mesmo valor (lançada à mão).
const PAG_AUTO_MAX = 6;
const PAG_AUTO_HORAS = [13, 18];   // horário de Brasília (Raul, 11/11/2026)
const PAG_AUTO_DIAS = 35;   // olha o extrato dos últimos 35 dias (pega o que ficou para trás)
// Regra do Raul (11/11/2026): automático SÓ para tarifa de valor múltiplo de R$ 1,60 (tarifa de boleto) → categoria Tarifa bancária.
// IOF, juros e taxa de cartão ficam para lançar à mão (em lote).
function tarifaBoleto(x) { const n = Math.round(x.valor / 1.6); return n >= 1 && Math.abs(n * 1.6 - x.valor) < 0.005; }   // por rodada (limite de chamadas do Worker); o cron continua na rodada seguinte
async function pagarTaxasAuto(env, opt) {
  opt = opt || {};
  const hoje = hojeLocal(), de = somaDias(hoje, -PAG_AUTO_DIAS);
  const st = (await env.BLING_KV.get('pagar:auto', 'json')) || {};
  const slot = hoje + '-' + new Date(Date.now() - 3 * 3600e3).getUTCHours();
  if (!opt.forcar && st.slot === slot && st.fim) return { ok: true, pulado: 'já feito nesta rodada' };
  const { debitos } = await lerDebitos(env, de, hoje);
  const pend = debitos.filter(x => x.tipo === 'taxa' && tarifaBoleto(x) && !x.ignorado && !x.lancado && !x.vinculo);
  let existentes = [];
  if (pend.length) existentes = await pagarListar(env, 'dataVencimento', de, hoje, 2);
  const itens = [];
  for (const x of pend) {
    const igual = existentes.find(c => soData(c.vencimento) === x.data && Math.abs(r2(c.valor) - x.valor) < 0.01);
    if (igual) { await salvarMarca(env, x.chave, { contaId: String(igual.id), por: 'automático (já existia no Bling)' }); continue; }
    itens.push({ chave: x.chave, data: x.data, valor: x.valor, categoriaId: PAG_CAT.tarifa, tipo: 'taxa',
      historico: 'Sicoob ' + brData(x.data) + ' - ' + x.desc + (x.compl ? ' - ' + x.compl : '') + ' (automático)' });
  }
  const lote = itens.slice(0, PAG_AUTO_MAX);
  const r = lote.length ? await pagarLancar(env, { itens: lote, usuario: 'automático' }) : { ok: true, itens: [] };
  const erros = (r.itens || []).filter(x => !x.ok);
  const fim = itens.length <= PAG_AUTO_MAX;
  await env.BLING_KV.put('pagar:auto', JSON.stringify({ dia: hoje, slot, fim, ultimo: Date.now(), feitos: (st.dia === hoje ? st.feitos || 0 : 0) + (r.itens || []).filter(x => x.ok).length,
    erros: erros.map(e => e.erro).slice(0, 5) }));
  if (erros.length) await registrarErro(env, 'Tarifas automáticas: ' + erros[0].erro);
  return { ok: !erros.length, lancados: (r.itens || []).filter(x => x.ok).length, restantes: Math.max(0, itens.length - lote.length), erros: erros.map(e => e.erro) };
}

// POST /pagar/marcar {chave, ignorar?:bool, tipo?:'pix'|'boleto'|'credito'|'taxa'|'outro'|'', contaId?:id|null, usuario}
async function pagarMarcar(env, b) {
  if (!b.chave) return { ok: false, erro: 'Falta a chave do débito.' };
  const d = { por: String(b.usuario || '').slice(0, 60) };
  if ('ignorar' in b) d.ign = !!b.ignorar;
  if ('tipo' in b) d.tipo = b.tipo || undefined;
  if ('contaId' in b) d.contaId = b.contaId ? String(b.contaId) : undefined;
  await salvarMarca(env, b.chave, d);
  return { ok: true };
}


// ======================================================================================================
// ---------------- Conciliação DDA: boletos do DDA (Sicoob) × Contas a Pagar do Bling ----------------
// API Cobrança Bancária Pagamentos v3 (app "JDFER Extrato", SICOOB_CLIENT_ID_CCO): escopos pagamentos_consulta e pagamentos_inclusao.
//  GET  /pagamentos/v3/boletos                         → boletos DDA do pagador (JDFER)
//  GET  /pagamentos/v3/boletos/{codigoBarras}?numeroConta=&dataPagamento=  → consulta para pagar (valor com juros/desconto, identificadorConsulta)
//  POST /pagamentos/v3/boletos/pagamentos/{codigoBarras} (header x-idempotency-key)  → PAGA (movimenta dinheiro)
//  GET  /pagamentos/v3/boletos/pagamentos/{chave}/idempotency/comprovantes?numeroConta= → acha pagamento já feito com a mesma chave
// Travas do pagamento: variável DDA_PAGAR = "sim" e segredo DDA_PIN (o Raul digita o PIN no app); só paga boleto que está no DDA da JDFER;
// limite diário DDA_LIMITE_DIA (padrão R$ 30.000); nunca paga duas vezes o mesmo boleto (chave de idempotência + registro no KV).
const SICOOB_PAG = 'https://api.sicoob.com.br/pagamentos/v3';
const SICOOB_COOP = 3054;
const DDA_RAZAO = 'JDFER COMERCIO E SERVICOS LTDA';
async function sicoobPag(env, escopo, metodo, caminho, corpo, extra) {
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID_CCO) throw new Error('Falta o app do Sicoob com a API "Cobrança Bancária Pagamentos" (variável SICOOB_CLIENT_ID_CCO).');
  let tok;
  try { tok = await sicoobToken(env, escopo); }
  catch (e) { throw new Error('O app do Sicoob ainda não tem a API "Cobrança Bancária Pagamentos" (' + escopo + '). Detalhe: ' + (e.message || e)); }
  const fazer = t => env.SICOOB_MTLS.fetch(SICOOB_PAG + caminho, { method: metodo,
    headers: Object.assign({ Authorization: 'Bearer ' + t, client_id: clientSicoob(env, escopo), Accept: 'application/json' }, corpo ? { 'Content-Type': 'application/json' } : {}, extra || {}),
    body: corpo ? JSON.stringify(corpo) : undefined });
  let r = await fazer(tok);
  if (r.status === 401) { await env.BLING_KV.delete(chaveTokenSicoob(env, escopo)); r = await fazer(await sicoobToken(env, escopo)); }
  if (r.status === 429) { await new Promise(x => setTimeout(x, 2500)); r = await fazer(tok); }
  const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = { _texto: txt.slice(0, 300) }; }
  if (!r.ok) {
    const cod = j && Array.isArray(j.mensagens) ? j.mensagens.map(m => (m.codigo ? m.codigo + ' ' : '') + (m.mensagem || '')).join('; ') : '';
    const e = new Error('Sicoob ' + r.status + ': ' + (cod || (j && (j.message || j.mensagem || j.moreInformation || j._texto)) || '').slice(0, 220)); e.status = r.status; e.txt = txt.slice(0, 400); throw e;
  }
  return j && j.resultado !== undefined ? j.resultado : j;
}
function ddaLista(o) { // primeira lista de boletos (objetos com código de barras) em qualquer nível da resposta
  if (Array.isArray(o)) { if (o.length && o[0] && typeof o[0] === 'object' && ('numeroCodigoBarras' in o[0] || 'codigoBarras' in o[0] || 'valorBoleto' in o[0])) return o; for (const x of o) { const l = ddaLista(x); if (l) return l; } return o.length ? null : o; }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) { const l = ddaLista(o[k]); if (l) return l; }
  return null;
}
function ddaNorm(b) {
  const pago = !!(b.dataPagamento || Number(b.valorPagamento || 0) > 0) || /pag|liquid|baix/i.test(String(b.descricaoSituacaoBoleto || ''));
  return { cb: String(b.numeroCodigoBarras || b.codigoBarras || '').replace(/\D/g, ''), linha: String(b.linhaDigitavel || ''),
    doc: dig(b.numeroCpfCnpjBeneficiario), nome: String(b.nomeRazaoSocialBeneficiario || b.nomeFantasiaBeneficiario || '').trim(),
    valor: r2(numBR(b.valorBoleto)), venc: soData(b.dataVencimentoBoleto), limite: soData(b.dataLimitePagamento), emissao: soData(b.dataEmissao),
    ndoc: String(b.numeroDocumento || '').trim(), situacao: String(b.descricaoSituacaoBoleto || b.codigoTipoSituacaoBoleto || ''), pagoNoBanco: pago,
    juros: !!Number(b.codigoTipoJuros || 0) };
}
// GET /boletos (documentação oficial): numeroConta*, dataInicial*, dataFinal*, situacao* (1 em aberto, 2 agendado, 3 liquidado, 4 baixado),
// tipoData* (1 vencimento, 2 emissão, 3 inclusão). Resposta: lista de BoletoDDA.
async function ddaListar(env, de, ate, situacao) {
  const conta = await contaSicoob(env);
  const p = { numeroConta: Number(conta), dataInicial: de, dataFinal: ate, situacao: situacao || 1, tipoData: 1 };
  let r;
  try { r = await sicoobPag(env, 'pagamentos_consulta', 'GET', '/boletos?' + new URLSearchParams(p)); }
  catch (e) { if (e.status === 404 || /10275|nenhum|n[aã]o encontrad/i.test(e.message)) return []; throw e; }
  return (ddaLista(r) || []).map(b => Object.assign(ddaNorm(b), { sit: Number(situacao || 1) })).filter(b => b.cb && b.valor);
}
async function ddaDiag(env) {
  const hoje = hojeLocal(), out = [];
  for (const sit of [1, 2, 3]) {
    try { const l = await ddaListar(env, somaDias(hoje, -10), somaDias(hoje, 10), sit); out.push({ situacao: sit, ok: true, qtd: l.length, exemplo: l[0] ? { nome: l[0].nome, valor: l[0].valor, venc: l[0].venc } : null }); }
    catch (e) { out.push({ situacao: sit, ok: false, erro: String(e.message).slice(0, 200) }); }
  }
  return { ok: true, testes: out };
}

// Painel do dia: DDA (vencidos não pagos dos últimos 10 dias até o dia escolhido) × contas a pagar em aberto do Bling (até o dia)
async function ddaPainel(env, dia) {
  const hoje = hojeLocal(); dia = soData(dia) || hoje;
  const de = somaDias(dia, -10);
  const abertos = await ddaListar(env, de, dia, 1);
  const agendados = await ddaListar(env, de, somaDias(dia, 5), 2).catch(() => []);
  const liquidados = await ddaListar(env, de, dia, 3).catch(() => []);
  const dda = abertos.concat(agendados, liquidados).filter(b => b.venc && (b.venc <= dia || b.sit === 2));
  const pagos = {};
  for (const b of dda) { const k = await env.BLING_KV.get('ddapago:' + b.cb, 'json'); if (k) pagos[b.cb] = k; }
  const contasRaw = await pagarListar(env, 'dataVencimento', somaDias(dia, -30), dia, 4);
  const fp = await formas(env);
  const contas = contasRaw.filter(c => [1, 3].includes(Number(c.situacao))).map(c => {
    const f = fp[c.formaPagamento && c.formaPagamento.id] || null;
    return { id: c.id, valor: r2(c.valor), venc: soData(c.vencimento), situacao: Number(c.situacao), contatoId: String((c.contato && c.contato.id) || ''), forma: f ? f.nome : '', historico: c.historico || '' };
  });
  const info = await contatosInfo(env, contas.map(c => c.contatoId), 18);
  contas.forEach(c => { const k = info.cache[c.contatoId] || {}; c.fornecedor = k.n || ('Fornecedor #' + c.contatoId); c.doc = k.d || ''; });
  const raiz = d => String(d || '').slice(0, 8);
  const tokens = s => semAcento(s).replace(/\b(LTDA|ME|EPP|EIRELI|S\/?A|SA|COMERCIO|INDUSTRIA|SERVICOS|DE|DA|DO|E)\b/g, ' ').split(/\W+/).filter(t => t.length >= 4);
  const parecido = (a, b) => { const A = tokens(a), B = new Set(tokens(b)); return A.some(t => B.has(t)); };
  const usadas = new Set(), linhas = [];
  // 1º: mesmo CNPJ (ou mesma empresa) e mesmo valor; 2º: mesmo CNPJ e valor diferente; 3º: nome parecido e mesmo valor
  const ordemDda = dda.slice().sort((a, b) => a.venc.localeCompare(b.venc) || b.valor - a.valor);
  for (const b of ordemDda) {
    const livre = contas.filter(c => !usadas.has(c.id));
    const docOk = c => b.doc && c.doc && (b.doc === c.doc || (b.doc.length === 14 && raiz(b.doc) === raiz(c.doc)));
    const igual = c => Math.abs(c.valor - b.valor) <= 0.01;
    let c = livre.filter(c => docOk(c) && igual(c)).sort((x, y) => Math.abs(Date.parse(x.venc) - Date.parse(b.venc)) - Math.abs(Date.parse(y.venc) - Date.parse(b.venc)))[0], st = 'ok';
    if (!c) { c = livre.filter(c => !b.doc && parecido(b.nome, c.fornecedor) && igual(c))[0] || livre.filter(c => !c.doc && parecido(b.nome, c.fornecedor) && igual(c))[0]; st = c ? 'provavel' : st; }
    if (!c) { c = livre.filter(docOk).sort((x, y) => Math.abs(x.valor - b.valor) - Math.abs(y.valor - b.valor))[0]; st = c ? 'divergente' : 'sem_bling'; }
    if (c) usadas.add(c.id);
    // agendado/liquidado no banco (pelo app do Sicoob ou por aqui): não paga de novo; se tiver conta no Bling em aberto, sugere só a baixa
    const pagoBanco = b.sit === 2 || b.sit === 3;
    const pg = pagos[b.cb] || (pagoBanco ? { situacao: b.sit === 2 ? 'Agendado no banco' : 'Pago no banco', data: b.venc, banco: true } : null);
    linhas.push({ st: pg ? 'pago' : st, dda: b, conta: c || null, pago: pg, dif: c ? r2(b.valor - c.valor) : 0 });
  }
  contas.filter(c => !usadas.has(c.id)).sort((a, b) => a.venc.localeCompare(b.venc)).forEach(c => linhas.push({ st: 'sem_dda', dda: null, conta: c }));
  const pend = (await env.BLING_KV.get('dda:pendentes', 'json')) || [];
  return { ok: true, dia, hoje, linhas, pendentes: pend.filter(p => !p.resolvido).slice(-50).reverse(), faltamNomes: info.faltam,
    pagarLigado: env.DDA_PAGAR === 'sim' && !!env.DDA_PIN, limiteDia: Number(env.DDA_LIMITE_DIA || 30000),
    pagoHoje: Number(((await env.BLING_KV.get('dda:dia:' + hoje, 'json')) || {}).total || 0) };
}

async function ddaChave(cb, tentativa, conta) {
  const h = await sha256hex(cb + ':' + tentativa);
  const v = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  return SICOOB_COOP + '-' + Number(conta) + '-' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-' + v + h.slice(17, 20) + '-' + h.slice(20, 32);
}
// chave para pagar este boleto, ou o pagamento já feito com ela (resposta perdida não vira pagamento em dobro)
async function ddaAcharChave(env, cb, conta) {
  for (let t = 0; t < 10; t++) {
    const k = await ddaChave(cb, t, conta);
    let ant;
    try { ant = await sicoobPag(env, 'pagamentos_consulta', 'GET', '/boletos/pagamentos/' + k + '/idempotency/comprovantes?numeroConta=' + Number(conta)); }
    catch (e) { if (/10275/.test(e.message) || e.status === 404) return { k }; throw e; }
    if (!ant) return { k };
    if (!['Cancelado', 'Rejeitado'].includes(ant.situacaoPagamento)) return { anterior: ant };
  }
  throw new Error('Este boleto já tem pagamentos demais cancelados/rejeitados.');
}

// POST /dda/pagar {cb, valor, contaId?, pin, usuario, avulso?}
async function ddaPagar(env, b) {
  if (env.DDA_PAGAR !== 'sim' || !env.DDA_PIN) return { ok: false, erro: 'Pagamento pelo app ainda desligado. No Cloudflare: variável DDA_PAGAR = sim e segredo DDA_PIN (o seu PIN).' };
  const tentKey = 'dda:pin:erros:' + hojeLocal(); const tent = Number(await env.BLING_KV.get(tentKey) || 0);
  if (tent >= 5) return { ok: false, erro: 'PIN errado 5 vezes hoje: pagamento bloqueado até amanhã.' };
  if ((await sha256hex(String(b.pin || ''))) !== (await sha256hex(String(env.DDA_PIN)))) { await env.BLING_KV.put(tentKey, String(tent + 1), { expirationTtl: 86400 }); return { ok: false, erro: 'PIN errado.', pin: true }; }
  const cb = dig(b.cb); if (cb.length !== 44) return { ok: false, erro: 'Código de barras inválido.' };
  const ja = await env.BLING_KV.get('ddapago:' + cb, 'json'); if (ja) return { ok: false, erro: 'Este boleto já foi pago pelo app em ' + brData(ja.data) + '.' };
  const trava = 'dda:trava:' + cb; if (await env.BLING_KV.get(trava)) return { ok: false, erro: 'Este boleto já está sendo pago.' };
  await env.BLING_KV.put(trava, '1', { expirationTtl: 120 });
  try {
    const hoje = hojeLocal(), conta = await contaSicoob(env);
    // 1) só boleto que está no DDA da JDFER
    const lista = await ddaListar(env, somaDias(hoje, -30), somaDias(hoje, 60), 1);
    const doDda = lista.find(x => x.cb === cb);
    if (!doDda) return { ok: false, erro: 'Esse boleto não está no DDA da JDFER: por segurança o app só paga boletos do DDA.' };
    // 2) consulta para pagar (valor do dia, juros/desconto, beneficiário)
    const q = await sicoobPag(env, 'pagamentos_consulta', 'GET', '/boletos/' + cb + '?numeroConta=' + Number(conta) + '&dataPagamento=' + hoje);
    if (q.bloquearPagamento === true) return { ok: false, erro: 'O Sicoob bloqueou o pagamento deste boleto.' };
    const valorPagar = r2(numBR(q.valorPagamento != null ? q.valorPagamento : q.valorBoleto));
    if (Math.abs(valorPagar - Number(b.valor || 0)) > 0.01) return { ok: false, erro: 'O valor a pagar hoje é ' + valorPagar.toFixed(2).replace('.', ',') + ' (com juros/desconto), diferente do que estava na tela. Confira e tente de novo.', valorNovo: valorPagar };
    // 3) limite do dia
    const limite = Number(env.DDA_LIMITE_DIA || 30000), kd = 'dda:dia:' + hoje, dd = (await env.BLING_KV.get(kd, 'json')) || { total: 0, qtd: 0 };
    if (dd.total + valorPagar > limite) return { ok: false, erro: 'Passaria do limite diário de pagamentos pelo app (R$ ' + limite.toFixed(2).replace('.', ',') + '). Já pago hoje: R$ ' + dd.total.toFixed(2).replace('.', ',') + '.' };
    // 4) chave (não paga duas vezes) e PAGAMENTO
    const kk = await ddaAcharChave(env, cb, conta);
    let pg = kk.anterior;
    if (!pg) {
      pg = await sicoobPag(env, 'pagamentos_inclusao', 'POST', '/boletos/pagamentos/' + cb, {
        identificadorConsulta: q.identificadorConsulta, valorBoleto: r2(numBR(q.valorBoleto)), valorDescontoAbatimento: r2(numBR(q.valorAbatimentoDesconto)),
        valorMultaMora: r2(numBR(q.valorMultaMora)), aceitaValorDivergente: false, numeroCpfCnpjPortador: ECONF_CNPJ, nomePortador: DDA_RAZAO,
        amount: valorPagar, date: soData(q.dataPagamento) || hoje,
        debtorAccount: { issuer: SICOOB_COOP, number: Number(conta), accountType: 0, personType: 1 },
      }, { 'x-idempotency-key': kk.k });
    }
    const sit = String((pg && pg.situacaoPagamento) || '');
    if (!['Efetivado', 'Agendado'].includes(sit)) return { ok: false, erro: 'O Sicoob não confirmou o pagamento (situação: ' + (sit || '?') + '). Confira no app do banco antes de tentar de novo.' };
    const dataPg = soData(pg.dataPagamento) || hoje;
    const reg = { data: dataPg, valor: valorPagar, situacao: sit, id: pg.idPagamento, por: String(b.usuario || '').slice(0, 60), em: Date.now(), nome: doDda.nome, doc: doDda.doc, contaId: b.contaId || null };
    await env.BLING_KV.put('ddapago:' + cb, JSON.stringify(reg), { expirationTtl: 400 * 86400 });
    dd.total = r2(dd.total + valorPagar); dd.qtd++; await env.BLING_KV.put(kd, JSON.stringify(dd), { expirationTtl: 3 * 86400 });
    await logAcao(env, { origem: 'dda', acao: 'dda_pago', cb, valor: valorPagar, situacao: sit, fornecedor: doDda.nome, por: reg.por });
    // 5) baixa no Bling (ou pendência de lançamento)
    let baixa = null;
    if (b.contaId) {
      baixa = await baixarContaPagar(env, b.contaId, valorPagar, dataPg, 'DDA Sicoob pago pelo app (' + sit + ') - ' + doDda.nome, Math.max(0, r2(valorPagar - Number(b.valorConta || valorPagar)))).catch(e => 'ERRO: ' + (e.message || e));
    } else {
      const pend = (await env.BLING_KV.get('dda:pendentes', 'json')) || [];
      pend.push({ cb, nome: doDda.nome, doc: doDda.doc, valor: valorPagar, venc: doDda.venc, data: dataPg, ndoc: doDda.ndoc, por: reg.por, em: Date.now() });
      await env.BLING_KV.put('dda:pendentes', JSON.stringify(pend.slice(-200)));
    }
    return { ok: true, situacao: sit, data: dataPg, valor: valorPagar, baixa, pendente: !b.contaId };
  } finally { await env.BLING_KV.delete(trava); }
}
async function ddaPendenteResolver(env, b) {
  const pend = (await env.BLING_KV.get('dda:pendentes', 'json')) || [];
  const p = pend.find(x => x.cb === dig(b.cb)); if (!p) return { ok: false, erro: 'Pendência não encontrada.' };
  p.resolvido = { por: String(b.usuario || '').slice(0, 60), em: Date.now(), contaId: b.contaId || null };
  await env.BLING_KV.put('dda:pendentes', JSON.stringify(pend));
  return { ok: true };
}
