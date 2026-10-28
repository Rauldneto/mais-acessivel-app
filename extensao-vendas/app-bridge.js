// Ponte entre o app Mais Acessível (github.io) e a extensão.
// O app manda window.postMessage({source:'ma-app', ...}) e recebe {source:'ma-ext', ...}.
(function() {
  var versao = chrome.runtime.getManifest().version;
  document.documentElement.setAttribute('data-ma-ext', versao);
  // guarda quem está logado no app neste computador (usado para mostrar/esconder botões do popup)
  function salvarUsuarioApp() {
    try {
      var ss = JSON.parse(localStorage.getItem('maisacessivel_session') || 'null');
      chrome.storage.local.set({ appUsuario: (ss && ss.usuario) || '', appRole: (ss && ss.role) || '' });
    } catch (e) {}
  }
  salvarUsuarioApp();
  setInterval(salvarUsuarioApp, 20000);
  window.addEventListener('storage', salvarUsuarioApp);
  window.postMessage({ source: 'ma-ext', type: 'pronta', versao: versao }, '*');

  window.addEventListener('message', function(e) {
    if (e.source !== window || !e.data || e.data.source !== 'ma-app') return;
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
    if (req.type === 'auditar' || req.type === 'relacionados' || req.type === 'perdas' || req.type === 'situacao') {
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
