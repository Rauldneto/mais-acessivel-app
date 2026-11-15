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
        // Não sobrescreve se já tiver algo
        if (inpUsr.value.trim() && inpSenha.value.trim()) { loginFeito = true; return; }
        preencher(inpUsr, st.cenprotUsuario);
        preencher(inpSenha, st.cenprotSenha);
        loginFeito = true;
        console.log('[CENPROT helper] login preenchido');
        // Opcional: auto-entrar
        if (st.cenprotAutoEntrar) {
          setTimeout(function(){
            // Procura o botão Entrar
            var botoes = document.querySelectorAll('button.btn-primary.btn-block, button');
            for (var i=0; i<botoes.length; i++) {
              var t = (botoes[i].textContent || '').trim().toLowerCase();
              if (t === 'entrar' || /^entrar$/i.test(t)) {
                if (botoes[i].offsetParent) {
                  botoes[i].click();
                  console.log('[CENPROT helper] clicou Entrar auto');
                  break;
                }
              }
            }
          }, 500);
        }
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

    // === LOOP: tenta a ação apropriada ===
    function ciclo(){
      try{
        if (ehTelaLogin()) tentarLogin();
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
