// cenprot-helper.js (v2.5.4) - Seletores REAIS do CENPROT
// Mapeados em 14/11/2026 inspecionando o site ao vivo.
//
// TELA LOGIN (pesquisaprotesto.com.br/login):
//   #usario (text) + #senha (password) + botão "Entrar"
//
// TELA CONSULTA (pesquisaprotesto.com.br/servico/consulta-documento):
//   #cpf_cnpj (text) + .bt-consultar (botão lupa)
//
// TELA RESULTADO (pesquisaprotesto.com.br/consulta):
//   Contém "Constam protestos" ou "Não constam" + "Documento informado"

(function(){
  'use strict';
  try{
    var KEY_CNPJ = 'ma_cenprot_cnpj_v2';
    var JA_CONSULTOU = 'ma_cenprot_consultou_v2';
    var JA_ENVIOU = 'ma_cenprot_enviou_v2';

    // 1) Captura CNPJ via URL ?ma_cnpj=XXX
    var url = new URL(location.href);
    var cnpjParam = url.searchParams.get('ma_cnpj');
    if (cnpjParam) {
      try{
        sessionStorage.setItem(KEY_CNPJ, cnpjParam);
        sessionStorage.removeItem(JA_CONSULTOU);
        sessionStorage.removeItem(JA_ENVIOU);
      }catch(_){}
    }
    var cnpj = '';
    try{ cnpj = (sessionStorage.getItem(KEY_CNPJ) || '').replace(/\D/g, ''); }catch(_){}
    if (!cnpj || cnpj.length !== 14) return;

    function fmt(c){ return c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5'); }

    function preencher(input, valor){
      try{
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, valor);
      }catch(e){ input.value = valor; }
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      input.dispatchEvent(new Event('blur', {bubbles:true}));
    }

    // === DETECTORES BASEADOS EM SELETORES EXATOS ===

    function ehTelaLogin(){
      var usr = document.getElementById('usario');
      var senha = document.getElementById('senha');
      return !!(usr && senha && usr.offsetParent && senha.offsetParent);
    }

    function ehTelaConsulta(){
      var cnpjInp = document.getElementById('cpf_cnpj');
      return !!(cnpjInp && cnpjInp.offsetParent);
    }

    function ehPainelPosLogin(){
      // Após login, CENPROT vai pra /painel. Precisa navegar pra consulta.
      return /\/painel\b/i.test(location.pathname);
    }

    function ehTelaResultado(){
      if (!/\/consulta\b/.test(location.pathname)) return false;
      var txt = (document.body && document.body.innerText) || '';
      return /\b(constam\s+protestos|n[aã]o\s+constam\s+protestos|documento\s+informado)\b/i.test(txt);
    }

    // === AÇÃO: LOGIN ===
    var loginFeito = false;
    function tentarLogin(){
      if (loginFeito) return;
      if (!ehTelaLogin()) return;
      chrome.storage.local.get(['cenprotUsuario', 'cenprotSenha', 'cenprotAutoEntrar'], function(st){
        if (!st || !st.cenprotUsuario || !st.cenprotSenha) {
          console.log('[CENPROT helper] sem credenciais salvas - colab digita manualmente');
          return;
        }
        var inpUsr = document.getElementById('usario');
        var inpSenha = document.getElementById('senha');
        if (!inpUsr || !inpSenha) return;
        // Preenche usuário e senha (só se vazios)
        if (!inpUsr.value.trim()) preencher(inpUsr, st.cenprotUsuario);
        if (!inpSenha.value.trim()) preencher(inpSenha, st.cenprotSenha);

        // SEMPRE marca "Manter-me conectado" (sessão dura dias)
        try {
          var toggleWrap = document.querySelector('.manter-logado-selection');
          if (toggleWrap) {
            var chkManter = toggleWrap.querySelector('input[type="checkbox"]');
            if (chkManter && !chkManter.checked) {
              chkManter.click();
              console.log('[CENPROT helper] marcou Manter-me conectado');
            }
          }
        } catch(_) {}

        loginFeito = true;
        console.log('[CENPROT helper] login preenchido');

        // SEMPRE clica Entrar (sem precisar de cenprotAutoEntrar - é o fluxo padrão)
        setTimeout(function(){
          // Procura o botão Entrar específico (btn-primary.btn-block)
          var botao = document.querySelector('button.btn-primary.btn-block');
          if (botao && /^\s*Entrar\s*$/i.test(botao.textContent || '')) {
            botao.click();
            console.log('[CENPROT helper] clicou Entrar auto');
            return;
          }
          // Fallback: procura qualquer botão com texto "Entrar"
          var botoes = document.querySelectorAll('button');
          for (var i=0; i<botoes.length; i++) {
            var t = (botoes[i].textContent || '').trim().toLowerCase();
            if (t === 'entrar' && botoes[i].offsetParent) {
              botoes[i].click();
              console.log('[CENPROT helper] clicou Entrar (fallback)');
              return;
            }
          }
        }, 800);
      });
    }

    // === AÇÃO: CONSULTAR CNPJ ===
    var consultaFeita = false;
    function tentarConsulta(){
      if (consultaFeita) return;
      try{ if (sessionStorage.getItem(JA_CONSULTOU)) { consultaFeita = true; return; } }catch(_){}
      if (!ehTelaConsulta()) return;
      var inp = document.getElementById('cpf_cnpj');
      if (!inp) return;
      preencher(inp, fmt(cnpj));
      consultaFeita = true;
      try{ sessionStorage.setItem(JA_CONSULTOU, '1'); }catch(_){}
      console.log('[CENPROT helper] CNPJ preenchido:', fmt(cnpj));
      // Clica no botão buscar
      setTimeout(function(){
        var btn = document.querySelector('button.bt-consultar') ||
                  document.querySelector('.bt-consultar') ||
                  document.querySelector('button[class*="consultar"]');
        if (btn && btn.offsetParent) {
          btn.click();
          console.log('[CENPROT helper] clicou buscar');
        } else {
          console.warn('[CENPROT helper] botão buscar não encontrado');
        }
      }, 400);
    }

    // === AÇÃO: EXTRAIR RESULTADO E ENVIAR PRO APP ===
    var enviou = false;
    function extrairEEnviar(tent){
      if (enviou) return;
      try{ if (sessionStorage.getItem(JA_ENVIOU)) { enviou = true; return; } }catch(_){}
      tent = tent || 0;
      if (tent > 20) return;
      if (!ehTelaResultado()) {
        setTimeout(function(){ extrairEEnviar(tent+1); }, 1000);
        return;
      }
      var corpo = ((document.body && document.body.innerText) || '').trim();
      // Parse direto: tem ou não tem protesto?
      var constam = /\bconstam\s+protestos\b/i.test(corpo);
      var naoConstam = /\bn[aã]o\s+constam\b/i.test(corpo);
      var temProtesto = constam && !naoConstam;

      // Extrai documento e data
      var docMatch = corpo.match(/Documento\s+informado:\s*([\d.\/-]+)/i);
      var dataMatch = corpo.match(/Data\s+da\s+consulta:\s*([\d\/\s:]+)/i);
      var userMatch = corpo.match(/Pesquisa\s+realizada\s+pelo\s+usu[aá]rio:\s*([^,\n]+)/i);

      var resultado = {
        temProtesto: temProtesto,
        documento: docMatch ? docMatch[1].trim() : fmt(cnpj),
        dataConsulta: dataMatch ? dataMatch[1].trim() : '',
        usuarioPesquisa: userMatch ? userMatch[1].trim() : '',
        textoCompleto: corpo.slice(0, 5000),
        urlResultado: location.href
      };

      enviou = true;
      try{ sessionStorage.setItem(JA_ENVIOU, '1'); }catch(_){}
      try{
        chrome.runtime.sendMessage({
          tipo: 'cenprot_resultado_raw',
          cnpj: cnpj,
          resultado: resultado,
          texto: corpo.slice(0, 15000)
        });
      }catch(_){}
      console.log('[CENPROT helper] resultado enviado:', resultado);
      // Limpa sessionStorage pra não repetir
      try{ sessionStorage.removeItem(KEY_CNPJ); }catch(_){}
    }

    // === AÇÃO EXTRA: fecha modal "Login — Continuar" (aparece após clicar Entrar) ===
    var modalContinuarClicado = false;
    function tentarContinuarModal(){
      if (modalContinuarClicado) return;
      // Procura modal aberto com texto "Login" / "Certificado Digital" / "GOV.BR"
      var modais = document.querySelectorAll('.modal, [class*="modal-dialog"]');
      for (var i=0; i<modais.length; i++){
        var m = modais[i];
        if (!m.offsetParent) continue;
        var texto = m.innerText || '';
        if (!/certificado\s+digital|gov\.br|carta\s+de\s+anu/i.test(texto)) continue;
        // Procura botão "Continuar" dentro do modal
        var botoes = m.querySelectorAll('button');
        for (var j=0; j<botoes.length; j++){
          var t = (botoes[j].textContent || '').trim();
          if (/^continuar$/i.test(t) && botoes[j].offsetParent){
            botoes[j].click();
            modalContinuarClicado = true;
            console.log('[CENPROT helper] clicou Continuar no modal');
            return;
          }
        }
      }
      // Fallback: procura qualquer botão verde/success com texto "Continuar"
      var todos = document.querySelectorAll('button');
      for (var k=0; k<todos.length; k++){
        var t2 = (todos[k].textContent || '').trim();
        if (/^continuar$/i.test(t2) && todos[k].offsetParent){
          var cls = (todos[k].className || '').toLowerCase();
          // Prioriza botão verde (success)
          if (/success|btn-success|green/i.test(cls) || todos[k].style.backgroundColor.indexOf('rgb(40, 167, 69)') >= 0){
            todos[k].click();
            modalContinuarClicado = true;
            console.log('[CENPROT helper] clicou Continuar (fallback verde)');
            return;
          }
        }
      }
    }

    // === AÇÃO EXTRA: navegar de /painel pra /servico/consulta-documento ===
    var navegouPraConsulta = false;
    function tentarIrParaConsulta(){
      if (navegouPraConsulta) return;
      if (!ehPainelPosLogin()) return;
      navegouPraConsulta = true;
      console.log('[CENPROT helper] no painel - navegando pra consulta-documento');
      location.href = 'https://www.pesquisaprotesto.com.br/servico/consulta-documento';
    }

    // === LOOP: tenta a ação apropriada ===
    function ciclo(){
      try{
        // Modal "Continuar" pode aparecer sobre qualquer tela, sempre verifica primeiro
        tentarContinuarModal();
        if (ehTelaLogin()) tentarLogin();
        else if (ehPainelPosLogin()) tentarIrParaConsulta();
        else if (ehTelaConsulta()) tentarConsulta();
        else if (ehTelaResultado()) extrairEEnviar(0);
      }catch(_){}
    }
    setTimeout(ciclo, 1200);
    setInterval(ciclo, 1500);
  }catch(e){
    console.error('[CENPROT helper] erro', e);
  }
})();
