// Teste de fumaça do app (trava de segurança da correção automática de chamados).
// Abre o index.html num Chrome sem tela, como ADMIN e como COLABORADOR, passa por todas as abas
// e falha se alguma tela der erro de JavaScript ou abrir vazia.
// Firebase e IA são SIMULADOS aqui dentro: o teste não lê nem grava nada de verdade.
// Uso:  npm i --no-save playwright && npx playwright install --with-deps chromium && node testes/smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORTA = 8099;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(RAIZ, p);
  if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORTA);

// Banco simulado
function novoBanco() {
  return { usuarios: { u1: { usuario: 'teste', ativo: true, role: 'user', abas: ['frete', 'mod10', 'mod8'] }, u2: { usuario: 'raul', ativo: true, role: 'admin' } } };
}
function partes(url) { return new URL(url).pathname.replace(/\.json$/, '').split('/').filter(Boolean); }
function ler(db, ps) { let d = db; for (const k of ps) { if (!d || typeof d !== 'object' || !(k in d)) return null; d = d[k]; } return d; }
function gravar(db, ps, v) { let d = db; ps.slice(0, -1).forEach(k => { d = d[k] = d[k] || {}; }); d[ps[ps.length - 1]] = v; }

const ABAS = ['inicio', 'frete', 'mod10', 'mod2', 'mod7', 'mod8', 'mod9', 'mod3', 'mod4', 'mod5', 'mod11', 'mod12', 'mod13', 'mod20', 'mod14', 'mod15', 'mod16', 'mod17', 'mod18', 'mod19', 'mod21'];
const falhas = [];

async function sessao(browser, usuario, role, abas) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const db = novoBanco();
  await ctx.addInitScript(([s]) => {
    if (window !== window.top) return; // só a página principal (quadros internos não têm acesso ao localStorage)
    try {
      localStorage.setItem('maisacessivel_session', JSON.stringify(s));
      localStorage.setItem('maisacessivel_fbauth', JSON.stringify({ uid: 't', email: 't@t', idToken: 't', refreshToken: 'r', exp: Date.now() + 1e9 }));
    } catch (e) {}
  }, [{ usuario, role, abas }]);
  await ctx.route('**/*', async (route, req) => {
    const u = req.url();
    if (u.startsWith('http://localhost:' + PORTA)) return route.continue();
    if (u.includes('firebaseio.com')) {
      const ps = partes(u), m = req.method(); let r = null;
      const corpo = () => { try { return JSON.parse(req.postData() || 'null'); } catch (e) { return null; } };
      if (m === 'GET') r = ler(db, ps);
      else if (m === 'PUT') { r = corpo(); gravar(db, ps, r); }
      else if (m === 'POST') { const k = '-T' + Date.now() + Math.random().toString(36).slice(2, 6); gravar(db, ps.concat(k), corpo()); r = { name: k }; }
      else if (m === 'PATCH') { r = Object.assign(ler(db, ps) || {}, corpo()); gravar(db, ps, r); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r), headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (u.includes('workers.dev')) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: true, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } }) });
    }
    return route.abort();
  });
  const page = await ctx.newPage();
  const erros = [];
  page.on('pageerror', e => erros.push(String(e && e.message || e)));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto(`http://localhost:${PORTA}/index.html`);
  await page.waitForTimeout(2500);
  return { ctx, page, erros };
}

async function conferirAbas(rotulo, s, abas) {
  if (s.erros.length) falhas.push(`[${rotulo}] erro ao abrir o app: ${s.erros.join(' | ')}`);
  const logado = await s.page.evaluate(() => typeof STATE !== 'undefined' && !!STATE.auth);
  if (!logado) { falhas.push(`[${rotulo}] o app não entrou logado`); return; }
  for (const id of abas) {
    const antes = s.erros.length;
    await s.page.evaluate(m => { try { irParaModulo(m); } catch (e) { setTimeout(() => { throw e; }); } }, id);
    await s.page.waitForTimeout(700);
    const info = await s.page.evaluate(() => {
      const main = document.querySelector('#app main');
      return { mod: STATE.modulo, txt: main ? main.innerText.trim().length : -1 };
    });
    if (s.erros.length > antes) falhas.push(`[${rotulo}] aba ${id}: ${s.erros.slice(antes).join(' | ')}`);
    else if (info.mod === id && info.txt <= 0) falhas.push(`[${rotulo}] aba ${id} abriu vazia`);
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROME || undefined });
try {
  const adm = await sessao(browser, 'raul', 'admin', null);
  await conferirAbas('admin', adm, ABAS);
  // Reportar Problema: formulário e painel
  await adm.page.evaluate(() => { RPP.aba = 'chamados'; irParaModulo('mod18'); });
  await adm.page.waitForTimeout(800);
  await adm.page.evaluate(() => { RPP.aba = 'aprendizado'; rppDraw(); });
  await adm.page.waitForTimeout(500);
  if (adm.erros.length) falhas.push('[admin] painel de chamados: ' + adm.erros.join(' | '));

  const col = await sessao(browser, 'teste', 'user', ['frete', 'mod10', 'mod8']);
  await conferirAbas('colaborador', col, ['inicio', 'frete', 'mod10', 'mod8', 'mod18']);
  const temForm = await col.page.evaluate(() => { rppAbrir(); return !!document.querySelector('#rppTela') && !!document.querySelector('#rppAconteceu'); });
  if (!temForm) falhas.push('[colaborador] formulário Reportar Problema não abriu');
  const vePrivado = await col.page.evaluate(() => !!document.querySelector('[data-aba=chamados]'));
  if (vePrivado) falhas.push('[colaborador] está vendo o painel de Chamados do admin');
} catch (e) {
  falhas.push('Teste quebrou: ' + (e && e.message || e));
} finally {
  await browser.close();
  srv.close();
}

if (falhas.length) {
  console.log('❌ TESTE FALHOU:\n- ' + falhas.join('\n- '));
  process.exit(1);
}
console.log('✅ Teste de fumaça ok: todas as abas abriram sem erro (admin e colaborador).');
