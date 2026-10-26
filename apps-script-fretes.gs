/**
 * Mais Acessível — envio dos fretes para a contabilidade
 * -------------------------------------------------------
 * Recebe do app (aba Lançamento de frete) as imagens recortadas do CT-e e os dados do lançamento,
 * anexa o PDF original (ou monta um PDF com as fotos), envia por e-mail para a contabilidade e guarda uma cópia no Google Drive
 * (pasta "Fretes - Contabilidade", com uma subpasta por mês).
 *
 * COMO INSTALAR (uma vez só, uns 5 minutos):
 *  1. Entre em https://script.google.com com a conta da empresa (rauldias@tendfer.com.br) → "Novo projeto".
 *  2. Apague o que vier escrito e cole este arquivo inteiro.
 *  3. Preencha DESTINO (e-mail da contabilidade) e CHAVE (uma senha qualquer, sem espaços) logo abaixo.
 *  4. Salve (ícone de disquete). No menu de funções, escolha "autorizar" e clique em Executar.
 *     O Google vai pedir permissão para Gmail, Drive e Documentos: permita.
 *  5. Implantar → Nova implantação → engrenagem → "App da Web".
 *     Executar como: "Eu".  Quem pode acessar: "Qualquer pessoa".  → Implantar.
 *  6. Copie o "URL do app da Web" (termina em /exec).
 *  7. No app: Financeiro → Lançamento de frete → Configurações → Envio à contabilidade → cole o URL e a mesma CHAVE → Salvar envio → Enviar e-mail de teste.
 *
 * Se mudar este código depois: Implantar → Gerenciar implantações → lápis → Versão: "Nova versão" → Implantar
 * (assim o URL continua o mesmo).
 */

const DESTINO = 'contabilidade@exemplo.com.br'; // e-mail da contabilidade (pode pôr mais de um separados por vírgula)
const COPIA = '';                               // opcional: alguém em cópia (ex.: o seu e-mail)
const CHAVE = 'TROQUE-ESTA-CHAVE';              // a mesma que vai no app
const PASTA = 'Fretes - Contabilidade';         // pasta no Google Drive
const REMETENTE_NOME = 'Mais Acessível - Fretes';

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents || '{}');
    if (!CHAVE || CHAVE === 'TROQUE-ESTA-CHAVE') return saida({ ok: false, erro: 'Defina a CHAVE no script do Google.' });
    if (p.token !== CHAVE) return saida({ ok: false, erro: 'Chave inválida: confira se é a mesma no app e no script.' });
    if (!DESTINO || /exemplo\.com/.test(DESTINO)) return saida({ ok: false, erro: 'Defina o e-mail da contabilidade (DESTINO) no script do Google.' });

    if (p.teste) {
      enviar('Teste — envio de fretes Mais Acessível',
        '<p>Este é um e-mail de teste do app Mais Acessível.</p><p>A partir de agora os documentos de frete chegam por aqui, com o PDF anexo.</p>',
        'E-mail de teste do app Mais Acessível.', []);
      return saida({ ok: true, para: DESTINO });
    }

    const fotos = (p.fotos || []).slice(0, 6);
    const pdfs = (p.pdfs || []).slice(0, 4);
    if (!fotos.length && !pdfs.length) return saida({ ok: false, erro: 'Nenhuma imagem ou PDF recebido.' });
    const nome = String(p.nome || 'Frete').replace(/[^\w\-]+/g, '-').slice(0, 90);

    // PDF original da transportadora vai como veio; fotos viram um PDF só
    let anexos = pdfs.map((x, i) => Utilities.newBlob(Utilities.base64Decode(x.b64), 'application/pdf', nome + (pdfs.length > 1 ? '_' + (i + 1) : '') + '.pdf'));
    if (fotos.length) {
      const nf = pdfs.length ? nome + '_fotos' : nome;
      try { anexos.push(montarPdf(fotos, nf)); }
      catch (err) { fotos.forEach((b, i) => anexos.push(Utilities.newBlob(Utilities.base64Decode(b), 'image/jpeg', nf + (fotos.length > 1 ? '_' + (i + 1) : '') + '.jpg'))); }
    }

    let link = '';
    try {
      const pasta = subpasta(PASTA, p.mes);
      anexos.forEach((a, i) => { const f = pasta.createFile(a.copyBlob().setName(a.getName())); if (!i) link = f.getUrl(); });
    } catch (err) { /* sem cópia no Drive, mas o e-mail segue */ }

    enviar(p.assunto || ('Frete ' + nome), p.html || '', p.texto || '', anexos);
    return saida({ ok: true, para: DESTINO, link: link });
  } catch (err) {
    return saida({ ok: false, erro: String(err && err.message || err) });
  }
}

function montarPdf(fotos, nome) {
  const doc = DocumentApp.create(nome);
  const body = doc.getBody();
  body.setPageWidth(595.28).setPageHeight(841.89);                       // A4
  body.setMarginTop(20).setMarginBottom(20).setMarginLeft(20).setMarginRight(20);
  const maxW = 555, maxH = 790;
  fotos.forEach((b, i) => {
    if (i > 0) body.appendPageBreak();
    const img = body.appendImage(Utilities.newBlob(Utilities.base64Decode(b), 'image/jpeg', 'img' + i + '.jpg'));
    const w = img.getWidth(), h = img.getHeight(), s = Math.min(maxW / w, maxH / h, 1);
    img.setWidth(Math.round(w * s)).setHeight(Math.round(h * s));
  });
  const primeiro = body.getChild(0);
  if (primeiro && primeiro.getType() === DocumentApp.ElementType.PARAGRAPH && !primeiro.asParagraph().getText() && primeiro.asParagraph().getNumChildren() === 0) {
    try { primeiro.removeFromParent(); } catch (e) {}
  }
  doc.saveAndClose();
  const arq = DriveApp.getFileById(doc.getId());
  const pdf = arq.getAs('application/pdf').setName(nome + '.pdf');
  arq.setTrashed(true);
  return pdf;
}

function enviar(assunto, html, texto, anexos) {
  const o = { to: DESTINO, subject: assunto, htmlBody: html, body: texto, name: REMETENTE_NOME };
  if (COPIA) o.cc = COPIA;
  if (anexos && anexos.length) o.attachments = anexos;
  MailApp.sendEmail(o);
}

function subpasta(nome, mes) {
  const it = DriveApp.getFoldersByName(nome);
  const raiz = it.hasNext() ? it.next() : DriveApp.createFolder(nome);
  if (!mes) return raiz;
  const s = raiz.getFoldersByName(mes);
  return s.hasNext() ? s.next() : raiz.createFolder(mes);
}

function saida(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Rode uma vez pelo editor para o Google pedir as permissões.
function autorizar() {
  DriveApp.getRootFolder();
  DocumentApp.create('teste-permissao').saveAndClose();
  const t = DriveApp.getFilesByName('teste-permissao'); while (t.hasNext()) t.next().setTrashed(true);
  Logger.log('E-mails que ainda dá para mandar hoje: ' + MailApp.getRemainingDailyQuota());
}
