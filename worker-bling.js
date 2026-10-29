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
    ctx.waitUntil(verificarPagamentos(env).catch(e => logAcao(env, { acao: 'erro', detalhe: String(e.message || e) })));
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
        const acoes = (await env.BLING_KV.get('acoes', 'json')) || [];
        const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
        const ult = await env.BLING_KV.get('pix:ultimaVerificacao');
        return resp({ ok: true, modo, ultimaVerificacao: ult ? Number(ult) : 0, acoes: acoes.slice(-100).reverse() });
      }
      if (url.pathname === '/pagamentos/verificar' && req.method === 'POST') {
        const r = await verificarPagamentos(env);
        return resp(Object.assign({ ok: true }, r));
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

async function logAcao(env, a) {
  const lista = (await env.BLING_KV.get('acoes', 'json')) || [];
  lista.push(Object.assign({ quando: Date.now() }, a));
  await env.BLING_KV.put('acoes', JSON.stringify(lista.slice(-300)));
}

function isoSemMs(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); }

async function verificarPagamentos(env) {
  if (!env.SICOOB_MTLS || !env.SICOOB_CLIENT_ID) return { novos: 0, aviso: 'PIX não ativado' };
  const agora = Date.now();
  const ult = Number((await env.BLING_KV.get('pix:ultimaVerificacao')) || (agora - 6 * 3600e3));
  const inicio = isoSemMs(Math.max(ult - 15 * 60e3, agora - 4 * 86400e3));
  const fim = isoSemMs(agora);
  let pagina = 0, novos = 0, vistos = 0;
  while (pagina < 10) {
    const j = await sicoob(env, 'GET', '/pix?inicio=' + encodeURIComponent(inicio) + '&fim=' + encodeURIComponent(fim) + '&paginacao.paginaAtual=' + pagina + '&paginacao.itensPorPagina=100');
    const lista = (j && j.pix) || [];
    for (const p of lista) {
      vistos++;
      if (!p.txid || !p.endToEndId) continue;              // PIX direto na chave: tratado em outra etapa (CNPJ + valor)
      const reg = await env.BLING_KV.get('pix:' + p.txid, 'json');
      if (!reg) continue;                                    // não foi gerado pelo app
      if (await env.BLING_KV.get('pago:' + p.endToEndId)) continue;
      await env.BLING_KV.put('pago:' + p.endToEndId, p.txid, { expirationTtl: 180 * 86400 });
      novos++;
      const valor = Number(p.valor || 0);
      reg.pagamentos = (reg.pagamentos || []).concat([{ e2e: p.endToEndId, valor, horario: p.horario }]);
      reg.status = 'PAGO';
      await env.BLING_KV.put('pix:' + p.txid, JSON.stringify(reg), { expirationTtl: 180 * 86400 });
      const kd = 'pagosdoc:' + reg.tipo + ':' + reg.id;
      const pd = (await env.BLING_KV.get(kd, 'json')) || [];
      pd.push({ txid: p.txid, e2e: p.endToEndId, valor, horario: p.horario, pagador: (p.pagador && p.pagador.nome) || '' });
      await env.BLING_KV.put(kd, JSON.stringify(pd), { expirationTtl: 365 * 86400 });
      await planejarAcoes(env, reg, valor, p, pd);
    }
    const tp = j && j.parametros && j.parametros.paginacao && j.parametros.paginacao.quantidadeDePaginas;
    pagina++;
    if (!tp || pagina >= tp || lista.length < 100) break;
  }
  await env.BLING_KV.put('pix:ultimaVerificacao', String(agora));
  if (novos) await env.BLING_KV.delete('cache:abertos');
  return { novos, vistos, inicio, fim };
}

async function planejarAcoes(env, reg, valor, p, pagosDoc) {
  const modo = (await env.BLING_KV.get('modo')) || 'simulacao';
  const totalPago = Math.round(pagosDoc.reduce((s, x) => s + Number(x.valor || 0), 0) * 100) / 100;
  const base = { modo, tipo: reg.tipo, id: reg.id, numero: reg.numero, cliente: reg.cliente, txid: reg.txid, valor, horario: p.horario, pagador: (p.pagador && p.pagador.nome) || '' };
  const data = String(p.horario || new Date().toISOString()).slice(0, 10);
  await logAcao(env, Object.assign({}, base, { acao: 'pix_pago', detalhe: 'PIX de R$ ' + valor.toFixed(2) + ' recebido' + (base.pagador ? ' de ' + base.pagador : '') }));
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
      detalhe: 'Pedido ' + reg.numero + ' → situação "' + sit + '" (pago R$ ' + totalPago.toFixed(2) + (alvo ? ' de R$ ' + alvo.toFixed(2) : '') + '). O pagamento fica guardado para a baixa quando a nota for emitida.' }));
  }
}

async function executarBaixa(env, contaId, valor, data, reg) {
  // ativado só no modo "real", depois de conferido na simulação
  const tok = await tokenValido(env);
  const r = await fetch(API + '/contas/receber/' + contaId + '/baixar', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data, usarDataVencimento: false, portador: { id: PORTADOR_SICOOB }, historico: 'PIX app Mais Acessível ' + reg.txid, valorRecebido: Math.round(valor * 100) / 100, juro: 0, desconto: 0, acrescimo: 0, taxa: 0 }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('Bling ' + r.status + ': ' + t.slice(0, 200));
  return 'ok';
}
