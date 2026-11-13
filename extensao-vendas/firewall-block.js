// firewall-block.js
// Content script injetado em TODAS as paginas em document_start.
// Pergunta ao background se o dominio atual esta bloqueado pela politica
// aplicada a esta maquina. Se sim, substitui a pagina pelo aviso.

(function(){
  try{
    var hostname=location.hostname||'';
    if(!hostname) return;
    // Nunca bloqueia paginas internas da extensao, chrome:// ou about:
    if(location.protocol==='chrome-extension:'||location.protocol==='chrome:'||location.protocol==='about:') return;

    chrome.runtime.sendMessage({tipo:'fw_check',hostname:hostname,url:location.href},function(resp){
      try{
        if(!resp||!resp.bloquear) return;
        // Bloqueia: substitui o documento inteiro
        document.open();
        document.write(
          '<!doctype html><html><head><meta charset="utf-8"><title>Bloqueado</title>'
          +'<style>'
          +'body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center}'
          +'.card{max-width:520px;background:#fff;border:3px solid #dc2626;border-radius:16px;padding:32px;box-shadow:0 10px 40px rgba(0,0,0,0.1);text-align:center}'
          +'.icone{font-size:64px;margin-bottom:12px}'
          +'h1{color:#991b1b;font-size:22px;margin:8px 0 4px}'
          +'.sub{color:#78350f;font-size:14px;margin-bottom:20px}'
          +'.dominio{background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:14px;color:#991b1b;margin:16px 0;word-break:break-all}'
          +'.rodape{margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b}'
          +'</style></head><body>'
          +'<div class="card">'
          +'<div class="icone">🚫</div>'
          +'<h1>Acesso bloqueado</h1>'
          +'<div class="sub">Este domínio está bloqueado pela política da Mais Acessível para esta estação de trabalho.</div>'
          +'<div class="dominio">'+hostname+'</div>'
          +'<div class="rodape">Em caso de necessidade, fale com <b>Raul (Administrador)</b>.</div>'
          +'</div></body></html>'
        );
        document.close();
        // Evita que o resto da pagina execute
        try{window.stop();}catch(_){}
      }catch(_){}
    });
  }catch(_){}
})();
