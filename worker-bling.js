// Cloudflare Worker: "bling"
// Ponte entre o app (aba BLING) e a API oficial do Bling (v3), usando o aplicativo "JDFER Financeiro Sicoob".
// Nada de senha no app: o acesso ao Bling fica guardado SÓ aqui.
//
// Configuração no painel da Cloudflare (Workers → bling → Settings):
//   Bindings → KV namespace:  nome da variável  BLING_KV   (crie um namespace chamado "bling")
//   Variables and Secrets:
//     BLING_CLIENT_ID      = Client ID do app no Bling               (tipo Text)
//     BLING_CLIENT_SECRET  = Client Secret do app no Bling           (tipo Secret)
//   PIX pelo Sicoob (opcional; sem isso o botão Gerar PIX fica desligado):
//     Bindings → Certificado mTLS:  SICOOB_MTLS  (certificado A1 da JDFER enviado pela API da Cloudflare)
//     SICOOB_CLIENT_ID     = client_id do app no portal Sicoob        (tipo Text)
//     PIX_CHAVE            = chave PIX que recebe as cobranças (CNPJ) (tipo Text)
//
// Rotas (todas só aceitam chamadas vindas do app https://rauldneto.github.io):
//   GET  /status            → {ok, conectado, empresa?}
//   GET  /oauth/inicio      → {ok, url}  (o app abre essa URL; o Bling volta para o app com ?code=&state=)
//   POST /oauth/troca       {code, state} → guarda o acesso no KV
//   GET  /abertos[?forcar=1]→ pedidos de venda "Em aberto" e notas com conta a receber em aberto,
//                             só com pagamento PIX ou cartão de crédito (link). Cache de 60 s.
//   POST /pix {tipo,id,numero,valor,usuario,cliente,doc} → cria cobrança imediata no Sicoob e devolve o copia e cola
//   GET  /pix/status?txid=  → situação da cobrança no Sicoob (ATIVA / CONCLUIDA ...)
//   GET  /pagamentos         → PIX pagos e ações planejadas/feitas no Bling (para o administrador)
//   POST /pagamentos/verificar → roda a verificação agora (a mesma do gatilho cron a cada 5 min)
//   GET  /pedido-compra?numero=N → pedido de compra pelo número (itens, fornecedor, frete, impostos, parcelas)
//                             para a aba Compras › Cotação compra. Precisa do escopo "Pedidos de compra" no app do Bling.
//   GET  /produtos-fornecedores?ids=1,2,3 → códigos que cada fornecedor usa para esses produtos (cadastro do Bling),
//                             usados como pista para ligar a cotação do fornecedor aos itens do pedido. Cache de 1 dia.
// Gatilho (Settings → Trigger Events → Cron): */5 * * * *
// Modo: KV "modo" = "simulacao" (padrão: só anota o que faria) ou "real" (executa no Bling).

const ORIGENS = ['https://rauldneto.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];
const API = 'https://api.bling.com.br/Api/v3';
const TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const SIT_PEDIDO_ABERTO = 6;              // "Em aberto" (módulo Vendas)
const COD_PIX = 17, COD_CREDITO = 3;      // códigos fiscais da forma de pagamento (tPag da NF-e)
const DIAS_PEDIDOS = 120;                 // pedidos em aberto criados nos últimos N dias
const DIAS_CONTAS = 180;                  // contas a receber em aberto emitidas nos últimos N dias

export default {
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(verificarPagamentos(env).then(() => registrarErro(env, null)).catch(e => registrarErro(env, String(e.message || e))));
  },
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
    if (!env.BLING_KV || !env.BLING_CLIENT_ID || !env.BLING_CLIENT_SECRET)
      return resp({ ok: false, erro: 'Worker sem configuração (BLING_KV, BLING_CLIENT_ID, BLING_CLIENT_SECRET).' }, 500);

    const url = new URL(req.url);
    try {
      if (url.pathname === '/status') {
        const t = await env.BLING_KV.get('tokens', 'json');
        const pixAtivo = !!(env.SICOOB_MTLS && env.SICOOB_CLIENT_ID && env.PIX_CHAVE);
        if (!t) return resp({ ok: true, conectado: false, pixAtivo });
        try {
          const emp = await bling(env, '/empresas/me/dados-basicos');
          return resp({ ok: true, conectado: true, pixAtivo, empresa: emp && emp.data && emp.data.nome });
        } catch (e) { return resp({ ok: true, conectado: false, pixAtivo, erro: String(e.message || e) }); }
      }
      if (url.pathname === '/oauth/inicio') {
        const state = 'wb' + crypto.randomUUID().replace(/-/g, '');
        await env.BLING_KV.put('state:' + state, '1', { expirationTtl: 900 });
        return resp({ ok: true, url: AUTH_URL + '?response_type=code&client_id=' + encodeURIComponent(env.BLING_CLIENT_ID) + '&state=' + state });
      }
      if (url.pathname === '/oauth/troca' && req.method === 'POST') {
        const b = await req.json();
        if (!b || !b.code || !b.state) return resp({ ok: false, erro: 'Faltou code/state' }, 400);
        const st = await env.BLING_KV.get('state:' + b.state);
        if (!st) return resp({ ok: false, erro: 'Autorização expirada ou não iniciada por este app. Comece de novo.' }, 400);
        await env.BLING_KV.delete('state:' + b.state);
        await trocarToken(env, 'grant_type=authorization_code&code=' + encodeURIComponent(b.code));
        await env.BLING_KV.delete('cache:abertos');
        const emp = await bling(env, '/empresas/me/dados-basicos');
        return resp({ ok: true, empresa: emp && emp.data && emp.data.nome });
      }
      if (url.pathname === '/abertos') {
        if (!url.searchParams.get('forcar')) {
          const c = await env.BLING_KV.get('cache:abertos', 'json');
          if (c && Date.now() - c.ts < 60000) return resp(Object.assign({ ok: true, cache: true }, c));
        }
        const dados = await listarAbertos(env);
        const out = { ts: Date.now(), itens: dados.itens, faltaram: dados.faltaram };
        if (!dados.faltaram) await env.BLING_KV.put('cache:abertos', JSON.stringify(out), { expirationTtl: 600 });
        return resp(Object.assign({ ok: true }, out));
      }
      if (url.pathname === '/pix' && req.method === 'POST') {
        const b = await req.json();
        return resp(await gerarPix(env, b || {}));
      }
      if (url.pathname === '/pagamentos') {
        let acoes = (await env.BLING_KV.get('acoes', 'json')) || [];
        if (acoes.some(x => x.acao === 'erro')) { acoes = acoes.filter(x => x.acao !== 'erro'); await env.BLING_KV.put('acoes', JSON.stringify(acoes)); }
        const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
        const ult = await env.BLING_KV.get('pix:ultimaVerificacao');
        return resp({ ok: true, modo, ultimaVerificacao: ult ? Number(ult) : 0, acoes: acoes.slice(-100).reverse() });
      }
      if (url.pathname === '/pagamentos/verificar' && req.method === 'POST') {
        const r = await verificarPagamentos(env);
        return resp(Object.assign({ ok: true }, r));
      }
      if (url.pathname === '/pagamentos/retroativo' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const dias = Math.min(Math.max(Number(b.dias || 10), 1), 30);
        let tot = { novos: 0, vistos: 0, pendentes: 0 };
        for (let d = dias; d > 0; d -= 4) {
          const ini = Date.now() - d * 86400e3, fim = Math.min(Date.now(), ini + 4 * 86400e3);
          const r = await verificarPagamentos(env, { inicio: ini, fim, semMarcar: true });
          tot.novos += r.novos; tot.vistos += r.vistos; tot.pendentes += r.pendentes || 0;
        }
        return resp(Object.assign({ ok: true, dias }, tot));
      }
      if (url.pathname === '/erros') {
        return resp(Object.assign({ ok: true }, (await env.BLING_KV.get('erros', 'json')) || {}));
      }
      if (url.pathname === '/diag/sicoob') {
        const n = Math.min(Number(url.searchParams.get('n') || 5), 10), out = [];
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          try {
            const r = await pedirTokenSicoob(env);
            const tx = await r.text();
            out.push({ status: r.status, ms: Date.now() - t0, server: r.headers.get('server'), tipo: r.headers.get('content-type'), corpo: r.ok ? '(token ok)' : tx.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) });
          } catch (e) { out.push({ erro: String(e.message || e), ms: Date.now() - t0 }); }
          await new Promise(x => setTimeout(x, 1500));
        }
        return resp({ ok: true, testes: out });
      }
      if (url.pathname === '/econf/pendentes') {
        return resp(Object.assign({ ok: true }, await econfPendentes(env)));
      }
      if (url.pathname === '/econf/registrar' && req.method === 'POST') {
        const b = await req.json();
        return resp(await econfRegistrar(env, b || {}));
      }
      if (url.pathname === '/pendentes') {
        const ids = (await env.BLING_KV.get('pendentes', 'json')) || [];
        const out = [];
        for (const e of ids.slice(-60).reverse()) { const x = await env.BLING_KV.get('pend:' + e, 'json'); if (x && !x.resolvido) out.push(x); }
        return resp({ ok: true, pendentes: out });
      }
      if (url.pathname === '/conciliar' && req.method === 'POST') {
        const b = await req.json();
        return resp(await conciliarManual(env, b || {}));
      }
      if (url.pathname === '/ignorar' && req.method === 'POST') {
        const b = await req.json();
        const x = await env.BLING_KV.get('pend:' + b.e2e, 'json');
        if (x) { x.resolvido = 'ignorado'; x.por = String(b.usuario || '').slice(0, 60); await env.BLING_KV.put('pend:' + b.e2e, JSON.stringify(x), { expirationTtl: 180 * 86400 }); }
        return resp({ ok: true });
      }
      if (url.pathname === '/pedido-compra') {
        const numero = String(url.searchParams.get('numero') || '').replace(/\D/g, '');
        if (!numero) return resp({ ok: false, erro: 'Informe o número do pedido de compra' }, 400);
        return resp(await pedidoCompra(env, numero));
      }
      if (url.pathname === '/produtos-fornecedores') {
        const ids = String(url.searchParams.get('ids') || '').split(',').map(x => x.replace(/\D/g, '')).filter(Boolean).slice(0, 60);
        if (!ids.length) return resp({ ok: false, erro: 'Faltou ids' }, 400);
        const out = {};
        for (const id of ids) {
          const c = await env.BLING_KV.get('pf:' + id, 'json');
          if (c) { out[id] = c; continue; }
          try {
            const j = await bling(env, '/produtos/fornecedores?idProduto=' + id + '&limite=100');
            const l = ((j && j.data) || []).filter(x => x.fornecedor && x.fornecedor.id && (x.codigo || x.descricao))
              .map(x => ({ fornecedorId: x.fornecedor.id, codigo: x.codigo || '', descricao: x.descricao || '' }));
            out[id] = l;
            await env.BLING_KV.put('pf:' + id, JSON.stringify(l), { expirationTtl: 86400 });
          } catch (e) { out[id] = []; }
        }
        return resp({ ok: true, produtos: out });
      }
      if (url.pathname === '/pix/status') {
        const txid = (url.searchParams.get('txid') || '').replace(/[^A-Za-z0-9]/g, '');
        if (!txid) return resp({ ok: false, erro: 'Faltou txid' }, 400);
        const c = await sicoob(env, 'GET', '/cob/' + txid);
        return resp({ ok: true, status: c.status, pix: c.pix || [] });
      }
      return resp({ ok: false, erro: 'Rota inexistente' }, 404);
    } catch (e) {
      return resp({ ok: false, erro: String((e && e.message) || e) }, 500);
    }
  },
};

// ---------------- acesso ao Bling ----------------
async function trocarToken(env, corpo) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '1.0',
      'Authorization': 'Basic ' + btoa(env.BLING_CLIENT_ID + ':' + env.BLING_CLIENT_SECRET),
    },
    body: corpo,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Bling recusou o acesso: ' + ((j.error && (j.error.description || j.error.message)) || j.error_description || r.status));
  const t = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (Number(j.expires_in || 21600) - 120) * 1000 };
  await env.BLING_KV.put('tokens', JSON.stringify(t));
  return t;
}

async function tokenValido(env) {
  let t = await env.BLING_KV.get('tokens', 'json');
  if (!t) throw new Error('Bling não conectado. Peça ao administrador para conectar na aba BLING.');
  if (Date.now() < t.exp) return t.access;
  t = await trocarToken(env, 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(t.refresh));
  return t.access;
}

let ultimaChamada = 0;
async function bling(env, caminho, tentativa) {
  // o Bling aceita ~3 chamadas por segundo
  const espera = ultimaChamada + 360 - Date.now();
  if (espera > 0) await new Promise(r => setTimeout(r, espera));
  ultimaChamada = Date.now();
  const tok = await tokenValido(env);
  const r = await fetch(API + caminho, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
  if (r.status === 429 && (tentativa || 0) < 3) { await new Promise(x => setTimeout(x, 1200)); return bling(env, caminho, (tentativa || 0) + 1); }
  if (r.status === 401 && !tentativa) { // token derrubado: força renovar uma vez
    const t = await env.BLING_KV.get('tokens', 'json');
    if (t) { t.exp = 0; await env.BLING_KV.put('tokens', JSON.stringify(t)); }
    return bling(env, caminho, 1);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Bling ' + r.status + ': ' + ((j.error && (j.error.description || j.error.message)) || caminho));
  return j;
}

async function paginas(env, base, max) {
  const out = [];
  for (let p = 1; p <= (max || 20); p++) {
    const j = await bling(env, base + (base.includes('?') ? '&' : '?') + 'limite=100&pagina=' + p);
    const d = (j && j.data) || [];
    out.push(...d);
    if (d.length < 100) break;
  }
  return out;
}

function isoDia(d) { return d.toISOString().slice(0, 10); }
function diasAtras(n) { return isoDia(new Date(Date.now() - n * 864e5)); }

// formas de pagamento (id → {nome, codigo}), guardadas por 6 h
async function formas(env) {
  const c = await env.BLING_KV.get('cache:formas', 'json');
  if (c && Date.now() - c.ts < 6 * 3600e3) return c.mapa;
  const lista = await paginas(env, '/formas-pagamentos', 5);
  const mapa = {};
  lista.forEach(f => { mapa[f.id] = { nome: f.descricao || '', codigo: Number(f.tipoPagamento || f.codigoFiscal || 0) }; });
  await env.BLING_KV.put('cache:formas', JSON.stringify({ ts: Date.now(), mapa }));
  return mapa;
}

async function vendedores(env) {
  const c = await env.BLING_KV.get('cache:vendedores', 'json');
  if (c && Date.now() - c.ts < 12 * 3600e3) return c.mapa;
  const mapa = {};
  try {
    const lista = await paginas(env, '/vendedores', 3);
    lista.forEach(v => { mapa[v.id] = (v.contato && v.contato.nome) || ''; });
  } catch (e) {}
  await env.BLING_KV.put('cache:vendedores', JSON.stringify({ ts: Date.now(), mapa }));
  return mapa;
}

function tipoForma(f) {
  if (!f) return '';
  if (f.codigo === COD_PIX || /pix/i.test(f.nome)) return 'pix';
  if (f.codigo === COD_CREDITO || /cr[eé]dito|link/i.test(f.nome)) return 'credito';
  return '';
}

async function listarAbertos(env) {
  const fp = await formas(env);
  const vend = await vendedores(env);
  const itens = [];

  // 1) Pedidos de venda em aberto (o detalhe traz as parcelas com a forma de pagamento)
  const pedidos = await paginas(env, '/pedidos/vendas?idsSituacoes[]=' + SIT_PEDIDO_ABERTO + '&dataInicial=' + diasAtras(DIAS_PEDIDOS) + '&dataFinal=' + isoDia(new Date()), 5);
  // plano grátis da Cloudflare: no máx. 50 chamadas externas por vez → detalhe dos pedidos fica guardado 20 min
  let novasBuscas = 0, faltaram = 0;
  for (const p of pedidos) {
    let d = null;
    const ck = 'ped:' + p.id;
    const c = await env.BLING_KV.get(ck, 'json');
    if (c && Date.now() - c.ts < 20 * 60e3) d = c.d;
    else if (novasBuscas < 30) {
      novasBuscas++;
      try { d = (await bling(env, '/pedidos/vendas/' + p.id)).data; } catch (e) { d = null; }
      if (d) await env.BLING_KV.put(ck, JSON.stringify({ ts: Date.now(), d }), { expirationTtl: 3600 });
    } else faltaram++;
    if (!d) continue;
    const parc = (d.parcelas || []).map(x => ({ valor: Number(x.valor || 0), venc: x.dataVencimento, forma: fp[x.formaPagamento && x.formaPagamento.id] }));
    const tipos = [...new Set(parc.map(x => tipoForma(x.forma)).filter(Boolean))];
    if (!tipos.length) continue;
    itens.push({
      tipo: 'pedido', id: d.id, numero: String(d.numero || ''), data: d.data, prevista: d.dataPrevista || '',
      cliente: (d.contato && d.contato.nome) || '', doc: (d.contato && d.contato.numeroDocumento) || '',
      total: Number(d.total || 0), aReceber: parc.filter(x => tipoForma(x.forma)).reduce((s, x) => s + x.valor, 0),
      formas: tipos, formaNome: parc.map(x => x.forma && x.forma.nome).filter(Boolean)[0] || '',
      vendedor: vend[d.vendedor && d.vendedor.id] || '', situacao: 'Em aberto', loja: (d.loja && d.loja.id) || 0,
      nf: (d.notaFiscal && d.notaFiscal.id) ? true : false,
    });
  }

  // 2) Notas fiscais com conta a receber em aberto por PIX/crédito
  const contas = await paginas(env, '/contas/receber?situacoes[]=1&tipoFiltroData=E&dataInicial=' + diasAtras(DIAS_CONTAS) + '&dataFinal=' + isoDia(new Date()), 10);
  const porNota = {};
  for (const c of contas) {
    const o = c.origem || {};
    if (o.tipoOrigem !== 'notafiscal') continue;
    const f = fp[c.formaPagamento && c.formaPagamento.id] || { codigo: Number(c.formaPagamento && c.formaPagamento.codigoFiscal), nome: '' };
    const t = tipoForma(f);
    if (!t) continue;
    const k = o.id;
    if (!porNota[k]) porNota[k] = {
      tipo: 'nota', id: o.id, numero: String(o.numero || ''), data: o.dataEmissao || c.dataEmissao, prevista: '',
      cliente: (c.contato && c.contato.nome) || '', doc: (c.contato && c.contato.numeroDocumento) || '',
      total: Number(o.valor || 0), aReceber: 0, formas: [], formaNome: f.nome || '', vendedor: '', situacao: 'Em aberto',
      contas: [], link: o.url || '',
    };
    const n = porNota[k];
    n.aReceber += Number(c.valor || 0);
    if (!n.formas.includes(t)) n.formas.push(t);
    n.contas.push({ id: c.id, valor: Number(c.valor || 0), venc: c.vencimento, pixBling: c.linkQRCodePix || '' });
  }
  itens.push(...Object.values(porNota));

  for (const it of itens) {
    const pg = (await env.BLING_KV.get('pagosdoc:' + it.tipo + ':' + it.id, 'json')) || [];
    if (pg.length) { it.pago = Math.round(pg.reduce((s, x) => s + Number(x.valor || 0), 0) * 100) / 100; it.pagos = pg; }
  }
  itens.sort((a, b) => String(b.data).localeCompare(String(a.data)) || Number(b.numero) - Number(a.numero));
  return { itens, faltaram };
}

// ---------------- PIX pelo Sicoob (cobrança imediata) ----------------
const SICOOB_TOKEN = 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token';
const SICOOB_PIX = 'https://api.sicoob.com.br/pix/api/v2';

function pedirTokenSicoob(env) {
  return env.SICOOB_MTLS.fetch(SICOOB_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(env.SICOOB_CLIENT_ID) + '&scope=' + encodeURIComponent('cob.write cob.read pix.read'),
  });
}

async function sicoobToken(env) {
  const c = await env.BLING_KV.get('sicoob:token', 'json');
  if (c && Date.now() < c.exp) return c.access;
  let r, txt = '', j = {};
  for (let t = 0; t < 2; t++) {
    r = await pedirTokenSicoob(env);
    txt = await r.text();
    try { j = JSON.parse(txt); } catch (e) { j = {}; }
    if (r.ok && j.access_token) break;
    if (t === 0) await new Promise(x => setTimeout(x, 2500));
  }
  if (!r.ok || !j.access_token) {
    const info = 'status ' + r.status + ' · servidor ' + (r.headers.get('server') || '?') + ' · ' + (j.error_description || j.error || txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160));
    throw new Error('Sicoob recusou o acesso (' + r.status + '): ' + info);
  }
  await env.BLING_KV.put('sicoob:token', JSON.stringify({ access: j.access_token, exp: Date.now() + (Number(j.expires_in || 300) - 30) * 1000 }), { expirationTtl: 3600 });
  return j.access_token;
}

async function sicoob(env, metodo, caminho, corpo) {
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) throw new Error('PIX do Sicoob ainda não ativado no Worker.');
  const tok = await sicoobToken(env);
  const r = await env.SICOOB_MTLS.fetch(SICOOB_PIX + caminho, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + tok, client_id: env.SICOOB_CLIENT_ID, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Sicoob ' + r.status + ': ' + (j.detail || j.title || j.mensagem || JSON.stringify(j).slice(0, 200)));
  return j;
}

function txidNovo(tipo, id) {
  // 26 a 35 caracteres [A-Za-z0-9]: MA + P/N + id do Bling + sufixo aleatório
  const base = 'MA' + (tipo === 'nota' ? 'N' : 'P') + String(id).replace(/\D/g, '');
  const rnd = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  return (base + 'X' + rnd).slice(0, 35);
}

async function gerarPix(env, b) {
  const valor = Math.round(Number(b.valor) * 100) / 100;
  if (!(valor > 0) || valor > 1e7) return { ok: false, erro: 'Valor inválido.' };
  if (!b.id || !b.tipo) return { ok: false, erro: 'Faltou o pedido/nota.' };
  if (!env.PIX_CHAVE) return { ok: false, erro: 'Chave PIX não configurada no Worker.' };
  const txid = txidNovo(b.tipo, b.id);
  const doc = String(b.doc || '').replace(/\D/g, '');
  const nome = String(b.cliente || '').slice(0, 200);
  const corpo = {
    calendario: { expiracao: 86400 },
    valor: { original: valor.toFixed(2) },
    chave: env.PIX_CHAVE,
    solicitacaoPagador: ((b.tipo === 'nota' ? 'NF ' : 'Pedido ') + String(b.numero || '')).slice(0, 140),
    infoAdicionais: [{ nome: b.tipo === 'nota' ? 'Nota fiscal' : 'Pedido', valor: String(b.numero || '').slice(0, 50) }],
  };
  if (nome && (doc.length === 11 || doc.length === 14)) corpo.devedor = doc.length === 14 ? { cnpj: doc, nome } : { cpf: doc, nome };
  const c = await sicoob(env, 'PUT', '/cob/' + txid, corpo);
  const contas = Array.isArray(b.contas) ? b.contas.slice(0, 24).map(x => ({ id: x.id, valor: Number(x.valor || 0), venc: x.venc || '' })) : [];
  const reg = { txid, tipo: b.tipo, id: b.id, numero: b.numero || '', valor, cliente: nome, doc, usuario: String(b.usuario || '').slice(0, 60),
    total: Number(b.total || 0), aReceber: Number(b.aReceber || 0), contas,
    criado: Date.now(), copia: c.brcode || '', status: c.status || 'ATIVA' };
  await env.BLING_KV.put('pix:' + txid, JSON.stringify(reg), { expirationTtl: 90 * 86400 });
  // lista por pedido/nota, para mostrar no app e conciliar pagamentos parciais
  const k = 'pixdoc:' + b.tipo + ':' + b.id;
  const lista = (await env.BLING_KV.get(k, 'json')) || [];
  lista.push({ txid, valor, criado: reg.criado });
  await env.BLING_KV.put(k, JSON.stringify(lista.slice(-20)), { expirationTtl: 90 * 86400 });
  const ate = new Date(Date.now() + 86400e3 - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  return { ok: true, txid, copiaECola: c.brcode || '', validade: ate.slice(8, 10) + '/' + ate.slice(5, 7) + ' ' + ate.slice(11) };
}

// ---------------- Pagamentos: confere PIX recebidos e planeja/executa as ações no Bling ----------------
const PORTADOR_SICOOB = 14890739452;   // conta "Sicoob" no Bling

async function registrarErro(env, msg) {
  const e = (await env.BLING_KV.get('erros', 'json')) || { total: 0, seguidos: 0, ultimos: [] };
  if (!msg) { if (e.seguidos) { e.seguidos = 0; e.ultimoOk = Date.now(); await env.BLING_KV.put('erros', JSON.stringify(e)); } else if (!e.ultimoOk || Date.now() - e.ultimoOk > 3600e3) { e.ultimoOk = Date.now(); await env.BLING_KV.put('erros', JSON.stringify(e)); } return; }
  e.total++; e.seguidos++; e.ultimo = Date.now();
  e.ultimos = [{ quando: Date.now(), msg: msg.slice(0, 300) }].concat(e.ultimos || []).slice(0, 40);
  await env.BLING_KV.put('erros', JSON.stringify(e));
}

async function logAcao(env, a) {
  const lista = (await env.BLING_KV.get('acoes', 'json')) || [];
  lista.push(Object.assign({ quando: Date.now() }, a));
  await env.BLING_KV.put('acoes', JSON.stringify(lista.slice(-300)));
}

function isoSemMs(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); }

async function verificarPagamentos(env, opt) {
  opt = opt || {};
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) return { novos: 0, aviso: 'PIX não ativado' };
  const agora = Date.now();
  const ult = Number((await env.BLING_KV.get('pix:ultimaVerificacao')) || (agora - 6 * 3600e3));
  const inicio = isoSemMs(opt.inicio || Math.max(ult - 15 * 60e3, agora - 4 * 86400e3));
  const fim = isoSemMs(opt.fim || agora);
  let pagina = 0, novos = 0, vistos = 0, pendentes = 0;
  const ctx = {};
  while (pagina < 10) {
    const j = await sicoob(env, 'GET', '/pix?inicio=' + encodeURIComponent(inicio) + '&fim=' + encodeURIComponent(fim) + '&paginacao.paginaAtual=' + pagina + '&paginacao.itensPorPagina=100');
    const lista = (j && j.pix) || [];
    for (const p of lista) {
      vistos++;
      if (!p.endToEndId) continue;
      if (await env.BLING_KV.get('pago:' + p.endToEndId)) continue;
      const reg = p.txid ? await env.BLING_KV.get('pix:' + p.txid, 'json') : null;
      if (reg) { await registrarPagamento(env, reg, p, 'app'); novos++; continue; }
      // PIX direto na chave (ou cobrança que não foi do app): tenta casar por CNPJ/CPF + valor
      if (await env.BLING_KV.get('visto:' + p.endToEndId)) continue;
      const r = await conciliarDireto(env, p, ctx);
      if (r === 'auto') novos++; else if (r === 'pendente') pendentes++;
    }
    const tp = j && j.parametros && j.parametros.paginacao && j.parametros.paginacao.quantidadeDePaginas;
    pagina++;
    if (!tp || pagina >= tp || lista.length < 100) break;
  }
  if (!opt.semMarcar) await env.BLING_KV.put('pix:ultimaVerificacao', String(agora));
  if (novos) await env.BLING_KV.delete('cache:abertos');
  return { novos, vistos, pendentes, inicio, fim };
}

function docPagador(p) { const g = p.pagador || {}; return String(g.cnpj || g.cpf || '').replace(/\D/g, ''); }
function diaLocal(horario) { const t = Date.parse(horario || ''); return isNaN(t) ? new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10) : new Date(t - 3 * 3600e3).toISOString().slice(0, 10); }

async function registrarPagamento(env, reg, p, origem) {
  const valor = Number(p.valor || 0);
  await env.BLING_KV.put('pago:' + p.endToEndId, reg.txid || ('direto:' + reg.tipo + ':' + reg.id), { expirationTtl: 365 * 86400 });
  if (reg.txid) {
    reg.pagamentos = (reg.pagamentos || []).concat([{ e2e: p.endToEndId, valor, horario: p.horario }]);
    reg.status = 'PAGO';
    await env.BLING_KV.put('pix:' + reg.txid, JSON.stringify(reg), { expirationTtl: 180 * 86400 });
  }
  const kd = 'pagosdoc:' + reg.tipo + ':' + reg.id;
  const pd = (await env.BLING_KV.get(kd, 'json')) || [];
  pd.push({ txid: reg.txid || '', e2e: p.endToEndId, valor, horario: p.horario, pagador: (p.pagador && p.pagador.nome) || '', origem });
  await env.BLING_KV.put(kd, JSON.stringify(pd), { expirationTtl: 365 * 86400 });
  await planejarAcoes(env, reg, valor, p, pd, origem);
}

async function itensAbertos(env, ctx) {
  if (ctx.itens) return ctx.itens;
  const c = await env.BLING_KV.get('cache:abertos', 'json');
  if (c && Date.now() - c.ts < 30 * 60e3) ctx.itens = c.itens;
  else { const d = await listarAbertos(env); ctx.itens = d.itens; if (!d.faltaram) await env.BLING_KV.put('cache:abertos', JSON.stringify({ ts: Date.now(), itens: d.itens }), { expirationTtl: 600 }); }
  return ctx.itens;
}

function regDeItem(it) {
  return { txid: '', tipo: it.tipo, id: it.id, numero: it.numero, cliente: it.cliente, doc: it.doc || '', total: it.total, aReceber: it.aReceber,
    contas: (it.contas || []).map(c => ({ id: c.id, valor: c.valor, venc: c.venc })) };
}

async function conciliarDireto(env, p, ctx) {
  const valor = Math.round(Number(p.valor || 0) * 100) / 100;
  const doc = docPagador(p);
  const alias = doc ? await env.BLING_KV.get('alias:' + doc) : null;
  const itens = await itensAbertos(env, ctx);
  const restante = it => Math.round((Number(it.aReceber || 0) - Number(it.pago || 0)) * 100) / 100;
  const docOk = it => { const d = String(it.doc || '').replace(/\D/g, ''); return d && (d === doc || d === alias); };
  const exatos = itens.filter(it => docOk(it) && Math.abs(restante(it) - valor) <= 0.01)
    .sort((a, b) => String(a.data).localeCompare(String(b.data)));
  await env.BLING_KV.put('visto:' + p.endToEndId, '1', { expirationTtl: 365 * 86400 });
  if (exatos.length) {
    // mesma empresa e mesmo valor: baixa automática, não importa a data combinada
    const it = exatos[0];
    await registrarPagamento(env, regDeItem(it), p, alias && String(it.doc || '').replace(/\D/g, '') === alias ? 'direto-apelido' : 'direto');
    it.pago = Number(it.pago || 0) + valor;
    return 'auto';
  }
  const sug = [];
  itens.forEach(it => {
    const r = restante(it);
    if (r <= 0.009) return;
    if (docOk(it) && valor < r) sug.push({ tipo: it.tipo, id: it.id, numero: it.numero, cliente: it.cliente, restante: r, data: it.data, motivo: 'Mesma empresa, valor menor (pagamento parcial?)' });
    else if (!docOk(it) && Math.abs(r - valor) <= 0.01) sug.push({ tipo: it.tipo, id: it.id, numero: it.numero, cliente: it.cliente, restante: r, data: it.data, motivo: 'Mesmo valor, pagador diferente' });
  });
  const pend = { e2e: p.endToEndId, valor, horario: p.horario, dia: diaLocal(p.horario), pagador: (p.pagador && p.pagador.nome) || p.nomePagador || '', doc,
    info: p.infoPagador || '', sugestoes: sug.slice(0, 6), criado: Date.now() };
  await env.BLING_KV.put('pend:' + p.endToEndId, JSON.stringify(pend), { expirationTtl: 180 * 86400 });
  const ids = (await env.BLING_KV.get('pendentes', 'json')) || [];
  if (!ids.includes(p.endToEndId)) { ids.push(p.endToEndId); await env.BLING_KV.put('pendentes', JSON.stringify(ids.slice(-300))); }
  return 'pendente';
}

async function conciliarManual(env, b) {
  const x = await env.BLING_KV.get('pend:' + b.e2e, 'json');
  if (!x) return { ok: false, erro: 'PIX não encontrado.' };
  if (x.resolvido) return { ok: false, erro: 'Este PIX já foi tratado.' };
  if (await env.BLING_KV.get('pago:' + b.e2e)) return { ok: false, erro: 'Este PIX já foi vinculado.' };
  const itens = await itensAbertos(env, {});
  const it = itens.find(i => i.tipo === b.tipo && String(i.id) === String(b.id));
  if (!it) return { ok: false, erro: 'Pedido/nota não está mais em aberto.' };
  const p = { endToEndId: x.e2e, valor: x.valor, horario: x.horario, pagador: { nome: x.pagador } };
  await registrarPagamento(env, regDeItem(it), p, 'manual');
  const dItem = String(it.doc || '').replace(/\D/g, '');
  if (x.doc && dItem && x.doc !== dItem && b.aprender !== false) {
    await env.BLING_KV.put('alias:' + x.doc, dItem);   // da próxima vez esse pagador já cai sozinho neste cliente
    await logAcao(env, { acao: 'apelido', tipo: it.tipo, numero: it.numero, cliente: it.cliente, detalhe: 'Aprendido: PIX de "' + x.pagador + '" passa a ser do cliente ' + it.cliente + '.' });
  }
  x.resolvido = 'vinculado'; x.vinculo = { tipo: it.tipo, id: it.id, numero: it.numero }; x.por = String(b.usuario || '').slice(0, 60);
  await env.BLING_KV.put('pend:' + b.e2e, JSON.stringify(x), { expirationTtl: 180 * 86400 });
  await env.BLING_KV.delete('cache:abertos');
  return { ok: true };
}

async function planejarAcoes(env, reg, valor, p, pagosDoc, origem) {
  const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
  const totalPago = Math.round(pagosDoc.reduce((s, x) => s + Number(x.valor || 0), 0) * 100) / 100;
  const base = { modo, tipo: reg.tipo, id: reg.id, numero: reg.numero, cliente: reg.cliente, txid: reg.txid, valor, horario: p.horario, pagador: (p.pagador && p.pagador.nome) || '' };
  const data = diaLocal(p.horario);
  const dataBr = data.split('-').reverse().join('/');
  const como = origem === 'direto' ? ' (PIX direto na chave — CNPJ e valor conferem)' : origem === 'direto-apelido' ? ' (PIX direto — pagador já conhecido deste cliente)' : origem === 'manual' ? ' (vinculado manualmente)' : '';
  await logAcao(env, Object.assign({}, base, { acao: 'pix_pago', detalhe: 'PIX de R$ ' + valor.toFixed(2) + ' recebido em ' + dataBr + (base.pagador ? ' de ' + base.pagador : '') + como }));
  if (reg.tipo === 'nota') {
    // reparte o valor pelas parcelas em aberto da nota, da mais antiga para a mais nova
    let resto = valor;
    const contas = (reg.contas || []).slice().sort((a, b) => String(a.venc).localeCompare(String(b.venc)));
    for (const c of contas) {
      if (resto <= 0.009) break;
      const v = Math.min(resto, c.valor);
      resto = Math.round((resto - v) * 100) / 100;
      const acao = { acao: 'baixa', contaId: c.id, valorBaixa: Math.round(v * 100) / 100, data,
        detalhe: 'Baixa de R$ ' + v.toFixed(2) + ' na parcela ' + (c.venc ? 'venc. ' + c.venc.split('-').reverse().join('/') : c.id) + ' (conta Sicoob)' + (v < c.valor - 0.009 ? ' — parcial' : '') };
      if (modo === 'real') acao.resultado = await executarBaixa(env, c.id, v, data, reg).catch(e => 'ERRO: ' + (e.message || e));
      await logAcao(env, Object.assign({}, base, acao));
    }
    if (resto > 0.009) await logAcao(env, Object.assign({}, base, { acao: 'sobra', detalhe: 'Sobrou R$ ' + resto.toFixed(2) + ' sem parcela em aberto para baixar — conferir.' }));
  } else {
    const alvo = reg.aReceber || reg.total || 0;
    const sit = alvo && totalPago >= alvo - 0.009 ? 'Pago' : 'Parcialmente pago';
    await logAcao(env, Object.assign({}, base, { acao: 'situacao', situacao: sit,
      detalhe: 'Pedido ' + reg.numero + ' → situação "' + sit + '" (pago R$ ' + totalPago.toFixed(2) + (alvo ? ' de R$ ' + alvo.toFixed(2) : '') + ').' }));
    const acao = { acao: 'contas_pedido', data, valorBaixa: valor,
      detalhe: 'Lançar as contas do pedido ' + reg.numero + ' e dar baixa de R$ ' + valor.toFixed(2) + ' com data ' + dataBr + ' (conta Sicoob). A nota emitida depois herda as contas do pedido já baixadas.' };
    if (modo === 'real') acao.resultado = await executarContasPedido(env, reg, valor, data).catch(e => 'ERRO: ' + (e.message || e));
    await logAcao(env, Object.assign({}, base, acao));
  }
}

async function executarBaixa(env, contaId, valor, data, reg) {
  // ativado só no modo "real", depois de conferido na simulação
  const tok = await tokenValido(env);
  const r = await fetch(API + '/contas/receber/' + contaId + '/baixar', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data, usarDataVencimento: false, portador: { id: PORTADOR_SICOOB }, historico: 'PIX ' + (reg.txid || 'direto') + ' - app Mais Acessível', valorRecebido: Math.round(valor * 100) / 100, juro: 0, desconto: 0, acrescimo: 0, taxa: 0 }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('Bling ' + r.status + ': ' + t.slice(0, 200));
  return 'ok';
}

async function executarContasPedido(env, reg, valor, data) {
  // ativado só no modo "real": lança as contas do pedido no Bling e baixa a(s) parcela(s) com a data do pagamento
  const tok = await tokenValido(env);
  const r = await fetch(API + '/pedidos/vendas/' + reg.id + '/lancar-contas', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
  if (!r.ok && r.status !== 400) throw new Error('Bling ' + r.status + ' ao lançar contas: ' + (await r.text()).slice(0, 160));
  const ped = (await bling(env, '/pedidos/vendas/' + reg.id)).data || {};
  const idContato = ped.contato && ped.contato.id;
  const lista = await paginas(env, '/contas/receber?situacoes[]=1' + (idContato ? '&idContato=' + idContato : ''), 3);
  const contas = lista.filter(c => String(c.idOrigem || (c.origem && c.origem.id)) === String(reg.id)).sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)));
  if (!contas.length) throw new Error('Contas do pedido não encontradas depois de lançar.');
  let resto = valor, feitas = 0;
  for (const c of contas) {
    if (resto <= 0.009) break;
    const v = Math.min(resto, Number(c.valor || 0));
    await executarBaixa(env, c.id, v, data, reg);
    resto = Math.round((resto - v) * 100) / 100; feitas++;
  }
  return 'ok (' + feitas + ' parcela(s))';
}

// ---------------- pedido de compra (aba Compras › Cotação compra) ----------------
// A API do Bling não filtra pedido de compra pelo número (e o filtro de data dela não é confiável):
// varre a lista inteira (poucas páginas) e guarda o mapa número → id no KV. Só varre de novo quando o número não está no mapa.
async function acharPedidoCompra(env, numero) {
  const mapa = (await env.BLING_KV.get('pc:mapa', 'json')) || {};
  if (mapa[numero]) return mapa[numero];
  const novo = {};
  for (let p = 1; p <= 80; p++) {
    const j = await bling(env, '/pedidos/compras?limite=100&pagina=' + p);
    const d = (j && j.data) || [];
    for (const o of d) if (o && o.numero != null) novo[String(o.numero)] = o.id;
    if (d.length < 100) break;
  }
  await env.BLING_KV.put('pc:mapa', JSON.stringify(novo), { expirationTtl: 30 * 86400 });
  return novo[numero] || null;
}

async function pedidoCompra(env, numero) {
  const id = await acharPedidoCompra(env, numero);
  if (!id) return { ok: false, erro: 'Pedido de compra nº ' + numero + ' não encontrado no Bling.' };
  const pc = ((await bling(env, '/pedidos/compras/' + id)) || {}).data || {};
  let forn = { id: pc.fornecedor && pc.fornecedor.id, nome: '', doc: '', uf: '' };
  if (forn.id) {
    try {
      const c = ((await bling(env, '/contatos/' + forn.id)) || {}).data || {};
      forn.nome = c.nome || c.fantasia || '';
      forn.doc = c.numeroDocumento || '';
      forn.uf = (c.endereco && c.endereco.geral && c.endereco.geral.uf) || '';
    } catch (e) { forn.nome = 'Fornecedor ' + forn.id; }
  }
  const formas = {};
  for (const pa of pc.parcelas || []) {
    const fid = pa.formaPagamento && pa.formaPagamento.id;
    if (fid && !(fid in formas)) {
      try { const f = ((await bling(env, '/formas-pagamentos/' + fid)) || {}).data || {}; formas[fid] = f.descricao || ''; }
      catch (e) { formas[fid] = ''; }
    }
  }
  const dia = s => s ? Math.round((new Date(s) - new Date(pc.data)) / 864e5) : null;
  const tr = pc.transporte || {}, tb = pc.tributacao || {}, ds = pc.desconto || {};
  return {
    ok: true,
    pedido: {
      id: pc.id, numero: pc.numero, data: pc.data, dataPrevista: pc.dataPrevista || '',
      fornecedor: forn,
      itens: (pc.itens || []).map(i => ({
        produtoId: i.produto && i.produto.id, codigo: (i.produto && i.produto.codigo) || '', descricao: i.descricao || '', codigoFornecedor: i.codigoFornecedor || '',
        unidade: i.unidade || '', quantidade: Number(i.quantidade || 0), valor: Number(i.valor || 0), aliquotaIPI: Number(i.aliquotaIPI || 0),
      })),
      totalProdutos: Number(pc.totalProdutos || 0), total: Number(pc.total || 0),
      desconto: ds.unidade === 'PERCENTUAL' ? Number(pc.totalProdutos || 0) * Number(ds.valor || 0) / 100 : Number(ds.valor || 0),
      frete: Number(tr.frete || 0), transportador: tr.transportador || '',
      totalIPI: Number(tb.totalIPI || 0), totalICMS: Number(tb.totalICMS || 0),
      parcelas: (pc.parcelas || []).map(pa => ({ vencimento: pa.dataVencimento, dias: dia(pa.dataVencimento), valor: Number(pa.valor || 0),
        forma: formas[pa.formaPagamento && pa.formaPagamento.id] || '' })),
    },
  };
}

// ---------------- ECONF (evento 110750): PIX vinculados a NF-e já emitidas ----------------
// O servidor só monta a lista e guarda os protocolos; a assinatura e o envio à SVRS são feitos
// pelo programa ENVIAR-ECONF no computador (certificado A1 instalado no Windows).
const CNPJ_SICOOB_IF = '02038232000164';   // Banco Cooperativo Sicoob S.A. (participante PIX)

async function nfDados(env, nfId) {
  const ck = 'nfdados:' + nfId;
  const c = await env.BLING_KV.get(ck, 'json');
  if (c && c.chave && Date.now() - c.ts < 7 * 86400e3) return c;
  const d = (await bling(env, '/nfe/' + nfId)).data || {};
  const out = { ts: Date.now(), id: nfId, numero: String(d.numero || ''), chave: String(d.chaveAcesso || '').replace(/\D/g, ''), situacao: d.situacao, emissao: String(d.dataEmissao || '').slice(0, 10) };
  if (out.chave.length === 44) await env.BLING_KV.put(ck, JSON.stringify(out), { expirationTtl: 30 * 86400 });
  return out;
}

async function nfDoPedido(env, pedId) {
  const ck = 'pednf:' + pedId;
  const c = await env.BLING_KV.get(ck);
  if (c) return c;
  const d = (await bling(env, '/pedidos/vendas/' + pedId)).data || {};
  const nf = d.notaFiscal && d.notaFiscal.id;
  if (nf) await env.BLING_KV.put(ck, String(nf), { expirationTtl: 90 * 86400 });
  return nf || null;
}

async function econfPendentes(env) {
  const out = [];
  let cursor, chamadas = 0, faltaram = 0;
  do {
    const l = await env.BLING_KV.list({ prefix: 'pagosdoc:', cursor });
    for (const k of l.keys) {
      const [, tipo, id] = k.name.split(':');
      const lista = (await env.BLING_KV.get(k.name, 'json')) || [];
      for (const p of lista) {
        if (!p.e2e) continue;
        const reg = (await env.BLING_KV.get('econf:' + p.e2e, 'json')) || null;
        if (reg && reg.ok) continue;
        const dia = diaLocal(p.horario);
        const item = { e2e: p.e2e, valor: Number(p.valor || 0), dia, horario: p.horario, pagador: p.pagador || '', tipo, docId: id, tPag: p.txid ? '17' : '20',
          ultimaTentativa: reg };
        try {
          let nfId = tipo === 'nota' ? id : null;
          if (tipo === 'pedido') { if (chamadas > 35) { faltaram++; continue; } chamadas++; nfId = await nfDoPedido(env, id); }
          if (!nfId) { item.status = 'aguardando_nf'; out.push(item); continue; }
          if (chamadas > 35) { faltaram++; continue; }
          const cache = await env.BLING_KV.get('nfdados:' + nfId); if (!cache) chamadas++;
          const nf = await nfDados(env, nfId);
          item.nf = nf;
          // Bling: 5 Autorizada, 6 Emitida DANFE, 7 Registrada. Outras (1 pendente, 2 cancelada, 4 rejeitada, 9 denegada...) não recebem ECONF
          const sitNF = Number(nf.situacao);
          const SIT_NOME = { 1: 'pendente', 2: 'cancelada', 3: 'aguardando recibo', 4: 'rejeitada', 8: 'aguardando protocolo', 9: 'denegada', 10: 'em consulta', 11: 'bloqueada' };
          if (nf.chave.length !== 44) item.status = 'nf_sem_chave';
          else if (![5, 6, 7].includes(sitNF)) { item.status = 'nf_nao_autorizada'; item.erro = 'NF ' + nf.numero + ' está ' + (SIT_NOME[sitNF] || ('situação ' + sitNF)) + ' no Bling'; await env.BLING_KV.delete('nfdados:' + nfId); if (tipo === 'pedido') await env.BLING_KV.delete('pednf:' + id); }
          else item.status = 'pronto';
          item.momento = nf.emissao && dia < nf.emissao ? 'anterior' : 'posterior';
          item.nSeq = Number((await env.BLING_KV.get('econfseq:' + nf.chave)) || 0) + 1;
        } catch (e) { item.status = 'erro'; item.erro = String(e.message || e); }
        out.push(item);
      }
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  out.sort((a, b) => String(a.dia).localeCompare(String(b.dia)));
  return { cnpj: '35017646000166', uf: 'GO', cnpjIF: CNPJ_SICOOB_IF, itens: out, faltaram };
}

async function econfRegistrar(env, b) {
  if (!b.e2e || !b.chave) return { ok: false, erro: 'Faltou e2e/chave' };
  const reg = { quando: Date.now(), chave: b.chave, nSeq: b.nSeq, ambiente: b.ambiente, cStat: String(b.cStat || ''), xMotivo: String(b.xMotivo || '').slice(0, 300), nProt: b.nProt || '' };
  // 135 = evento registrado e vinculado; 136 = registrado sem vínculo; 573 = duplicidade (já existe)
  reg.ok = b.ambiente === 'producao' && ['135', '136', '573'].includes(reg.cStat);
  await env.BLING_KV.put('econf:' + b.e2e, JSON.stringify(reg), { expirationTtl: 5 * 365 * 86400 });
  if (b.ambiente === 'producao' && ['135', '136'].includes(reg.cStat)) await env.BLING_KV.put('econfseq:' + b.chave, String(b.nSeq || 1), { expirationTtl: 5 * 365 * 86400 });
  if (b.ambiente === 'producao') await logAcao(env, { acao: 'econf', modo: 'real', detalhe: 'ECONF da chave ' + b.chave.slice(25, 34) + ' (R$ ' + Number(b.valor || 0).toFixed(2) + '): ' + reg.cStat + ' ' + reg.xMotivo + (reg.nProt ? ' · protocolo ' + reg.nProt : '') });
  return { ok: true, registrado: reg.ok };
}
