# =====================================================================
#  HAPPY ALPHA - Instalador para Windows
#  Rode com: botão direito em INSTALAR.bat > Executar como administrador
# =====================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
function Titulo($t) { Write-Host "`n=== $t ===" -ForegroundColor Yellow }
function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Falha($t) { Write-Host "`nERRO: $t`n" -ForegroundColor Red; Read-Host 'Pressione Enter para sair'; exit 1 }

Write-Host "`n  HAPPY ALPHA - instalação do sistema`n" -ForegroundColor Cyan

# ---------- 1. Node.js ----------
Titulo 'Verificando o Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Falha 'Node.js não encontrado. Instale o Node.js 22 LTS (https://nodejs.org) e rode o instalador de novo.' }
$major = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { Falha "Node.js $(& node -v) é antigo. Instale o Node.js 22 LTS." }
Ok "Node.js $(& node -v)"

# Portas usadas pelo Happy Alpha (3010 sistema, 3011 demonstração)
$jaInstalado = Get-ScheduledTask -TaskName 'Happy Alpha' -ErrorAction SilentlyContinue
foreach ($porta in @(3010, 3011)) {
  $uso = Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue
  if ($uso -and -not $jaInstalado) { Falha "A porta $porta já está em uso por outro programa. Libere a porta ou peça ajuste no instalador." }
}
Ok 'Portas 3010 e 3011 livres'

# ---------- 2. PostgreSQL ----------
Titulo 'Verificando o PostgreSQL'
$pgDir = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
  Sort-Object { [int]($_.Name -replace '\D', '') } -Descending | Select-Object -First 1
if (-not $pgDir) { Falha 'PostgreSQL não encontrado em C:\Program Files\PostgreSQL. Instale o PostgreSQL 16 ou mais novo.' }
$pgBin = Join-Path $pgDir.FullName 'bin'
$psql = Join-Path $pgBin 'psql.exe'
Ok "PostgreSQL $($pgDir.Name)"

$sec = Read-Host 'Digite a senha do usuário "postgres" (a que você definiu ao instalar o PostgreSQL)' -AsSecureString
$pgPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$env:PGPASSWORD = $pgPass
& $psql -U postgres -h localhost -tAc 'SELECT 1' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Falha 'Não consegui entrar no PostgreSQL. Confira a senha e se o serviço do PostgreSQL está rodando.' }
foreach ($dbn in @('happy_alpha', 'happy_alpha_demo')) {
  $exists = & $psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='$dbn'"
  if ("$exists".Trim() -ne '1') { & (Join-Path $pgBin 'createdb.exe') -U postgres -h localhost $dbn; Ok "Banco $dbn criado" }
  else { Ok "Banco $dbn já existe (mantido)" }
}
$enc = [Uri]::EscapeDataString($pgPass)

# ---------- 3. Configuração (.env) ----------
Titulo 'Configuração'
if (-not (Test-Path '.env')) {
  $bk = Read-Host 'Pastas de backup separadas por ";" (Enter = C:\HappyAlpha-Backups)'
  if (-not $bk) { $bk = 'C:\HappyAlpha-Backups' }
  if ($bk -match 'Meu Drive|My Drive|(^|;)\s*G:') {
    Write-Host '  Atenção: o sistema roda como serviço do Windows e NÃO enxerga a unidade G: do Google Drive.' -ForegroundColor DarkYellow
    Write-Host '  Use C:\HappyAlpha-Backups e configure o Google Drive para sincronizar essa pasta (docs\INSTALACAO.md).' -ForegroundColor DarkYellow
    $bk2 = Read-Host 'Pastas de backup (Enter = C:\HappyAlpha-Backups)'
    $bk = if ($bk2) { $bk2 } else { 'C:\HappyAlpha-Backups' }
  }
  @(
    'PORT=3010',
    "DATABASE_URL=postgres://postgres:$enc@localhost:5432/happy_alpha",
    "BACKUP_DIRS=$bk",
    "PG_DUMP_PATH=$(Join-Path $pgBin 'pg_dump.exe')"
  ) | Set-Content -Encoding ASCII '.env'
  Ok 'Arquivo .env criado'
} else { Ok 'Arquivo .env já existe (mantido)' }
if (-not (Test-Path '.env.demo')) {
  @('DEMO_MODE=true', 'PORT=3011', "DATABASE_URL=postgres://postgres:$enc@localhost:5432/happy_alpha_demo") | Set-Content -Encoding ASCII '.env.demo'
  Ok 'Arquivo .env.demo criado'
}

# ---------- 4. Dependências ----------
Titulo 'Instalando dependências (precisa de internet só agora)'
& npm ci --omit=dev -w server --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Falha 'Falha ao instalar dependências. Verifique a internet e rode de novo.' }
Ok 'Dependências instaladas'

# ---------- 5. Banco + usuários + cardápio ----------
Titulo 'Configurando o sistema (usuários e cardápio)'
& node server\dist\scripts\setup.js
if ($LASTEXITCODE -ne 0) { Falha 'Falha na configuração inicial.' }

Titulo 'Preparando o modo demonstração (treinamento)'
$env:ENV_FILE = Join-Path $root '.env.demo'
& node server\dist\scripts\demo.js
Remove-Item Env:ENV_FILE
if ($LASTEXITCODE -ne 0) { Write-Host '  Aviso: demonstração não foi preparada (não impede o uso).' -ForegroundColor DarkYellow }

# ---------- 6. Firewall ----------
Titulo 'Liberando o acesso do tablet (firewall)'
Get-NetFirewallRule -DisplayName 'Happy Alpha' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Happy Alpha' -Direction Inbound -Protocol TCP -LocalPort 3010,3011 -Action Allow -Profile Any | Out-Null
Ok 'Portas 3010 (sistema) e 3011 (demonstração) liberadas na rede local'

# ---------- 7. Iniciar com o Windows ----------
Titulo 'Inicialização automática'
$auto = Read-Host 'Iniciar o Happy Alpha sozinho sempre que o computador ligar? (S/n) — use S no computador do caixa'
if ($auto -notmatch '^[nN]') {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$root\windows\servidor.cmd`"" -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'Happy Alpha' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName 'Happy Alpha'
  Ok 'Tarefa "Happy Alpha" criada e iniciada'
} else {
  Start-Process -FilePath 'cmd.exe' -ArgumentList "/k `"$root\windows\servidor.cmd`"" -WorkingDirectory $root
  Ok 'Sistema iniciado numa janela separada (feche a janela para parar). Para abrir de novo: windows\servidor.cmd'
}

Write-Host '  Aguardando o sistema subir...'
$up = $false
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-WebRequest -UseBasicParsing 'http://localhost:3010/api/health' -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep 2 }
}
if (-not $up) { Falha 'O sistema não respondeu. Veja o arquivo data\servidor.log.' }

$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
Write-Host "`n  PRONTO! O Happy Alpha está rodando.`n" -ForegroundColor Green
Write-Host '  Neste computador:  http://localhost:3010'
foreach ($ip in $ips) { Write-Host "  Tablet da cozinha: http://$($ip):3010/cozinha" }
Write-Host "`n  Anote o IP acima e reserve-o no roteador (veja docs\INSTALACAO.md).`n"
Start-Process 'http://localhost:3010'
Read-Host 'Pressione Enter para fechar'
