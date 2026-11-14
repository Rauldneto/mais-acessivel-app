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
    var MAX_TENTATIVAS = 40;

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
            setTimeout(function(){ lerResultado(0); }, 1500);
          } else {
            setTimeout(function(){ preencherEConsultar(tent+1); }, 500);
          }
        }
      }, 400);
    }

    function lerResultado(tent) {
      tent = tent || 0;
      if (tent > MAX_TENTATIVAS) {
        reportar({ erro: 'não consegui ler o resultado após 20s — veja o resultado manualmente' });
        return;
      }
      var corpo = (document.body.innerText || '').trim();
      var temProtesto = /(consta|existem?|possui|há)\s+(protest|apontament|t[ií]tul)/i.test(corpo);
      var naoConsta = /(n[aã]o\s+consta|sem\s+protest|nenhum\s+protest|sem\s+apontament|n[aã]o\s+h[aá]|n[aã]o\s+foram\s+encontrados?|n[aã]o\s+possui)/i.test(corpo);
      if (!temProtesto && !naoConsta) {
        setTimeout(function(){ lerResultado(tent+1); }, 500);
        return;
      }
      var qtdMatch = corpo.match(/(\d+)\s+(apontament|protest|t[ií]tul)/i);
      var valorMatch = corpo.match(/R\$\s*([\d.,]+)/);
      var cartorios = [];
      var linhas = corpo.split('\n');
      linhas.forEach(function(l) {
        if (/(tabelionato|cart[oó]rio|\dº\s*(of[ií]cio|tab))/i.test(l) && l.length < 180) {
          cartorios.push(l.trim());
        }
      });
      reportar({
        temProtesto: temProtesto && !naoConsta,
        quantidade: qtdMatch ? parseInt(qtdMatch[1], 10) : (temProtesto ? 1 : 0),
        valorTotal: valorMatch ? valorMatch[1] : '',
        cartorios: cartorios.slice(0, 5),
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
