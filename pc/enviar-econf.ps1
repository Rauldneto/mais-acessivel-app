# JDFER - ENVIAR ECONF (evento 110750 - Conciliacao Financeira da NF-e)
# Informa a Sefaz os PIX recebidos que ja estao vinculados a NF-e emitidas (TEF Goias - IN 1.608/2025).
# - A lista vem do servidor do app (aba Financeiro > BLING).
# - Assina com o certificado A1 da JDFER instalado neste Windows (a chave nao sai do computador).
# - Envia para a SVRS (quem recebe o ECONF de NF-e modelo 55 de todos os estados).
# - Guarda o protocolo no servidor para nunca enviar o mesmo PIX duas vezes.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security
$pasta = $PSScriptRoot
$CNPJ = '35017646000166'
$UF = 'GO'
$SERVIDOR = 'https://bling.rauldias.workers.dev'
$ORIGEM = 'https://rauldneto.github.io'
$URL = @{ teste = 'https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx'; producao = 'https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx' }
$NS = 'http://www.portalfiscal.inf.br/nfe'
$WSDL = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4'
try { Stop-Transcript | Out-Null } catch {}
Start-Transcript -Path (Join-Path $pasta 'log-econf.txt') -Append | Out-Null
function Pausa($m) { Write-Host ''; Read-Host $m | Out-Null }

Write-Host '=============================================='
Write-Host ' JDFER - ECONF (PIX vinculado a NF-e) - Sefaz'
Write-Host '=============================================='

# ---------- certificado ----------
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.HasPrivateKey -and $_.Subject -match $CNPJ -and $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) { Write-Host 'Certificado A1 da JDFER nao encontrado neste Windows.' -ForegroundColor Red; Pausa 'Enter para fechar'; exit 1 }
Write-Host "Certificado: valido ate $($cert.NotAfter.ToString('dd/MM/yyyy'))"

# ---------- ambiente ----------
Write-Host ''
Write-Host '  [1] TESTE (homologacao) - confere assinatura e formato, nao vale nada'
Write-Host '  [2] PRODUCAO - envio de verdade para a Sefaz'
$amb = (Read-Host 'Escolha 1 ou 2').Trim()
$ambiente = if ($amb -eq '2') { 'producao' } else { 'teste' }
$tpAmb = if ($ambiente -eq 'producao') { '1' } else { '2' }
Write-Host "Ambiente: $($ambiente.ToUpper())" -ForegroundColor $(if ($ambiente -eq 'producao') { 'Yellow' } else { 'Cyan' })

# ---------- lista do servidor ----------
Write-Host ''
Write-Host 'Buscando os PIX vinculados a notas no servidor do app...'
$lista = Invoke-RestMethod -Uri "$SERVIDOR/econf/pendentes" -Headers @{ Origin = $ORIGEM } -TimeoutSec 120
if (-not $lista.ok) { Write-Host "Servidor respondeu erro: $($lista.erro)" -ForegroundColor Red; Pausa 'Enter para fechar'; exit 1 }
$itens = @($lista.itens)
$prontos = @($itens | Where-Object { $_.status -eq 'pronto' })
$semNF = @($itens | Where-Object { $_.status -eq 'aguardando_nf' })
$outros = @($itens | Where-Object { $_.status -ne 'pronto' -and $_.status -ne 'aguardando_nf' })

Write-Host ''
Write-Host "PRONTOS PARA ENVIAR: $($prontos.Count)" -ForegroundColor Green
$i = 0
foreach ($p in $prontos) {
    $i++
    $quando = if ($p.momento -eq 'anterior') { 'pago ANTES da NF' } else { 'pago depois da NF' }
    Write-Host ("  {0,2}) NF {1,-7} R$ {2,10:N2}  pago {3}  {4}  ({5})" -f $i, $p.nf.numero, [double]$p.valor, ([datetime]$p.dia).ToString('dd/MM/yyyy'), $p.pagador, $quando)
    if ($p.obs) { Write-Host "      obs: $($p.obs)" -ForegroundColor DarkGray }
}
if ($semNF.Count) {
    Write-Host ''
    Write-Host "AGUARDANDO A NOTA SER EMITIDA (pedido pago antes): $($semNF.Count)" -ForegroundColor DarkYellow
    foreach ($p in $semNF) { Write-Host ("      Pedido {0}  R$ {1:N2}  pago {2}  {3}" -f $p.docId, [double]$p.valor, ([datetime]$p.dia).ToString('dd/MM/yyyy'), $p.pagador) }
}
if ($outros.Count) {
    Write-Host ''
    Write-Host "COM PROBLEMA (conferir no Bling): $($outros.Count)" -ForegroundColor Red
    foreach ($p in $outros) { Write-Host ("      {0} {1}  R$ {2:N2}  {3}  {4}" -f $p.tipo, $p.docId, [double]$p.valor, $p.status, $p.erro) }
}
if ($lista.faltaram) { Write-Host "(Mais $($lista.faltaram) ficaram para a proxima rodada - limite de consultas ao Bling.)" -ForegroundColor DarkGray }
if (-not $prontos.Count) { Pausa 'Nada para enviar agora. Enter para fechar'; Stop-Transcript | Out-Null; exit 0 }

Write-Host ''
$ok = (Read-Host "Enviar os $($prontos.Count) ECONF em $($ambiente.ToUpper())? (S/N)").Trim().ToUpper()
if ($ok -ne 'S') { Write-Host 'Cancelado.'; Stop-Transcript | Out-Null; exit 0 }

# ---------- monta, assina e envia ----------
function Assinar([xml]$doc, $idRef) {
    $sx = New-Object System.Security.Cryptography.Xml.SignedXml($doc)
    $sx.SigningKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
    $sx.SignedInfo.CanonicalizationMethod = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
    $sx.SignedInfo.SignatureMethod = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
    $ref = New-Object System.Security.Cryptography.Xml.Reference("#$idRef")
    $ref.DigestMethod = 'http://www.w3.org/2000/09/xmldsig#sha1'
    $ref.AddTransform((New-Object System.Security.Cryptography.Xml.XmlDsigEnvelopedSignatureTransform))
    $ref.AddTransform((New-Object System.Security.Cryptography.Xml.XmlDsigC14NTransform))
    $sx.AddReference($ref)
    $ki = New-Object System.Security.Cryptography.Xml.KeyInfo
    $ki.AddClause((New-Object System.Security.Cryptography.Xml.KeyInfoX509Data($cert)))
    $sx.KeyInfo = $ki
    $sx.ComputeSignature()
    [void]$doc.DocumentElement.AppendChild($doc.ImportNode($sx.GetXml(), $true))
    return $doc
}

function Enviar($envEvento) {
    $soap = '<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>' +
            "<nfeDadosMsg xmlns=""$WSDL"">$envEvento</nfeDadosMsg></soap12:Body></soap12:Envelope>"
    $req = [System.Net.HttpWebRequest]::Create($URL[$ambiente])
    $req.Method = 'POST'
    $req.ContentType = "application/soap+xml; charset=utf-8; action=""$WSDL/nfeRecepcaoEvento"""
    [void]$req.ClientCertificates.Add($cert)
    $b = [Text.Encoding]::UTF8.GetBytes($soap); $req.ContentLength = $b.Length
    $s = $req.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close()
    try { $res = $req.GetResponse() } catch [System.Net.WebException] { $res = $_.Exception.Response; if (-not $res) { throw } }
    $sr = New-Object IO.StreamReader($res.GetResponseStream()); $t = $sr.ReadToEnd(); $sr.Close()
    return $t
}

$enviados = 0; $falhas = 0
$saida = Join-Path $pasta 'econf-enviados'
if (-not (Test-Path $saida)) { New-Item -ItemType Directory -Path $saida | Out-Null }
foreach ($p in $prontos) {
    $chave = $p.nf.chave
    $seq = [int]$p.nSeq; if ($seq -lt 1) { $seq = 1 }
    $id = 'ID110750' + $chave + $seq.ToString('00')
    $dh = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss') + '-03:00'
    $vPag = ([double]$p.valor).ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
    $xmlEv = "<evento xmlns=""$NS"" versao=""1.00""><infEvento Id=""$id""><cOrgao>92</cOrgao><tpAmb>$tpAmb</tpAmb><CNPJ>$CNPJ</CNPJ><chNFe>$chave</chNFe>" +
             "<dhEvento>$dh</dhEvento><tpEvento>110750</tpEvento><nSeqEvento>$seq</nSeqEvento><verEvento>1.00</verEvento>" +
             "<detEvento versao=""1.00""><descEvento>ECONF</descEvento><verAplic>MaisAcessivel-1.0</verAplic>" +
             "<detPag><indPag>0</indPag><tPag>$($p.tPag)</tPag><vPag>$vPag</vPag><dPag>$($p.dia)</dPag>" +
             "<CNPJPag>$CNPJ</CNPJPag><UFPag>$UF</UFPag><CNPJIF>$($lista.cnpjIF)</CNPJIF><cAut>$($p.e2e)</cAut>" +
             "<CNPJReceb>$CNPJ</CNPJReceb><UFReceb>$UF</UFReceb></detPag></detEvento></infEvento></evento>"
    $doc = New-Object System.Xml.XmlDocument
    $doc.PreserveWhitespace = $false
    $doc.LoadXml($xmlEv)
    $doc = Assinar $doc $id
    $lote = (Get-Date -Format 'yyyyMMddHHmmss') + (Get-Random -Minimum 0 -Maximum 9)
    $env = "<envEvento xmlns=""$NS"" versao=""1.00""><idLote>$lote</idLote>" + $doc.DocumentElement.OuterXml + '</envEvento>'
    Write-Host ''
    Write-Host ("Enviando NF {0} - R$ {1} ..." -f $p.nf.numero, $vPag)
    try { $resp = Enviar $env } catch { Write-Host "  Falhou a conexao: $($_.Exception.Message)" -ForegroundColor Red; $falhas++; continue }
    $cStat = ''; $xMotivo = ''; $nProt = ''
    try {
        [xml]$rx = $resp
        $ns = New-Object System.Xml.XmlNamespaceManager($rx.NameTable); $ns.AddNamespace('n', $NS)
        $ie = $rx.SelectSingleNode('//n:retEvento/n:infEvento', $ns)
        if (-not $ie) { $ie = $rx.SelectSingleNode('//n:retEnvEvento', $ns) }
        $cStat = $ie.SelectSingleNode('n:cStat', $ns).InnerText
        $xMotivo = $ie.SelectSingleNode('n:xMotivo', $ns).InnerText
        $np = $ie.SelectSingleNode('n:nProt', $ns); if ($np) { $nProt = $np.InnerText }
    } catch { $xMotivo = 'Resposta inesperada: ' + ($resp -replace '<[^>]+>', ' ' -replace '\s+', ' ').Trim().Substring(0, [Math]::Min(200, $resp.Length)) }
    $cor = if ($cStat -in '135', '136') { 'Green' } elseif ($cStat -eq '573') { 'Yellow' } else { 'Red' }
    Write-Host "  Sefaz: $cStat - $xMotivo $(if ($nProt) { "(protocolo $nProt)" })" -ForegroundColor $cor
    # guarda o XML enviado e a resposta (arquivo fiscal)
    $nome = "{0}_{1}_NF{2}_seq{3}_{4}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $ambiente, $p.nf.numero, $seq, $cStat
    Set-Content -Path (Join-Path $saida "$nome-envio.xml") -Value $env -Encoding UTF8
    Set-Content -Path (Join-Path $saida "$nome-retorno.xml") -Value $resp -Encoding UTF8
    if ($cStat -in '135', '136', '573') { $enviados++ } else { $falhas++ }
    try {
        $corpo = @{ e2e = $p.e2e; chave = $chave; nSeq = $seq; ambiente = $ambiente; cStat = $cStat; xMotivo = $xMotivo; nProt = $nProt; valor = [double]$p.valor } | ConvertTo-Json
        [void](Invoke-RestMethod -Method Post -Uri "$SERVIDOR/econf/registrar" -Headers @{ Origin = $ORIGEM } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($corpo)))
    } catch { Write-Host "  (nao consegui avisar o servidor: $($_.Exception.Message))" -ForegroundColor DarkYellow }
}

Write-Host ''
Write-Host "FIM: $enviados aceito(s), $falhas com problema. XMLs guardados em: $saida" -ForegroundColor $(if ($falhas) { 'Yellow' } else { 'Green' })
if ($ambiente -eq 'teste') { Write-Host 'Era TESTE: nada foi registrado de verdade. Mande o resultado para o Claude.' -ForegroundColor Cyan }
Stop-Transcript | Out-Null
Pausa 'Aperte Enter para fechar'
