// Cloudflare Worker: "email-contabilidade"
// Envia os e-mails do app (despesas e fretes) para a contabilidade pela SUA caixa da Locaweb (rauldias@tendfer.com.br), via SMTP.
// A senha do e-mail fica SÓ aqui, como segredo (Settings → Variables and Secrets). Nunca no app.
//   SMTP_USER  = rauldias@tendfer.com.br
//   SMTP_PASS  = (senha do e-mail)            ← tipo "Secret"
//   DESTINOS   = contabil@apoiocontabilidadenc.com.br   (só envia para estes; separe por vírgula. Evita uso indevido.)
//   COPIA_PARA_MIM = sim   (opcional: manda cópia oculta para o próprio SMTP_USER, para ficar registrado na sua caixa)
//   SMTP_HOST / SMTP_PORT  (opcional; padrão Locaweb: email-ssl.com.br : 465 SSL)
// Uso: POST JSON {para:"a@b, c@d", cc:"", assunto:"...", html:"...", anexos:[{nome:"x.pdf", tipo:"application/pdf", b64:"..."}]}
// Resposta: {ok:true, de:"rauldias@tendfer.com.br"} ou {ok:false, erro:"..."}
import { connect } from 'cloudflare:sockets';

const ORIGENS = ['https://rauldneto.github.io'];

export default {
  async fetch(req, env) {
    const origem = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGENS.includes(origem) ? origem : ORIGENS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8',
    };
    const resp = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: cors });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (origem && !ORIGENS.includes(origem)) return resp({ ok: false, erro: 'origem não permitida' }, 403);
    if (req.method === 'GET') return resp({ ok: true, pronto: !!(env.SMTP_USER && env.SMTP_PASS && env.DESTINOS), de: env.SMTP_USER || '' });
    if (req.method !== 'POST') return resp({ ok: false, erro: 'use POST' }, 405);
    if (!env.SMTP_USER || !env.SMTP_PASS) return resp({ ok: false, erro: 'SMTP_USER/SMTP_PASS não configurados no Worker' }, 500);

    let d; try { d = await req.json(); } catch (e) { return resp({ ok: false, erro: 'JSON inválido' }, 400); }
    const lista = s => String(s || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    const permitidos = lista(env.DESTINOS);
    const para = lista(d.para), cc = lista(d.cc);
    if (!para.length) return resp({ ok: false, erro: 'sem destinatário' }, 400);
    const fora = para.concat(cc).filter(x => !permitidos.includes(x));
    if (fora.length) return resp({ ok: false, erro: 'Destinatário não autorizado no Worker: ' + fora.join(', ') + ' (inclua em DESTINOS)' }, 403);
    const bcc = /^s/i.test(env.COPIA_PARA_MIM || '') ? [env.SMTP_USER.toLowerCase()] : [];
    const anexos = Array.isArray(d.anexos) ? d.anexos : [];
    const tam = anexos.reduce((t, a) => t + String(a.b64 || '').length * 0.75, 0);
    if (tam > 15e6) return resp({ ok: false, erro: 'anexos passam de 15 MB' }, 413);

    try {
      await enviarSmtp(env, { de: env.SMTP_USER, para, cc, bcc, assunto: String(d.assunto || '(sem assunto)'), html: String(d.html || ''), anexos });
      return resp({ ok: true, de: env.SMTP_USER, para: para.join(', ') });
    } catch (e) {
      return resp({ ok: false, erro: String(e.message || e) }, 502);
    }
  },
};

// ---------- SMTP ----------
function b64utf8(s) { const b = new TextEncoder().encode(s); let x = ''; for (let i = 0; i < b.length; i++) x += String.fromCharCode(b[i]); return btoa(x); }
function cab(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64utf8(s) + '?='; }
function quebrar(b64) { return String(b64).replace(/\s+/g, '').replace(/(.{76})/g, '$1\r\n'); }
function montarMime(m) {
  const fr = 'maf' + crypto.randomUUID().replace(/-/g, '');
  const dom = m.de.split('@')[1] || 'localhost';
  const h = [
    'From: ' + cab('Mais Acessível') + ' <' + m.de + '>',
    'To: ' + m.para.join(', '),
    m.cc.length ? 'Cc: ' + m.cc.join(', ') : '',
    'Subject: ' + cab(m.assunto),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + crypto.randomUUID() + '@' + dom + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + fr + '"',
  ].filter(Boolean);
  let corpo = '--' + fr + '\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + quebrar(b64utf8(m.html)) + '\r\n';
  m.anexos.forEach(a => {
    const nome = String(a.nome || 'anexo.pdf').replace(/["\r\n]/g, '');
    corpo += '--' + fr + '\r\nContent-Type: ' + (a.tipo || 'application/octet-stream') + '; name="' + cab(nome) + '"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="' + cab(nome) + '"\r\n\r\n' + quebrar(a.b64) + '\r\n';
  });
  corpo += '--' + fr + '--\r\n';
  return h.join('\r\n') + '\r\n\r\n' + corpo;
}

async function enviarSmtp(env, m) {
  const host = env.SMTP_HOST || 'email-ssl.com.br', port = Number(env.SMTP_PORT || 465);
  const sock = connect({ hostname: host, port }, { secureTransport: env.SMTP_TLS === 'off' ? 'off' : 'on', allowHalfOpen: false });
  const w = sock.writable.getWriter(), r = sock.readable.getReader(), dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '';
  async function resposta() {
    // lê até a última linha da resposta ("250 ..." e não "250-...")
    const limite = Date.now() + 30000;
    for (;;) {
      const linhas = buf.split('\r\n');
      for (let i = 0; i < linhas.length - 1; i++) {
        if (/^\d{3} /.test(linhas[i]) || /^\d{3}$/.test(linhas[i])) { const txt = linhas.slice(0, i + 1).join('\n'); buf = linhas.slice(i + 1).join('\r\n'); return { cod: Number(linhas[i].slice(0, 3)), txt }; }
      }
      if (Date.now() > limite) throw new Error('o servidor de e-mail não respondeu');
      const { value, done } = await r.read();
      if (done) throw new Error('o servidor de e-mail fechou a conexão');
      buf += dec.decode(value, { stream: true });
    }
  }
  async function cmd(linha, esperado, rotulo) {
    if (linha !== null) await w.write(enc.encode(linha + '\r\n'));
    const x = await resposta();
    if (!esperado.includes(x.cod)) throw new Error((rotulo || linha.split(' ')[0]) + ' recusado: ' + x.txt.replace(/\s+/g, ' ').slice(0, 200));
    return x;
  }
  try {
    await cmd(null, [220], 'conexão');
    await cmd('EHLO app.maisacessivel', [250]);
    await cmd('AUTH LOGIN', [334]);
    await cmd(b64utf8(env.SMTP_USER), [334], 'usuário');
    await cmd(b64utf8(env.SMTP_PASS), [235], 'senha (confira SMTP_USER/SMTP_PASS)');
    await cmd('MAIL FROM:<' + m.de + '>', [250]);
    for (const x of m.para.concat(m.cc, m.bcc)) await cmd('RCPT TO:<' + x + '>', [250, 251]);
    await cmd('DATA', [354]);
    const dados = montarMime(m).replace(/\r\n\./g, '\r\n..');
    await w.write(enc.encode(dados + '\r\n.\r\n'));
    await cmd(null, [250], 'envio');
    try { await w.write(enc.encode('QUIT\r\n')); } catch (e) {}
  } finally {
    try { await sock.close(); } catch (e) {}
  }
}
