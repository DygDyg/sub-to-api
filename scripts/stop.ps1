param(
  [Parameter(Mandatory = $true)][int]$Port = 8787
)

$ErrorActionPreference = 'SilentlyContinue'
$targets = New-Object System.Collections.Generic.List[int]
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  $processId = [int]$listener.OwningProcess
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
  $name = [string]$process.Name
  $command = [string]$process.CommandLine
  $isNode = $name -eq 'node.exe'
  $isOurServer = $command -like '*src\cli.js*' -or $command -like '*src/cli.js*'
  if ($isNode -and $isOurServer -and $processId -ne $PID) { $targets.Add($processId) }
}

foreach ($processId in ($targets | Select-Object -Unique)) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
