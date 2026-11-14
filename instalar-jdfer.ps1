# ============================================================
# Mais Acessível — Instalação JDFER (CENPROT + Firewall)
# Versão 1.0 — 2026-11-14
# ============================================================
# USO: em cada máquina, PowerShell COMO ADMINISTRADOR, cole:
#   iwr -useb https://rauldneto.github.io/mais-acessivel-app/instalar-jdfer.ps1 | iex
#
# O script faz:
#  1. Localiza o .pfx no pen drive (E:\JDFER\certificado.pfx ou variações)
#  2. Pede a senha do certificado
#  3. Instala o certificado com NonExportable + MachineKeyNo (proteção forte)
#  4. Força o Chrome a instalar a extensão Mais Acessível 2.4.0
#  5. Registra a máquina no Firebase para você monitorar
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host " Mais Acessível — Instalação JDFER (CENPROT + Firewall)" -ForegroundColor Cyan
Write-Host " Máquina: $env:COMPUTERNAME | Usuário Windows: $env:USERNAME" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

# -----------------------------------------------------------
# 0. Verifica se está rodando como admin
# -----------------------------------------------------------
$prp = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $prp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "❌ ERRO: Este script precisa ser executado como ADMINISTRADOR." -ForegroundColor Red
    Write-Host "   Feche esta janela e abra o PowerShell com botão direito > 'Executar como administrador'." -ForegroundColor Yellow
    Read-Host "Pressione ENTER para sair"
    exit 1
}

# -----------------------------------------------------------
# 1. Localiza o .pfx em pen drives
# -----------------------------------------------------------
Write-Host "[1/5] Procurando certificado no pen drive..." -ForegroundColor Green
$pfxPath = $null
$candidatosNome = @("certificado.pfx", "jdfer.pfx", "e-cnpj.pfx", "ecnpj.pfx")

# Varre todas as unidades removíveis (D:, E:, F:, etc.)
$drives = Get-WmiObject Win32_LogicalDisk -Filter "DriveType=2" | Select-Object -ExpandProperty DeviceID
if (-not $drives) {
    # Também tenta discos fixos, caso o pen drive seja reconhecido como fixo
    $drives = Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" | Where-Object { $_.DeviceID -ne "C:" } | Select-Object -ExpandProperty DeviceID
}

foreach ($d in $drives) {
    foreach ($nome in $candidatosNome) {
        $p = Join-Path $d "JDFER\$nome"
        if (Test-Path $p) { $pfxPath = $p; break }
        $p2 = Join-Path $d $nome
        if (Test-Path $p2) { $pfxPath = $p2; break }
    }
    if ($pfxPath) { break }
}

# Fallback: busca qualquer .pfx em pastas JDFER
if (-not $pfxPath) {
    foreach ($d in $drives) {
        $busca = Get-ChildItem -Path "$d\JDFER" -Filter "*.pfx" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($busca) { $pfxPath = $busca.FullName; break }
    }
}

if (-not $pfxPath) {
    Write-Host "❌ Não encontrei .pfx nos pen drives." -ForegroundColor Red
    Write-Host "   Confira: pen drive plugado? Tem a pasta JDFER com o .pfx dentro?" -ForegroundColor Yellow
    $pfxManual = Read-Host "Cole aqui o caminho completo do .pfx (ou ENTER para cancelar)"
    if (-not $pfxManual -or -not (Test-Path $pfxManual)) {
        Write-Host "Cancelado." -ForegroundColor Yellow
        exit 1
    }
    $pfxPath = $pfxManual
}
Write-Host "   ✅ Certificado localizado: $pfxPath" -ForegroundColor Gray

# -----------------------------------------------------------
# 2. Senha do certificado
# -----------------------------------------------------------
Write-Host ""
Write-Host "[2/5] Senha do certificado (digitação oculta):" -ForegroundColor Green
$senha = Read-Host "   Senha" -AsSecureString
if (-not $senha -or $senha.Length -eq 0) {
    Write-Host "❌ Senha vazia. Cancelado." -ForegroundColor Red
    exit 1
}

# -----------------------------------------------------------
# 3. Instala o certificado (NonExportable + proteção forte)
# -----------------------------------------------------------
Write-Host ""
Write-Host "[3/5] Instalando certificado com NonExportable + proteção forte..." -ForegroundColor Green
try {
    # NonExportable: a chave não pode ser copiada para fora
    # MachineKeyNo + UserKeySet: fica no perfil do usuário atual (não no computador todo)
    # Persistent: chave persiste entre reboots
    $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet -bor `
             [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet
    # Obs: NonExportable é o padrão quando não se marca Exportable, então basta NÃO marcar Exportable.

    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfxPath, $senha, $flags)
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("My", "CurrentUser")
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $store.Add($cert)
    $store.Close()
    Write-Host "   ✅ Certificado instalado: $($cert.Subject)" -ForegroundColor Gray
    Write-Host "   📅 Validade: $($cert.NotAfter.ToString('dd/MM/yyyy'))" -ForegroundColor Gray
    $certSubject = $cert.Subject
    $certThumb = $cert.Thumbprint
    $certNotAfter = $cert.NotAfter.ToString('yyyy-MM-dd')
} catch {
    Write-Host "❌ Erro ao instalar certificado: $_" -ForegroundColor Red
    Write-Host "   Verifique se a senha está correta." -ForegroundColor Yellow
    exit 1
}

# -----------------------------------------------------------
# 4. Força instalação da extensão Chrome
# -----------------------------------------------------------
Write-Host ""
Write-Host "[4/5] Configurando Chrome para instalar a extensão Mais Acessível 2.4.0..." -ForegroundColor Green
try {
    $extId = "ojhkakepmgbmhnfoabkmmjbpilmhhmpj"
    $updateUrl = "https://clients2.google.com/service/update2/crx"
    $regPath = "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"

    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }

    # Procura primeiro índice livre
    $existentes = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
    $idx = 1
    while ($existentes.PSObject.Properties.Name -contains "$idx") {
        $valorExistente = (Get-ItemProperty -Path $regPath -Name "$idx").$idx
        if ($valorExistente -like "$extId*") {
            Write-Host "   ℹ️  Extensão já está forçada (índice $idx)." -ForegroundColor Gray
            $idx = -1
            break
        }
        $idx++
    }
    if ($idx -gt 0) {
        Set-ItemProperty -Path $regPath -Name "$idx" -Value "$extId;$updateUrl"
        Write-Host "   ✅ Extensão $extId forçada (índice $idx)." -ForegroundColor Gray
    }

    # Reinicia o Chrome (se estiver aberto) pra aplicar
    $chromeAberto = Get-Process chrome -ErrorAction SilentlyContinue
    if ($chromeAberto) {
        Write-Host "   🔄 Reiniciando Chrome para aplicar a extensão..." -ForegroundColor Yellow
        Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Start-Process "chrome.exe"
    }
    Write-Host "   ✅ Chrome configurado (extensão será instalada na próxima abertura)." -ForegroundColor Gray
} catch {
    Write-Host "⚠️  Erro ao configurar extensão: $_" -ForegroundColor Yellow
    Write-Host "   Continuando mesmo assim..." -ForegroundColor Yellow
}

# -----------------------------------------------------------
# 5. Registra a máquina no Firebase
# -----------------------------------------------------------
Write-Host ""
Write-Host "[5/5] Registrando a máquina no sistema da Mais Acessível..." -ForegroundColor Green
try {
    $hostname = $env:COMPUTERNAME
    $usuarioWin = $env:USERNAME
    $payload = @{
        hostname = $hostname
        usuarioWindows = $usuarioWin
        certSubject = $certSubject
        certThumbprint = $certThumb
        certValidade = $certNotAfter
        extensaoVersao = "2.4.0"
        instaladoEm = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
        instaladoPorScript = "instalar-jdfer.ps1 v1.0"
        lastSeen = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
        usuario = $usuarioWin
    } | ConvertTo-Json -Compress

    $url = "https://maisacessivel-1d0ad-default-rtdb.firebaseio.com/firewall/maquinas/$([uri]::EscapeDataString($hostname)).json"
    Invoke-RestMethod -Uri $url -Method Patch -Body $payload -ContentType "application/json" -TimeoutSec 15 | Out-Null
    Write-Host "   ✅ Máquina registrada como: $hostname" -ForegroundColor Gray
} catch {
    Write-Host "⚠️  Erro ao registrar no Firebase: $_" -ForegroundColor Yellow
    Write-Host "   A instalação local funcionou, mas o Raul precisa confirmar manualmente." -ForegroundColor Yellow
}

# -----------------------------------------------------------
# Fim
# -----------------------------------------------------------
Write-Host ""
Write-Host "==============================================================" -ForegroundColor Green
Write-Host " ✅ INSTALAÇÃO CONCLUÍDA" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Próximos passos (feitos pelo Raul no app):" -ForegroundColor Cyan
Write-Host "  1. Abrir o CENPROT uma vez nesta máquina e fazer login com o certificado" -ForegroundColor Gray
Write-Host "     (O popup 'Selecione um certificado' vai aparecer — escolha JDFER)" -ForegroundColor Gray
Write-Host "  2. Testar consulta automática pelo app Mais Acessível (Vendas > Modelo em Teste)" -ForegroundColor Gray
Write-Host "  3. Raul aplica o perfil de firewall remotamente" -ForegroundColor Gray
Write-Host ""
Write-Host "Pode retirar o pen drive e ir para a próxima máquina." -ForegroundColor Yellow
Write-Host ""
Read-Host "Pressione ENTER para fechar"
