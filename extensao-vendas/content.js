if (!window.__maContentLoaded) {
window.__maContentLoaded = true;
// content.js — lê os campos da proposta do Bling e responde ao popup.
// v1.3: sem botões flutuantes; tudo acontece pelo popup da extensão.

function fld(n) {
  var e = document.querySelector('[name="' + n + '"]');
  return e ? (e.value || '').trim() : '';
}

function textoSelect(n) {
  var e = document.querySelector('[name="' + n + '"]');
  if (!e || !e.options || e.selectedIndex < 0) return '';
  return (e.options[e.selectedIndex].text || '').trim();
}

function numX(s) { if (typeof s === 'number') return s; var t = String(s || '').trim(); return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : numBR(t); } // aceita 2636.00 e 2.636,00
function numBR(s) {
  return parseFloat(String(s || '').replace(/\./g, '').replace(',', '.')) || 0;
}

function telaDeProposta() {
  var url = window.location.href;
  return url.indexOf('orcamentos.php') !== -1 && /#(edit|add)/.test(url);
}

function coletarDados() {
  var url = window.location.href;
  var num = fld('numeroProposta');
  var mUrl = url.match(/[#\/](\d{10,})/);
  var idProposta = mUrl ? mUrl[1] : '';

  var dados = {
    emBling: url.includes('bling.com.br'),
    emProposta: telaDeProposta() && !!(num || idProposta),
    numeroProposta: num,
    idProposta: idProposta,
    nomeVendedor: fld('nomeVendedor'),
    nomeContato: fld('contato'),
    pesoBruto: fld('pesoBruto'),
    totalOrcamento: fld('totalOrcamento'),
    qtdVolumes: fld('qtdVolumes'),
    campoTotalQtds: fld('campoTotalQtds'),
    frete_modalidade: fld('frete_modalidade'),
    idContato: fld('idContato'),
    etiqueta_cep: fld('etiqueta_cep'),
    etiqueta_endereco: fld('etiqueta_endereco'),
    etiqueta_numero: fld('etiqueta_numero'),
    etiqueta_complemento: fld('etiqueta_complemento'),
    etiqueta_bairro: fld('etiqueta_bairro'),
    etiqueta_municipio: fld('etiqueta_municipio'),
    etiqueta_uf: fld('etiqueta_uf'),
    itens: []
  };

  var prods = document.querySelectorAll('[name="itens[produto][]"]');
  var qtds  = document.querySelectorAll('[name="itens[quantidade][]"]');
  var cods  = document.querySelectorAll('[name="itens[codigo][]"]');
  var pus   = document.querySelectorAll('[name="itens[precounitario][]"]');
  prods.forEach(function(el, i) {
    dados.itens.push({
      produto: { descricao: el.value },
      quantidade: qtds[i] ? parseFloat(qtds[i].value) || 1 : 1,
      codigo: cods[i] ? cods[i].value : '',
      precoUnitario: pus[i] ? pus[i].value : ''
    });
  });

  return dados;
}

// ====================== CHECK PROPOSTA ======================
// Regras do checklist da Mais Acessível. Para mudar uma regra, mexa aqui.
var REGRAS = {
  lojaEsperada: 'mais acessivel',
  validadeDias: 5,
  formaPix: 'pix - venda',           // forma obrigatória quando a condição é 0 ou PIX
  formaPixExcecao: 'pix - bling conta' // só se a diretoria estiver ausente
};

// Boleto: a única forma aceita é "BOLETO BLING-CONTA" (qualquer outro boleto é erro)
function chaveForma(t) { return norm(t).replace(/[^a-z0-9]/g, ''); }
function boletoErrado(nome) { var k = chaveForma(nome); return k.indexOf('boleto') !== -1 && k !== 'boletoblingconta'; }
var FORMAS_NOME = null;
async function carregarFormas() {
  if (FORMAS_NOME) return FORMAS_NOME;
  try { var l = await finListas(); FORMAS_NOME = {}; (l.formas || []).forEach(function(o) { FORMAS_NOME[o.id] = o.nome; }); } catch (e) { FORMAS_NOME = {}; }
  return FORMAS_NOME;
}
function norm(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

// status: 'ok' | 'erro' (bloqueia) | 'aviso' (só alerta)
function item(grupo, campo, status, msg) {
  return { grupo: grupo, campo: campo, status: status, msg: msg || '' };
}

// Regra do frete (tabela da diretoria). Qualquer combinação fora dela = erro.
//  Cortesia               + CIF + frete = 0
//  Mais Acessível         + CIF + frete > 0
//  Transportadora (coleta)+ CIF + frete > 0
//  FOB - Retirada na loja + FOB + frete = 0
//  Transportadora (coleta)+ FOB + frete = 0
function regraFrete(transp, mod, frete) {
  var t = norm(transp);
  var nome = /cortesia/.test(t) ? 'cortesia' : /retir/.test(t) ? 'retirada' : /mais acessivel/.test(t) ? 'mais' : 'transp';
  var rot = { cortesia: 'Cortesia', retirada: 'Retirada na loja', mais: 'Mais Acessível', transp: 'Transportadora' }[nome];
  if (vazio(transp)) return { ok: false, msg: 'Informe o transportador: Cortesia, Mais Acessível, FOB - Retirada na loja ou a transportadora que vai coletar' };
  if (mod !== 'R' && mod !== 'D') return { ok: false, msg: 'Frete por conta: use CIF ou FOB' };
  if (nome === 'transp' && !t.replace(/\b(cif|fob|frete|por conta|do|da|de)\b/g, '').replace(/[^a-z0-9]/g, ''))
    return { ok: false, msg: 'Transportador "' + transp.trim() + '" não é um nome: informe a transportadora que vai coletar (ou Cortesia / Mais Acessível / FOB - Retirada na loja)' };
  var cif = mod === 'R', valor = frete > 0;
  if (nome === 'cortesia') {
    if (!cif) return { ok: false, msg: 'Cortesia: o frete deve ser CIF' };
    if (valor) return { ok: false, msg: 'Cortesia: o valor do frete deve ser R$ 0,00' };
  } else if (nome === 'retirada') {
    if (cif) return { ok: false, msg: 'Retirada na loja: o frete deve ser FOB' };
    if (valor) return { ok: false, msg: 'Retirada na loja: o valor do frete deve ser R$ 0,00' };
  } else if (cif && !valor) {
    return { ok: false, msg: rot + ' com frete CIF: informe o valor do frete (maior que 0)' };
  } else if (!cif && nome === 'mais') {
    return { ok: false, msg: 'Mais Acessível entregando: o frete deve ser CIF com valor' };
  } else if (!cif && valor) {
    return { ok: false, msg: 'Frete FOB: o valor do frete deve ser R$ 0,00 (o cliente paga a transportadora)' };
  }
  return { ok: true, msg: rot + ' · ' + (cif ? 'CIF' : 'FOB') + ' · R$ ' + frete.toFixed(2).replace('.', ',') };
}

// "Endereço de entrega diferente da cobrança" marcado: frete > 0 => CIF; frete = 0 => FOB (Cortesia é exceção).
function regraEntrega(mod, frete, transp) {
  // Cortesia é exceção: vale a regra da Cortesia (CIF + R$ 0,00), conferida em regraFrete
  if (/cortesia/.test(norm(transp))) return { ok: true, msg: 'Cortesia (exceção) · CIF · R$ 0,00' };
  if (frete > 0) return mod === 'R' ? { ok: true, msg: 'CIF · R$ ' + frete.toFixed(2).replace('.', ',') }
    : { ok: false, msg: 'Entrega em outro endereço com valor de frete: o frete deve ser CIF' };
  return mod === 'D' ? { ok: true, msg: 'FOB · frete R$ 0,00' }
    : { ok: false, msg: 'Entrega em outro endereço com frete zerado: o frete deve ser FOB' };
}

function vazio(v) { return !v || !String(v).trim(); }

// Aguarda o Bling terminar de carregar a proposta (evita checar com campos ainda vazios)
async function aguardarFormulario() {
  var ultimo = '';
  for (var t = 0; t < 16; t++) {
    var pronto = fld('numeroProposta') && fld('idContato') &&
      document.querySelectorAll('[name="parcelas[nroDias][]"]').length > 0;
    var assinatura = [fld('numeroProposta'), fld('idContato'), fld('idVendedor'), fld('validade'),
      fld('transportador'), fld('qtdVolumes'), fld('observacaoInterna').length,
      document.querySelectorAll('[name="parcelas[nroDias][]"]').length].join('|');
    if (pronto && assinatura === ultimo) return true; // estável por 2 leituras seguidas
    ultimo = assinatura;
    await new Promise(function(res) { setTimeout(res, 400); });
  }
  return false;
}

async function checarProposta() {
  await aguardarFormulario();
  var r = [];

  // ---------- Cliente ----------
  var idContato = fld('idContato');
  var nomeContato = fld('contato');
  if (vazio(idContato) || idContato === '0') {
    r.push(item('Cliente', 'Cliente', 'erro', 'Selecione um cliente cadastrado (não digite só o nome)'));
  } else {
    var c = null, falhaApi = '';
    try {
      var x = await fetch('/Api/v3/contatos/' + idContato, { credentials: 'include' });
      if (!x.ok) falhaApi = 'HTTP ' + x.status;
      else {
        var resp = await x.json();
        var d = resp && resp.data;
        // só aceita se for realmente um cadastro (evita ler resposta de erro como cliente sem dados)
        if (d && (d.id || d.nome)) c = d; else falhaApi = 'resposta sem cadastro';
      }
    } catch (e) { falhaApi = 'sem conexão'; }
    if (!c) {
      r.push(item('Cliente', 'Cadastro do cliente', 'aviso', 'Não consegui abrir o cadastro no Bling (' + falhaApi + '). Confira telefone, e-mail e CPF/CNPJ manualmente'));
    } else {
      var faltas = [];
      if (vazio(c.cpf_cnpj)) faltas.push('CPF/CNPJ');
      if (vazio(c.fone) && vazio(c.celular)) faltas.push('telefone');
      if (vazio(c.email) && vazio(c.email_nfe)) faltas.push('e-mail');
      r.push(faltas.length
        ? item('Cliente', 'Cadastro do cliente', 'erro', 'Falta no cadastro: ' + faltas.join(', '))
        : item('Cliente', 'Cadastro do cliente', 'ok', nomeContato));
    }
  }
  r.push(item('Cliente', 'Lembrete: cadastro na Baruc', 'aviso', 'Confirme se o cliente já está cadastrado na Baruc'));
  r.push(item('Cliente', 'Lembrete: telefone e e-mail', 'aviso', 'Confirme se o telefone e o e-mail do cliente estão corretos e cadastrados na Baruc'));

  // ---------- Dados gerais ----------
  r.push(vazio(fld('contato_ac'))
    ? item('Geral', 'Aos cuidados de', 'erro', 'Informe o nome do comprador')
    : item('Geral', 'Aos cuidados de', 'ok', fld('contato_ac')));

  var loja = textoSelect('loja');
  r.push(loja.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').indexOf(REGRAS.lojaEsperada) === -1
    ? item('Geral', 'Loja', 'erro', 'Selecione a loja Mais Acessível')
    : item('Geral', 'Loja', 'ok', loja));

  var lista = fld('idListaPreco');
  r.push((vazio(lista) || lista === '0')
    ? item('Geral', 'Lista de preços', 'erro', 'Está em "Selecione uma lista". Escolha a lista correta')
    : item('Geral', 'Lista de preços', 'ok', textoSelect('idListaPreco')));

  var idVend = fld('idVendedor');
  r.push((vazio(fld('nomeVendedor')) || vazio(idVend) || idVend === '0')
    ? item('Geral', 'Vendedor', 'erro', 'Selecione o vendedor cadastrado')
    : item('Geral', 'Vendedor', 'ok', fld('nomeVendedor')));

  // ---------- Condições comerciais: parcelas ----------
  var dias  = document.querySelectorAll('[name="parcelas[nroDias][]"]');
  var forma = document.querySelectorAll('[name="parcelas[idFormaPagamento][]"]');
  var obs   = document.querySelectorAll('[name="parcelas[obs][]"]');
  var condicao = norm(fld('condicao'));
  var condPix = condicao === '0' || condicao.indexOf('pix') !== -1;
  if (!dias.length) {
    r.push(item('Pagamento', 'Parcelas', 'erro', 'Nenhuma parcela gerada. Informe a condição de pagamento'));
  } else {
    var problemas = [];
    dias.forEach(function(el, i) {
      var f = [];
      if (vazio(el.value)) f.push('dias');
      if (!forma[i] || vazio(forma[i].value)) f.push('forma de pagamento');
      if (!obs[i] || vazio(obs[i].value)) f.push('observação');
      if (f.length) problemas.push('Parcela ' + (i + 1) + ': falta ' + f.join(', '));
    });
    // Forma de pagamento PIX: condição 0 ou PIX exige PIX - Venda
    var formaErros = [], usaBlingConta = false, boletoErr = [];
    forma.forEach(function(sel, i) {
      if (!sel || vazio(sel.value)) return; // já apontado acima
      var txtOrig = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text.trim() : '';
      if (boletoErrado(txtOrig)) boletoErr.push('Parcela ' + (i + 1) + ' está "' + txtOrig + '"');
      var txt = norm(txtOrig);
      if (txt === REGRAS.formaPixExcecao) { usaBlingConta = true; return; }
      if (condPix && txt !== REGRAS.formaPix) formaErros.push('Parcela ' + (i + 1));
    });
    if (boletoErr.length) r.push(item('Pagamento', 'Forma de pagamento (boleto)', 'erro', 'Boleto: a forma deve ser "BOLETO BLING-CONTA" (' + boletoErr.join(', ') + ')'));
    if (formaErros.length) {
      r.push(item('Pagamento', 'Forma de pagamento', 'erro',
        'Condição ' + (condicao === '0' ? '0 (à vista)' : 'PIX') + ': a forma deve ser "PIX - Venda" (' + formaErros.join(', ') + ')'));
    } else if (usaBlingConta) {
      r.push(item('Pagamento', 'Forma de pagamento', 'aviso',
        '"Pix - Bling Conta" só pode ser usado se a diretoria estiver ausente'));
    } else if (condPix) {
      r.push(item('Pagamento', 'Forma de pagamento', 'ok', 'PIX - Venda'));
    }
    r.push(problemas.length
      ? item('Pagamento', 'Parcelas', 'erro', problemas.join(' • '))
      : item('Pagamento', 'Parcelas', 'ok', dias.length + ' parcela(s) completas'));
  }

  // ---------- Condições gerais ----------
  // Validade: só confere se foi preenchida (pode ser menor que o padrão, conforme o produto)
  var validade = parseInt(fld('validade'), 10);
  r.push((isNaN(validade) || validade <= 0)
    ? item('Condições', 'Validade', 'erro', 'Informe a validade (padrão: ' + REGRAS.validadeDias + ' dias)')
    : item('Condições', 'Validade', 'ok', validade + ' dias'));

  r.push(vazio(fld('prazo_entrega'))
    ? item('Condições', 'Prazo de entrega', 'erro', 'Informe o prazo de entrega')
    : item('Condições', 'Prazo de entrega', 'ok', fld('prazo_entrega')));

  // ---------- Transportador ----------
  var transp = fld('transportador');
  var mod = fld('frete_modalidade');
  var rf = regraFrete(transp, mod, numBR(fld('frete')));

  r.push(vazio(transp)
    ? item('Transporte', 'Transportador', 'erro', 'Informe o transportador')
    : item('Transporte', 'Transportador', 'ok', transp));
  r.push(item('Transporte', 'Frete (transportador × CIF/FOB × valor)', rf.ok ? 'ok' : 'erro', rf.msg));

  // ---------- Entrega em endereço diferente do cadastro ----------
  var cbEntrega = document.getElementById('etiqueta_mostrar') || document.querySelector('[name="etiqueta_mostrar"]');
  if (cbEntrega && cbEntrega.checked) {
    // 1) com valor de frete > 0 deve ser CIF; com frete zerado deve ser FOB
    var reE = regraEntrega(mod, numBR(fld('frete')), transp);
    r.push(item('Entrega', 'Entrega em outro endereço: frete', reE.ok ? 'ok' : 'erro', reE.msg));
    // 2) endereço de entrega completo
    var campos = [['etiqueta_nome', 'nome'], ['etiqueta_cep', 'CEP'], ['etiqueta_endereco', 'endereço'],
      ['etiqueta_numero', 'número'], ['etiqueta_bairro', 'bairro'], ['etiqueta_municipio', 'município'], ['etiqueta_uf', 'UF']];
    var faltaEnd = campos.filter(function(c) { return vazio(fld(c[0])); }).map(function(c) { return c[1]; });
    r.push(faltaEnd.length
      ? item('Entrega', 'Endereço de entrega', 'erro', 'Preencha em "Endereço de entrega diferente da cobrança": ' + faltaEnd.join(', '))
      : item('Entrega', 'Endereço de entrega', 'ok', fld('etiqueta_endereco') + ', ' + fld('etiqueta_numero') + ' - ' + fld('etiqueta_municipio') + '/' + fld('etiqueta_uf')));
    // 3) endereço de entrega informado nas Observações (Condições gerais)
    var ceo = checaEndObs(fld('observacao'), fld('etiqueta_cep'), fld('etiqueta_endereco'));
    r.push(item('Entrega', 'Endereço nas Observações', ceo.ok ? 'ok' : 'erro', ceo.msg));
  }

  r.push(numBR(fld('qtdVolumes')) <= 0
    ? item('Transporte', 'Quantidade de volumes', 'erro', 'Informe a quantidade de volumes')
    : item('Transporte', 'Quantidade de volumes', 'ok', fld('qtdVolumes')));

  r.push(vazio(fld('observacaoInterna'))
    ? item('Transporte', 'Dados adicionais (interno)', 'erro', 'Preencha "Observações Internas" na seção Dados adicionais (não confundir com Observações das Condições gerais)')
    : item('Transporte', 'Dados adicionais (interno)', 'ok', 'Preenchido'));

  return {
    numeroProposta: fld('numeroProposta'),
    itens: r,
    erros: r.filter(function(x) { return x.status === 'erro'; }).length,
    avisos: r.filter(function(x) { return x.status === 'aviso'; }).length
  };
}


// ====================== CONFERÊNCIA EM LOTE (aba Cotações do app) ======================
// Mesmas regras do Check, aplicadas aos dados salvos da proposta (API interna do Bling).
var LOTE = {
  lojaId: 204368449,              // Mais Acessivel
  formaPixVenda: 3901857,         // PIX - Venda
  formaPixBlingConta: 11272920    // Pix - Bling Conta
};

async function blingGet(path) {
  for (var t = 0; ; t++) {
    var x = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (x.status === 401 || x.status === 403) throw new Error('SESSAO');
    if (x.ok) return x.json();
    if (x.status >= 500 && t < 3) { await new Promise(function(r) { setTimeout(r, 2500 * (t + 1)); }); continue; } // Bling instável: tenta de novo
    throw new Error('HTTP ' + x.status);
  }
}

async function listarPropostas(filtro) {
  if (filtro.situacaoPesq !== undefined) return listarPropostasBling(filtro);
  return listarPropostasApi(filtro);
}

// Usa a MESMA busca da tela de Propostas do Bling (mesmas situações, inclusive "Em aberto").
// Cotações "ORÇAMENTO VAGO" são números reservados para reaproveitar: tratadas como inexistentes
function naoVago(i) { return !/or[cç]amento\s*vago/i.test(String(i.cliente || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')); }
async function listarPropostasBling(filtro) {
  function br(iso) { var p = String(iso).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function iso(br) { var p = String(br || '').split('/'); return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : ''; }
  var hoje = new Date();
  var fim = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0') + '-' + String(hoje.getDate()).padStart(2, '0');
  var base = '/Api/v3/propostas-comerciais/list?pesquisa=' + encodeURIComponent(filtro.pesquisa || '') + '&unidadesNegocioSelect=0&idPsqCidade=0&psqCidade=&psqEmailCliente=' +
    '&idPsqProduto=0&psqProduto=&idPsqVendedor=0&psqVendedor=&lojasVinculadas=todas&criterioPeriod=' + encodeURIComponent('Período customizado') +
    '&dataOpc=periodo&idLoja=todas&idConfUnidadeNegocio=0&situacaoPesq=' + encodeURIComponent(filtro.situacaoPesq || 'sit-') +
    '&dataIni=' + encodeURIComponent(br(filtro.desde || fim)) + '&dataFim=' + encodeURIComponent(br(fim));
  var itens = [], vistos = {}, total = null;
  for (var pag = 1; pag <= 100; pag++) {
    var j = await blingGet(base + '&pagina=' + pag);
    var lista = (j && j.data) || [];
    if (total === null) total = parseInt(j && j.paginacao && j.paginacao.totalRegistros, 10) || 0;
    var novos = 0;
    lista.forEach(function(p) {
      if (vistos[p.id]) return;
      vistos[p.id] = 1; novos++;
      itens.push({ id: p.id, numero: String(p.numeroProposta || '').trim(), data: iso(p.data), situacao: p.situacao,
        total: p.totalOrcamento, cliente: p.nome || '' });
    });
    if (!lista.length || !novos || itens.length >= total) break;
  }
  return { itens: itens.filter(naoVago) };
}

async function listarPropostasApi(filtro) {
  var desde = filtro.desde || '0000-00-00';
  var sits = filtro.situacoes || null; // null = todas
  var itens = [], vistos = {};
  // A API interna do Bling pagina com page/limit (ignora pagina/limite).
  for (var pag = 1; pag <= 60; pag++) {
    var j = await blingGet('/Api/v3/propostas-comerciais?page=' + pag + '&limit=100');
    var lista = (j && j.data) || [];
    var novos = 0, antigas = 0;
    lista.forEach(function(p) {
      if (vistos[p.id]) return;
      vistos[p.id] = 1; novos++;
      if ((p.data || '') < desde) { antigas++; return; }
      if (sits && sits.indexOf(p.situacao) === -1) return;
      itens.push({ id: p.id, numero: p.numero, data: p.data, situacao: p.situacao, total: p.total,
        cliente: (p.contato && p.contato.nome) || '' });
    });
    // lista vem da mais nova para a mais antiga: para quando acabar, repetir ou passar do período
    if (lista.length < 100 || !novos || antigas === novos) break;
  }
  return { itens: itens.filter(naoVago) };
}

function regrasApi(d) {
  var r = [];
  function erro(campo, msg) { r.push({ status: 'erro', campo: campo, msg: msg }); }
  function aviso(campo, msg) { r.push({ status: 'aviso', campo: campo, msg: msg }); }
  var c = d.contato || {};
  if (!c.id) erro('Cliente', 'Cliente não selecionado do cadastro');
  else {
    var f = [];
    if (vazio(c.cnpj) && vazio(c.cpf_cnpj)) f.push('CPF/CNPJ');
    if (vazio(c.fone) && vazio(c.celular)) f.push('telefone');
    if (vazio(c.email) && vazio(c.email_nfe)) f.push('e-mail');
    if (f.length) erro('Cadastro do cliente', 'Falta no cadastro: ' + f.join(', '));
  }
  if (vazio(d.contatoAc)) erro('Aos cuidados de', 'Informe o nome do comprador');
  if (!d.loja || String(d.loja.id) !== String(LOTE.lojaId)) erro('Loja', 'Selecione a loja Mais Acessível');
  if (vazio(d.idListaPreco) || String(d.idListaPreco) === '0') erro('Lista de preços', 'Está em "Selecione uma lista"');
  if (!d.vendedor || !d.vendedor.id || String(d.vendedor.id) === '0') erro('Vendedor', 'Selecione o vendedor cadastrado');

  var parc = d.parcelas || [];
  var condicao = norm(d.condicao);
  var condPix = condicao === '0' || condicao.indexOf('pix') !== -1;
  if (!parc.length) erro('Parcelas', 'Nenhuma parcela gerada');
  else {
    var probs = [], formaErr = [], blingConta = false, bolErr = [];
    parc.forEach(function(p, i) {
      var falta = [];
      if (p.nroDias === null || p.nroDias === undefined || p.nroDias === '') falta.push('dias');
      var fid = p.formaPagamento && p.formaPagamento.id;
      if (!fid) falta.push('forma de pagamento');
      if (vazio(p.obs)) falta.push('observação');
      if (falta.length) probs.push('Parcela ' + (i + 1) + ': falta ' + falta.join(', '));
      var fnome = (p.formaPagamento && (p.formaPagamento.descricao || p.formaPagamento.nome)) || (FORMAS_NOME && FORMAS_NOME[fid]) || '';
      if (fid && boletoErrado(fnome)) bolErr.push('Parcela ' + (i + 1) + ' está "' + fnome + '"');
      if (fid == LOTE.formaPixBlingConta) blingConta = true;
      else if (fid && condPix && fid != LOTE.formaPixVenda) formaErr.push('Parcela ' + (i + 1));
    });
    if (probs.length) erro('Parcelas', probs.join(' • '));
    if (bolErr.length) erro('Forma de pagamento (boleto)', 'Boleto: a forma deve ser "BOLETO BLING-CONTA" (' + bolErr.join(', ') + ')');
    if (formaErr.length) erro('Forma de pagamento', 'Condição 0/PIX: a forma deve ser "PIX - Venda" (' + formaErr.join(', ') + ')');
    else if (blingConta) aviso('Forma de pagamento', '"Pix - Bling Conta" só se a diretoria estiver ausente');
  }

  if (!(parseInt(d.validade, 10) > 0)) erro('Validade', 'Informe a validade (padrão: ' + REGRAS.validadeDias + ' dias)');
  if (vazio(d.prazoEntrega)) erro('Prazo de entrega', 'Informe o prazo de entrega');

  var tx = d.transporte || {};
  var transp = (tx.contato && tx.contato.nome) || '';
  var mod = tx.frete_modalidade;
  var rf = regraFrete(transp, mod, numBR(tx.frete));
  if (!rf.ok) erro('Frete', rf.msg);
  if (!(numBR(tx.qtdVolumes) > 0)) erro('Quantidade de volumes', 'Informe a quantidade de volumes');
  if (vazio(d.observacaoInterna)) erro('Dados adicionais (interno)', 'Preencha "Observações Internas"');

  var e = tx.etiqueta;
  if (e) { // "Endereço de entrega diferente da cobrança" marcado
    var reE = regraEntrega(mod, numBR(tx.frete), transp);
    if (!reE.ok) erro('Entrega em outro endereço', reE.msg);
    var nomes = { nome: 'nome', cep: 'CEP', endereco: 'endereço', numero: 'número', bairro: 'bairro', municipio: 'município', uf: 'UF' };
    var fe = Object.keys(nomes).filter(function(k) { return vazio(e[k]); }).map(function(k) { return nomes[k]; });
    if (fe.length) erro('Endereço de entrega', 'Falta: ' + fe.join(', '));
    var ceo = checaEndObs(d.observacoes, e.cep, e.endereco);
    if (!ceo.ok) erro('Endereço nas Observações', ceo.msg);
  }
  return r;
}

async function auditarProposta(id) {
  var d = (await blingGet('/Api/v3/propostas-comerciais/' + id)).data;
  await carregarFormas();
  var regras = regrasApi(d);
  return {
    id: id, numero: d.numero, data: d.data, situacao: d.situacao, total: d.total,
    cliente: (d.contato && d.contato.nome) || '', vendedor: d.nomeVendedor || '',
    cidade: (d.contato && d.contato.cidade) || '', uf: (d.contato && d.contato.uf) || '',
    fone: d.contato ? [d.contato.celular, d.contato.fone].filter(function(x) { return x && String(x).replace(/\D/g, '').length >= 8; }).join(' / ') : '',
    itens: (d.itens || []).map(function(it) { return { codigo: it.codigo || '', descricao: it.descricao || (it.produto && it.produto.descricao) || '', qtd: it.quantidade, v: numX(it.valor) }; }),
    erros: regras.filter(function(x) { return x.status === 'erro'; }),
    avisos: regras.filter(function(x) { return x.status === 'aviso'; })
  };
}

// ====================== MENSAGENS DO POPUP ======================
// ====================== RELATÓRIO (registro de cada Check) ======================
// Cada Check feito pelo popup é salvo no Firebase do app (aba Cotações > Relatório).
var FB_DB = 'https://maisacessivel-1d0ad-default-rtdb.firebaseio.com';
var _usuarioBling = null;
async function usuarioBling() {
  if (_usuarioBling) return _usuarioBling;
  try {
    var j = await (await fetch('/Api/v3/usuario', { credentials: 'include' })).json();
    _usuarioBling = { nome: (j.data && j.data.nome) || '', login: (j.data && j.data.login) || '' };
  } catch (e) { _usuarioBling = { nome: '', login: '' }; }
  return _usuarioBling;
}
async function registrarCheck(res) {
  try {
    var u = await usuarioBling();
    var d = new Date();
    var reg = {
      ts: d.getTime(), data: d.toISOString(), ano: d.getFullYear(), mes: d.getMonth() + 1,
      numero: res.numeroProposta || fld('numeroProposta'), cliente: fld('contato'),
      vendedor: fld('nomeVendedor'), usuario: (u.nome || u.login || 'desconhecido').trim(), login: u.login,
      total: fld('totalOrcamento'), nErros: res.erros, nAvisos: res.avisos,
      erros: res.itens.filter(function(i) { return i.status === 'erro'; })
        .map(function(i) { return { grupo: i.grupo, campo: i.campo, msg: i.msg }; }),
      versao: chrome.runtime.getManifest().version
    };
    await fetch(FB_DB + '/checkLogs.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reg) });
  } catch (e) {}
}

// ====================== PRODUTOS RELACIONADOS ======================
// Lê as vendas dos últimos 12 meses e descobre quais produtos costumam ser vendidos juntos.
async function calcRelacionados() {
  function br(d) { return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear(); }
  var fim = new Date(), ini = new Date(); ini.setFullYear(ini.getFullYear() - 1);
  var base = '/Api/v3/vendasinternal/list?pesquisa=&idContatoConsulta=0&unidadesNegocioSelect=0&toggleDefinirSituacaoPadrao=false&fatura=T&idPsqVendedor=0&psqVendedor=&idProduto=0&nomePsqProduto=' +
    '&lojasVinculadas=todas&criterio=periodo&criterioPeriod=' + encodeURIComponent('Período customizado') + '&idVendedor=0&idTransportador=0&idLoja=todas&idConfUnidadeNegocio=0&situacaoEnvioFatura=T&idContato=0&view=default' +
    '&dataIni=' + encodeURIComponent(br(ini)) + '&dataFim=' + encodeURIComponent(br(fim));
  var ids = [];
  for (var p = 1; p <= 60; p++) {
    var j = await blingGet(base + '&pagina=' + p);
    var l = (j && j.data) || [];
    l.forEach(function(v) { if (String(v.idSituacao) !== '12') ids.push(v.id); }); // 12 = cancelado
    if (l.length < 100) break;
  }
  var cesta = [], fila = ids.slice();
  async function w() {
    while (fila.length) {
      var id = fila.shift();
      try {
        var d = (await blingGet('/Api/v3/vendas/' + id)).data;
        cesta.push((d.itens || []).map(function(i) { return [(i.produto && i.produto.codigo) || i.codigo || '', (i.produto && i.produto.descricao) || i.descricao || '']; }));
      } catch (e) { if (e.message === 'SESSAO') throw e; }
    }
  }
  await Promise.all([w(), w(), w(), w(), w(), w()]);
  var cnt = {}, desc = {}, par = {};
  cesta.forEach(function(it) {
    var cods = [];
    it.forEach(function(x) { if (x[0]) { desc[x[0]] = x[1]; if (cods.indexOf(x[0]) === -1) cods.push(x[0]); } });
    cods.forEach(function(a) {
      cnt[a] = (cnt[a] || 0) + 1;
      cods.forEach(function(c) { if (c !== a) { var k = a + '\u0001' + c; par[k] = (par[k] || 0) + 1; } });
    });
  });
  var rel = {};
  Object.keys(par).forEach(function(k) {
    var ab = k.split('\u0001'), a = ab[0], c = ab[1], n = par[k];
    if (cnt[a] >= 5 && n >= 3 && n / cnt[a] >= 0.25) (rel[a] = rel[a] || []).push({ c: c, d: desc[c], n: n, p: Math.round(n / cnt[a] * 100) });
  });
  var regras = {};
  Object.keys(rel).forEach(function(a) {
    regras[String(a).replace(/[.#$\/\[\]]/g, '_')] = { c: a, d: desc[a], n: cnt[a], rel: rel[a].sort(function(x, y) { return y.p - x.p; }).slice(0, 6) };
  });
  var doc = { meta: { ts: Date.now(), vendas: cesta.length, periodo: '12 meses', minVendas: 5, minPct: 25 }, regras: regras };
  var r = await fetch(FB_DB + '/produtosRelacionados.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
  if (!r.ok) throw new Error('Não consegui salvar no app (Firebase ' + r.status + ')');
  return { vendas: cesta.length, produtos: Object.keys(cnt).length, comSugestao: Object.keys(regras).length };
}

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'getDados') {
    var dados = coletarDados();
    // Página ainda carregando: tenta de novo em 1,5s
    if (!dados.emProposta && telaDeProposta()) {
      setTimeout(function() { sendResponse(coletarDados()); }, 1500);
      return true;
    }
    sendResponse(dados);
    return true;
  }
  if (request.action === 'checkProposta') {
    checarProposta()
      .then(function(res) { registrarCheck(res); sendResponse(res); })
      .catch(function(e) { sendResponse({ falha: String(e) }); });
    return true; // resposta assíncrona
  }
  if (request.action === 'ping') { sendResponse({ ok: true }); return true; }
  if (request.action === 'listarPropostas') {
    listarPropostas(request.filtro || {}).then(sendResponse)
      .catch(function(e) { sendResponse({ erro: e.message === 'SESSAO' ? 'SESSAO' : String(e.message || e) }); });
    return true;
  }
  if (request.action === 'calcRelacionados') {
    calcRelacionados().then(sendResponse)
      .catch(function(e) { sendResponse({ erro: e.message === 'SESSAO' ? 'SESSAO' : String(e.message || e) }); });
    return true;
  }
  if (request.action === 'cacheGet') {
    Promise.all((request.meses || []).map(function(m) {
      return fetch(FB_DB + '/cotacoesCache/' + m + '.json').then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; });
    })).then(function(arr) { var o = {}; arr.forEach(function(x) { if (x) Object.keys(x).forEach(function(k) { o[k] = x[k]; }); }); sendResponse(o); });
    return true;
  }
  if (request.action === 'cacheSet') {
    fetch(FB_DB + '/cotacoesCache.json', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.dados || {}) })
      .then(function(r) { sendResponse({ ok: r.ok }); }).catch(function() { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'mudarSituacao') {
    // muda a situação da proposta no Bling (Rascunho, Pendente, Aguardando, Aprovado, Não aprovado, Concluído)
    fetch('/Api/v3/propostas-comerciais/' + request.id + '/situacoes', { method: 'PATCH', credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ situacao: request.situacao }) })
      .then(function(x) { if (x.status === 401 || x.status === 403) return sendResponse({ erro: 'SESSAO' }); sendResponse(x.ok ? { ok: true } : { erro: 'O Bling recusou (HTTP ' + x.status + ')' }); })
      .catch(function(e) { sendResponse({ erro: String(e.message || e) }); });
    return true;
  }
  if (request.action === 'listarVendas') {
    listarVendas(request.desde, request.ate).then(sendResponse)
      .catch(function(e) { sendResponse({ erro: e.message === 'SESSAO' ? 'SESSAO' : String(e.message || e) }); });
    return true;
  }
  if (request.action === 'itensVenda') {
    blingGet('/Api/v3/vendas/' + request.id).then(function(j) {
      var d = j.data || {};
      sendResponse({ itens: (d.itens || []).map(function(i) { return { c: (i.produto && i.produto.codigo) || i.codigo || '', d: (i.produto && i.produto.descricao) || i.descricao || '', q: numX(i.quantidade), v: numX(i.valor) }; }) });
    }).catch(function(e) { sendResponse({ erro: String(e.message || e) }); });
    return true;
  }
  if (request.action === 'finBling') {
    finBling(request.op, request.dados || {}).then(sendResponse)
      .catch(function(e) { sendResponse({ ok: false, erro: e.message === 'SESSAO' ? 'SESSAO' : String(e.message || e) }); });
    return true;
  }
  if (request.action === 'auditarProposta') {
    auditarProposta(request.id).then(sendResponse)
      .catch(function(e) { sendResponse({ id: request.id, falha: e.message === 'SESSAO' ? 'Sessão do Bling expirada' : String(e.message || e) }); });
    return true;
  }
  return false;
});

// Limpeza: remove balões das versões antigas, caso ainda estejam na tela
['mais-acessivel-btn', 'mais-acessivel-btn-avulsa'].forEach(function(id) {
  var el = document.getElementById(id);
  if (el) el.remove();
});

}

// Endereço de entrega nas Observações: confere pelo CEP; se as Observações tiverem um CEP diferente do endereço de entrega, avisa os dois
function checaEndObs(obsRaw, cepEnd, ruaEnd) {
  var obs = String(obsRaw || ''), cep = String(cepEnd || '').replace(/\D/g, '');
  var ceps = (obs.match(/\b\d{2}\.?\d{3}-?\d{3}\b/g) || []).map(function(c) { return c.replace(/\D/g, ''); }).filter(function(c) { return c.length === 8; });
  var fmt = function(c) { return c.slice(0, 5) + '-' + c.slice(5); };
  if (cep.length === 8 && ceps.indexOf(cep) !== -1) return { ok: true, msg: 'Informado (CEP ' + fmt(cep) + ')' };
  if (cep.length === 8 && ceps.length) return { ok: false, msg: 'O CEP escrito nas Observações (' + ceps.map(fmt).join(', ') + ') é diferente do CEP do "Endereço de entrega" (' + fmt(cep) + '). Corrija o que estiver errado.' };
  var rua = norm(ruaEnd);
  if (rua.length >= 6 && norm(obs).indexOf(rua) !== -1) return { ok: true, msg: 'Informado' };
  return { ok: false, msg: 'Informe o endereço de entrega (com CEP' + (cep.length === 8 ? ' ' + fmt(cep) : '') + ') nas Observações das Condições gerais' };
}

// Pedidos de venda do período, com a cotação que gerou cada um (idOrigem = id da proposta comercial)
async function listarVendas(desde, ate) {
  function br(iso) { var p = String(iso).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  var base = '/Api/v3/vendasinternal/list?pesquisa=&idContatoConsulta=0&unidadesNegocioSelect=0&toggleDefinirSituacaoPadrao=false&fatura=T&idPsqVendedor=0&psqVendedor=&idProduto=0&nomePsqProduto=' +
    '&lojasVinculadas=todas&criterio=periodo&criterioPeriod=' + encodeURIComponent('Período customizado') + '&idVendedor=0&idTransportador=0&idLoja=todas&idConfUnidadeNegocio=0&situacaoEnvioFatura=T&idContato=0&view=default' +
    '&dataIni=' + encodeURIComponent(br(desde)) + '&dataFim=' + encodeURIComponent(br(ate));
  var out = [], vistos = {};
  for (var p = 1; p <= 60; p++) {
    var j = await blingGet(base + '&pagina=' + p);
    var l = (j && j.data) || [], novos = 0;
    l.forEach(function(v) {
      if (vistos[v.id]) return; vistos[v.id] = 1; novos++;
      if (String(v.idSituacao) === '12') return; // cancelado
      out.push({ id: v.id, numero: v.numeroPedido, data: v.data, idOrigem: v.idOrigem && v.idOrigem !== '0' ? String(v.idOrigem) : '', total: numX(v.totalVenda), cliente: v.nome || '' });
    });
    if (l.length < 100 || !novos) break;
  }
  return { itens: out };
}

// ====================== FINANCEIRO (aba Financeiro do app) ======================
// Usa a mesma API interna que a tela de Contas a Pagar do Bling usa (cabeçalho x-api-revision 3.1.0).
var FIN_H = { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-revision': '3.1.0' };
function finBr(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
function finValorBr(n) { return Number(n || 0).toFixed(2).replace('.', ','); }
async function finJson(path, opt) {
  var x = await fetch(path, Object.assign({ credentials: 'include', headers: FIN_H }, opt || {}));
  if (x.status === 401 || x.status === 403) throw new Error('SESSAO');
  var t = await x.text(), j = null;
  try { j = JSON.parse(t); } catch (e) {}
  return { status: x.status, ok: x.ok, json: j, texto: t };
}
async function finBuscarContato(d) {
  var doc = String(d.doc || '').replace(/\D/g, ''), nome = String(d.nome || '').trim();
  function mapa(j) { return ((j && j.data) || []).map(function(c) { return { id: c.id, nome: c.nome, doc: String(c.cpf_cnpj || c.numeroDocumento || '').replace(/\D/g, '') }; }); }
  if (doc) {
    var r = await finJson('/Api/v3/contatos?limite=5&pesquisa=' + encodeURIComponent(doc));
    var L = mapa(r.json);
    if (L.length) return { ok: true, itens: L, porDoc: L.length === 1 };
  }
  if (nome) {
    var r2 = await finJson('/Api/v3/contatos?limite=8&pesquisa=' + encodeURIComponent(nome.slice(0, 40)));
    return { ok: true, itens: mapa(r2.json), porDoc: false };
  }
  return { ok: true, itens: [], porDoc: false };
}
async function finLancar(d) {
  if (!d.idContato || !(d.valor > 0) || !d.vencimento) return { ok: false, erro: 'Faltam fornecedor, valor ou vencimento' };
  var parc = parseInt(d.parcelas, 10) || 1;
  var body = {
    idContato: String(d.idContato), contato: d.contato || '', valor: finValorBr(d.valor),
    vencimento: finBr(d.vencimento), vencimentoOriginal: finBr(d.vencimento), data: finBr(d.emissao || d.vencimento), competencia: finBr(d.competencia || d.emissao || d.vencimento),
    observacoes: String(d.historico || '').slice(0, 2000), nroDocumento: String(d.numeroDocumento || '').slice(0, 50),
    idCategoria: d.categoria ? String(d.categoria) : '', idPortador: d.portador ? String(d.portador) : '0', idFormaPagamento: d.forma ? String(d.forma) : '0',
    receberpagar: 'P', situacao: 'aberto', tipoCRec: parc > 1 ? 'P' : 'U', parcelasCRec: parc > 1 ? parc : null,
    diaVencimentoCRec: parc > 1 ? Number(String(d.vencimento).slice(8, 10)) : null,
    juros: '0,00', multa: '0,00', considerar_dias_uteis: false, attachments: [], saveAttachments: [], deleteAttachments: [], importador: 'N'
  };
  var r = await finJson('/Api/v3/contas/pagar', { method: 'POST', body: JSON.stringify(body) });
  var id = r.json && r.json.data && r.json.data.id;
  if (r.ok && id) return { ok: true, id: id };
  var msg = (r.json && r.json.error && (r.json.error.description || r.json.error.message)) || ('O Bling respondeu ' + r.status + ' sem confirmar o lançamento. Confira no Contas a Pagar antes de tentar de novo.');
  return { ok: false, erro: msg };
}
// Baixa (marca como paga) uma conta a pagar já lançada. Confere depois se o Bling mudou a situação para paga.
async function finBaixar(d) {
  var id = String(d.id || '').replace(/\D/g, ''); if (!id) return { ok: false, erro: 'Conta sem ID do Bling' };
  var antes = await finJson('/Api/v3/contas/pagar/' + id);
  var c = antes.json && antes.json.data;
  if (!c) return { ok: false, erro: 'Não achei a conta ' + id + ' no Bling.' };
  if (Number(c.situacao) === 2) return { ok: true, jaPaga: true };
  var valor = Number(d.valor || c.saldo || c.valor || 0);
  var body = { data: d.data || c.vencimento, usarDataVencimento: false, portador: { id: Number(d.portador || (c.portador && c.portador.id) || 0) },
    categoria: { id: Number(d.categoria || (c.categoria && c.categoria.id) || 0) }, historico: String(d.historico || c.historico || '').slice(0, 200),
    taxa: 0, juro: 0, desconto: 0, acrescimo: 0, valorPago: Math.round(valor * 100) / 100 };
  if (!body.portador.id) return { ok: false, erro: 'Informe a conta financeira para dar baixa.' };
  if (!body.categoria.id) delete body.categoria;
  var r = await finJson('/Api/v3/contas/pagar/' + id + '/baixar', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) return { ok: false, erro: (r.json && r.json.error && ((r.json.error.fields && r.json.error.fields.map(function(f) { return f.msg || f.message; }).join('; ')) || r.json.error.description || r.json.error.message)) || ('O Bling respondeu ' + r.status) };
  var dep = await finJson('/Api/v3/contas/pagar/' + id);
  var s = dep.json && dep.json.data && Number(dep.json.data.situacao);
  if (s === 2) return { ok: true };
  return { ok: false, erro: 'O Bling aceitou o pedido mas a conta não ficou paga (situação ' + s + '). Confira no Contas a Pagar.' };
}
async function finListas() {
  var x = await fetch('/contas.pagar.php', { credentials: 'include' });
  if (/login/i.test(x.url)) throw new Error('SESSAO');
  var doc = new DOMParser().parseFromString(await x.text(), 'text/html');
  function op(id) { var s = doc.getElementById(id); if (!s) return []; return Array.prototype.map.call(s.options, function(o) { return { id: o.value, nome: o.textContent.trim() }; }).filter(function(o) { return o.id && o.id !== '0' && o.id !== '-1'; }); }
  return { ok: true, formas: op('idFormaPagamento'), contas: op('idPortador') };
}

// Cadastro de fornecedor: mesmo formato e cabeçalhos da tela de contatos do Bling (sem x-api-revision).
var FIN_CONTATO_TPL = {"id":"0","gerenciarComissoesContasPagar":"N","usuarioSuporte":"0","facturaUsoCfdi":"","idSefaz":"","tiposDeContatos":"","nome":"","fantasia":"","tipo":"J","cnpj":"","crt":"0","clienteDesde":"","indIEDest":"9","ie":"","rg":"","orgaoEmissor":"","idPais":"","nomePais":"","im":"","cep":"","uf":" ","ufExteriorGeral":"","idMunicipio":"","cidade":"","bairro":"","endereco":"","enderecoNro":"","complemento":"","cepCobranca":"","ufExteriorCobranca":"","idMunicipioCobranca":"","cidadeCobranca":"","bairroCobranca":"","enderecoCobranca":"","enderecoNroCobranca":"","complementoCobranca":"","contatos":"","contatoPessoa":"","fone":"","fax":"","celular":"","operadora":"","email":"","email_nfe":"","site":"","skype":"","proxVisita":"","aliqCargaMedia":"","estadoCivil":" ","profissao":"","sexo":"","dataNascimento":"","naturalidade":"","nomePai":"","cpfPai":"","nomeMae":"","cpfMae":"","situacao":"A","idVendedor":"","idUsuarioVendedor":"","nomeVendedor":"","idOperacaoFiscal":"","operacaoFiscal":"","indFinalNfse":"0","inscricaoSuframa":"","idSegmentoCliente":"","limiteCreditoIlimitado":true,"limiteCredito":"0,00","condicao":"","idCategoria":"0","obs":"","customFields":"","ieIsento":"N","orgaoPublico":"N","linhasProduto":[],"imagens":[],"attachments":[],"camposCustomizados":[],"cpf_cnpj":"","numero":"","idContatoPessoa":[null]};
function finCnpjFmt(d) { d = String(d || '').replace(/\D/g, ''); if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'); if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4'); return ''; }
function finCepFmt(d) { d = String(d || '').replace(/\D/g, ''); return d.length === 8 ? d.slice(0, 5) + '-' + d.slice(5) : ''; }
async function finCriarContato(d) {
  var nome = String(d.nome || '').trim().slice(0, 120);
  if (!nome) return { ok: false, erro: 'Fornecedor sem nome' };
  var doc = String(d.doc || '').replace(/\D/g, '');
  var hoje = new Date(); var p2 = function(n) { return String(n).padStart(2, '0'); };
  var b = JSON.parse(JSON.stringify(FIN_CONTATO_TPL));
  b.nome = nome; b.tipo = doc.length === 11 ? 'F' : 'J'; b.clienteDesde = p2(hoje.getDate()) + '/' + p2(hoje.getMonth() + 1) + '/' + hoje.getFullYear();
  if (doc.length === 14 || doc.length === 11) b.cnpj = finCnpjFmt(doc);
  if (d.fantasia) b.fantasia = String(d.fantasia).slice(0, 60);
  if (d.cep) b.cep = finCepFmt(d.cep);
  if (d.uf) b.uf = String(d.uf).toUpperCase().slice(0, 2);
  ['cidade', 'bairro', 'endereco', 'complemento', 'email'].forEach(function(k) { if (d[k]) b[k] = String(d[k]).slice(0, 120); });
  if (d.numero) b.enderecoNro = String(d.numero).slice(0, 20);
  if (b.cidade) { delete b.idMunicipio; delete b.idMunicipioCobranca; } // com idMunicipio vazio o Bling não acha a cidade
  if (d.fone) b.fone = String(d.fone).replace(/\D/g, '').slice(0, 15);
  var send = async function(body) {
    var x = await fetch('/Api/v3/contatos', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (x.status === 401 || x.status === 403) throw new Error('SESSAO');
    var t = await x.text(), j = null; try { j = JSON.parse(t); } catch (e) {}
    return { ok: x.ok, status: x.status, j: j };
  };
  var r = await send(b);
  // se o endereço/CNPJ der problema de validação, tenta só com nome e documento, depois só com nome
  if (!r.ok && r.status === 400) { var b2 = JSON.parse(JSON.stringify(FIN_CONTATO_TPL)); b2.nome = b.nome; b2.tipo = b.tipo; b2.clienteDesde = b.clienteDesde; b2.cnpj = b.cnpj; r = await send(b2);
    if (!r.ok && r.status === 400) { b2.cnpj = ''; r = await send(b2); } }
  var id = r.j && r.j.data && (r.j.data.idContato || r.j.data.id);
  if (r.ok && id) return { ok: true, id: id };
  var f = r.j && r.j.error && r.j.error.fields; var msg = f && f.length ? f.map(function(x) { return x.msg; }).join('; ') : ((r.j && r.j.error && (r.j.error.description || r.j.error.message)) || ('Bling respondeu ' + r.status));
  return { ok: false, erro: 'Não consegui cadastrar o fornecedor: ' + msg };
}

// Atualiza uma conta a pagar já lançada (completar pendências). Mesmo caminho da tela do Bling: lê a duplicata e grava com PUT.
async function finAtualizar(d) {
  var id = String(d.blingId || '').replace(/\D/g, '');
  if (!id) return { ok: false, erro: 'Lançamento sem ID do Bling' };
  var g = await finJson('/Api/v3/contas/pagar/duplicata/' + id);
  var b = g.json && g.json.data;
  if (!g.ok || !b) return { ok: false, erro: 'Não achei a conta ' + id + ' no Bling (' + g.status + ')' };
  if (d.idContato) { b.idContato = String(d.idContato); if (d.contato) b.contato = d.contato; }
  if (d.valor > 0 && String(b.situacao) === 'aberto') { b.valor = finValorBr(d.valor); b.saldo = Number(d.valor).toFixed(2); }
  if (d.vencimento && String(b.situacao) === 'aberto') { b.vencimento = finBr(d.vencimento); }
  if (d.emissao) b.data = finBr(d.emissao);
  if (d.competencia) b.competencia = finBr(d.competencia);
  if (d.historico != null && d.historico !== '') b.observacoes = String(d.historico).slice(0, 2000);
  if (d.numeroDocumento) b.nroDocumento = String(d.numeroDocumento).slice(0, 50);
  if (d.categoria) b.idCategoria = String(d.categoria);
  if (d.portador) b.idPortador = String(d.portador);
  if (d.forma) b.idFormaPagamento = String(d.forma);
  var r = await finJson('/Api/v3/contas/pagar/' + id, { method: 'PUT', body: JSON.stringify(b) });
  if (r.ok) return { ok: true, id: id };
  var msg = (r.json && r.json.error && (r.json.error.fields && r.json.error.fields.length ? r.json.error.fields.map(function(x) { return x.msg; }).join('; ') : (r.json.error.description || r.json.error.message))) || ('Bling respondeu ' + r.status);
  return { ok: false, erro: msg };
}

// Duplicidade: contas a pagar EM ABERTO no Bling com o mesmo valor e a mesma data (emissão ou vencimento).
async function finVerificarDuplicado(d) {
  // Procura no Contas a Pagar conta com o mesmo valor (em aberto, paga ou parcial; ignora canceladas) com data próxima (±2 dias)
  var v = Number(d.valor || 0); if (!(v > 0)) return { ok: true, itens: [] };
  var achados = {};
  function faixa(iso, dias) { var t = new Date(iso + 'T12:00:00'); var a = new Date(t); a.setDate(a.getDate() - dias); var b = new Date(t); b.setDate(b.getDate() + dias);
    var f = function(x) { return x.toISOString().slice(0, 10); }; return [f(a), f(b)]; }
  async function busca(q) {
    for (var pg = 1; pg <= 3; pg++) {
      var r = await finJson('/Api/v3/contas/pagar?limite=100&pagina=' + pg + '&situacoes%5B%5D=1&situacoes%5B%5D=2&situacoes%5B%5D=3&' + q);
      var L = (r.json && r.json.data) || [];
      L.forEach(function(x) { var s = Number(x.situacao); if ([1, 2, 3].indexOf(s) >= 0 && Math.abs(Number(x.valor) - v) < 0.005) achados[x.id] = { id: x.id, valor: Number(x.valor), vencimento: x.vencimento, situacao: s, contatoId: x.contato && x.contato.id }; });
      if (L.length < 100) break;
    }
  }
  var datas = {};
  [d.emissao, d.vencimento].forEach(function(x) { if (/^\d{4}-\d{2}-\d{2}$/.test(x || '')) datas[x] = 1; });
  for (var k in datas) {
    var fx = faixa(k, 2);
    await busca('dataEmissaoInicial=' + fx[0] + '&dataEmissaoFinal=' + fx[1]);
    await busca('dataVencimentoInicial=' + fx[0] + '&dataVencimentoFinal=' + fx[1]);
  }
  var itens = Object.keys(achados).map(function(k) { return achados[k]; });
  for (var i = 0; i < itens.length && i < 6; i++) {
    try { var c = await finJson('/Api/v3/contatos/' + itens[i].contatoId); itens[i].contatoNome = (c.json && c.json.data && c.json.data.nome) || ''; } catch (e) {}
    try { var dd = await finJson('/Api/v3/contas/pagar/' + itens[i].id); var o = dd.json && dd.json.data; if (o) { itens[i].historico = o.historico || ''; itens[i].dataEmissao = o.dataEmissao || ''; } } catch (e) {}
  }
  return { ok: true, itens: itens };
}
async function finBling(op, d) {
  if (op === 'verificarDuplicado') return finVerificarDuplicado(d);
  if (op === 'atualizar') return finAtualizar(d);
  if (op === 'criarContato') return finCriarContato(d);
  if (op === 'buscarContato') return finBuscarContato(d);
  if (op === 'lancar') return finLancar(d);
  if (op === 'baixar') return finBaixar(d);
  if (op === 'listas') return finListas();
  return { ok: false, erro: 'Operação desconhecida' };
}
