// cenprot-reader.js (v2.4.6)
// Content script em TODAS as páginas do CENPROT. 2 modos:
// 1) Modo login (login=govbr): detecta quando usuário autenticou e avisa o background pra fechar popup
// 2) Modo consulta (cnpj=X): preenche formulário, consulta, lê resultado

(function(){
  'use strict';
  try{
    var url = new URL(location.href);
    var cnpj = url.searchParams.get('cnpj') || url.searchParams.get('CNPJ') || url.searchParams.get('documento');
    var fromApp = (url.searchParams.get('from') || '') === 'maisacessivel';
    var modoLogin = url.searchParams.get('login') === 'govbr';
    var SESSION_KEY = 'ma_cenprot_cnpj';

    // Modo login persiste entre redirects via chrome.storage (todos os domínios compartilham)
    // Se a flag estiver setada, considera modo login mesmo sem URL param
    chrome.storage.local.get(['cenprotLoginEmAndamento'], function(st){
      var flagAtiva = st && st.cenprotLoginEmAndamento;
      if (flagAtiva) {
        // Se a flag foi setada < 5 min atrás, considera login em andamento
        var idade = Date.now() - new Date(flagAtiva).getTime();
        if (idade < 5*60*1000) {
          modoLogin = true;
          processar();
          return;
        }
      }
      processar();
    });

    function processar(){

    // MODO LOGIN: esconde CENPROT + clica "Entrar com GOV.BR" automático + detecta sucesso
    if (modoLogin) {
      console.log('[CENPROT] modo login - escondendo página + buscando botão GOV.BR');
      // 1) Esconde o corpo da página do CENPROT com overlay "Redirecionando pro GOV.BR..."
      function mostrarOverlay(txt){
        var ov = document.getElementById('ma_overlay_login');
        if (!ov) {
          ov = document.createElement('div');
          ov.id = 'ma_overlay_login';
          ov.style.cssText = 'position:fixed;inset:0;background:linear-gradient(135deg,#1565c0,#1d4ed8);z-index:2147483647;display:flex;align-items:center;justify-content:center;color:#fff;font-family:-apple-system,"Segoe UI",sans-serif;text-align:center;padding:20px';
          document.documentElement.appendChild(ov);
        }
        ov.innerHTML = '<div style="max-width:380px"><div style="font-size:48px;margin-bottom:12px">🛡️</div><div style="font-size:18px;font-weight:700;margin-bottom:8px">'+txt+'</div><div style="font-size:13px;opacity:.85;line-height:1.6">Aguarde, estamos levando você direto pro GOV.BR...</div><div style="margin-top:20px;width:40px;height:40px;border:4px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite;margin:20px auto 0"></div></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
      }
      function esconderOverlay(){
        var ov = document.getElementById('ma_overlay_login');
        if (ov) ov.remove();
      }

      mostrarOverlay('Mais Acessível · Autenticação CENPROT');

      // 2) Procura e clica no botão "Entrar com GOV.BR"
      function clicarEntrarGovBr(tent) {
        tent = tent || 0;
        if (tent > 20) { esconderOverlay(); return; } // desiste após 10s, mostra a página pro user
        // Procura por botões/links com texto "gov.br" ou "entrar"
        var alvos = document.querySelectorAll('a, button, [role="button"]');
        var candidatos = [];
        for (var i = 0; i < alvos.length; i++) {
          var el = alvos[i];
          var t = (el.textContent || '').trim().toLowerCase();
          var h = (el.getAttribute('href') || '').toLowerCase();
          if (/gov\.?br/.test(t) || /gov\.?br/.test(h) || /entrar\s+com\s+gov/i.test(t)) {
            candidatos.push({el: el, score: 10});
          } else if (/^(entrar|login|acessar)$/i.test(t)) {
            candidatos.push({el: el, score: 1});
          }
        }
        // Prioriza quem tem "gov.br"
        candidatos.sort(function(a,b){return b.score-a.score;});
        for (var j = 0; j < candidatos.length; j++) {
          if (candidatos[j].el.offsetParent !== null) {
            console.log('[CENPROT] clicando em:', candidatos[j].el.textContent.trim());
            candidatos[j].el.click();
            setTimeout(function(){ clicarEntrarGovBr(tent+5); }, 1500);
            return;
          }
        }
        setTimeout(function(){ clicarEntrarGovBr(tent+1); }, 500);
      }
      setTimeout(function(){ clicarEntrarGovBr(0); }, 300);

      // 3) Fica monitorando: quando chegar no GOV.BR, tira overlay (pro user ver login). Quando voltar logado, avisa background.
      var checagemLogin = 0;
      var intervalLogin = setInterval(function(){
        checagemLogin++;
        if (checagemLogin > 300) { clearInterval(intervalLogin); return; } // 5min
        var host = location.hostname;
        // Se chegou no gov.br → remove overlay pra user ver tela de login
        if (/gov\.br/.test(host)) {
          esconderOverlay();
          return;
        }
        // Se voltou pra pesquisaprotesto depois do login
        var corpo = document.body.innerText || '';
        var logado = /\b(sair|logout|meus\s+dados|meu\s+perfil|minhas\s+consultas|bem.vindo)\b/i.test(corpo) ||
                     document.querySelector('a[href*="logout"],a[href*="sair"],[class*="logout"]');
        if (logado && !/gov\.br/.test(host)) {
          clearInterval(intervalLogin);
          console.log('[CENPROT] detectou login OK');
          try{ chrome.runtime.sendMessage({tipo: 'cenprot_logado_detectado', url: location.href}); }catch(_){}
        }
      }, 1000);
      return;
    }

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
    } // fim de processar()
  }catch(e){
    console.error('[CENPROT reader] falhou', e);
  }
})();
