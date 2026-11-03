// Cloudflare Worker "soft-limit-b3a1": a IA do app (repassa os pedidos para a API da Anthropic).
// A chave da Anthropic fica SÓ aqui, como segredo (Settings → Variables and Secrets → ANTHROPIC_API_KEY).
//
// SEGURANÇA (nov/2026): antes qualquer pessoa na internet podia usar este endereço e gastar os créditos.
// Agora o pedido precisa levar o token do login do app:  Authorization: Bearer <token do Firebase>.
// O Worker confere a assinatura (chaves públicas do Google), o projeto, a validade e se o usuário
// está na lista "acl" do app.
//
// Variável MODO_AUTH (Settings → Variables and Secrets, tipo texto):
//   (vazia) ou 'aviso'  aceita pedido sem token, mas registra "SEM ACESSO" no log (fase de transição)
//   'obrigatorio'       recusa pedido sem token válido (erro 401)
//
// Travas de gasto (valem sempre): só modelos Claude Sonnet/Haiku e no máximo 8000 tokens de resposta.

const PROJETO = 'maisacessivel-1d0ad';
const DB = 'https://maisacessivel-1d0ad-default-rtdb.firebaseio.com';
const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const MODELOS = /^claude-(sonnet|haiku)-/;
const MAX_TOKENS = 8000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
function resposta(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
}

let chaves = null, chavesAte = 0;
const aclCache = new Map();

function b64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
}

async function pegarChaves() {
  if (chaves && Date.now() < chavesAte) return chaves;
  const r = await fetch(JWK_URL);
  if (!r.ok) throw new Error('chaves do Google ' + r.status);
  const j = await r.json();
  const novas = {};
  for (const k of j.keys) {
    novas[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  const m = /max-age=(\d+)/.exec(r.headers.get('Cache-Control') || '');
  chaves = novas;
  chavesAte = Date.now() + (m ? parseInt(m[1], 10) : 3600) * 1000;
  return chaves;
}

// Devolve o uid se o token do Firebase for válido; senão null
async function conferirToken(token) {
  const p = token.split('.');
  if (p.length !== 3) return null;
  let h, c;
  try {
    h = JSON.parse(new TextDecoder().decode(b64url(p[0])));
    c = JSON.parse(new TextDecoder().decode(b64url(p[1])));
  } catch (e) { return null; }
  if (h.alg !== 'RS256' || !h.kid) return null;
  const agora = Math.floor(Date.now() / 1000);
  if (c.aud !== PROJETO || c.iss !== 'https://securetoken.google.com/' + PROJETO) return null;
  if (!c.sub || !(c.exp > agora) || (c.iat && c.iat > agora + 300)) return null;
  let ks = await pegarChaves();
  if (!ks[h.kid]) { chavesAte = 0; ks = await pegarChaves(); } // o Google troca as chaves de tempos em tempos
  if (!ks[h.kid]) return null;
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', ks[h.kid], b64url(p[2]), new TextEncoder().encode(p[0] + '.' + p[1]));
  return ok ? c.sub : null;
}

// O usuário precisa estar na lista do app (acl). Resultado guardado por 10 min.
async function naListaDoApp(uid, token) {
  const x = aclCache.get(uid);
  if (x && Date.now() < x.ate) return x.ok;
  const r = await fetch(DB + '/acl/' + encodeURIComponent(uid) + '.json?auth=' + encodeURIComponent(token));
  const v = r.ok ? await r.json() : null;
  const ok = v === 'admin' || v === 'user';
  aclCache.set(uid, { ok: ok, ate: Date.now() + 600000 });
  return ok;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

    // 1) Quem está pedindo?
    const modo = env.MODO_AUTH === 'obrigatorio' ? 'obrigatorio' : 'aviso';
    const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
    let uid = null, motivo = 'sem token';
    if (m) {
      try {
        uid = await conferirToken(m[1]);
        if (!uid) motivo = 'token inválido ou vencido';
        else if (!(await naListaDoApp(uid, m[1]))) { motivo = 'usuário fora da lista do app'; uid = null; }
      } catch (e) { motivo = 'erro ao conferir: ' + e.message; uid = null; }
    }
    if (!uid) {
      console.log(JSON.stringify({ ia: 'SEM ACESSO', motivo: motivo, modo: modo, origem: request.headers.get('Origin') || '' }));
      if (modo === 'obrigatorio') {
        return resposta({ error: { type: 'nao_autorizado', message: 'Entre no app Mais Acessível para usar a IA (' + motivo + ').' } }, 401);
      }
    }

    // 2) Repassa para a Anthropic, com as travas de gasto
    try {
      const body = await request.json();
      if (!body || typeof body.model !== 'string' || !MODELOS.test(body.model)) {
        return resposta({ error: { type: 'modelo_nao_permitido', message: 'Modelo não permitido: ' + (body && body.model) } }, 400);
      }
      if (!(body.max_tokens > 0)) body.max_tokens = 1000;
      if (body.max_tokens > MAX_TOKENS) body.max_tokens = MAX_TOKENS;
      delete body.stream;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      return resposta(data); // como antes: devolve o que a Anthropic respondeu
    } catch (err) {
      return resposta({ error: err.message }, 500);
    }
  }
};
