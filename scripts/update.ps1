param(
  [Parameter(Mandatory = $true)][int]$ServerPid,
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Settings,
  [string]$AppArgs = ''
)

# Compatibility bootstrap for releases whose server still starts update.ps1.
# Current releases start updater.exe directly.

$ErrorActionPreference = 'Stop'
$log = Join-Path $Settings 'update.log'

function Write-Log([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $Settings | Out-Null
    Add-Content -LiteralPath $log -Value "$((Get-Date).ToString('s')) $Message" -Encoding UTF8
  } catch {}
}

try {
  $updater = Join-Path $Source 'updater.exe'
  if (-not (Test-Path -LiteralPath $updater)) { throw "updater.exe not found: $updater" }
  $arguments = @(
    '--server-pid', [string]$ServerPid,
    '--source', ('"' + $Source.Replace('"', '\"') + '"'),
    '--target', ('"' + $Target.Replace('"', '\"') + '"'),
    '--port', [string]$Port,
    '--settings', ('"' + $Settings.Replace('"', '\"') + '"')
  )
  if ($AppArgs) {
    foreach ($arg in ($AppArgs -split '\s+' | Where-Object { $_ })) {
      $arguments += '--app-arg'
      $arguments += $arg
    }
  }
  Write-Log "bootstrap starting updater.exe pid=$ServerPid"
  Start-Process -FilePath $updater -ArgumentList $arguments -WorkingDirectory $Source -WindowStyle Hidden
} catch {
  Write-Log "bootstrap failed: $($_.Exception.Message)"
  exit 1
}
