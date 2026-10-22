// Cloudflare Worker: "saldo-anthropic"
// Devolve o gasto REAL da conta Anthropic (Admin API /v1/organizations/cost_report), dia a dia, para a aba T.I. › Controle.
// A chave de administrador fica SÓ aqui, como segredo (Settings → Variables and Secrets → ADMIN_KEY). Nunca no app.
// Uso: GET https://saldo-anthropic.<sua-conta>.workers.dev/?de=2026-10-01   (de = primeiro dia, UTC)
// Resposta: {ok:true, dias:{"2026-10-01":1.23,...}, total:12.34, ts:...}   (valores em US$)

const ORIGENS = ['https://rauldneto.github.io'];

export default {
  async fetch(req, env, ctx) {
    const origem = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGENS.includes(origem) ? origem : ORIGENS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (origem && !ORIGENS.includes(origem)) return new Response('{"ok":false,"erro":"origem"}', { status: 403, headers: cors });
    if (!env.ADMIN_KEY) return new Response('{"ok":false,"erro":"ADMIN_KEY não configurada no Worker"}', { status: 500, headers: cors });

    const url = new URL(req.url);
    const de = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('de') || '') ? url.searchParams.get('de') : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

    // cache de 2 minutos para não martelar a API
    const cache = caches.default;
    const chave = new Request('https://cache.local/custo?de=' + de);
    const emCache = await cache.match(chave);
    if (emCache) { const r = new Response(emCache.body, emCache); Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); return r; }

    const fim = new Date(Date.now() + 864e5).toISOString().slice(0, 10) + 'T00:00:00Z';
    const dias = {};
    let total = 0, pagina = null, voltas = 0;
    try {
      do {
        const q = new URLSearchParams({ starting_at: de + 'T00:00:00Z', ending_at: fim, bucket_width: '1d', limit: '31' });
        if (pagina) q.set('page', pagina);
        const r = await fetch('https://api.anthropic.com/v1/organizations/cost_report?' + q, {
          headers: { 'x-api-key': env.ADMIN_KEY, 'anthropic-version': '2023-06-01' },
        });
        const j = await r.json();
        if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
        (j.data || []).forEach((b) => {
          const dia = String(b.starting_at).slice(0, 10);
          // amount vem em centavos de dólar (string decimal)
          const usd = (b.results || []).reduce((s, x) => s + (parseFloat(x.amount) || 0), 0) / 100;
          dias[dia] = (dias[dia] || 0) + usd;
          total += usd;
        });
        pagina = j.has_more ? j.next_page : null;
      } while (pagina && ++voltas < 20);
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, erro: String(e.message || e) }), { status: 502, headers: cors });
    }
    const resp = new Response(JSON.stringify({ ok: true, dias, total, ts: Date.now() }), {
      headers: { ...cors, 'Cache-Control': 'max-age=120' },
    });
    ctx.waitUntil(cache.put(chave, resp.clone()));
    return resp;
  },
};
