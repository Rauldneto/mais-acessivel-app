// cenprot-reader.js (v2.4.2)
// Content script injetado em TODAS as páginas do CENPROT (Nacional e SP/pesquisaprotesto).
// Fluxo: app Mais Acessível abre nova aba com ?cnpj=XXX&from=maisacessivel
//        content script detecta → tenta preencher automaticamente → lê resultado → devolve pro app.

(function(){
  'use strict';
  try{
    var url = new URL(location.href);
    var cnpj = url.searchParams.get('cnpj') || url.searchParams.get('CNPJ') || url.searchParams.get('documento');
    var fromApp = (url.searchParams.get('from') || '') === 'maisacessivel';
    // Marcador sessao: permite continuar o fluxo mesmo depois de redirect/login
    var SESSION_KEY = 'ma_cenprot_cnpj';
    if (cnpj && fromApp) {
      try{ sessionStorage.setItem(SESSION_KEY, cnpj); }catch(_){}
    } else {
      try{ cnpj = cnpj || sessionStorage.getItem(SESSION_KEY); }catch(_){}
    }
    if (!cnpj) return;
    cnpj = cnpj.replace(/\D/g, '');
    if (cnpj.length !== 14) return;

    console.log('[CENPROT reader v2.4.2] ativo pra CNPJ', cnpj);

    var STATUS = { preencheu: false, consultou: false, leu: false };
    var MAX_TENTATIVAS = 60;  // 60 x 300ms = 18s para preencher, 60 x 300ms para ler
    var POLL_MS = 300;        // Antes era 500ms — acelera a detecção

    function fmt(cnpj) {
      return cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }

    function acharInput() {
      var seletores = [
        'input[name*="documento" i]',
        'input[name*="cnpj" i]',
        'input[id*="cnpj" i]',
        'input[id*="documento" i]',
        'input[placeholder*="CNPJ" i]',
        'input[placeholder*="CPF" i]',
        'input[placeholder*="Documento" i]',
        'input[type="text"]',
        'input[type="tel"]',
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"])'
      ];
      for (var i = 0; i < seletores.length; i++) {
        var els = document.querySelectorAll(seletores[i]);
        for (var j = 0; j < els.length; j++) {
          if (els[j].offsetParent !== null) return els[j];
        }
      }
      return null;
    }

    function acharBotao() {
      var botoes = document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], a.btn');
      for (var i = 0; i < botoes.length; i++) {
        var t = (botoes[i].textContent || botoes[i].value || '').toLowerCase().trim();
        if (/^(consultar|pesquisar|buscar|localizar|verificar)$/.test(t) ||
            /\b(consultar|pesquisar|buscar)\b/.test(t)) {
          if (botoes[i].offsetParent !== null) return botoes[i];
        }
      }
      return null;
    }

    function preencherEConsultar(tent) {
      tent = tent || 0;
      if (tent > MAX_TENTATIVAS) {
        reportar({ erro: 'não encontrei o campo CNPJ na página do CENPROT após 20s' });
        return;
      }
      var input = acharInput();
      if (!input) { setTimeout(function(){ preencherEConsultar(tent+1); }, 500); return; }

      if (!STATUS.preencheu) {
        try{
          // Define com o setter nativo pra React/Vue detectarem
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, fmt(cnpj));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        }catch(e){
          input.value = fmt(cnpj);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        STATUS.preencheu = true;
      }

      setTimeout(function(){
        if (!STATUS.consultou) {
          var btn = acharBotao();
          if (btn) {
            btn.click();
            STATUS.consultou = true;
            setTimeout(function(){ lerResultado(0); }, 800); // antes 1500
          } else {
            setTimeout(function(){ preencherEConsultar(tent+1); }, POLL_MS);
          }
        }
      }, 300);
    }

    function lerResultado(tent) {
      tent = tent || 0;
      if (tent > MAX_TENTATIVAS) {
        reportar({ erro: 'não consegui ler o resultado após 20s — veja manualmente' });
        return;
      }
      var corpo = (document.body.innerText || '').trim();
      var temProtesto = /(consta|existem?|possui|há)\s+(protest|apontament|t[ií]tul)/i.test(corpo);
      var naoConsta = /(n[aã]o\s+consta|sem\s+protest|nenhum\s+protest|sem\s+apontament|n[aã]o\s+h[aá]|n[aã]o\s+foram\s+encontrados?|n[aã]o\s+possui)/i.test(corpo);
      if (!temProtesto && !naoConsta) {
        setTimeout(function(){ lerResultado(tent+1); }, POLL_MS);
        return;
      }
      var qtdMatch = corpo.match(/(\d+)\s+(apontament|protest|t[ií]tul)/i);
      var valorMatch = corpo.match(/R\$\s*([\d.,]+)/);
      var cartorios = [];
      var porEstado = {}; // UF -> {qtd, valor_num}
      var linhas = corpo.split('\n');
      var UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
      linhas.forEach(function(l) {
        var lt = l.trim();
        if (/(tabelionato|cart[oó]rio|\dº\s*(of[ií]cio|tab))/i.test(lt) && lt.length < 200) {
          cartorios.push(lt);
          // Tenta extrair UF (procura "- UF" no fim ou "/UF" ou " UF")
          var ufMatch = lt.match(/[\s\-\/\(]\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b[\s\-\/\),]/i) ||
                        lt.match(/\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\s*$/i);
          if (ufMatch) {
            var uf = ufMatch[1].toUpperCase();
            if (!porEstado[uf]) porEstado[uf] = { qtd: 0, valor_num: 0 };
            porEstado[uf].qtd++;
            // Tenta achar valor na mesma linha
            var vm = lt.match(/R\$\s*([\d.,]+)/);
            if (vm) {
              var v = parseFloat(vm[1].replace(/\./g,'').replace(',','.')) || 0;
              porEstado[uf].valor_num += v;
            }
          }
        }
      });
      // Formata porEstado em valor legível
      var porEstadoFmt = {};
      Object.keys(porEstado).forEach(function(uf){
        var v = porEstado[uf].valor_num;
        porEstadoFmt[uf] = {
          qtd: porEstado[uf].qtd,
          valor: v > 0 ? v.toLocaleString('pt-BR', {minimumFractionDigits:2}) : '?'
        };
      });
      reportar({
        temProtesto: temProtesto && !naoConsta,
        quantidade: qtdMatch ? parseInt(qtdMatch[1], 10) : (temProtesto ? Math.max(1, cartorios.length) : 0),
        valorTotal: valorMatch ? valorMatch[1] : '',
        cartorios: cartorios.slice(0, 10),
        porEstado: porEstadoFmt,
        urlResultado: location.href
      });
      try{ sessionStorage.removeItem(SESSION_KEY); }catch(_){}
    }

    function reportar(resultado) {
      var payload = { tipo: 'cenprot_resultado', cnpj: cnpj, resultado: resultado };
      try{ chrome.runtime.sendMessage(payload); }catch(_){}
      // Também avisa a janela que abriu (pode ter sido o app com window.open)
      try{
        if (window.opener) window.opener.postMessage(payload, 'https://rauldneto.github.io');
      }catch(_){}
      // Fecha a aba automaticamente após 2s
      if (!resultado.erro) {
        setTimeout(function(){
          try{ window.close(); }catch(_){}
        }, 2500);
      }
    }

    // Começa depois que a página respirar
    setTimeout(function(){ preencherEConsultar(0); }, 800);
  }catch(e){
    console.error('[CENPROT reader] falhou', e);
  }
})();
