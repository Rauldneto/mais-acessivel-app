// Travas e resultado da correção automática de chamados (usado pelo workflow corrigir-chamado.yml).
//   node testes/correcao.mjs travas     → confere a mudança feita pela IA (arquivos, tamanho, sintaxe)
//   node testes/correcao.mjs resultado  → grava chamados-auto/<chave>.json, que o app lê para dar a resposta ao colaborador
import fs from 'node:fs';
import vm from 'node:vm';
import { execSync } from 'node:child_process';

const modo = process.argv[2];
const LIMITE = parseInt(process.env.LIMITE_LINHAS || '40', 10);
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const saida = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
fs.mkdirSync('.correcao', { recursive: true });

if (modo === 'travas') {
  const motivos = [];
  const arquivos = sh('git status --porcelain --untracked-files=all').split('\n').filter(Boolean)
    .map(l => l.slice(3).trim()).filter(f => !f.startsWith('.correcao/') && !f.startsWith('node_modules'));
  const outros = arquivos.filter(f => f !== 'index.html');
  if (outros.length) motivos.push('a correção mexeu em outros arquivos: ' + outros.join(', '));
  let linhas = 0;
  if (arquivos.includes('index.html')) {
    const ns = sh('git diff --numstat -- index.html');
    ns.split('\n').filter(Boolean).forEach(l => { const [a, d] = l.split('\t'); linhas += (parseInt(a, 10) || 0) + (parseInt(d, 10) || 0); });
    if (linhas > LIMITE) motivos.push(`mudança grande demais (${linhas} linhas; limite ${LIMITE})`);
    const html = fs.readFileSync('index.html', 'utf8');
    const blocos = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(m => !/\bsrc=/.test(m[1] || '') && !/type=["'](?!text\/javascript|module)/.test(m[1] || ''));
    blocos.forEach((m, i) => { try { new vm.Script(m[2], { filename: 'bloco' + i + '.js' }); } catch (e) { motivos.push('erro de sintaxe no JavaScript: ' + e.message); } });
  } else {
    motivos.push('nenhuma mudança no app');
  }
  const r = { ok: motivos.length === 0, linhas, arquivos, motivo: motivos.join('; ') };
  fs.writeFileSync('.correcao/travas.json', JSON.stringify(r, null, 2));
  console.log(r.ok ? `✅ Travas ok (${linhas} linhas alteradas em index.html)` : '❌ Travas: ' + r.motivo);
  saida('ok', r.ok ? 'true' : 'false');
  process.exit(0);
}

if (modo === 'resultado') {
  const chave = process.env.CHAVE, numero = parseInt(process.env.NUMERO, 10);
  const lerJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  const ia = lerJson('.correcao/resultado.json') || {};
  const travas = lerJson('.correcao/travas.json') || {};
  const etapa = process.env.ETAPA_FALHOU || '';
  let ok = false, motivo = '';
  if (etapa) motivo = etapa;
  else if (ia.corrigiu !== true) motivo = 'a IA não aplicou correção: ' + (ia.motivo || 'sem motivo informado');
  else if (!travas.ok) motivo = 'correção descartada pelas travas: ' + (travas.motivo || '?');
  else if (process.env.TESTE_DEPOIS !== 'ok') motivo = 'correção descartada: o teste das telas falhou depois da mudança';
  else ok = true;
  const PADRAO_PEND = 'O erro foi confirmado e ficou pendente para o T.I. avaliar. Você acompanha a resposta aqui.';
  const r = {
    chave, numero, ok, t: Date.now(),
    resumo: String(ia.resumo || '').slice(0, 600),
    parecer: String(ok ? (ia.parecer || 'Corrigido! Clique em 🔄 Atualizar no topo do app e tente de novo.') : PADRAO_PEND).slice(0, 600),
    motivo: String(motivo).slice(0, 600),
    linhas: travas.linhas || 0,
    execucao: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : ''
  };
  fs.mkdirSync('chamados-auto', { recursive: true });
  fs.writeFileSync(`chamados-auto/${chave}.json`, JSON.stringify(r, null, 2));
  console.log((ok ? '✅ Corrigido: ' : '⏳ Ficou pendente: ') + (ok ? r.resumo : r.motivo));
  saida('ok', ok ? 'true' : 'false');
  process.exit(0);
}

console.error('uso: node testes/correcao.mjs travas|resultado');
process.exit(2);
