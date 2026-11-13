// cenprot-reader.js
// Content script injetado nas paginas do CENPROT.
// 1) Reporta pro background quando esta logado (pra o app saber)
// 2) Faz a consulta automatica quando recebe cnpj via URL (?cnpj=XXX)
// 3) Faz parse do resultado e manda pro app Mais Acessivel

(function(){
  try{
    var url=new URL(location.href);
    var cnpj=url.searchParams.get('cnpj');
    var fromApp=url.searchParams.get('from')==='maisacessivel';
    if(!cnpj || !fromApp) return;

    // Espera a pagina carregar e tenta fazer a consulta
    function tentar(tentativa){
      tentativa=tentativa||0;
      if(tentativa>30) {reportar({erro:'timeout aguardando pagina CENPROT'}); return;}

      // Procura o campo CNPJ na pagina (nomes variam, testa varios)
      var campo=document.querySelector('input[name*="documento" i], input[name*="cnpj" i], input[id*="cnpj" i], input[placeholder*="CNPJ" i]');
      if(!campo){ setTimeout(function(){tentar(tentativa+1);},500); return; }

      // Preenche e dispara eventos
      campo.value=cnpj;
      campo.dispatchEvent(new Event('input',{bubbles:true}));
      campo.dispatchEvent(new Event('change',{bubbles:true}));

      // Procura botao consultar/pesquisar
      setTimeout(function(){
        var botoes=document.querySelectorAll('button,input[type=submit]');
        var btn=null;
        for(var i=0;i<botoes.length;i++){
          var t=(botoes[i].textContent||botoes[i].value||'').toLowerCase();
          if(/(consultar|pesquisar|buscar)/.test(t)){ btn=botoes[i]; break; }
        }
        if(!btn){reportar({erro:'botao consultar nao encontrado'}); return;}
        btn.click();
        // Aguarda resultado
        setTimeout(function(){lerResultado(0);},1500);
      },300);
    }

    function lerResultado(tentativa){
      tentativa=tentativa||0;
      if(tentativa>20){reportar({erro:'timeout aguardando resultado'}); return;}
      // Procura padroes de resposta - texto que indique protesto ou nao
      var corpo=document.body.innerText||'';
      var temProtesto=/(consta|possui|existem?)\s+(protest|apontament)/i.test(corpo);
      var naoConsta=/(n[aã]o\s+consta|sem\s+protest|nenhum\s+protest)/i.test(corpo);
      if(!temProtesto && !naoConsta){ setTimeout(function(){lerResultado(tentativa+1);},500); return; }

      // Tenta extrair numero e valor total
      var qtdMatch=corpo.match(/(\d+)\s+(apontament|protest|t[ií]tul)/i);
      var valorMatch=corpo.match(/R\$\s*([\d.,]+)/);

      // Tenta extrair cartorios (linhas que contenham "tabeli" ou "cart[oó]rio")
      var linhas=corpo.split('\n');
      var cartorios=[];
      linhas.forEach(function(l){
        if(/(tabeli|cart[oó]rio)/i.test(l) && l.length<200) cartorios.push(l.trim());
      });

      reportar({
        temProtesto: temProtesto && !naoConsta,
        quantidade: qtdMatch?parseInt(qtdMatch[1],10):(temProtesto?1:0),
        valorTotal: valorMatch?valorMatch[1]:'',
        cartorios: cartorios.slice(0,5),
        textoBruto: corpo.slice(0,2000)
      });
    }

    function reportar(resultado){
      // Envia pro background que repassa pro app Mais Acessivel
      try{ chrome.runtime.sendMessage({tipo:'cenprot_resultado',cnpj:cnpj,resultado:resultado}); }catch(_){}
      // Tambem posta via window.postMessage caso a aba do app esteja escutando
      try{
        window.opener && window.opener.postMessage({tipo:'cenprot_resultado',cnpj:cnpj,resultado:resultado},'https://rauldneto.github.io');
      }catch(_){}
    }

    // Comeca apos 1s pra pagina carregar
    setTimeout(function(){tentar(0);},1000);
  }catch(e){
    console.error('[CENPROT reader]',e);
  }
})();
