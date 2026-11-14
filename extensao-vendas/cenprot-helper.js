// cenprot-helper.js (v2.5.2)
// Content script que assiste o colaborador no CENPROT:
//   1. Na tela de LOGIN: preenche usuário e senha (salvos no chrome.storage). Colab clica Entrar.
//   2. Na tela de CONSULTA (já logado): preenche CNPJ, clica Buscar, lê resultado, envia pro app.
//
// TRAVAS DE SEGURANÇA (nunca preenche campo errado):
//   - Login SÓ se: URL tem /login + tem campo type=password + tem campo usuário
//   - CNPJ SÓ se: URL NÃO tem /login + NÃO tem campo type=password + tem indicadores de logado

(function(){
  'use strict';
  try{
    var KEY_CNPJ = 'ma_cenprot_cnpj_v1';
    var CNPJ_CONSULTADO_KEY = 'ma_cenprot_cnpj_consultado_v1'; // pra não repetir
    var RESULTADO_ENVIADO_KEY = 'ma_cenprot_resultado_enviado_v1';

    // 1) Captura CNPJ via URL param e persiste em sessionStorage
    var url = new URL(location.href);
    var cnpjParam = url.searchParams.get('ma_cnpj');
    if (cnpjParam) {
      try{
        sessionStorage.setItem(KEY_CNPJ, cnpjParam);
        sessionStorage.removeItem(CNPJ_CONSULTADO_KEY);
        sessionStorage.removeItem(RESULTADO_ENVIADO_KEY);
      }catch(_){}
    }
    var cnpj = '';
    try{ cnpj = (sessionStorage.getItem(KEY_CNPJ) || '').replace(/\D/g, ''); }catch(_){}
    if (!cnpj || cnpj.length !== 14) return;

    function fmt(c){ return c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,'$1.$2.$3/$4-$5'); }

    function preencherCampo(input, valor){
      try{
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, valor);
      }catch(e){ input.value = valor; }
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      input.dispatchEvent(new Event('blur', {bubbles:true}));
    }

    // --- DETECÇÕES ---
    function temCampoSenha(){
      return !!document.querySelector('input[type="password"]');
    }
    function ehTelaLogin(){
      // URL contém /login E tem campo senha E tem campo usuário
      if (!/\/login\b/i.test(location.href)) return false;
      if (!temCampoSenha()) return false;
      var inputs = document.querySelectorAll('input[type="text"],input[type="tel"],input[type="email"],input:not([type])');
      var temUsuario = false;
      for (var i=0; i<inputs.length; i++){
        if (inputs[i].offsetParent !== null) { temUsuario = true; break; }
      }
      return temUsuario;
    }
    function usuarioLogado(){
      // Sem campo de senha + URL fora do login + indicadores de logado
      if (temCampoSenha()) return false;
      if (/\/login\b/i.test(location.href)) return false;
      var corpo = (document.body && document.body.innerText) || '';
      var temIndicadorTexto = /\b(sair|logout|meus\s+dados|meu\s+perfil|minhas\s+consultas)\b/i.test(corpo);
      var temIndicadorElem = !!document.querySelector('a[href*="logout" i],a[href*="sair" i],[class*="logout"],[class*="user-menu" i]');
      return temIndicadorTexto || temIndicadorElem;
    }
    function ehTelaConsulta(){
      // Está numa tela que tem campo pra pesquisar CNPJ/documento (não é login)
      if (temCampoSenha()) return false;
      if (/\/login\b/i.test(location.href)) return false;
      var campo = acharCampoCnpj();
      return !!campo;
    }
    function acharCampoCnpj(){
      // Procura input visível que mencione documento/cnpj/cpf no name/id/placeholder/label
      var candidatos = document.querySelectorAll('input[name*="documento" i], input[name*="cnpj" i], input[name*="cpf" i], input[id*="documento" i], input[id*="cnpj" i], input[placeholder*="CNPJ" i], input[placeholder*="CPF" i], input[placeholder*="documento" i]');
      for (var i=0; i<candidatos.length; i++){
        if (candidatos[i].offsetParent !== null && candidatos[i].type !== 'password') return candidatos[i];
      }
      return null;
    }
    function acharBotaoBuscar(){
      var botoes = document.querySelectorAll('button, input[type="submit"]');
      for (var i=0; i<botoes.length; i++){
        var t = ((botoes[i].textContent || botoes[i].value || '')+'').toLowerCase().trim();
        if (/^(buscar|consultar|pesquisar|localizar)$/.test(t) || /\b(buscar|consultar|pesquisar)\b/.test(t)){
          if (botoes[i].offsetParent !== null) return botoes[i];
        }
      }
      return null;
    }

    // --- AÇÃO 1: preencher login ---
    var loginPreenchido = false;
    function tentarPreencherLogin(){
      if (loginPreenchido) return;
      if (!ehTelaLogin()) return;
      chrome.storage.local.get(['cenprotUsuario', 'cenprotSenha'], function(st){
        if (!st || !st.cenprotUsuario || !st.cenprotSenha) return;
        // Busca os 2 campos - usuário (text/tel) e senha (password)
        var inputSenha = document.querySelector('input[type="password"]');
        var inputUsuario = null;
        var inputs = document.querySelectorAll('input[type="text"],input[type="tel"],input[type="email"],input:not([type])');
        for (var i=0; i<inputs.length; i++){
          if (inputs[i].offsetParent !== null && inputs[i].type !== 'password') { inputUsuario = inputs[i]; break; }
        }
        if (!inputUsuario || !inputSenha) return;
        // TRAVA EXTRA: só preenche se campo tá vazio (não sobrescreve se colab já digitou)
        if (inputUsuario.value.trim() && !/^\s*$/.test(inputUsuario.value)) {
          // Já tem algo - não mexe
          loginPreenchido = true;
          return;
        }
        preencherCampo(inputUsuario, st.cenprotUsuario);
        preencherCampo(inputSenha, st.cenprotSenha);
        loginPreenchido = true;
        console.log('[CENPROT helper] login preenchido');
      });
    }

    // --- AÇÃO 2: preencher CNPJ e buscar ---
    var consultaFeita = false;
    function tentarConsultar(){
      if (consultaFeita) return;
      try{ if (sessionStorage.getItem(CNPJ_CONSULTADO_KEY)) { consultaFeita = true; return; } }catch(_){}
      if (!usuarioLogado()) return;
      if (!ehTelaConsulta()) return;
      var campo = acharCampoCnpj();
      if (!campo) return;
      preencherCampo(campo, fmt(cnpj));
      consultaFeita = true;
      try{ sessionStorage.setItem(CNPJ_CONSULTADO_KEY, '1'); }catch(_){}
      console.log('[CENPROT helper] CNPJ preenchido');
      // Clica buscar
      setTimeout(function(){
        var btn = acharBotaoBuscar();
        if (btn) {
          btn.click();
          console.log('[CENPROT helper] clicou buscar');
          setTimeout(function(){ coletarEEnviarResultado(0); }, 2500);
        }
      }, 500);
    }

    // --- AÇÃO 3: coletar resultado e enviar pro app ---
    function coletarEEnviarResultado(tent){
      try{ if (sessionStorage.getItem(RESULTADO_ENVIADO_KEY)) return; }catch(_){}
      tent = tent || 0;
      if (tent > 30) return;
      var corpo = ((document.body && document.body.innerText) || '').trim();
      var temResultado = /constam?|n[aã]o\s+consta|protest|apontament|t[ií]tul|sem\s+apontamento/i.test(corpo) && corpo.length > 500;
      if (!temResultado) {
        setTimeout(function(){ coletarEEnviarResultado(tent+1); }, 1000);
        return;
      }
      try{
        chrome.runtime.sendMessage({
          tipo: 'cenprot_resultado_raw',
          cnpj: cnpj,
          texto: corpo.slice(0, 15000),
          url: location.href
        });
        sessionStorage.setItem(RESULTADO_ENVIADO_KEY, '1');
        sessionStorage.removeItem(KEY_CNPJ);
      }catch(_){}
      console.log('[CENPROT helper] resultado enviado pro app');
    }

    // --- LOOP: tenta login OU consulta em ciclo (SPA pode mudar sem reload) ---
    function ciclo(){
      try{
        if (ehTelaLogin()) tentarPreencherLogin();
        else if (ehTelaConsulta()) tentarConsultar();
      }catch(_){}
    }
    setTimeout(ciclo, 1200);
    setInterval(ciclo, 1500);
  }catch(e){
    console.error('[CENPROT helper] erro', e);
  }
})();
