// Janela de Chat da extensão (abre pelo botão 💬 Chat do popup, ou sozinha quando chega um aviso).
// Usa os MESMOS dados do Chat do app (aba T.I. › Chat), então a conversa é a mesma nos dois lugares:
//   chat/{conv}/{id} = {de, para, t, txt, av}       conv = "todos" ou os 2 logins em ordem alfabética ("joao__raul")
//   chatCaixa/{login}/{conv} = {com, ult, ultT, ultDe, n (não lidas), av (aviso pendente), lidoT}
// Qualquer pessoa conversa com qualquer pessoa ou com Todos. Só o administrador manda "Aviso na tela".
var FB = 'https://maisacessivel-1d0ad-default-rtdb.firebaseio.com';
var S = { eu: '', role: '', users: [], nomes: {}, caixa: {}, sel: null, com: null, msgs: [], lido: 0, ult: 0, enviando: false, busca: '' };
var $ = function (id) { return document.getElementById(id); };

function k(u) { return String(u || '').trim().toLowerCase().replace(/[.#$\[\]\/\s]+/g, '_') || '_'; }
function convDe(a, b) { if (b === 'todos') return 'todos'; var x = [k(a), k(b)].sort(); return x[0] + '__' + x[1]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function nome(u) { return u === 'todos' ? 'Todos' : (S.nomes[u] || u || '?'); }
function hora(t) {
  if (!t) return ''; var d = new Date(t), h = new Date();
  var hh = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === h.toDateString() ? hh : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hh;
}
function admin() { return S.role === 'admin'; }
async function api(caminho, opt) {
  var r = await fetch(FB + '/' + caminho, opt ? { method: opt.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opt.body) } : undefined);
  if (!r.ok) throw new Error('Banco respondeu ' + r.status);
  return r.json();
}
function avisarBackground() { try { chrome.runtime.sendMessage({ action: 'chatAtualizar' }, function () { void chrome.runtime.lastError; }); } catch (e) {} }

// ---------- dados ----------
async function carregarUsers() {
  var u = await api('usuarios.json') || {};
  S.nomes = {}; S.users = [];
  Object.keys(u).forEach(function (id) {
    var x = u[id]; if (!x || !x.usuario) return;
    S.nomes[x.usuario] = x.nome || x.usuario;
    if (x.ativo && x.usuario !== S.eu) S.users.push(x);
  });
  S.users.sort(function (a, b) { return String(a.nome || a.usuario).localeCompare(String(b.nome || b.usuario), 'pt-BR'); });
}
async function carregarCaixa() { S.caixa = await api('chatCaixa/' + encodeURIComponent(k(S.eu)) + '.json') || {}; }
async function carregarMsgs() {
  var conv = S.sel;
  var j = await api('chat/' + encodeURIComponent(conv) + '.json?orderBy="$key"&limitToLast=200') || {};
  var lido = 0;
  if (conv !== 'todos') { try { lido = Number(await api('chatCaixa/' + encodeURIComponent(k(S.com)) + '/' + encodeURIComponent(conv) + '/lidoT.json')) || 0; } catch (e) {} }
  if (S.sel !== conv) return false;
  var l = Object.keys(j).sort().map(function (x) { return j[x]; }).filter(Boolean);
  var ult = l.length ? l[l.length - 1].t : 0, mudou = ult !== S.ult || lido !== S.lido || l.length !== S.msgs.length;
  S.msgs = l; S.lido = lido; S.ult = ult;
  return mudou;
}
function marcarLida(conv, ciente) {
  var c = S.caixa[conv];
  if (!c) return;
  if (c.av && !ciente) return; // aviso: só some quando a pessoa clica em "Ciente"
  if (!(c.n > 0) && !c.av && (c.lidoT || 0) >= (c.ultT || 0)) return;
  var agora = Date.now(); c.n = 0; c.av = null; c.lidoT = agora;
  api('chatCaixa/' + encodeURIComponent(k(S.eu)) + '/' + encodeURIComponent(conv) + '.json', { method: 'PATCH', body: { n: 0, av: null, lidoT: agora } })
    .then(avisarBackground).catch(function () {});
}

// ---------- telas ----------
function desenharLista() {
  var itens = { todos: { conv: 'todos', com: 'todos', nome: '📢 Todos' } };
  S.users.forEach(function (u) { var c = convDe(S.eu, u.usuario); itens[c] = { conv: c, com: u.usuario, nome: u.nome || u.usuario }; });
  Object.keys(S.caixa).forEach(function (c) { var x = S.caixa[c]; if (!x || !x.com) return; itens[c] = itens[c] || { conv: c, com: x.com, nome: nome(x.com) }; Object.assign(itens[c], { ult: x.ult, ultT: x.ultT, ultDe: x.ultDe, n: x.n, av: x.av }); });
  var q = S.busca.trim().toLowerCase();
  var l = Object.keys(itens).map(function (c) { return itens[c]; })
    .filter(function (x) { return !q || String(x.nome).toLowerCase().indexOf(q) >= 0; })
    .sort(function (a, b) { return (a.conv === 'todos' ? -1 : 0) - (b.conv === 'todos' ? -1 : 0) || (b.ultT || 0) - (a.ultT || 0) || String(a.nome).localeCompare(String(b.nome), 'pt-BR'); });
  $('lista').innerHTML = l.map(function (x) {
    var n = Number(x.n) || 0;
    return '<div class="it" data-conv="' + esc(x.conv) + '" data-com="' + esc(x.com) + '">' +
      '<div class="av' + (x.conv === 'todos' ? ' todos' : '') + '">' + (x.conv === 'todos' ? '📢' : esc(String(x.nome).charAt(0).toUpperCase())) + '</div>' +
      '<div class="tx"><div class="nm"><span>' + esc(x.nome) + '</span><small>' + hora(x.ultT) + '</small></div>' +
      '<div class="pv' + (n ? ' nl' : '') + '">' + (x.av && n ? '🔔 ' : '') + (x.ult ? (x.ultDe === S.eu ? 'Você: ' : (x.conv === 'todos' && x.ultDe ? esc(nome(x.ultDe)) + ': ' : '')) + esc(x.ult) : '<i>' + (x.conv === 'todos' ? 'Mensagem para toda a equipe' : 'Sem mensagens') + '</i>') + '</div></div>' +
      (n ? '<span class="bd">' + n + '</span>' : '') + '</div>';
  }).join('') || '<div class="vazio">Ninguém encontrado.</div>';
  $('lista').querySelectorAll('.it').forEach(function (d) { d.onclick = function () { abrir(d.getAttribute('data-conv'), d.getAttribute('data-com')); }; });
}
function desenharAviso() {
  var c = S.caixa[S.sel], box = $('aviso');
  var m = null;
  if (c && c.av) for (var i = S.msgs.length - 1; i >= 0; i--) { if (S.msgs[i].av && S.msgs[i].de !== S.eu) { m = S.msgs[i]; break; } }
  if (!m) { box.classList.add('oculto'); return; }
  box.classList.remove('oculto');
  box.innerHTML = '<div class="t">🔔 AVISO IMPORTANTE' + (S.sel === 'todos' ? ' PARA TODOS' : '') + '</div><div class="de">de <b>' + esc(nome(m.de)) + '</b> · ' + hora(m.t) + '</div>' +
    '<div class="x">' + esc(m.txt) + '</div><button id="ciente">✔ Ciente</button>';
  $('ciente').onclick = function () { marcarLida(S.sel, true); box.classList.add('oculto'); desenharMsgs(); };
}
function desenharMsgs() {
  var box = $('msgs');
  var perto = box.scrollHeight - box.scrollTop - box.clientHeight < 120 || !box.querySelector('.m');
  if (!S.msgs.length) { box.innerHTML = '<div class="vazio">Nenhuma mensagem ainda.<br>Escreva abaixo para começar.</div>'; return; }
  var ultMinha = -1; S.msgs.forEach(function (m, i) { if (m.de === S.eu) ultMinha = i; });
  box.innerHTML = S.msgs.map(function (m, i) {
    var meu = m.de === S.eu, st = '';
    if (meu && i === ultMinha && S.sel !== 'todos') st = S.lido >= m.t ? ' · ✓✓ Vista' : ' · ✓ Enviada';
    return '<div class="m ' + (meu ? 'eu' : 'ele') + (m.av ? ' aw' : '') + '">' + (m.av ? '<span class="tg">🔔 AVISO IMPORTANTE</span>' : '') +
      (!meu && S.sel === 'todos' ? '<span class="qm">' + esc(nome(m.de)) + '</span>' : '') + esc(m.txt) + '<span class="hr">' + hora(m.t) + st + '</span></div>';
  }).join('');
  if (perto) box.scrollTop = box.scrollHeight;
}
function telaLista() {
  S.sel = null; S.com = null;
  $('voltar').classList.add('oculto'); $('titulo').innerHTML = '💬 Chat<small>' + esc(nome(S.eu)) + '</small>';
  ['busca', 'lista'].forEach(function (i) { $(i).classList.remove('oculto'); });
  ['msgs', 'comp', 'aviso'].forEach(function (i) { $(i).classList.add('oculto'); });
  desenharLista();
}
async function abrir(conv, com) {
  S.sel = conv; S.com = com; S.msgs = []; S.lido = 0; S.ult = 0;
  $('voltar').classList.remove('oculto');
  $('titulo').innerHTML = esc(com === 'todos' ? '📢 Todos' : nome(com)) + '<small>' + (com === 'todos' ? 'Mensagem para toda a equipe' : esc(com)) + '</small>';
  ['busca', 'lista'].forEach(function (i) { $(i).classList.add('oculto'); });
  ['msgs', 'comp'].forEach(function (i) { $(i).classList.remove('oculto'); });
  $('lblAv').classList.toggle('oculto', !admin());
  $('msgs').innerHTML = '<div class="vazio">Carregando...</div>';
  try { await carregarMsgs(); } catch (e) { $('msgs').innerHTML = '<div class="vazio">Não consegui carregar: ' + esc(e.message) + '</div>'; return; }
  desenharMsgs(); desenharAviso(); marcarLida(conv, false);
  $('txt').focus();
}

// ---------- enviar ----------
async function enviar() {
  var txt = $('txt').value.trim(); if (!txt || S.enviando || !S.com) return;
  var av = admin() && $('chkAv').checked;
  if (av && S.com === 'todos' && !confirm('Mandar este AVISO NA TELA para TODOS os colaboradores?')) return;
  S.enviando = true; $('enviar').disabled = true; $('enviar').textContent = 'Enviando...';
  var para = S.com, conv = convDe(S.eu, para), t = Date.now();
  try {
    var m = { de: S.eu, para: para, t: t, txt: txt.slice(0, 4000) }; if (av) m.av = 1;
    await api('chat/' + encodeURIComponent(conv) + '.json', { method: 'POST', body: m });
    var res = txt.replace(/\s+/g, ' ').slice(0, 140), p = {};
    var destinos = para === 'todos' ? S.users.map(function (u) { return u.usuario; }) : [para];
    destinos.forEach(function (d) {
      var kd = k(d) + '/' + conv;
      p[kd + '/com'] = para === 'todos' ? 'todos' : S.eu; p[kd + '/ult'] = res; p[kd + '/ultT'] = t; p[kd + '/ultDe'] = S.eu;
      p[kd + '/n'] = { '.sv': { 'increment': 1 } }; if (av) p[kd + '/av'] = 1;
    });
    var ke = k(S.eu) + '/' + conv;
    p[ke + '/com'] = para; p[ke + '/ult'] = res; p[ke + '/ultT'] = t; p[ke + '/ultDe'] = S.eu;
    await api('chatCaixa.json', { method: 'PATCH', body: p });
    S.msgs.push(m); S.ult = t;
    var c = S.caixa[conv] = S.caixa[conv] || {}; c.com = para; c.ult = res; c.ultT = t; c.ultDe = S.eu;
    $('txt').value = ''; $('txt').style.height = ''; $('chkAv').checked = false;
    desenharMsgs();
  } catch (e) { alert('Não consegui enviar: ' + e.message); }
  S.enviando = false; $('enviar').disabled = false; $('enviar').textContent = 'Enviar ➤'; $('txt').focus();
}

// ---------- início ----------
async function iniciar() {
  var st = await chrome.storage.local.get(['appUsuario', 'appRole', 'fbAuth']);
  S.eu = st.appUsuario || ''; S.role = st.appRole || '';
  if (!S.eu || !st.fbAuth) {
    ['busca', 'lista'].forEach(function (i) { $(i).classList.add('oculto'); });
    document.body.insertAdjacentHTML('beforeend', '<div class="info">👤 Abra o <b>app Mais Acessível</b> neste computador e entre com <b>seu login</b> uma vez. Depois feche e abra o Chat de novo.</div>');
    return;
  }
  $('voltar').onclick = function () { telaLista(); carregarCaixa().then(desenharLista).catch(function () {}); };
  $('busca').oninput = function () { S.busca = this.value; desenharLista(); };
  $('txt').onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } };
  $('txt').oninput = function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; };
  $('enviar').onclick = enviar;
  $('lista').innerHTML = '<div class="vazio">Carregando...</div>';
  try { await Promise.all([carregarUsers(), carregarCaixa()]); } catch (e) { $('lista').innerHTML = '<div class="vazio">Não consegui carregar: ' + esc(e.message) + '<br>Abra o app e entre de novo.</div>'; return; }
  var q = new URLSearchParams(location.search);
  if (q.get('conv') && q.get('com')) abrir(q.get('conv'), q.get('com')); else telaLista();
  // atualiza sozinho a cada 5 s enquanto a janela está aberta
  setInterval(async function () {
    try {
      await carregarCaixa();
      if (S.sel) { if (await carregarMsgs()) { desenharMsgs(); desenharAviso(); } marcarLida(S.sel, false); }
      else desenharLista();
    } catch (e) {}
  }, 5000);
  // background pede para abrir outra conversa nesta mesma janela (chegou aviso novo)
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.action === 'chatAbrirConv' && msg.conv) { carregarCaixa().then(function () { abrir(msg.conv, msg.com); }).catch(function () {}); }
  });
}
iniciar();
