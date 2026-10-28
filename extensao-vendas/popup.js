var APP='https://rauldneto.github.io/mais-acessivel-app/';
var APP_AVULSA='https://rauldneto.github.io/mais-acessivel-cotacao-avulsa/';
var body=document.getElementById('body');

// Div onde o conteudo que muda de acordo com o contexto (Bling ou nao,
// proposta aberta ou nao) e renderizado. O botao "Abrir app" fica fora
// dela, sempre visivel, independente do contexto.
var dynamicWrap=document.createElement('div');

function abrirApp(d){
  chrome.tabs.create({url:APP+'#bling='+encodeURIComponent(JSON.stringify(d))});
  window.close();
}

function abrirAppAvulsa(d){
  chrome.tabs.create({url:APP_AVULSA+'#bling='+encodeURIComponent(JSON.stringify(d))});
  window.close();
}

// Atalho fixo: sempre abre o app numa janela nova, sem depender de
// estar numa proposta do Bling.
function abrirAppNovaJanela(){
  chrome.windows.create({url:APP});
  window.close();
}

function montarBotaoAbrirAppFixo(){
  var btn=document.createElement('button');
  btn.className='btn btn-sec';
  btn.id='btnAbrirAppFixo';
  btn.textContent='🪟 Abrir app';
  btn.onclick=abrirAppNovaJanela;
  return btn;
}

function importar(dados){
  dynamicWrap.innerHTML='<p class="status">⏳ Buscando contato...</p>';
  var etCep=(dados.etiqueta_cep||'').replace(/\D/g,'');
  var etEnd=[dados.etiqueta_endereco,dados.etiqueta_numero,dados.etiqueta_complemento,
    dados.etiqueta_bairro,dados.etiqueta_municipio+' - '+dados.etiqueta_uf]
    .filter(function(s){return s&&s.trim()&&s!=' - ';}).join(', ');
  var kg=(dados.pesoBruto||'').replace(',','.');
  var vi=dados.totalOrcamento||'';
  var volRaw=dados.qtdVolumes||'';
  var vol=(volRaw&&volRaw!=='0')?volRaw:(dados.campoTotalQtds||'').split(',')[0];
  var fm=dados.frete_modalidade||'';
  var ft=(fm==='R'||fm==='r')?'CIF':'FOB';

  function finalizar(cnpj,cep,end){
    abrirApp({n:dados.numeroProposta,vend:dados.nomeVendedor,c:cnpj,p:cep,
      end:end,endE:'',kg:kg,ft:ft,vi:vi,vol:vol,itens:dados.itens||[]});
  }

  if(!dados.idContato){finalizar('',etCep,etEnd);return;}

  chrome.tabs.query({active:true,currentWindow:true},function(tabs){
    chrome.scripting.executeScript({
      target:{tabId:tabs[0].id},
      func:function(id){
        return fetch('/Api/v3/contatos/'+id,{credentials:'include'})
          .then(function(r){return r.json();}).catch(function(){return null;});
      },
      args:[dados.idContato]
    },function(results){
      var resp=results&&results[0]&&results[0].result;
      var cnpj='',cep=etCep,end=etEnd;
      if(resp&&resp.data){
        var c=resp.data;
        cnpj=(c.cpf_cnpj||c.numeroDocumento||'').replace(/[^\d]/g,'');
        var g=(c.endereco&&c.endereco.geral)||{};
        var cadCep=(g.cep||c.cep||'').replace(/\D/g,'');
        var cadEnd=[g.endereco||c.endereco,g.numero||c.numero,g.complemento||c.complemento,
          g.bairro||c.bairro,(g.municipio||c.cidade)+' - '+(g.uf||c.uf)]
          .filter(function(s){return s&&String(s).trim()&&s!=' - ';}).join(', ');
        if(etCep&&etCep!==cadCep){cep=etCep;end=etEnd;}
        else{cep=cadCep||etCep;end=cadEnd||etEnd;}
      }
      finalizar(cnpj,cep,end);
    });
  });
}

function importarAvulsa(dados){
  dynamicWrap.innerHTML='<p class="status">⏳ Buscando contato...</p>';

  function montarItens(){
    return (dados.itens||[]).map(function(i){
      var precoStr=(i.precoUnitario||'0').toString();
      var alvo=parseFloat(precoStr.replace(/\./g,'').replace(',','.'))||0;
      return {nome:(i.produto&&i.produto.descricao)||'',codigo:i.codigo||'',qtd:i.quantidade||1,alvo:alvo};
    });
  }

  function finalizar(cnpj){
    abrirAppAvulsa({n:dados.numeroProposta,cliente:dados.nomeContato||'',c:cnpj,itens:montarItens()});
  }

  if(!dados.idContato){finalizar('');return;}

  chrome.tabs.query({active:true,currentWindow:true},function(tabs){
    chrome.scripting.executeScript({
      target:{tabId:tabs[0].id},
      func:function(id){
        return fetch('/Api/v3/contatos/'+id,{credentials:'include'})
          .then(function(r){return r.json();}).catch(function(){return null;});
      },
      args:[dados.idContato]
    },function(results){
      var resp=results&&results[0]&&results[0].result;
      var cnpj='';
      if(resp&&resp.data){
        cnpj=(resp.data.cpf_cnpj||resp.data.numeroDocumento||'').replace(/[^\d]/g,'');
      }
      finalizar(cnpj);
    });
  });
}


// ====================== CHECK PROPOSTA ======================
var ICON={ok:'✅',erro:'❌',aviso:'⚠️'};

function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function pedirCheck(tabId,cb){
  dynamicWrap.innerHTML='<p class="status">⏳ Conferindo a proposta...</p>';
  chrome.tabs.sendMessage(tabId,{action:'checkProposta'},function(res){
    if(chrome.runtime.lastError||!res||res.falha){
      dynamicWrap.innerHTML='<div class="erro">⚠️ Não consegui conferir. Recarregue a página do Bling (F5) e tente de novo.</div>';
      return;
    }
    cb(res);
  });
}

// continuar: função opcional exibida como "Seguir mesmo assim" (usada antes da cotação de frete)
function mostrarCheck(res,tabId,dados,continuar){
  var ok=res.erros===0;
  var resumo=ok
    ?'<div class="ck-res ck-ban-ok"><div class="ck-ico">✔</div><div><div class="ck-tit">PROPOSTA COMPLETA</div><div class="ck-sub">Pode enviar ao cliente'+(res.avisos?' · confira '+res.avisos+' lembrete(s)':'')+'</div></div></div>'
    :'<div class="ck-res ck-ban-bad"><div class="ck-ico">✖</div><div><div class="ck-tit">FALTA'+(res.erros>1?'M ':' ')+res.erros+' CAMPO'+(res.erros>1?'S':'')+'</div><div class="ck-sub">Corrija no Bling, salve e confira de novo</div></div></div>';

  // erros primeiro, depois avisos, depois ok
  var ordem={erro:0,aviso:1,ok:2};
  var lista=res.itens.slice().sort(function(a,b){return ordem[a.status]-ordem[b.status];});
  var html=lista.map(function(i){
    return '<div class="ck-item ck-'+i.status+'"><span>'+ICON[i.status]+'</span><div><b>'+esc(i.campo)+'</b>'+
      (i.msg?'<div class="ck-msg">'+esc(i.msg)+'</div>':'')+'</div></div>';
  }).join('');

  dynamicWrap.innerHTML=
    '<div class="num" style="font-size:16px;margin-bottom:8px">Check · Proposta Nº '+esc(res.numeroProposta)+' <span style="font-size:10px;color:#999;font-weight:400">v'+chrome.runtime.getManifest().version+'</span></div>'+
    resumo+'<div class="ck-list">'+html+'</div>'+'<div id="ckSug"></div>'+
    (continuar&&!ok?'<button class="btn btn-warn" id="btnSeguir">Seguir para a cotação mesmo assim</button>':'')+
    (continuar&&ok?'<button class="btn btn-ok" id="btnSeguir">🚛 Seguir para a cotação de frete</button>':'')+
    '<button class="btn btn-sec" id="btnRecheck">🔄 Conferir de novo</button>'+
    '<button class="btn btn-sec" id="btnVoltar">← Voltar</button>';

  document.getElementById('btnRecheck').onclick=function(){pedirCheck(tabId,function(r){mostrarCheck(r,tabId,dados,continuar);});};
  document.getElementById('btnVoltar').onclick=function(){mostrarProposta(tabId,dados);};
  var s=document.getElementById('btnSeguir');
  if(s)s.onclick=continuar;
  montarSugestoes(tabId,dados);
}

// ====================== 💡 PRODUTOS QUE COSTUMAM IR JUNTO ======================
// Base: vendas dos últimos 12 meses (produtosRelacionados no Firebase, calculado pelo app).
// O colaborador pode marcar "já ofertei — cliente recusou": fica salvo e aparece no app (aba Cotações).
function chaveFB(c){return String(c||'').replace(/[.#$\/\[\]]/g,'_')||'sem';}
function montarSugestoes(tabId,dados){
  var box=document.getElementById('ckSug');if(!box)return;
  var cods={};(dados.itens||[]).forEach(function(i){if(i.codigo)cods[i.codigo]=1;});
  if(!Object.keys(cods).length)return;
  chrome.tabs.get(tabId,function(tab){
    var m=String((tab&&tab.url)||'').match(/#(?:edit)\/(\d+)/);var idProp=m?m[1]:'';
    Promise.all([
      fetch(FB_POP+'/produtosRelacionados/regras.json').then(function(r){return r.ok?r.json():null;}).catch(function(){return null;}),
      idProp?fetch(FB_POP+'/sugRecusa/'+idProp+'.json').then(function(r){return r.ok?r.json():null;}).catch(function(){return null;}):Promise.resolve(null),
      new Promise(function(res){chrome.storage.local.get(['appUsuario'],res);})
    ]).then(function(a){
      var regras=a[0]||{},rec=a[1]||{},usu=(a[2]&&a[2].appUsuario)||'';
      var idx={};Object.keys(regras).forEach(function(k){var g=regras[k];if(g&&g.c)idx[g.c]=g;});
      var sug={};
      Object.keys(cods).forEach(function(c){var g=idx[c];if(!g)return;(g.rel||[]).forEach(function(r){if(cods[r.c])return;var o=sug[r.c];if(!o||r.p>o.p)sug[r.c]={c:r.c,d:r.d,p:r.p,base:g.d};});});
      var L=Object.keys(sug).map(function(k){return sug[k];}).sort(function(x,y){return y.p-x.p;}).slice(0,5);
      if(!L.length)return;
      box.innerHTML='<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px;color:#1e3a8a">'+
        '<b>💡 Dica: costuma ir junto e não está na cotação</b><div style="font-size:10.5px;color:#3b82f6;margin-bottom:4px">Ofereça ao cliente. Se ele recusar, marque abaixo.</div>'+
        L.map(function(x){var k=chaveFB(x.c),r=rec[k];
          return '<div style="padding:5px 0;border-top:1px dashed #bfdbfe">'+
            '<div><b>'+esc(x.d)+'</b> <span style="color:#64748b">· vai junto em '+x.p+'% das vendas de '+esc(x.base)+'</span></div>'+
            (idProp?'<label style="display:flex;gap:6px;align-items:center;margin-top:3px;cursor:pointer;color:#475569"><input type="checkbox" class="sugRec" data-k="'+esc(k)+'" data-d="'+esc(x.d)+'"'+(r?' checked':'')+'> Já ofertei — cliente recusou'+(r&&r.usuario?' <span style="font-size:10px;color:#94a3b8">('+esc(r.usuario)+')</span>':'')+'</label>':'')+'</div>';}).join('')+'</div>';
      box.querySelectorAll('.sugRec').forEach(function(cb){cb.onchange=function(){
        var url=FB_POP+'/sugRecusa/'+idProp+'/'+cb.getAttribute('data-k')+'.json';
        var body=cb.checked?JSON.stringify({ts:Date.now(),usuario:usu,d:cb.getAttribute('data-d'),numero:dados.numeroProposta||''}):null;
        fetch(url,cb.checked?{method:'PUT',headers:{'Content-Type':'application/json'},body:body}:{method:'DELETE'}).catch(function(){cb.checked=!cb.checked;});
      };});
    });
  });
}

// ====================== TELA DA PROPOSTA ======================
function mostrarProposta(tabId,dados){
  var fm=dados.frete_modalidade||'';
  var ft=(fm==='R'||fm==='r')?'CIF':'FOB';
  dynamicWrap.innerHTML=
    '<div class="info">'+
      '<div class="num">Proposta Nº '+esc(dados.numeroProposta)+'</div>'+
      '<div class="det">👤 '+esc(dados.nomeVendedor||'—')+'</div>'+
      '<div class="det">💰 R$ '+esc(dados.totalOrcamento||'0')+' &nbsp;⚖️ '+esc(dados.pesoBruto||'0')+' kg</div>'+
      '<div class="det">🚚 '+ft+' &nbsp;📦 '+(dados.itens||[]).length+' item(s)</div>'+
    '</div>'+
    '<button class="btn btn-ok" id="btnImp">🚛 Cotação de Frete</button>'+
    '<button class="btn btn-sec" id="btnImpAvulsa">🧾 Cotação avulsa (Baruc)</button>'+
    '<button class="btn btn-check" id="btnCheck">✅ Check Proposta</button>'+
    '<hr class="sep">';

  // Cotação de frete: confere antes; se faltar algo, mostra o check e deixa seguir mesmo assim
  document.getElementById('btnImp').onclick=function(){
    this.disabled=true;this.textContent='⏳ Importando...';
    importar(dados);
  };
  document.getElementById('btnImpAvulsa').onclick=function(){
    this.disabled=true;this.textContent='⏳ Importando...';
    importarAvulsa(dados);
  };
  document.getElementById('btnCheck').onclick=function(){
    pedirCheck(tabId,function(res){mostrarCheck(res,tabId,dados,null);});
  };
}

// Estrutura fixa: área dinâmica + botão "Abrir app" sempre visível
body.innerHTML='';
body.appendChild(dynamicWrap);
body.appendChild(montarBotaoAbrirAppFixo());
body.appendChild(montarBlocoWhatsApp());

var AVISO_SEM_PROPOSTA='<p class="status">Abra uma <b>proposta comercial</b> no Bling para usar Cotação de Frete, Cotação avulsa e Check Proposta.</p>';

chrome.tabs.query({active:true,currentWindow:true},function(tabs){
  var tab=tabs[0];
  var url=(tab&&tab.url)||'';
  // Só libera os botões na tela de proposta (orcamentos.php#edit/... ou #add)
  if(url.indexOf('bling.com.br')===-1||url.indexOf('orcamentos.php')===-1||!/#(edit|add)/.test(url)){
    dynamicWrap.innerHTML=AVISO_SEM_PROPOSTA;
    return;
  }
  chrome.tabs.sendMessage(tab.id,{action:'getDados'},function(dados){
    if(chrome.runtime.lastError||!dados){
      dynamicWrap.innerHTML='<div class="erro">⚠️ Recarregue a página do Bling (F5) e tente novamente.</div>';
      return;
    }
    if(!dados.emProposta){dynamicWrap.innerHTML=AVISO_SEM_PROPOSTA;return;}
    mostrarProposta(tab.id,dados);
  });
});


// ====================== WHATSAPP (só nos computadores escolhidos) ======================
function montarBlocoWhatsApp(){
  var d=document.createElement('div');
  d.style.cssText='margin-top:6px;border-top:1px solid #eee;padding-top:8px;font-size:11.5px;color:#555';
  d.innerHTML='<div id="waAlertas"></div><div id="waSyncBox"><div style="display:flex;gap:6px;align-items:center">💬 WhatsApp: <b style="color:#15803d">sincronização automática</b></div>'+
    '<div id="waInfo" style="color:#888;margin:4px 0 0 20px"></div>'+
    '</div>';
  setTimeout(function(){
    var info=document.getElementById('waInfo');
    function mostrar(c){
      var rec=c.waUltima&&Date.now()-c.waUltima<30*60000;
      info.textContent=c.waUltima?(rec?'✅ ':'⚠️ ')+'Última: '+new Date(c.waUltima).toLocaleString('pt-BR')+' · '+(c.waUltimaQtd||0)+' conversas'+(rec?'':' — deixe o WhatsApp Web aberto e logado'):'Sincroniza sozinho sempre que o WhatsApp Web estiver aberto neste computador.';
    }
    chrome.storage.local.get(['waSync','waUltima','waUltimaQtd'],mostrar);
    chrome.storage.local.get(['waAlertas','waAguardo'],function(c){
      var l=c.waAlertas||[],a=c.waAguardo||[],box=document.getElementById('waAlertas');if((!l.length&&!a.length)||!box)return;
      var esc=function(t){return String(t).replace(/[&<>"]/g,function(x){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[x];});};
      var fone=function(p){var x=String(p).replace(/^55/,'');return x.length>=10?'('+x.slice(0,2)+') '+x.slice(2,-4)+'-'+x.slice(-4):p;};
      var min=function(d){var m=Math.max(1,Math.round((Date.now()-d)/60000));return m<60?m+' min':Math.floor(m/60)+'h'+(m%60?String(m%60).padStart(2,'0'):'');};
      var cp=function(x,cor,borda){return '<span class="waCopiar" data-n="'+esc(String(x.p).replace(/^55/,''))+'" title="Clique para copiar" style="cursor:pointer;background:'+cor+';border:1px dashed '+borda+';border-radius:5px;padding:1px 6px;font-weight:700">📋 '+esc(fone(x.p))+'</span>';};
      var h='';
      if(l.length)h+='<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:7px 9px;margin-bottom:8px;color:#b91c1c">'+
        '<b>🚨 ATENÇÃO! Atenda o(s) cliente(s):</b>'+l.slice(0,8).map(function(x){return '<div style="margin-top:4px">• <b>'+esc(x.n||'(sem nome)')+'</b><br>'+cp(x,'#fee2e2','#f87171')+' <span style="color:#991b1b">'+(x.sr===false?'há '+min(x.desde)+' SEM ETIQUETA!':'há '+min(x.desde)+' sem atendimento!'+(x.se?' (e sem etiqueta)':''))+'</span></div>';}).join('')+
        (l.length>8?'<div style="margin-top:3px">+ '+(l.length-8)+' outro(s)</div>':'')+'</div>';
      if(a.length)h+='<div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:7px 9px;margin-bottom:8px;color:#713f12">'+
        '<b>⏳ Cliente(s) aguardando sua resposta:</b>'+a.slice(0,8).map(function(x){return '<div style="margin-top:4px">• <b>'+esc(x.n||'(sem nome)')+'</b><br>'+cp(x,'#fef08a','#ca8a04')+' <span>aguarda resposta há '+min(x.desde)+'</span></div>';}).join('')+
        (a.length>8?'<div style="margin-top:3px">+ '+(a.length-8)+' outro(s)</div>':'')+'</div>';
      box.innerHTML=h+'<div style="font-size:10.5px;color:#888;margin:-4px 0 8px">Clique no número para copiar e buscar no WhatsApp</div>';
      box.querySelectorAll('.waCopiar').forEach(function(sp){sp.onclick=function(){var n=sp.getAttribute('data-n');navigator.clipboard.writeText(n).then(function(){var t=sp.innerHTML;sp.innerHTML='✅ Copiado!';setTimeout(function(){sp.innerHTML=t;},1500);});};});
    });
  },0);
  return d;
}


// ====================== BOTÕES QUE CADA PESSOA VÊ (configurado pelo administrador no app) ======================
var FB_POP='https://maisacessivel-1d0ad-default-rtdb.firebaseio.com';
var BOTOES_CSS={frete:'#btnImp,#btnSeguir',avulsa:'#btnImpAvulsa',check:'#btnCheck',app:'#btnAbrirAppFixo',whats:'#waSyncBox'};
function aplicarBotoes(cfg,usuario,role,waSync){
  var o={};
  if(role!=='admin'&&cfg){o=(cfg.usuarios&&usuario&&cfg.usuarios[usuario])||cfg.padrao||{};}
  // computador que já sincroniza o WhatsApp sempre mostra a opção (para poder ver/desligar)
  var esconder=Object.keys(BOTOES_CSS).filter(function(k){return o[k]===false&&!(k==='whats'&&waSync);}).map(function(k){return BOTOES_CSS[k];});
  // sem login do app neste computador: avisa (os botões seguem o "Padrão" das Configurações)
  var av=document.getElementById('avisoLogin');
  if(!usuario){
    if(!av){av=document.createElement('div');av.id='avisoLogin';av.style.cssText='margin:0 0 8px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:7px 9px;font-size:11.5px;color:#1e3a8a';
      av.innerHTML='👤 Abra o <b>app</b> neste computador e entre com <b>seu login</b> para liberar os seus botões (inclusive o do WhatsApp). Depois feche e abra este popup.';
      var b=document.querySelector('.body')||document.body;b.insertBefore(av,b.firstChild);}
  }else if(av)av.remove();
  var st=document.getElementById('permBotoes');
  if(!st){st=document.createElement('style');st.id='permBotoes';document.head.appendChild(st);}
  st.textContent=esconder.length?esconder.join(',')+'{display:none!important}':'';
}
chrome.storage.local.get(['appUsuario','appRole','extBotoesCache','waSync'],function(c){
  aplicarBotoes(c.extBotoesCache||null,c.appUsuario,c.appRole,c.waSync);
  fetch(FB_POP+'/extBotoes.json').then(function(r){return r.ok?r.json():null;}).then(function(cfg){
    chrome.storage.local.set({extBotoesCache:cfg||null});
    aplicarBotoes(cfg,c.appUsuario,c.appRole,c.waSync);
  }).catch(function(){});
});
