// cenprot-helper.js (v2.6.4) - MODO MANUAL: so pre-preenche CNPJ, sem automacao
// O colaborador faz login, consulta e volta no app marcar o resultado manualmente.
// Automacao desativada a pedido do usuario (demorava demais).
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
//   Lista cartórios com botão "Detalhes" que expande inline mostrando:
//   "Documento: XXX  Valor Protestado: R$ Y,YY"

(function(){
  'use strict';
  try{
    var KEY_CNPJ = 'ma_cenprot_cnpj_v2';
    var JA_CONSULTOU = 'ma_cenprot_consultou_v2';
    var JA_ENVIOU = 'ma_cenprot_enviou_v2';

    // 1) Captura CNPJ via URL ?ma_cnpj=XXX
    var url = new URL(location.href);
    var cnpjParam = url.searchParams.get('ma_cnpj');
    var ocultoParam = url.searchParams.get('ma_oculto');
    if (cnpjParam) {
      try{
        sessionStorage.setItem(KEY_CNPJ, cnpjParam);
        sessionStorage.setItem('ma_cenprot_oculto_v2', ocultoParam==='1'?'1':'0');
        sessionStorage.removeItem(JA_CONSULTOU);
        sessionStorage.removeItem(JA_ENVIOU);
      }catch(_){}
    }
    var cnpj = '';
    var ehOculto = false;
    try{
      cnpj = (sessionStorage.getItem(KEY_CNPJ) || '').replace(/\D/g, '');
      ehOculto = sessionStorage.getItem('ma_cenprot_oculto_v2') === '1';
    }catch(_){}
    if (!cnpj || cnpj.length !== 14) return;

    // Helper pra avisar background que precisa tornar a aba visivel
    function avisarPrecisaLogin(motivo){
      if (!ehOculto) return;
      try{
        chrome.runtime.sendMessage({tipo:'cenprot_precisa_login',cnpj:cnpj,motivo:motivo||''});
        console.log('[CENPROT helper] avisou background: precisa login -', motivo);
      }catch(_){}
      // Marca que ficou visivel, pra re-ocultar depois quando login for feito
      ehOculto = false;
      try{
        sessionStorage.setItem('ma_cenprot_oculto_v2','0');
        sessionStorage.setItem('ma_cenprot_foi_visivel_v2','1');
      }catch(_){}
    }

    // v2.6.2: Depois do login manual, re-oculta a janela e devolve foco pro app
    var jaReocultou = false;
    function tentarReocultarAposLogin(){
      if (jaReocultou) return;
      // So faz sentido se a aba foi tornada visivel antes (precisa login) E saiu da tela de login
      var foiVisivel = false;
      try{ foiVisivel = sessionStorage.getItem('ma_cenprot_foi_visivel_v2') === '1'; }catch(_){}
      if (!foiVisivel) return;
      // Login terminou quando NAO esta mais na tela de login e nao tem modal de "continuar" aberto
      if (ehTelaLogin()) return;
      // Esta em /painel ou /servico/consulta-documento ou /consulta -> logou com sucesso
      var logado = ehPainelPosLogin() || ehTelaConsulta() || /\/consulta\b/.test(location.pathname) || /\/servico\b/.test(location.pathname);
      if (!logado) return;
      jaReocultou = true;
      try{
        chrome.runtime.sendMessage({tipo:'cenprot_login_ok',cnpj:cnpj});
        console.log('[CENPROT helper] login manual detectado - avisou background pra re-ocultar');
      }catch(_){}
      try{ sessionStorage.setItem('ma_cenprot_foi_visivel_v2','0'); }catch(_){}
    }

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
          avisarPrecisaLogin('sem_credenciais');
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

    // === v2.6.0: ESTRATEGIA ITERATIVA: clica 1 Detalhes, captura texto, proximo, etc ===
    var botoesIterar = [];
    var indiceIter = 0;
    var textosAcumulados = [];
    var htmlFinal = '';
    var iterIniciada = false;
    var iterFinalizada = false;

    function coletarBotoesDetalhes(){
      var tudo = document.querySelectorAll('button, a, [role="button"], .btn, span[onclick]');
      var out = [];
      for (var i=0; i<tudo.length; i++){
        var el = tudo[i];
        if (!el.offsetParent) continue;
        var txt = (el.textContent || '').trim();
        if (/^detalhes(\s|$)/i.test(txt) && txt.length < 30){
          out.push(el);
        }
      }
      return out;
    }

    function iniciarIteracao(){
      if (iterIniciada) return;
      iterIniciada = true;
      botoesIterar = coletarBotoesDetalhes();
      console.log('[CENPROT helper] iteracao: encontrados', botoesIterar.length, 'botao(oes) Detalhes');
      if (botoesIterar.length === 0){
        iterFinalizada = true;
        return;
      }
      // Captura estado INICIAL (antes de qualquer clique)
      try{
        var txtIni = (document.body && document.body.innerText) || '';
        textosAcumulados.push('=== INICIAL ===\n' + txtIni);
      }catch(_){}
      proximoClique();
    }

    function proximoClique(){
      if (indiceIter >= botoesIterar.length){
        // Terminou todos os cliques - captura HTML final tambem
        try{ htmlFinal = (document.body && document.body.innerHTML) || ''; }catch(_){ htmlFinal=''; }
        iterFinalizada = true;
        console.log('[CENPROT helper] iteracao FINALIZADA:', textosAcumulados.length, 'capturas');
        return;
      }
      // Re-coleta os botoes toda vez (podem ter mudado apos cada clique)
      var atuais = coletarBotoesDetalhes();
      var btn = atuais[indiceIter];
      if (!btn){
        indiceIter++;
        setTimeout(proximoClique, 100);
        return;
      }
      try {
        btn.click();
        console.log('[CENPROT helper] clicou Detalhes', indiceIter+1, '/', botoesIterar.length);
      } catch(e){
        console.warn('[CENPROT helper] erro clique', e);
      }
      // Espera 1.8s pros Detalhes expandirem, depois captura texto
      setTimeout(function(){
        try{
          var txt = (document.body && document.body.innerText) || '';
          textosAcumulados.push('=== APOS DETALHES #' + (indiceIter+1) + ' ===\n' + txt);
        }catch(_){}
        indiceIter++;
        proximoClique();
      }, 1800);
    }

    // === AÇÃO: EXTRAIR RESULTADO E ENVIAR PRO APP ===
    var enviou = false;
    function extrairEEnviar(tent){
      if (enviou) return;
      try{ if (sessionStorage.getItem(JA_ENVIOU)) { enviou = true; return; } }catch(_){}
      tent = tent || 0;
      if (tent > 60) {
        console.warn('[CENPROT helper] timeout extração');
        return;
      }
      if (!ehTelaResultado()) {
        setTimeout(function(){ extrairEEnviar(tent+1); }, 1000);
        return;
      }

      // PASSO 1: Inicia iteracao (clica Detalhes 1-a-1, capturando texto entre cliques)
      if (!iterIniciada){
        iniciarIteracao();
        setTimeout(function(){ extrairEEnviar(tent+1); }, 1500);
        return;
      }

      // PASSO 2: Espera a iteracao terminar
      if (!iterFinalizada){
        setTimeout(function(){ extrairEEnviar(tent+1); }, 800);
        return;
      }

      // PASSO 3: Combina todos os textos capturados
      var combinado = textosAcumulados.join('\n\n');

      // Parse basico
      var constam = /\bconstam\s+protestos\b/i.test(combinado);
      var naoConstam = /\bn[aã]o\s+constam\b/i.test(combinado);
      var temProtesto = constam && !naoConstam;

      var docMatch = combinado.match(/Documento\s+informado:\s*([\d.\/-]+)/i);
      var dataMatch = combinado.match(/Data\s+da\s+consulta:\s*([\d\/\s:]+)/i);
      var userMatch = combinado.match(/Pesquisa\s+realizada\s+pelo\s+usu[aá]rio:\s*([^,\n]+)/i);

      // Conta quantos valores foram capturados (feedback visual)
      var matchValores = combinado.match(/valor\s+protestado/gi);
      var totalValores = matchValores ? matchValores.length : 0;

      var resultado = {
        temProtesto: temProtesto,
        documento: docMatch ? docMatch[1].trim() : fmt(cnpj),
        dataConsulta: dataMatch ? dataMatch[1].trim() : '',
        usuarioPesquisa: userMatch ? userMatch[1].trim() : '',
        totalValoresCapturados: totalValores,
        urlResultado: location.href
      };

      enviou = true;
      try{ sessionStorage.setItem(JA_ENVIOU, '1'); }catch(_){}
      try{
        chrome.runtime.sendMessage({
          tipo: 'cenprot_resultado_raw',
          cnpj: cnpj,
          resultado: resultado,
          texto: combinado.slice(0, 80000), // v2.6.0: ate 80k chars de texto combinado
          htmlBruto: (htmlFinal || '').slice(0, 40000) // v2.6.0: HTML bruto final de backup
        });
      }catch(_){}
      console.log('[CENPROT helper] resultado enviado:', totalValores, 'ocorrencias de "valor protestado"');
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

    // === DETECTOR: se login falhou (ainda na tela de login apos 15s = credencial errada) ===
    var tsInicioLogin = 0;
    function detectarLoginFalhou(){
      if (!ehOculto) return;
      if (!ehTelaLogin()) { tsInicioLogin = 0; return; }
      if (tsInicioLogin === 0){ tsInicioLogin = Date.now(); return; }
      // Mais de 18s na tela de login (com credenciais salvas) = credencial errada
      if (Date.now() - tsInicioLogin > 18000 && loginFeito){
        console.warn('[CENPROT helper] login nao concluiu em 18s - credencial pode estar errada');
        avisarPrecisaLogin('credencial_invalida');
      }
    }

    // === DETECTOR: mensagens de erro visiveis (ex: "Dados invalidos", "CAPTCHA") ===
    var jaAvisouErro = false;
    function detectarErroVisivel(){
      if (!ehOculto || jaAvisouErro) return;
      var txt = ((document.body && document.body.innerText) || '').toLowerCase();
      if (/(usu[aá]rio\s+ou\s+senha\s+(inv[aá]lid|incorret)|dados\s+inv[aá]lidos|captcha|recaptcha|verifique\s+se\s+voc[eê]|robô)/i.test(txt)){
        jaAvisouErro = true;
        console.warn('[CENPROT helper] erro visivel detectado');
        avisarPrecisaLogin('erro_pagina');
      }
    }

    // === v2.6.4: MODO MANUAL - helper SO PRE-PREENCHE O CNPJ ===
    // Nao faz login automatico, nao clica buscar, nao expande Detalhes, nao envia resultado.
    // O colaborador faz tudo manualmente e marca o resultado no app sozinho.
    var preenchido = false;
    function cicloManual(){
      try{
        if (preenchido) return;
        if (ehTelaConsulta()){
          var inp = document.getElementById('cpf_cnpj');
          if (inp && !inp.value.trim()){
            preencher(inp, fmt(cnpj));
            preenchido = true;
            console.log('[CENPROT helper] CNPJ pre-preenchido (modo manual):', fmt(cnpj));
          } else if (inp && inp.value.trim()){
            preenchido = true;
          }
        }
      }catch(_){}
    }
    setTimeout(cicloManual, 1000);
    setInterval(cicloManual, 2000);
  }catch(e){
    console.error('[CENPROT helper] erro', e);
  }
})();
