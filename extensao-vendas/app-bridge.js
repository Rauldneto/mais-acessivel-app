// Ponte entre o app Mais Acessível (github.io) e a extensão.
// O app manda window.postMessage({source:'ma-app', ...}) e recebe {source:'ma-ext', ...}.
(function() {
  var versao = chrome.runtime.getManifest().version;
  // v2.1.9: a mesma extensão pode estar instalada pela loja do Chrome (instalação automática) ou pelo
  // modo desenvolvedor (pasta C:\MaisAcessivel). Se a da loja estiver presente, a do modo desenvolvedor
  // para de atender o app e se desinstala sozinha (background.js), para não haver duas fazendo a mesma coisa.
  var LOJA_ID = 'ojhkakepmgbmhnfoabkmmjbpilmhhmpj';
  var souLoja = chrome.runtime.id === LOJA_ID;
  var html = document.documentElement;
  function lojaPresente() { return !souLoja && html.hasAttribute('data-ma-ext-loja'); }
  function marcar() {
    if (souLoja) { html.setAttribute('data-ma-ext-loja', versao); html.setAttribute('data-ma-ext', versao); }
    else if (!lojaPresente()) html.setAttribute('data-ma-ext', versao);
    else { try { chrome.runtime.sendMessage({ action: 'sairDevPorLoja' }, function() { void chrome.runtime.lastError; }); } catch (e) {} }
  }
  marcar();
  setTimeout(marcar, 3000);
  setInterval(marcar, 20000);
  // guarda quem está logado no app neste computador (usado para mostrar/esconder botões do popup)
  function salvarUsuarioApp() {
    try {
      var ss = JSON.parse(localStorage.getItem('maisacessivel_session') || 'null');
      chrome.storage.local.set({ appUsuario: (ss && ss.usuario) || '', appRole: (ss && ss.role) || '' });
      // crachá do login seguro: a extensão usa para acessar o banco (fb-auth.js)
      var fa = JSON.parse(localStorage.getItem('maisacessivel_fbauth') || 'null');
      if (fa && fa.refreshToken && fa.k) {
        chrome.storage.local.set({ fbAuth: { uid: fa.uid, k: fa.k, refreshToken: fa.refreshToken, idToken: fa.idToken, exp: fa.exp } });
      } else if (!ss) {
        chrome.storage.local.remove('fbAuth'); // saiu do app: a extensão também perde o acesso
      }
    } catch (e) {}
  }
  salvarUsuarioApp();
  setInterval(salvarUsuarioApp, 20000);
  window.addEventListener('storage', salvarUsuarioApp);
  if (!lojaPresente()) window.postMessage({ source: 'ma-ext', type: 'pronta', versao: versao }, '*');

  window.addEventListener('message', function(e) {
    if (e.source !== window || !e.data || e.data.source !== 'ma-app') return;
    if (lojaPresente()) return; // a da loja responde; esta (modo desenvolvedor) está saindo
    var req = e.data;
    if (req.type === 'ping') {
      window.postMessage({ source: 'ma-ext', type: 'pronta', versao: versao, reqId: req.reqId }, '*');
      return;
    }
    if (req.type === 'recarregarExt') {
      try { chrome.runtime.sendMessage({ action: 'recarregarExt' }, function() { void chrome.runtime.lastError; }); } catch (err) {}
      window.postMessage({ source: 'ma-ext', type: 'recarregando', versao: versao }, '*');
      return;
    }
    if (req.type === 'cenprotAuto') {
      try {
        chrome.runtime.sendMessage({ action: 'cenprotAuto', cnpj: req.cnpj || '' }, function(resp) {
          var erro = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
          var r = resp || { ok: false, erro: erro || 'Sem resposta da extensão' };
          window.postMessage(Object.assign({ source: 'ma-ext', type: 'cenprotResp', reqId: req.reqId }, r), '*');
        });
      } catch (err) {
        window.postMessage({ source: 'ma-ext', type: 'cenprotResp', reqId: req.reqId, ok: false, erro: 'Extensão foi atualizada: recarregue o app (🔄 Atualizar).' }, '*');
      }
      return;
    }
    if (req.type === 'finBling') {
      try {
        chrome.runtime.sendMessage({ action: 'finBling', op: req.op, dados: req.dados || {} }, function(resp) {
          var erro = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
          window.postMessage(Object.assign({ source: 'ma-ext', type: 'finResp', reqId: req.reqId }, resp || { ok: false, erro: erro || 'Sem resposta da extensão' }), '*');
        });
      } catch (err) {
        window.postMessage({ source: 'ma-ext', type: 'finResp', reqId: req.reqId, ok: false, erro: 'Extensão foi atualizada: recarregue o app (🔄 Atualizar).' }, '*');
      }
      return;
    }
    if (req.type === 'auditar' || req.type === 'relacionados' || req.type === 'perdas' || req.type === 'situacao' || req.type === 'reativacao') {
      var port;
      try { port = chrome.runtime.connect({ name: 'auditoria' }); }
      catch (err) {
        window.postMessage({ source: 'ma-ext', reqId: req.reqId, type: 'erro', msg: 'Extensão foi atualizada: recarregue o app (🔄 Atualizar).' }, '*');
        return;
      }
      port.onMessage.addListener(function(m) {
        var out = Object.assign({ source: 'ma-ext', reqId: req.reqId }, m);
        window.postMessage(out, '*');
        if (m.type === 'fim' || m.type === 'erro') try { port.disconnect(); } catch (x) {}
      });
      port.postMessage({ type: req.type, filtro: req.filtro || {} });
    }
  });
})();
