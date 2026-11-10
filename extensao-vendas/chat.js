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
      (!meu && S.sel === 'todos' ? '<span class="qm">' + esc(nome(m.de)) + '</span>' : '') + htmlArq(m) + esc(m.txt) + '<span class="hr">' + hora(m.t) + st + '</span></div>';
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
async function gravar(m, res) {
  var para = S.com, conv = convDe(S.eu, para), t = m.t, av = !!m.av;
  await api('chat/' + encodeURIComponent(conv) + '.json', { method: 'POST', body: m });
  var p = {};
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
  desenharMsgs();
}
function ocupado(sim, txt) { S.enviando = sim; $('enviar').disabled = sim; $('enviar').textContent = sim ? (txt || 'Enviando...') : 'Enviar ➤'; }
function pedeAvisoTodos() { var av = admin() && $('chkAv').checked; return !(av && S.com === 'todos' && !confirm('Mandar este AVISO NA TELA para TODOS os colaboradores?')); }
async function enviar() {
  var txt = $('txt').value.trim(); if (!txt || S.enviando || !S.com) return;
  if (!pedeAvisoTodos()) return;
  var av = admin() && $('chkAv').checked;
  ocupado(true);
  try {
    var m = { de: S.eu, para: S.com, t: Date.now(), txt: txt.slice(0, 4000) }; if (av) m.av = 1;
    await gravar(m, txt.replace(/\s+/g, ' ').slice(0, 140));
    $('txt').value = ''; $('txt').style.height = ''; $('chkAv').checked = false;
  } catch (e) { alert('Não consegui enviar: ' + e.message); }
  ocupado(false); $('txt').focus();
}

// ---------- anexos (mesmo formato do app: chatArq/{id}) ----------
var MAX_ARQ = 5 * 1024 * 1024;
function tam(b) { b = Number(b) || 0; return b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1).replace('.', ',') + ' MB'; }
function imgJpeg(file, max, q) {
  return new Promise(function (res, rej) {
    var u = URL.createObjectURL(file), img = new Image();
    img.onload = function () { var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)); var c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s); var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); res(c.toDataURL('image/jpeg', q)); };
    img.onerror = function () { URL.revokeObjectURL(u); rej(new Error('não consegui abrir a imagem')); }; img.src = u;
  });
}
function b64De(file) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(String(fr.result).split(',')[1] || ''); }; fr.onerror = function () { rej(new Error('não consegui ler o arquivo')); }; fr.readAsDataURL(file); }); }
async function prepArq(file) {
  if (/^image\/(jpeg|png|webp|bmp)$/i.test(file.type)) {
    var full = await imgJpeg(file, 1920, 0.85), th = await imgJpeg(file, 360, 0.6), b = full.split(',')[1];
    return { nome: String(file.name || 'foto').replace(/\.[a-z0-9]+$/i, '') + '.jpg', tipo: 'image/jpeg', tam: Math.round(b.length * 0.75), b64: b, th: th };
  }
  if (file.size > MAX_ARQ) throw new Error('"' + file.name + '" tem ' + tam(file.size) + '. O limite é 5 MB.');
  var o = { nome: String(file.name || 'arquivo').slice(0, 120), tipo: file.type || 'application/octet-stream', tam: file.size, b64: await b64De(file) };
  if (/^image\/gif$/i.test(file.type)) o.th = 'data:image/gif;base64,' + o.b64;
  return o;
}
async function enviarArqs(files) {
  files = Array.prototype.slice.call(files || []); if (!files.length || !S.com) return;
  if (S.enviando) { alert('Espere terminar o envio anterior.'); return; }
  if (!pedeAvisoTodos()) return;
  var leg = $('txt').value.trim(), av = admin() && $('chkAv').checked, conv = convDe(S.eu, S.com), erros = [];
  for (var i = 0; i < files.length; i++) {
    ocupado(true, 'Enviando ' + (i + 1) + '/' + files.length + '...');
    try {
      var a = await prepArq(files[i]), t = Date.now();
      var r = await api('chatArq.json', { method: 'POST', body: { nome: a.nome, tipo: a.tipo, tam: a.tam, b64: a.b64, de: S.eu, conv: conv, t: t } });
      var m = { de: S.eu, para: S.com, t: t, txt: i === 0 ? leg.slice(0, 4000) : '', arq: { id: r.name, nome: a.nome, tipo: a.tipo, tam: a.tam } };
      if (a.th) m.arq.th = a.th; if (av) m.av = 1;
      await gravar(m, (a.th ? '📷 Foto' : '📎 ' + a.nome) + (m.txt ? ' — ' + m.txt.replace(/\s+/g, ' ').slice(0, 100) : ''));
    } catch (e) { erros.push(files[i].name + ': ' + e.message); }
  }
  ocupado(false);
  if (!erros.length) { $('txt').value = ''; $('txt').style.height = ''; }
  $('chkAv').checked = false;
  if (erros.length) alert('Não consegui enviar:\n' + erros.join('\n'));
}
async function baixar(id, nomeArq, abrirAba) {
  try {
    var a = await api('chatArq/' + encodeURIComponent(id) + '.json'); if (!a || !a.b64) throw new Error('arquivo não encontrado');
    var bin = atob(a.b64), u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([u8], { type: a.tipo || 'application/octet-stream' }));
    if (abrirAba) chrome.tabs.create({ url: url });
    else { var l = document.createElement('a'); l.href = url; l.download = nomeArq || a.nome || 'arquivo'; document.body.appendChild(l); l.click(); l.remove(); }
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  } catch (e) { alert('Não consegui baixar: ' + e.message); }
}
function htmlArq(m) {
  var a = m.arq; if (!a) return '';
  var id = esc(a.id), nm = esc(a.nome);
  if (a.th) return '<img class="img" src="' + esc(a.th) + '" data-arq="' + id + '" data-nome="' + nm + '" title="Clique para ver grande"><button class="sv" data-arq="' + id + '" data-nome="' + nm + '">⬇️ Salvar no computador</button>';
  var ic = /pdf/i.test(a.tipo) ? '📕' : /sheet|excel|csv/i.test(a.tipo + a.nome) ? '📗' : /word|document/i.test(a.tipo) ? '📘' : /zip|rar|7z/i.test(a.tipo + a.nome) ? '🗜️' : '📄';
  return '<div class="arq"><span class="ic">' + ic + '</span><span class="tx"><b>' + nm + '</b><small>' + tam(a.tam) + '</small></span></div><button class="sv" data-arq="' + id + '" data-nome="' + nm + '">⬇️ Salvar no computador</button>';
}

// ---------- aviso de uso (uma vez por pessoa; fica registrado em chatTermo/{login}) ----------
async function termo() {
  var st = await chrome.storage.local.get(['chatTermoOk']);
  if (st.chatTermoOk === S.eu) return;
  var j = null; try { j = await api('chatTermo/' + encodeURIComponent(k(S.eu)) + '.json'); } catch (e) {}
  if (j) { chrome.storage.local.set({ chatTermoOk: S.eu }); return; }
  $('termo').classList.remove('oculto');
  $('termoOk').onclick = function () {
    chrome.storage.local.set({ chatTermoOk: S.eu });
    api('chatTermo/' + encodeURIComponent(k(S.eu)) + '.json', { method: 'PUT', body: { t: Date.now(), onde: 'extensão' } }).catch(function () {});
    $('termo').classList.add('oculto');
  };
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
  $('clip').onclick = function () { $('arq').click(); };
  $('arq').onchange = function () { enviarArqs($('arq').files).then(function () { $('arq').value = ''; }); };
  $('txt').addEventListener('paste', function (e) { var f = e.clipboardData && e.clipboardData.files; if (f && f.length) { e.preventDefault(); enviarArqs(f); } });
  document.addEventListener('dragover', function (e) { if (S.sel) { e.preventDefault(); document.body.classList.add('arrastando'); } });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) document.body.classList.remove('arrastando'); });
  document.addEventListener('drop', function (e) { document.body.classList.remove('arrastando'); if (!S.sel) return; e.preventDefault(); enviarArqs(e.dataTransfer.files); });
  $('msgs').addEventListener('click', function (e) { var b = e.target.closest('[data-arq]'); if (b) baixar(b.getAttribute('data-arq'), b.getAttribute('data-nome'), b.tagName === 'IMG'); });
  $('lista').innerHTML = '<div class="vazio">Carregando...</div>';
  try { await Promise.all([carregarUsers(), carregarCaixa()]); } catch (e) { $('lista').innerHTML = '<div class="vazio">Não consegui carregar: ' + esc(e.message) + '<br>Abra o app e entre de novo.</div>'; return; }
  termo();
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
