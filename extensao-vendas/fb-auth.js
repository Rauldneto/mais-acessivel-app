// Login seguro do banco (Firebase) dentro da extensão.
// O app, quando está aberto neste computador, entrega o "crachá" (token) do usuário logado
// pelo app-bridge.js, que guarda em chrome.storage.local (chave fbAuth).
// Este arquivo faz todo fetch da extensão ao banco levar esse crachá e o renova sozinho.
// Sem crachá (app nunca logado neste computador, ou login antigo), o fetch segue como antes.
(function (g) {
  var FB = 'https://maisacessivel-1d0ad-default-rtdb.firebaseio.com';
  var _fetch = g.fetch.bind(g);
  var renovando = null;

  function ler() {
    return new Promise(function (ok) {
      try { chrome.storage.local.get('fbAuth', function (o) { void chrome.runtime.lastError; ok((o && o.fbAuth) || null); }); }
      catch (e) { ok(null); }
    });
  }
  function gravar(st) {
    return new Promise(function (ok) {
      try { chrome.storage.local.set({ fbAuth: st }, function () { void chrome.runtime.lastError; ok(); }); }
      catch (e) { ok(); }
    });
  }
  function renovar(st) {
    if (renovando) return renovando;
    renovando = (async function () {
      try {
        var r = await _fetch('https://securetoken.googleapis.com/v1/token?key=' + st.k, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(st.refreshToken)
        });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) return null;
        var novo = Object.assign({}, st, {
          idToken: j.id_token, refreshToken: j.refresh_token || st.refreshToken,
          exp: Date.now() + (parseInt(j.expires_in, 10) || 3600) * 1000
        });
        await gravar(novo);
        return novo;
      } catch (e) { return null; } // sem internet: tenta de novo depois
      finally { renovando = null; }
    })();
    return renovando;
  }
  async function token(forcar) {
    var st = await ler();
    if (!st || !st.refreshToken || !st.k) return null;
    if (forcar || !st.idToken || Date.now() > (st.exp || 0) - 120000) {
      var n = await renovar(st);
      return n && n.idToken;
    }
    return st.idToken;
  }
  function comToken(url, t) { return url + (url.indexOf('?') > -1 ? '&' : '?') + 'auth=' + encodeURIComponent(t); }

  // Worker da IA: exige o token do login para não gastarem os créditos da Anthropic
  var IA = 'https://soft-limit-b3a1.rauldias.workers.dev';
  function comCracha(init, t) { var o = Object.assign({}, init || {}); var h = new Headers(o.headers || {}); h.set('Authorization', 'Bearer ' + t); o.headers = h; return o; }

  g.fetch = async function (input, init) {
    if (typeof input === 'string' && input.indexOf(IA) === 0) {
      var ti = await token();
      if (ti) {
        var ri = await _fetch(input, comCracha(init, ti));
        if (ri.status === 401) { ti = await token(true); if (ti) ri = await _fetch(input, comCracha(init, ti)); }
        return ri;
      }
    }
    if (typeof input === 'string' && input.indexOf(FB) === 0) {
      var t = await token();
      if (t) {
        var r = await _fetch(comToken(input, t), init);
        if (r.status === 401) { t = await token(true); if (t) r = await _fetch(comToken(input, t), init); }
        return r;
      }
    }
    return _fetch(input, init);
  };
})(typeof self !== 'undefined' ? self : window);
