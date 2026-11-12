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
async function pushUsuario() {
  try { var c = await caches.open('push-cfg'); var r = await c.match('./push-usuario'); return r ? (await r.text()) : ''; } catch (e) { return ''; }
}
// ids já mostrados neste navegador (para um toque de pagamento não repetir mensagem do Chat e vice-versa)
async function vistosLer() { try { var c = await caches.open('push-cfg'); var r = await c.match('./push-vistos'); return r ? JSON.parse(await r.text()) : []; } catch (e) { return []; } }
async function vistosGravar(l) { try { var c = await caches.open('push-cfg'); await c.put('./push-vistos', new Response(JSON.stringify(l.slice(-150)))); } catch (e) {} }
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
self.addEventListener('push', function(e) {
  e.waitUntil((async function() {
    var avisos = [], chat = [], mostrou = 0;
    try {
      var u = await pushServidor(), eu = await pushUsuario();
      if (u) { var r = await fetch(u + '/push/ultimos' + (eu ? '?u=' + encodeURIComponent(eu) : ''), { cache: 'no-store' }); var j = await r.json(); avisos = (j && j.avisos) || []; chat = (j && j.chat) || []; }
    } catch (err) {}
    var vistos = await vistosLer();
    // Mensagens do Chat (só as deste usuário; o servidor já filtra)
    var novosChat = chat.filter(function(a) { return vistos.indexOf(a.id) < 0; }).slice(0, 3);
    for (var k = 0; k < novosChat.length; k++) {
      var m = novosChat[k]; vistos.push(m.id); mostrou++;
      await self.registration.showNotification((m.av ? '🔔 Aviso de ' : '💬 ') + (m.nome || m.de || 'Mais Acessível'), {
        body: m.txt || 'Nova mensagem no Chat.', tag: 'cht-' + (m.conv || m.id), renotify: true, requireInteraction: !!m.av,
        icon: 'logo.jpg', data: { url: new URL('./#chat', self.registration.scope).href, tipo: 'abrirChat' } });
    }
    // Pagamentos confirmados
    var novosPag = avisos.filter(function(a) { return vistos.indexOf(a.id) < 0; }).slice(0, 3);
    for (var i = 0; i < novosPag.length; i++) {
      var a = novosPag[i]; vistos.push(a.id); mostrou++;
      var titulo = a.teste ? '🔔 Teste de aviso' : a.uso ? '⚠️ Limite do servidor' : '💰 Pagamento confirmado';
      var ref = a.numero ? (a.tipo === 'nota' ? 'NF ' : 'Pedido ') + a.numero + ' · ' : '';
      var corpo = a.uso ? a.cliente : a.teste ? (a.cliente || 'Os avisos de pagamento estão funcionando neste computador.') : ref + 'R$ ' + brl(a.valor) + (a.cliente ? ' · ' + a.cliente : '') + (a.forma ? ' (' + a.forma + ')' : '');
      await self.registration.showNotification(titulo, { body: corpo, tag: a.id, icon: 'logo.jpg', data: { url: new URL('./#bling', self.registration.scope).href } });
    }
    await vistosGravar(vistos);
    if (!mostrou) return self.registration.showNotification('📬 Mais Acessível', { body: 'Abra o app para ver.', tag: 'generico', icon: 'logo.jpg' });
  })());
});
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var alvo = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async function() {
    var abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    var tipo = (e.notification.data && e.notification.data.tipo) || 'abrirConciliacao';
    for (var i = 0; i < abas.length; i++) { if (abas[i].url.indexOf(self.registration.scope) === 0) { try { await abas[i].focus(); abas[i].postMessage({ tipo: tipo }); return; } catch (err) {} } }
    return self.clients.openWindow(alvo);
  })());
});
