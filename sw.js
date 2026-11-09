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

// ---- Avisos de pagamento confirmado (Web Push) ----
// O servidor manda só um "toque" (sem conteúdo); aqui buscamos os avisos recentes e mostramos a notificação,
// mesmo com o app fechado (basta o Chrome estar aberto). O endereço do servidor é guardado pelo app em caches 'push-cfg'.
async function pushServidor() {
  try { var c = await caches.open('push-cfg'); var r = await c.match('./push-cfg'); return r ? (await r.text()).replace(/\/+$/, '') : ''; } catch (e) { return ''; }
}
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
self.addEventListener('push', function(e) {
  e.waitUntil((async function() {
    var avisos = [];
    try { var u = await pushServidor(); if (u) { var r = await fetch(u + '/push/ultimos', { cache: 'no-store' }); var j = await r.json(); avisos = (j && j.avisos) || []; } } catch (err) {}
    if (!avisos.length) return self.registration.showNotification('💰 Pagamento confirmado', { body: 'Abra o app para ver.', tag: 'pag-generico', icon: 'logo.jpg' });
    for (var i = 0; i < Math.min(avisos.length, 3); i++) {
      var a = avisos[i];
      var titulo = a.teste ? '🔔 Teste de aviso' : '💰 Pagamento confirmado';
      var ref = a.numero ? (a.tipo === 'nota' ? 'NF ' : 'Pedido ') + a.numero + ' · ' : '';
      var corpo = a.teste ? (a.cliente || 'Os avisos de pagamento estão funcionando neste computador.') : ref + 'R$ ' + brl(a.valor) + (a.cliente ? ' · ' + a.cliente : '') + (a.forma ? ' (' + a.forma + ')' : '');
      await self.registration.showNotification(titulo, { body: corpo, tag: a.id, icon: 'logo.jpg', data: { url: new URL('./#bling', self.registration.scope).href } });
    }
  })());
});
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var alvo = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async function() {
    var abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < abas.length; i++) { if (abas[i].url.indexOf(self.registration.scope) === 0) { try { await abas[i].focus(); abas[i].postMessage({ tipo: 'abrirConciliacao' }); return; } catch (err) {} } }
    return self.clients.openWindow(alvo);
  })());
});
