// Cloudflare Worker: "corrigir-chamado"
// Ponte entre o app (aba T.I. › Reportar Problema) e o robô de correção automática no GitHub
// (workflow .github/workflows/corrigir-chamado.yml). O token do GitHub fica SÓ aqui, nunca no app.
//
// Configuração no painel da Cloudflare (Workers → corrigir-chamado → Settings → Variables and Secrets):
//   GITHUB_TOKEN = token "fine-grained" do GitHub, só deste repositório, permissão Contents: Read and write  (tipo Secret)
//   REPO         = Rauldneto/mais-acessivel-app                                                            (tipo Text, opcional)
//
// Rotas (só aceitam chamadas vindas do app https://rauldneto.github.io):
//   GET  /status    → {ok, configurado}
//   POST /corrigir  {chave, numero, relatorio} → dispara o robô (repository_dispatch "corrigir-chamado")
// O próprio robô limita a 10 correções por dia e não repete chamado já tratado.

const ORIGENS = ['https://rauldneto.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];

export default {
  async fetch(req, env) {
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
    if (!okOrigem) return resp({ ok: false, erro: 'Origem não autorizada' }, 403);

    const url = new URL(req.url);
    const repo = env.REPO || 'Rauldneto/mais-acessivel-app';
    if (url.pathname === '/status') return resp({ ok: true, configurado: !!env.GITHUB_TOKEN, repo });

    if (url.pathname === '/corrigir' && req.method === 'POST') {
      if (!env.GITHUB_TOKEN) return resp({ ok: false, erro: 'GITHUB_TOKEN não configurado no Worker' }, 500);
      let b;
      try { b = await req.json(); } catch (e) { return resp({ ok: false, erro: 'JSON inválido' }, 400); }
      const chave = String(b.chave || ''), numero = String(b.numero || ''), relatorio = String(b.relatorio || '');
      if (!/^-?[A-Za-z0-9_-]{5,40}$/.test(chave) || !/^[0-9]{1,6}$/.test(numero) || relatorio.length < 20)
        return resp({ ok: false, erro: 'Pedido inválido' }, 400);
      const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'mais-acessivel-corrigir-chamado',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ event_type: 'corrigir-chamado', client_payload: { chave, numero, relatorio: relatorio.slice(0, 12000) } }),
      });
      if (r.status === 204) return resp({ ok: true });
      const t = await r.text();
      return resp({ ok: false, erro: 'GitHub respondeu ' + r.status + ': ' + t.slice(0, 200) }, 502);
    }
    return resp({ ok: false, erro: 'Rota não encontrada' }, 404);
  },
};
