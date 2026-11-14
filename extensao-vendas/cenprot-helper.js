// cenprot-helper.js (v2.5.0)
// Content script LEVE — só pra assistir o colaborador no CENPROT
// Fluxo: app abre pesquisaprotesto.com.br/servico/consulta-documento e guarda CNPJ no sessionStorage
// Depois do login, o site carrega essa URL. O script preenche o CNPJ e clica buscar.
// Se não tem CNPJ guardado ou já preencheu, não faz NADA.

(function(){
  'use strict';
  try{
    // Chave única
    var KEY = 'ma_cenprot_cnpj_v1';
    // 1. Captura CNPJ via URL param e guarda em sessionStorage (persiste entre redirects do login)
    var url = new URL(location.href);
    var cnpjParam = url.searchParams.get('ma_cnpj');
    if (cnpjParam) {
      try{ sessionStorage.setItem(KEY, cnpjParam); }catch(_){}
    }
    var cnpj = null;
    try{ cnpj = sessionStorage.getItem(KEY); }catch(_){}
    if (!cnpj) return;
    cnpj = cnpj.replace(/\D/g, '');
    if (cnpj.length !== 14) return;

    // 2. Formata com pontos
    function fmt(c){ return c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,'$1.$2.$3/$4-$5'); }

    // 3. Procura o campo CNPJ na tela e preenche + clica buscar
    var tentativas = 0;
    var MAX = 40; // 20 segundos
    var preenchido = false;

    function procurarECpliClicar(){
      tentativas++;
      if (tentativas > MAX || preenchido) return;

      // Procura input que parece ser pra CNPJ
      var input = document.querySelector('input[name*="documento" i], input[name*="cnpj" i], input[id*="cnpj" i], input[id*="documento" i], input[placeholder*="CNPJ" i], input[placeholder*="CPF" i], input[placeholder*="documento" i]');

      // Fallback: primeiro input de texto visível
      if (!input) {
        var inputs = document.querySelectorAll('input[type="text"],input[type="tel"],input:not([type])');
        for (var i=0; i<inputs.length; i++) {
          if (inputs[i].offsetParent !== null && !inputs[i].readOnly && !inputs[i].disabled) {
            input = inputs[i]; break;
          }
        }
      }

      if (input && input.offsetParent !== null) {
        try{
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, fmt(cnpj));
        }catch(e){
          input.value = fmt(cnpj);
        }
        input.dispatchEvent(new Event('input', {bubbles:true}));
        input.dispatchEvent(new Event('change', {bubbles:true}));
        input.focus();
        preenchido = true;
        console.log('[CENPROT helper] CNPJ preenchido');

        // Procura botão buscar e clica
        setTimeout(function(){
          var botoes = document.querySelectorAll('button, input[type="submit"]');
          var btn = null;
          for (var i=0; i<botoes.length; i++) {
            var t = ((botoes[i].textContent || botoes[i].value || '')+'').toLowerCase().trim();
            if (/^(buscar|consultar|pesquisar|localizar)$/.test(t) || /\b(buscar|consultar|pesquisar)\b/.test(t)) {
              if (botoes[i].offsetParent !== null) { btn = botoes[i]; break; }
            }
          }
          if (btn) {
            btn.click();
            console.log('[CENPROT helper] clicou buscar');
            // Limpa storage pra não repetir
            try{ sessionStorage.removeItem(KEY); }catch(_){}
            // Aguarda resultado carregar e envia texto da tela pro app
            setTimeout(function(){ coletarEEnviarResultado(0); }, 3000);
          }
        }, 400);
        return;
      }
      setTimeout(procurarECpliClicar, 500);
    }

    // Lê o resultado da tela e envia pro app Mais Acessível
    function coletarEEnviarResultado(tent){
      tent = tent || 0;
      if (tent > 30) return; // 30 tentativas = 30s
      var corpo = (document.body.innerText || '').trim();
      // Heurística: resultado carregou quando tem "constam" / "não consta" / "protesto" muito
      var temResultado = /constam?|n[aã]o\s+consta|protest|apontament|t[ií]tul|sem\s+apontamento/i.test(corpo) && corpo.length > 500;
      if (!temResultado) {
        setTimeout(function(){ coletarEEnviarResultado(tent+1); }, 1000);
        return;
      }
      console.log('[CENPROT helper] resultado detectado, enviando pro app');
      // Envia o texto cru do resultado pro background
      try{
        chrome.runtime.sendMessage({
          tipo: 'cenprot_resultado_raw',
          cnpj: cnpj,
          texto: corpo.slice(0, 15000), // limita tamanho
          url: location.href
        });
      }catch(_){}
    }

    // Só roda se a URL for de consulta (não no login/home)
    function talvezRodar(){
      var href = location.href;
      if (/consulta|servico|pesquisa|buscar|protesto/i.test(href) && !/\/login\b/i.test(href)) {
        procurarECpliClicar();
      } else {
        // Ainda não é a tela de consulta - tenta de novo em 2s
        setTimeout(talvezRodar, 2000);
      }
    }
    setTimeout(talvezRodar, 1500);
  }catch(e){
    console.error('[CENPROT helper] erro', e);
  }
})();
