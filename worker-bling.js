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

const ORIGENS = ['https://rauldneto.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];
const API = 'https://api.bling.com.br/Api/v3';
const TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const SIT_PEDIDO_ABERTO = 6;              // "Em aberto" (módulo Vendas)
const COD_PIX = 17, COD_CREDITO = 3;      // códigos fiscais da forma de pagamento (tPag da NF-e)
const DIAS_PEDIDOS = 120;                 // pedidos em aberto criados nos últimos N dias
const DIAS_CONTAS = 180;                  // contas a receber em aberto emitidas nos últimos N dias

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

  itens.sort((a, b) => String(b.data).localeCompare(String(a.data)) || Number(b.numero) - Number(a.numero));
  return { itens, faltaram };
}

// ---------------- PIX pelo Sicoob (cobrança imediata) ----------------
const SICOOB_TOKEN = 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token';
const SICOOB_PIX = 'https://api.sicoob.com.br/pix/api/v2';

async function sicoobToken(env) {
  const c = await env.BLING_KV.get('sicoob:token', 'json');
  if (c && Date.now() < c.exp) return c.access;
  const r = await env.SICOOB_MTLS.fetch(SICOOB_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(env.SICOOB_CLIENT_ID) + '&scope=' + encodeURIComponent('cob.write cob.read pix.read'),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Sicoob recusou o acesso (' + r.status + '): ' + (j.error_description || j.error || ''));
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
  const reg = { txid, tipo: b.tipo, id: b.id, numero: b.numero || '', valor, cliente: nome, doc, usuario: String(b.usuario || '').slice(0, 60),
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
