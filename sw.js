// Service worker do app Mais Acessível.
// Só faz UMA coisa: recebe comprovantes compartilhados pelo Android (botão Compartilhar -> "Despesas")
// e entrega para a tela de Enviar do Financeiro. Todo o resto do app passa direto, sem cache.
var PASTA = 'dsp-compartilhado';
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'POST' || !/\/compartilhar\/?$/.test(u.pathname)) return;
  e.respondWith((async function() {
    try {
      var fd = await e.request.formData();
      var arqs = fd.getAll('arquivos').filter(function(f) { return f && f.size; }).slice(0, 4);
      var c = await caches.open(PASTA);
      var velhos = await c.keys(); await Promise.all(velhos.map(function(k) { return c.delete(k); }));
      for (var i = 0; i < arqs.length; i++) {
        await c.put(new Request('./compartilhado/' + i), new Response(arqs[i], { headers: { 'Content-Type': arqs[i].type || 'image/jpeg', 'X-Nome': encodeURIComponent(arqs[i].name || ('comprovante' + i)) } }));
      }
      var txt = [fd.get('title'), fd.get('text')].filter(Boolean).join(' ').slice(0, 200);
      if (txt) await c.put(new Request('./compartilhado/texto'), new Response(txt));
    } catch (err) {}
    return Response.redirect(new URL('./?v=' + Date.now() + '#compartilhado', self.registration.scope).href, 303);
  })());
});
