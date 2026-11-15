param(
  [Parameter(Mandatory = $true)][int]$ServerPid,
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Settings,
  [string]$AppArgs = ''
)

# Replaces the portable SubToAPI files after the server has exited.
# The settings folder is never touched. On failure the previous files are restored.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$log = Join-Path $Settings 'update.log'
$work = Split-Path -Parent $Source | Split-Path -Parent
$backup = Join-Path $work 'backup'
$files = @('sub-to-api.exe', 'tray.ps1', 'update.ps1', 'start.bat', 'icon.ico', 'README.txt', 'THIRD_PARTY_NOTICES.md')

function Write-Log([string]$Message) {
  try { Add-Content -LiteralPath $log -Value "$((Get-Date).ToString('s')) $Message" -Encoding UTF8 } catch {}
}

function Wait-Exit([int]$ProcessId, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { return $false }
    Start-Sleep -Milliseconds 300
  }
  return $true
}

function Test-Server {
  try {
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/" -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Copy-WithRetry([string]$From, [string]$To) {
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    try {
      Copy-Item -LiteralPath $From -Destination $To -Force
      return
    } catch {
      if ($attempt -eq 20) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Start-App {
  $exe = Join-Path $Target 'sub-to-api.exe'
  if ($AppArgs) { return Start-Process -FilePath $exe -ArgumentList $AppArgs -WorkingDirectory $Target -PassThru }
  return Start-Process -FilePath $exe -WorkingDirectory $Target -PassThru
}

function Wait-Server([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Server) { return $true }
    Start-Sleep -Milliseconds 700
  }
  return $false
}

function Restore-Backup {
  foreach ($name in $files) {
    $saved = Join-Path $backup $name
    if (Test-Path -LiteralPath $saved) { Copy-WithRetry $saved (Join-Path $Target $name) }
  }
}

Write-Log "update start pid=$ServerPid source=$Source target=$Target"
if (-not (Wait-Exit $ServerPid 30)) {
  Write-Log "server $ServerPid did not exit, stopping it"
  Stop-Process -Id $ServerPid -Force -ErrorAction SilentlyContinue
  if (-not (Wait-Exit $ServerPid 10)) {
    Write-Log 'server is still running, update aborted'
    exit 1
  }
}

try {
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($name in $files) {
    $current = Join-Path $Target $name
    if (Test-Path -LiteralPath $current) { Copy-WithRetry $current (Join-Path $backup $name) }
  }
  foreach ($name in $files) {
    $next = Join-Path $Source $name
    if (Test-Path -LiteralPath $next) { Copy-WithRetry $next (Join-Path $Target $name) }
  }
  Write-Log 'files replaced'
} catch {
  Write-Log "copy failed: $($_.Exception.Message); restoring"
  try { Restore-Backup } catch { Write-Log "restore failed: $($_.Exception.Message)" }
  try { Start-App | Out-Null } catch { Write-Log "start failed: $($_.Exception.Message)" }
  exit 1
}

$process = $null
try { $process = Start-App } catch { Write-Log "start failed: $($_.Exception.Message)" }
if ($process -and (Wait-Server 25)) {
  Write-Log 'new version is running'
  try { Remove-Item -LiteralPath (Split-Path -Parent $Source) -Recurse -Force } catch {}
  try { Remove-Item -LiteralPath $backup -Recurse -Force } catch {}
  Get-ChildItem -LiteralPath $work -Filter '*.zip' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  exit 0
}

Write-Log 'new version did not answer, rolling back'
if ($process) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Wait-Exit $process.Id 10 | Out-Null
}
try {
  Restore-Backup
  Start-App | Out-Null
  Write-Log 'previous version restored'
} catch {
  Write-Log "rollback failed: $($_.Exception.Message)"
}
exit 1
