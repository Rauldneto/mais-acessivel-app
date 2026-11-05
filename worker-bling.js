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
//   GET  /boletos, POST /boletos/verificar|vincular|ignorar|simular|simular/passo → boletos Sicoob liquidados (ver o fim do arquivo)
// Gatilho (Settings → Trigger Events → Cron): */5 * * * *  (PIX a cada 5 min; boletos a cada 30 min)
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
    ctx.waitUntil(verificarPagamentos(env).then(() => registrarErro(env, null)).catch(e => registrarErro(env, String(e.message || e)))
      .then(() => verificarBoletos(env)).catch(e => registrarErro(env, 'Boletos: ' + String(e.message || e))));
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
      if (url.pathname === '/boletos') return resp(await boletosPainel(env));
      if (url.pathname === '/boletos/verificar' && req.method === 'POST') return resp(Object.assign({ ok: true }, await verificarBoletos(env, true)));
      if (url.pathname === '/boletos/vincular' && req.method === 'POST') return resp(await boletosVincular(env, (await req.json()) || {}));
      if (url.pathname === '/boletos/ignorar' && req.method === 'POST') {
        const b = (await req.json()) || {};
        const x = await env.BLING_KV.get('bolpend:' + b.nossoNumero, 'json');
        if (x) { x.resolvido = 'ignorado'; x.por = String(b.usuario || '').slice(0, 60); await env.BLING_KV.put('bolpend:' + b.nossoNumero, JSON.stringify(x), { expirationTtl: 180 * 86400 }); }
        return resp({ ok: true });
      }
      if (url.pathname === '/boletos/simular' && req.method === 'POST') return resp(await simularIniciar(env, (await req.json().catch(() => ({}))) || {}));
      if (url.pathname === '/boletos/simular/passo' && req.method === 'POST') return resp(await simularPasso(env));
      if (url.pathname === '/boletos/simular') {
        const sim = await env.BLING_KV.get('bolsim:estado', 'json');
        return resp({ ok: true, sim: sim ? resumoSim(sim) : null, rel: sim ? ((await env.BLING_KV.get('bolsim:rel', 'json')) || []) : [] });
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

const ESCOPO_PIX = 'cob.write cob.read pix.read';
const ESCOPO_BOLETOS = 'boletos_consulta';

function pedirTokenSicoob(env, escopo) {
  return env.SICOOB_MTLS.fetch(SICOOB_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(env.SICOOB_CLIENT_ID) + '&scope=' + encodeURIComponent(escopo || ESCOPO_PIX),
  });
}

async function sicoobToken(env, escopo) {
  escopo = escopo || ESCOPO_PIX;
  const chave = escopo === ESCOPO_PIX ? 'sicoob:token' : 'sicoob:token:boletos';
  const c = await env.BLING_KV.get(chave, 'json');
  if (c && Date.now() < c.exp) return c.access;
  let r, txt = '', j = {};
  for (let t = 0; t < 2; t++) {
    r = await pedirTokenSicoob(env, escopo);
    txt = await r.text();
    try { j = JSON.parse(txt); } catch (e) { j = {}; }
    if (r.ok && j.access_token) break;
    if (t === 0) await new Promise(x => setTimeout(x, 2500));
  }
  if (!r.ok || !j.access_token) {
    const info = 'status ' + r.status + ' · servidor ' + (r.headers.get('server') || '?') + ' · ' + (j.error_description || j.error || txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160));
    throw new Error('Sicoob recusou o acesso (' + r.status + '): ' + info);
  }
  await env.BLING_KV.put(chave, JSON.stringify({ access: j.access_token, exp: Date.now() + (Number(j.expires_in || 300) - 30) * 1000 }), { expirationTtl: 3600 });
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
    body: JSON.stringify({ data, usarDataVencimento: false, portador: { id: PORTADOR_SICOOB }, historico: reg.historico || ('PIX ' + (reg.txid || 'direto') + ' - app Mais Acessível'), valorRecebido: Math.round(valor * 100) / 100, juro: Math.round(Number(reg.juro || 0) * 100) / 100, desconto: Math.round(Number(reg.desconto || 0) * 100) / 100, acrescimo: 0, taxa: 0 }),
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
  const out = { ts: Date.now(), id: nfId, numero: String(d.numero || ''), chave: String(d.chaveAcesso || '').replace(/\D/g, ''), situacao: d.situacao, emissao: String(d.dataEmissao || '').slice(0, 10),
    contatoId: (d.contato && d.contato.id) || null, valor: Number(d.valorNota || d.total || 0) };
  if (out.chave.length === 44) await env.BLING_KV.put(ck, JSON.stringify(out), { expirationTtl: 30 * 86400 });
  return out;
}

// Pedido cuja NF foi rejeitada/cancelada e reemitida: acha a NF autorizada do mesmo cliente emitida depois,
// com o mesmo valor do pedido (ou a única candidata). Guarda a escolha.
async function nfSubstituta(env, pedId, nfVelha) {
  const ck = 'pednfsubst:' + pedId;
  const c = await env.BLING_KV.get(ck);
  if (c) return c;
  let contatoId = nfVelha.contatoId;
  const nv = await nfDados(env, nfVelha.id).catch(() => null);
  if (nv && nv.contatoId) contatoId = nv.contatoId;
  if (!contatoId) return null;
  const ped = (await bling(env, '/pedidos/vendas/' + pedId)).data || {};
  const totalPed = Number(ped.total || 0);
  const desde = nfVelha.emissao || String(ped.data || '').slice(0, 10);
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const lista = await paginas(env, '/nfe?tipo=1&dataEmissaoInicial=' + encodeURIComponent(desde + ' 00:00:00') + '&dataEmissaoFinal=' + encodeURIComponent(hoje + ' 23:59:59'), 3);
  const cands = lista.filter(n => n.contato && String(n.contato.id) === String(contatoId) && [5, 6, 7].includes(Number(n.situacao)) && String(n.id) !== String(nfVelha.id));
  let escolha = null;
  for (const n of cands.slice(0, 6)) {
    const d = await nfDados(env, n.id);
    if (totalPed && Math.abs(Number(d.valor || 0) - totalPed) <= 0.05) { escolha = n.id; break; }
  }
  if (!escolha && cands.length === 1) escolha = cands[0].id;
  if (escolha) await env.BLING_KV.put(ck, String(escolha), { expirationTtl: 365 * 86400 });
  return escolha;
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
          else if (![5, 6, 7].includes(sitNF) && tipo === 'pedido' && (item.subst = await nfSubstituta(env, id, nf))) {
            const nova = await nfDados(env, item.subst);
            item.nf = nova; item.obs = 'NF ' + nf.numero + ' não autorizada; usando a NF ' + nova.numero + ' emitida depois para o mesmo cliente';
            item.status = 'pronto';
            item.momento = nova.emissao && dia < nova.emissao ? 'anterior' : 'posterior';
            item.nSeq = Number((await env.BLING_KV.get('econfseq:' + nova.chave)) || 0) + 1;
          }
          else if (![5, 6, 7].includes(sitNF)) { item.status = 'nf_nao_autorizada'; item.erro = 'NF ' + nf.numero + ' está ' + (SIT_NOME[sitNF] || ('situação ' + sitNF)) + ' no Bling'; await env.BLING_KV.delete('nfdados:' + nfId); if (tipo === 'pedido') await env.BLING_KV.delete('pednf:' + id); }
          else item.status = 'pronto';
          if (item.status === 'pronto' && !item.subst) item.momento = nf.emissao && dia < nf.emissao ? 'anterior' : 'posterior';
          if (!item.subst) item.nSeq = Number((await env.BLING_KV.get('econfseq:' + nf.chave)) || 0) + 1;
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

// ======================================================================================================
// ---------------- Boletos Sicoob liquidados → baixa no Contas a Receber do Bling ----------------
// Mesma conciliação dos PIX: o que entra na conta Sicoob vira baixa (valor cheio, data em que o dinheiro entrou)
// e a tarifa do boleto vira despesa separada em "Tarifa bancária".
//
// Fluxo da API de Cobrança Bancária v3 do Sicoob (1 dia por pedido):
//   POST /boletos/movimentacoes {numeroCliente, tipoMovimento:5 (liquidação), dataInicial=dataFinal}
//   GET  /boletos/movimentacoes?numeroCliente&codigoSolicitacao      → quando pronto, traz os ids dos arquivos
//   GET  /boletos/movimentacoes/download?numeroCliente&codigoSolicitacao&idArquivo → base64 (zip com JSON)
// Cada boleto liquidado é completado com GET /boletos?numeroCliente&codigoModalidade=1&nossoNumero=
// (vencimento, seuNumero e CPF/CNPJ do pagador) e casado com a conta a receber do Bling:
//   seuNumero (nº da NF ou id da conta) ou CPF/CNPJ do pagador  +  mesmo valor  +  mesmo vencimento → baixa sozinho
//   só uma pista bate                                                                                 → "Boletos sem vínculo"
//
// Rotas novas (aba Financeiro › Conciliação contas a Receber):
//   GET  /boletos                    → boletos já tratados (log), pendentes e situação da leitura diária
//   POST /boletos/verificar          → roda agora o passo diário (o mesmo do cron, a cada 30 min)
//   POST /boletos/vincular {nossoNumero, contaId, usuario} / POST /boletos/ignorar {nossoNumero, usuario}
//   POST /boletos/simular {de, ate}  → prepara a SIMULAÇÃO com boletos antigos (não mexe no Bling nem no log real)
//   POST /boletos/simular/passo      → avança a simulação um pedaço (o app chama em sequência)
//   GET  /boletos/simular            → andamento + relatório da simulação

const SICOOB_COB = 'https://api.sicoob.com.br/cobranca-bancaria/v3';
const SICOOB_NUM_CLIENTE = 2547538;
const BOL_POR_PASSO = 10;          // boletos tratados por chamada (limite de 50 chamadas externas do plano grátis)
const BOL_INTERVALO = 30 * 60e3;   // leitura diária pelo cron: a cada 30 min

async function sicoobCob(env, metodo, caminho, corpo) {
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) throw new Error('Sicoob ainda não ativado no Worker.');
  const tok = await sicoobToken(env, ESCOPO_BOLETOS);
  const r = await env.SICOOB_MTLS.fetch(SICOOB_COB + caminho, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + tok, client_id: env.SICOOB_CLIENT_ID, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (r.status === 204) return { _vazio: true };
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _texto: txt.slice(0, 300) }; }
  if (!r.ok) {
    const m = (j.mensagens && j.mensagens.map(x => x.mensagem).join('; ')) || j.message || j.mensagem || j.detail || j._texto || JSON.stringify(j).slice(0, 200);
    const e = new Error('Sicoob ' + r.status + ': ' + m); e.status = r.status; e.msg = String(m); throw e;
  }
  return j;
}

// ---- utilidades ----
const r2 = v => Math.round(Number(v || 0) * 100) / 100;
const dig = s => String(s == null ? '' : s).replace(/\D/g, '');
function brData(iso) { return iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : ''; }
function soData(v) {
  // aceita 2026-07-08, 2026-07-08T00:00:00-03:00, 08/07/2026
  const s = String(v || '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return m[3] + '-' + m[2] + '-' + m[1];
  return '';
}
function hojeLocal() { return new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); }
function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fimDeSemana(iso) { const w = new Date(iso + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; }
function acharCampo(o, nomes) { // procura um campo pelo nome em qualquer nível (respostas do Sicoob variam entre versões)
  if (!o || typeof o !== 'object') return undefined;
  for (const n of nomes) if (o[n] != null) return o[n];
  for (const k of Object.keys(o)) { const v = acharCampo(o[k], nomes); if (v != null) return v; }
  return undefined;
}
function acharLista(o) { // primeira lista de objetos que tenha nossoNumero/seuNumero
  if (Array.isArray(o)) {
    if (o.length && typeof o[0] === 'object' && o[0] && ('nossoNumero' in o[0] || 'seuNumero' in o[0])) return o;
    for (const x of o) { const l = acharLista(x); if (l) return l; }
    return o.length === 0 ? null : null;
  }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) { const l = acharLista(o[k]); if (l) return l; }
  return null;
}

// zip simples (central directory; aceita "stored" e "deflate") — o arquivo da movimentação vem zipado
async function deszipar(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || dv.getUint32(0, true) !== 0x04034b50) return [new TextDecoder().decode(bytes)];
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Zip da movimentação inválido.');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const saida = [];
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(p + 10, true), tamC = dv.getUint32(p + 20, true);
    const lNome = dv.getUint16(p + 28, true), lExtra = dv.getUint16(p + 30, true), lCom = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const nome = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + lNome));
    p += 46 + lNome + lExtra + lCom;
    if (nome.endsWith('/')) continue;
    const ini = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const dados = bytes.subarray(ini, ini + tamC);
    let plano;
    if (metodo === 0) plano = dados;
    else if (metodo === 8) plano = new Uint8Array(await new Response(new Blob([dados]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('Zip com compressão não suportada (' + metodo + ').');
    saida.push(new TextDecoder().decode(plano));
  }
  return saida;
}

function normalizarLiquidacao(x) {
  const n = k => r2(x[k]);
  const valorTitulo = n('valorTitulo'), mora = r2(Number(x.valorMora || 0) + Number(x.valorMulta || 0) + Number(x.valorJuros || 0));
  const desconto = r2(Number(x.valorDesconto || 0) + Number(x.valorAbatimento || 0));
  const tarifa = n('valorTarifaMovimento');
  const pago = r2(Number(x.valorPago || 0) || (valorTitulo + mora - desconto));
  return {
    nossoNumero: String(x.nossoNumero || '').trim(), seuNumero: String(x.seuNumero || '').trim(),
    dataLiquidacao: soData(x.dataLiquidacao || x.dataPagamento || x.dataMovimento),
    dataCredito: soData(x.dataPrevisaoCredito || x.dataCredito),
    dataVencimento: soData(x.dataVencimento), valorTitulo, mora, desconto, tarifa, pago, valorLiquido: n('valorLiquido'),
    pagadorDoc: dig(x.numeroCpfCnpjPagador || x.cpfCnpjPagador || (x.pagador && x.pagador.numeroCpfCnpj)),
    pagadorNome: String(x.nomePagador || (x.pagador && x.pagador.nome) || '').trim(),
  };
}

// completa com os dados do boleto (vencimento, seuNumero, pagador). Guardado 1 ano.
async function completarBoleto(env, b) {
  if (!b.nossoNumero || (b.dataVencimento && b.pagadorDoc && b.seuNumero)) return b;
  const ck = 'bolinfo:' + b.nossoNumero;
  let info = await env.BLING_KV.get(ck, 'json');
  if (!info) {
    try {
      const j = await sicoobCob(env, 'GET', '/boletos?numeroCliente=' + SICOOB_NUM_CLIENTE + '&codigoModalidade=1&nossoNumero=' + encodeURIComponent(b.nossoNumero));
      const bo = (j && j.resultado) || j || {};
      const pg = bo.pagador || {};
      info = { venc: soData(bo.dataVencimento), seu: String(bo.seuNumero || ''), doc: dig(pg.numeroCpfCnpj || pg.cpfCnpj), nome: String(pg.nome || ''),
        valor: r2(bo.valor || bo.valorTitulo), emissao: soData(bo.dataEmissao) };
      await env.BLING_KV.put(ck, JSON.stringify(info), { expirationTtl: 365 * 86400 });
    } catch (e) { info = { erro: String(e.message || e).slice(0, 160) }; }
  }
  return Object.assign({}, b, {
    dataVencimento: b.dataVencimento || info.venc || '', seuNumero: b.seuNumero || info.seu || '',
    pagadorDoc: b.pagadorDoc || info.doc || '', pagadorNome: b.pagadorNome || info.nome || '',
    valorTitulo: b.valorTitulo || info.valor || 0, infoErro: info.erro || '',
  });
}

// contas a receber do Bling com o mesmo vencimento do boleto (em aberto, parcial e — na simulação — recebidas)
async function contasPorVencimento(env, venc, ctx, incluirRecebidas) {
  const k = venc + (incluirRecebidas ? ':t' : ':a');
  ctx.venc = ctx.venc || {};
  if (ctx.venc[k]) return ctx.venc[k];
  const ck = 'bolcand:' + k;
  const c = await env.BLING_KV.get(ck, 'json');
  if (c && Date.now() - c.ts < (ctx.historico ? 6 * 3600e3 : 10 * 60e3)) return (ctx.venc[k] = c.l);
  const sits = '&situacoes[]=1&situacoes[]=3' + (incluirRecebidas ? '&situacoes[]=2' : '');
  const lista = await paginas(env, '/contas/receber?tipoFiltroData=V&dataInicial=' + venc + '&dataFinal=' + venc + sits, 3);
  const l = lista.map(x => ({ id: x.id, valor: r2(x.valor), venc: x.vencimento, situacao: Number(x.situacao),
    cliente: (x.contato && x.contato.nome) || '', doc: dig(x.contato && x.contato.numeroDocumento),
    origemTipo: (x.origem && x.origem.tipoOrigem) || '', origemId: (x.origem && x.origem.id) || 0, numero: String((x.origem && x.origem.numero) || ''),
    boleto: !!x.linkBoleto, forma: Number(x.formaPagamento && x.formaPagamento.codigoFiscal) || 0 }));
  await env.BLING_KV.put(ck, JSON.stringify({ ts: Date.now(), l }), { expirationTtl: 6 * 3600 });
  return (ctx.venc[k] = l);
}

const SIT_CONTA = { 1: 'Em aberto', 2: 'Recebido', 3: 'Parcialmente recebido', 4: 'Devolvido', 5: 'Cancelado' };

// decide a conta do Bling para um boleto liquidado
async function casarBoleto(env, b, ctx, simulacao) {
  const vinculo = await env.BLING_KV.get('bolvinc:' + b.nossoNumero, 'json');
  if (!b.dataVencimento && !vinculo) return { tipo: 'sem', motivo: 'Sem vencimento do boleto (consulta ao Sicoob falhou' + (b.infoErro ? ': ' + b.infoErro : '') + ').', candidatos: [] };
  const cands = b.dataVencimento ? await contasPorVencimento(env, b.dataVencimento, ctx, simulacao) : [];
  if (vinculo) {
    const c = cands.find(x => String(x.id) === String(vinculo.contaId)) || vinculo.conta;
    if (c) return { tipo: 'auto', conta: c, motivo: 'Vinculado manualmente por ' + (vinculo.por || '?'), pontos: 9 };
  }
  const tokens = (b.seuNumero.match(/\d+/g) || []).map(t => String(Number(t)));
  const avalia = c => {
    const valor = Math.abs(c.valor - b.valorTitulo) <= 0.01;
    const doc = !!(b.pagadorDoc && c.doc && b.pagadorDoc === c.doc);
    const seuConta = tokens.includes(String(c.id));
    const seuNf = !!(c.numero && tokens.length && tokens[0] === String(Number(c.numero)));
    return { c, valor, doc, seu: seuConta || seuNf, seuConta, seuNf };
  };
  const av = cands.map(avalia);
  const fortes = av.filter(a => a.valor && (a.doc || a.seu));
  // prefere quem bate tudo; depois quem tem boleto/forma boleto (código fiscal 15)
  fortes.sort((a, b2) => (Number(b2.doc) + Number(b2.seu) - Number(a.doc) - Number(a.seu)) || (Number(b2.c.forma === 15) - Number(a.c.forma === 15)));
  if (fortes.length === 1 || (fortes.length > 1 && (fortes[0].doc && fortes[0].seu) && !(fortes[1].doc && fortes[1].seu))) {
    const a = fortes[0];
    const m = [a.seu ? (a.seuConta ? 'seuNumero = id da conta' : 'seuNumero = nº da NF') : '', a.doc ? 'mesmo CPF/CNPJ' : '', 'mesmo valor e vencimento'].filter(Boolean).join(' + ');
    return { tipo: 'auto', conta: a.c, motivo: m, pontos: 1 + Number(a.doc) + Number(a.seu) };
  }
  const sug = av.filter(a => a.valor || a.doc || a.seu).slice(0, 6).map(a => ({
    contaId: a.c.id, numero: a.c.numero, origemTipo: a.c.origemTipo, cliente: a.c.cliente, valor: a.c.valor, situacao: a.c.situacao,
    motivo: [a.valor ? 'valor' : '', a.doc ? 'CPF/CNPJ' : '', a.seu ? 'seuNumero' : ''].filter(Boolean).join(' + ') + ' conferem' }));
  return { tipo: 'sem', motivo: fortes.length > 1 ? 'Mais de uma conta com o mesmo valor e pagador — escolha qual.' : (cands.length ? 'Nenhuma conta com o mesmo valor e pagador nesse vencimento.' : 'Nenhuma conta a receber no Bling com vencimento ' + brData(b.dataVencimento) + '.'), candidatos: sug };
}

// o que a automação faria/fará com um boleto casado
function planoBoleto(b, conta) {
  const data = b.dataCredito || b.dataLiquidacao;   // data em que o dinheiro entrou na conta
  const principal = r2(Math.min(r2(b.pago - b.mora + b.desconto), conta.valor));
  const parcial = principal < conta.valor - 0.009;
  const acoes = [{ acao: 'baixa', contaId: conta.id, data, valorBaixa: principal, juro: b.mora, desconto: b.desconto,
    detalhe: 'Baixa de R$ ' + principal.toFixed(2) + (b.mora ? ' + juros/multa R$ ' + b.mora.toFixed(2) : '') + (b.desconto ? ' − desconto R$ ' + b.desconto.toFixed(2) : '') +
      ' na conta ' + conta.id + (conta.numero ? ' (' + (conta.origemTipo === 'notafiscal' ? 'NF ' : 'pedido ') + conta.numero + ')' : '') + ', data ' + brData(data) + ', conta Sicoob' + (parcial ? ' — PARCIAL' : '') }];
  if (b.tarifa > 0) acoes.push({ acao: 'tarifa', data, valor: b.tarifa,
    detalhe: 'Despesa R$ ' + b.tarifa.toFixed(2) + ' em "Tarifa bancária", data ' + brData(data) + ', conta Sicoob (boleto ' + b.nossoNumero + ').' });
  return { data, principal, parcial, acoes };
}

// ---- leitura de um dia de movimentação (máquina de estados: solicitar → aguardar → baixar → tratar) ----
// job = {dia, cod, pedidoEm, tentativas, etapa, itens, idx, msg}
async function passoDia(env, job) {
  const nc = SICOOB_NUM_CLIENTE;
  if (job.etapa === 'novo') {
    try {
      const j = await sicoobCob(env, 'POST', '/boletos/movimentacoes', { numeroCliente: nc, tipoMovimento: 5, dataInicial: job.dia, dataFinal: job.dia });
      job.cod = acharCampo(j, ['codigoSolicitacao']);
      if (!job.cod) { job.etapa = 'vazio'; job.msg = 'Sicoob não devolveu código de solicitação.'; return job; }
      job.etapa = 'aguardando'; job.pedidoEm = Date.now(); job.tentativas = 0;
    } catch (e) {
      if (/nenhum|n[aã]o (foram )?encontrad|sem movimenta/i.test(e.msg || e.message)) { job.etapa = 'vazio'; job.msg = 'Sem liquidações neste dia.'; }
      else { job.etapa = 'erro'; job.msg = String(e.message || e).slice(0, 200); }
    }
    return job;
  }
  if (job.etapa === 'aguardando') {
    job.tentativas = (job.tentativas || 0) + 1;
    let j;
    try { j = await sicoobCob(env, 'GET', '/boletos/movimentacoes?numeroCliente=' + nc + '&codigoSolicitacao=' + encodeURIComponent(job.cod)); }
    catch (e) {
      if (/nenhum|n[aã]o (foram )?encontrad/i.test(e.msg || e.message) && e.status !== 500) { job.etapa = 'vazio'; job.msg = 'Sem liquidações neste dia.'; return job; }
      job.msg = 'Aguardando o Sicoob preparar o arquivo (' + String(e.msg || e.message).slice(0, 120) + ')';
      if (job.tentativas > 12) { job.etapa = 'erro'; }
      return job;
    }
    const qtd = acharCampo(j, ['quantidadeTotalRegistros', 'quantidadeRegistros']);
    let ids = acharCampo(j, ['idArquivos', 'idsArquivos', 'arquivos']);
    if (ids != null && !Array.isArray(ids)) ids = [ids];
    if (Number(qtd) === 0) { job.etapa = 'vazio'; job.msg = 'Sem liquidações neste dia.'; return job; }
    if (!ids || !ids.length) { job.msg = 'Aguardando o Sicoob preparar o arquivo.'; if (job.tentativas > 12) { job.etapa = 'erro'; job.msg = 'Sicoob não liberou o arquivo: ' + JSON.stringify(j).slice(0, 160); } return job; }
    job.arquivos = ids.map(x => (x && typeof x === 'object') ? (x.idArquivo || x.id) : x); job.etapa = 'baixar';
    return job;
  }
  if (job.etapa === 'baixar') {
    const itens = [];
    for (const id of job.arquivos) {
      const j = await sicoobCob(env, 'GET', '/boletos/movimentacoes/download?numeroCliente=' + nc + '&codigoSolicitacao=' + encodeURIComponent(job.cod) + '&idArquivo=' + encodeURIComponent(id));
      let b64 = acharCampo(j, ['arquivo', 'conteudo', 'arquivoBase64']);
      if (!b64 && typeof j._texto === 'string') b64 = j._texto;
      if (!b64) throw new Error('Download da movimentação sem arquivo: ' + JSON.stringify(j).slice(0, 160));
      let bytes;
      const s = String(b64).trim();
      if (s[0] === '{' || s[0] === '[') bytes = new TextEncoder().encode(s);
      else bytes = Uint8Array.from(atob(s.replace(/\s/g, '')), ch => ch.charCodeAt(0));
      for (const txt of await deszipar(bytes)) {
        let o; try { o = JSON.parse(txt); } catch (e) { continue; }
        const l = acharLista(o) || [];
        l.forEach(x => itens.push(normalizarLiquidacao(x)));
      }
    }
    job.itens = itens.filter(x => x.nossoNumero || x.seuNumero); job.idx = 0; job.etapa = job.itens.length ? 'tratar' : 'vazio';
    if (!job.itens.length) job.msg = 'Arquivo sem boletos liquidados.';
    return job;
  }
  return job;
}

// ---- simulação com boletos antigos (não grava nada no log real nem no Bling) ----
async function simularIniciar(env, b) {
  const de = soData(b.de) || '2026-07-01', ate = soData(b.ate) || '2026-08-31';
  if (ate < de) return { ok: false, erro: 'Período inválido.' };
  const dias = [];
  for (let d = de; d <= ate && dias.length < 200; d = somaDias(d, 1)) if (!fimDeSemana(d)) dias.push(d);
  const sim = { de, ate, dias, i: 0, job: null, iniciado: Date.now(), por: String(b.usuario || '').slice(0, 60), fim: false, resumo: { boletos: 0, auto: 0, sem: 0, jaRecebidas: 0, valor: 0, tarifas: 0, erros: 0 } };
  await env.BLING_KV.put('bolsim:estado', JSON.stringify(sim));
  await env.BLING_KV.put('bolsim:rel', '[]');
  return { ok: true, dias: dias.length };
}

async function simularPasso(env) {
  const sim = await env.BLING_KV.get('bolsim:estado', 'json');
  if (!sim) return { ok: false, erro: 'Nenhuma simulação iniciada.' };
  if (sim.fim) return { ok: true, fim: true, sim };
  const rel = (await env.BLING_KV.get('bolsim:rel', 'json')) || [];
  const ctx = { historico: true };
  if (!sim.job) sim.job = { dia: sim.dias[sim.i], etapa: 'novo' };
  const job = sim.job;
  if (job.etapa === 'aguardando' && job.pedidoEm && Date.now() - (job.ultimaConsulta || 0) < 4000) {
    return { ok: true, esperar: 4, sim: resumoSim(sim) };
  }
  if (job.etapa === 'tratar') {
    const fatia = job.itens.slice(job.idx, job.idx + BOL_POR_PASSO);
    for (const x0 of fatia) {
      const x = await completarBoleto(env, x0);
      const m = await casarBoleto(env, x, ctx, true);
      const linha = { dia: job.dia, nossoNumero: x.nossoNumero, seuNumero: x.seuNumero, pagador: x.pagadorNome, doc: x.pagadorDoc,
        vencimento: x.dataVencimento, liquidacao: x.dataLiquidacao, credito: x.dataCredito, valorTitulo: x.valorTitulo, mora: x.mora, desconto: x.desconto,
        pago: x.pago, tarifa: x.tarifa, liquido: x.valorLiquido, tipo: m.tipo, motivo: m.motivo };
      sim.resumo.boletos++; sim.resumo.valor = r2(sim.resumo.valor + x.pago); sim.resumo.tarifas = r2(sim.resumo.tarifas + x.tarifa);
      if (m.tipo === 'auto') {
        const pl = planoBoleto(x, m.conta);
        Object.assign(linha, { contaId: m.conta.id, nf: m.conta.numero, origemTipo: m.conta.origemTipo, cliente: m.conta.cliente, valorConta: m.conta.valor,
          situacaoBling: SIT_CONTA[m.conta.situacao] || m.conta.situacao, dataBaixa: pl.data, valorBaixa: pl.principal, parcial: pl.parcial, acoes: pl.acoes.map(a => a.detalhe) });
        sim.resumo.auto++; if (m.conta.situacao === 2) sim.resumo.jaRecebidas++;
      } else { linha.sugestoes = m.candidatos; sim.resumo.sem++; }
      rel.push(linha);
    }
    job.idx += fatia.length;
    if (job.idx >= job.itens.length) { job.etapa = 'feito'; job.itens = []; }
  } else {
    try { await passoDia(env, job); } catch (e) { job.etapa = 'erro'; job.msg = String(e.message || e).slice(0, 200); }
    job.ultimaConsulta = Date.now();
  }
  if (job.etapa === 'erro') { sim.resumo.erros++; rel.push({ dia: job.dia, tipo: 'erro', motivo: job.msg }); }
  if (['feito', 'vazio', 'erro'].includes(job.etapa)) {
    sim.i++; sim.job = null;
    if (sim.i >= sim.dias.length) { sim.fim = true; sim.terminado = Date.now(); }
  }
  await env.BLING_KV.put('bolsim:estado', JSON.stringify(sim));
  await env.BLING_KV.put('bolsim:rel', JSON.stringify(rel));
  return { ok: true, fim: sim.fim, sim: resumoSim(sim), esperar: job.etapa === 'aguardando' ? 4 : 0 };
}

function resumoSim(sim) {
  const j = sim.job || {};
  return { de: sim.de, ate: sim.ate, totalDias: sim.dias.length, diaAtual: j.dia || sim.dias[Math.min(sim.i, sim.dias.length - 1)], feitos: sim.i,
    etapa: j.etapa || '', msg: j.msg || '', fim: sim.fim, resumo: sim.resumo, iniciado: sim.iniciado, terminado: sim.terminado || 0 };
}

// ---- leitura diária (cron) — mesmo log de ações dos PIX ----
async function verificarBoletos(env, forcar) {
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) return { aviso: 'Sicoob não ativado' };
  const st = (await env.BLING_KV.get('bol:estado', 'json')) || { jobs: {}, ultimo: 0 };
  if (!forcar && Date.now() - (st.ultimo || 0) < BOL_INTERVALO && !Object.values(st.jobs).some(j => j.etapa === 'aguardando' || j.etapa === 'tratar' || j.etapa === 'baixar')) return { pulou: true };
  const hoje = hojeLocal();
  // hoje, ontem e anteontem: liquidações entram no dia e às vezes só aparecem no dia seguinte
  const dias = [hoje, somaDias(hoje, -1), somaDias(hoje, -2), somaDias(hoje, -3)].filter(d => !fimDeSemana(d));
  for (const k of Object.keys(st.jobs)) if (!dias.includes(k)) delete st.jobs[k];
  const ctx = {};
  let novos = 0, pendentes = 0, passos = 0;
  for (const dia of dias) {
    let job = st.jobs[dia];
    // dia ainda "vivo": pede de novo a cada leitura (hora em hora) para pegar liquidações novas
    if (!job || (['feito', 'vazio', 'erro'].includes(job.etapa) && Date.now() - (job.pedidoEm || 0) > 60 * 60e3 && dia >= somaDias(hoje, -1)))
      job = st.jobs[dia] = { dia, etapa: 'novo', pedidoEm: Date.now() };
    if (passos >= 2) break;
    if (job.etapa === 'tratar') {
      const fatia = job.itens.slice(job.idx, job.idx + BOL_POR_PASSO);
      for (const x0 of fatia) {
        const r = await tratarBoletoReal(env, x0, ctx);
        if (r === 'auto') novos++; else if (r === 'pendente') pendentes++;
      }
      job.idx += fatia.length;
      if (job.idx >= job.itens.length) { job.etapa = 'feito'; job.itens = []; }
      passos++;
    } else if (!['feito', 'vazio', 'erro'].includes(job.etapa)) {
      try { await passoDia(env, job); } catch (e) { job.etapa = 'erro'; job.msg = String(e.message || e).slice(0, 200); }
      if (job.etapa === 'novo' || job.etapa === 'aguardando') job.pedidoEm = job.pedidoEm || Date.now();
      passos++;
    }
  }
  st.ultimo = Date.now();
  await env.BLING_KV.put('bol:estado', JSON.stringify(st));
  if (novos) await env.BLING_KV.delete('cache:abertos');
  return { novos, pendentes, dias: Object.values(st.jobs).map(j => ({ dia: j.dia, etapa: j.etapa, msg: j.msg || '', qtd: (j.itens || []).length })) };
}

async function tratarBoletoReal(env, x0, ctx) {
  if (!x0.nossoNumero) return 'ignorado';
  if (await env.BLING_KV.get('bolpago:' + x0.nossoNumero)) return 'ja';
  const x = await completarBoleto(env, x0);
  const m = await casarBoleto(env, x, ctx, true);
  if (m.tipo === 'auto' && m.conta.situacao === 2) {
    // já estava recebida no Bling (baixa manual): só registra, nada a fazer
    await env.BLING_KV.put('bolpago:' + x.nossoNumero, 'ja-recebida', { expirationTtl: 400 * 86400 });
    await logAcao(env, { modo: (await env.BLING_KV.get('modo')) || 'simulacao', origem: 'boleto', acao: 'boleto_pago', tipo: 'nota', numero: m.conta.numero, cliente: m.conta.cliente, valor: x.pago,
      detalhe: 'Boleto ' + x.nossoNumero + ' de R$ ' + x.pago.toFixed(2) + ' liquidado em ' + brData(x.dataLiquidacao) + ' — a conta já estava Recebida no Bling (nada a fazer).' });
    return 'ja';
  }
  if (m.tipo === 'auto') { await executarPlanoBoleto(env, x, m); return 'auto'; }
  const pend = { nossoNumero: x.nossoNumero, seuNumero: x.seuNumero, pagador: x.pagadorNome, doc: x.pagadorDoc, vencimento: x.dataVencimento,
    liquidacao: x.dataLiquidacao, credito: x.dataCredito, valorTitulo: x.valorTitulo, pago: x.pago, mora: x.mora, desconto: x.desconto, tarifa: x.tarifa,
    motivo: m.motivo, sugestoes: m.candidatos, criado: Date.now(), dados: x };
  await env.BLING_KV.put('bolpend:' + x.nossoNumero, JSON.stringify(pend), { expirationTtl: 180 * 86400 });
  await env.BLING_KV.put('bolpago:' + x.nossoNumero, 'pendente', { expirationTtl: 400 * 86400 });
  const ids = (await env.BLING_KV.get('bolpendentes', 'json')) || [];
  if (!ids.includes(x.nossoNumero)) { ids.push(x.nossoNumero); await env.BLING_KV.put('bolpendentes', JSON.stringify(ids.slice(-300))); }
  return 'pendente';
}

async function executarPlanoBoleto(env, x, m, como) {
  const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
  const conta = m.conta;
  const pl = planoBoleto(x, conta);
  const base = { modo, origem: 'boleto', tipo: conta.origemTipo === 'venda' ? 'pedido' : 'nota', id: conta.origemId, numero: conta.numero, cliente: conta.cliente,
    nossoNumero: x.nossoNumero, valor: x.pago, pagador: x.pagadorNome };
  await env.BLING_KV.put('bolpago:' + x.nossoNumero, String(conta.id), { expirationTtl: 400 * 86400 });
  await logAcao(env, Object.assign({}, base, { acao: 'boleto_pago',
    detalhe: 'Boleto Sicoob ' + x.nossoNumero + (x.seuNumero ? ' (seu nº ' + x.seuNumero + ')' : '') + ' de R$ ' + x.pago.toFixed(2) + ' liquidado em ' + brData(x.dataLiquidacao) +
      (x.dataCredito && x.dataCredito !== x.dataLiquidacao ? ', crédito em ' + brData(x.dataCredito) : '') + (x.pagadorNome ? ' — ' + x.pagadorNome : '') + ' · ' + (como || m.motivo) }));
  for (const a of pl.acoes) {
    const reg = Object.assign({}, a);
    if (modo === 'real') {
      if (a.acao === 'baixa') reg.resultado = await executarBaixa(env, a.contaId, a.valorBaixa, a.data, { historico: 'Boleto Sicoob ' + x.nossoNumero + ' - app Mais Acessível', juro: a.juro, desconto: a.desconto }).catch(e => 'ERRO: ' + (e.message || e));
      else if (a.acao === 'tarifa') reg.resultado = 'PENDENTE: lançamento da tarifa ainda não ligado no modo real';
    }
    await logAcao(env, Object.assign({}, base, reg));
  }
  const kd = 'pagosdoc:' + base.tipo + ':' + base.id;
  const pd = (await env.BLING_KV.get(kd, 'json')) || [];
  pd.push({ boleto: x.nossoNumero, valor: x.pago, horario: x.dataCredito || x.dataLiquidacao, pagador: x.pagadorNome, origem: 'boleto' });
  await env.BLING_KV.put(kd, JSON.stringify(pd), { expirationTtl: 365 * 86400 });
}

async function boletosVincular(env, b) {
  const nn = String(b.nossoNumero || '');
  const p = await env.BLING_KV.get('bolpend:' + nn, 'json');
  if (!p) return { ok: false, erro: 'Boleto não encontrado.' };
  if (p.resolvido) return { ok: false, erro: 'Este boleto já foi tratado.' };
  const cands = p.vencimento ? await contasPorVencimento(env, p.vencimento, {}, true) : [];
  let conta = cands.find(c => String(c.id) === String(b.contaId));
  if (!conta) {
    const j = await bling(env, '/contas/receber/' + encodeURIComponent(b.contaId));
    const x = (j && j.data) || {};
    if (!x.id) return { ok: false, erro: 'Conta a receber não encontrada no Bling.' };
    conta = { id: x.id, valor: r2(x.valor), venc: x.vencimento, situacao: Number(x.situacao), cliente: (x.contato && x.contato.nome) || '', doc: dig(x.contato && x.contato.numeroDocumento),
      origemTipo: (x.origem && x.origem.tipoOrigem) || '', origemId: (x.origem && x.origem.id) || 0, numero: String((x.origem && x.origem.numero) || '') };
  }
  if (conta.situacao === 2) return { ok: false, erro: 'Essa conta já está Recebida no Bling.' };
  const por = String(b.usuario || '').slice(0, 60);
  await env.BLING_KV.put('bolvinc:' + nn, JSON.stringify({ contaId: conta.id, conta, por, em: Date.now() }), { expirationTtl: 400 * 86400 });
  await executarPlanoBoleto(env, p.dados, { conta, motivo: 'vinculado manualmente' }, 'vinculado manualmente por ' + por);
  p.resolvido = 'vinculado'; p.vinculo = { contaId: conta.id, numero: conta.numero }; p.por = por;
  await env.BLING_KV.put('bolpend:' + nn, JSON.stringify(p), { expirationTtl: 180 * 86400 });
  return { ok: true };
}

async function boletosPainel(env) {
  const ids = (await env.BLING_KV.get('bolpendentes', 'json')) || [];
  const pendentes = [];
  for (const nn of ids.slice(-60).reverse()) { const x = await env.BLING_KV.get('bolpend:' + nn, 'json'); if (x && !x.resolvido) { delete x.dados; pendentes.push(x); } }
  const acoes = ((await env.BLING_KV.get('acoes', 'json')) || []).filter(a => a.origem === 'boleto').slice(-150).reverse();
  const st = (await env.BLING_KV.get('bol:estado', 'json')) || { jobs: {} };
  const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
  return { ok: true, modo, ultimo: st.ultimo || 0, dias: Object.values(st.jobs || {}).map(j => ({ dia: j.dia, etapa: j.etapa, msg: j.msg || '' })), pendentes, acoes };
}
