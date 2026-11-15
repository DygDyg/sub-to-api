param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][int]$ServerPid
)

$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class TrayDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
'@
  [void][TrayDpi]::SetProcessDPIAware()
} catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$url = "http://127.0.0.1:$Port/"
$iconPath = Join-Path $PSScriptRoot 'icon.ico'
if (-not (Test-Path -LiteralPath $iconPath)) { $iconPath = Join-Path $PSScriptRoot '..\assets\icon.ico' }
$icon = New-Object System.Drawing.Icon $iconPath
$script:popupWidth = 320

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = "SubToAPI :$Port"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open settings')
$close = $menu.Items.Add('Exit')
$notify.ContextMenuStrip = $menu

$script:popup = $null
$script:dismissPopup = $null
$script:dismissTimer = $null
$script:suppressDismiss = $false
$script:usageRows = $null
$script:usageCachedAt = [datetime]::MinValue
$script:fetch = $null

function Open-Settings {
  Start-Process $url
}

function Test-OurServer([int]$ProcessId) {
  if ($ProcessId -le 4) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $name = [string]$process.Name
  if ($name -ne 'node.exe' -and $name -ne 'sub-to-api.exe') { return $false }
  if ($name -eq 'sub-to-api.exe') { return $true }
  $command = [string]$process.CommandLine
  return $command -like '*src\cli.js*' -or $command -like '*src/cli.js*' -or $command -like '*sub-to-api*'
}

function Stop-UsageFetch {
  if (-not $script:fetch) { return }
  try { $script:fetch.Timer.Stop() } catch {}
  try { $script:fetch.PowerShell.Stop() } catch {}
  try { $script:fetch.PowerShell.Dispose() } catch {}
  $script:fetch = $null
}

function Close-App {
  $notify.Visible = $false
  Stop-UsageFetch
  if ($script:popup -and -not $script:popup.IsDisposed) { $script:popup.Close() }
  if (Test-OurServer $ServerPid) { Stop-Process -Id $ServerPid -Force -ErrorAction SilentlyContinue }
  [System.Windows.Forms.Application]::Exit()
}

function Format-Remaining([double]$UsedPercent) {
  $remaining = [math]::Max(0, [math]::Min(100, 100 - $UsedPercent))
  return '{0:0}% осталось' -f $remaining
}

function Format-Reset([object]$Window) {
  if (-not $Window.resetsAt) { return $null }
  $resets = [datetimeoffset]::FromUnixTimeMilliseconds([int64]$Window.resetsAt).LocalDateTime
  $left = $resets - (Get-Date)
  $absolute = $resets.ToString('dd.MM.yyyy, HH:mm:ss')
  if ($left.TotalSeconds -le 0) { return [pscustomobject]@{ Text = 'сброс сейчас'; Tip = $absolute } }
  $parts = New-Object System.Collections.Generic.List[string]
  if ($left.Days -gt 0) { $parts.Add("$($left.Days)д") }
  if ($left.Hours -gt 0) { $parts.Add("$($left.Hours)ч") }
  if ($left.Days -eq 0 -and $left.Minutes -gt 0) { $parts.Add("$($left.Minutes)м") }
  if ($parts.Count -eq 0) { $parts.Add('меньше минуты') }
  return [pscustomobject]@{ Text = "сброс через $($parts -join ' ')"; Tip = $absolute }
}

function Get-WindowLabel([object]$Window) {
  $base = switch ($Window.kind) {
    'session' { 'Окно 5 часов' }
    'weekly' { 'Неделя' }
    default { 'Период' }
  }
  if ($Window.scope) { return "$base · $($Window.scope)" }
  return $base
}

function Get-ProviderTitle($Row) {
  switch ($Row.id) {
    'codex' { 'Codex' }
    'claude' { 'Claude' }
    'grok' { 'Grok' }
    'copilot' { 'Copilot' }
    'antigravity' { 'Antigravity' }
    default { if ($Row.label) { [string]$Row.label } else { [string]$Row.id } }
  }
}

function Get-UsageColor([double]$UsedPercent) {
  if ($UsedPercent -ge 95) { return [System.Drawing.Color]::FromArgb(240, 68, 56) }
  if ($UsedPercent -ge 80) { return [System.Drawing.Color]::FromArgb(247, 144, 9) }
  return [System.Drawing.Color]::FromArgb(18, 183, 106)
}

function Add-PopupText($Parent, [ref]$Y, [string]$Text, $Font, $Color, [int]$X, [int]$Width) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.Font = $Font
  $label.ForeColor = $Color
  $label.AutoSize = $false
  $label.Location = New-Object System.Drawing.Point($X, $Y.Value)
  $preferred = $label.GetPreferredSize((New-Object System.Drawing.Size($Width, 0)))
  $label.Size = New-Object System.Drawing.Size($Width, [math]::Max($Font.Height + 2, $preferred.Height))
  $Parent.Controls.Add($label)
  $Y.Value += $label.Height + 2
  return $label
}

function Add-PopupSplit($Parent, [ref]$Y, [string]$LeftText, [string]$RightText, $Font, $LeftColor, $RightColor) {
  $left = New-Object System.Windows.Forms.Label
  $left.Text = $LeftText
  $left.Font = $Font
  $left.ForeColor = $LeftColor
  $left.AutoSize = $true
  $left.Location = New-Object System.Drawing.Point(14, $Y.Value)
  $Parent.Controls.Add($left)

  $rightWidth = 0
  if ($RightText) {
    $right = New-Object System.Windows.Forms.Label
    $right.Text = $RightText
    $right.Font = $Font
    $right.ForeColor = $RightColor
    $right.AutoSize = $true
    $Parent.Controls.Add($right)
    $rightWidth = $right.PreferredWidth
    $right.Location = New-Object System.Drawing.Point(($script:popupWidth - 14 - $rightWidth), $Y.Value)
  }
  $left.MaximumSize = New-Object System.Drawing.Size(($script:popupWidth - 36 - $rightWidth), 0)
  $Y.Value += [math]::Max($left.PreferredHeight, $Font.Height + 2) + 2
}

function Add-UsageBar($Parent, [ref]$Y, [double]$UsedPercent) {
  $remaining = [math]::Max(0, [math]::Min(100, 100 - $UsedPercent))
  $track = New-Object System.Windows.Forms.Panel
  $track.Location = New-Object System.Drawing.Point(14, ($Y.Value + 3))
  $track.Size = New-Object System.Drawing.Size(($script:popupWidth - 28), 6)
  $track.BackColor = [System.Drawing.Color]::FromArgb(48, 54, 61)
  $fill = New-Object System.Windows.Forms.Panel
  $width = 0
  if ($remaining -gt 0) { $width = [math]::Max(2, [int]($track.Width * $remaining / 100)) }
  $fill.Size = New-Object System.Drawing.Size($width, 6)
  $fill.BackColor = Get-UsageColor $UsedPercent
  $track.Controls.Add($fill)
  $Parent.Controls.Add($track)
  $Y.Value += 16
}

function Set-PopupContent($Popup, $Rows, [string]$Message) {
  if (-not $Popup -or $Popup.IsDisposed) { return }
  $closeButton = $Popup.Tag.CloseButton
  $Popup.Controls.Clear()
  if ($closeButton) { $Popup.Controls.Add($closeButton); $closeButton.BringToFront() }
  $ink = [System.Drawing.Color]::FromArgb(230, 237, 243)
  $muted = [System.Drawing.Color]::FromArgb(139, 148, 158)
  $titleFont = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $nameFont = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $small = New-Object System.Drawing.Font('Segoe UI', 8)
  $y = 14
  Add-PopupText $Popup ([ref]$y) 'Использование' $titleFont $ink 14 ($script:popupWidth - 52) | Out-Null
  $y += 6

  $list = @()
  if ($Rows) { $list = @($Rows | Where-Object { $_ }) }
  if ($Message -and $list.Count -eq 0) {
    Add-PopupText $Popup ([ref]$y) $Message $Popup.Font $muted 14 ($script:popupWidth - 28) | Out-Null
  } elseif ($list.Count -eq 0) {
    Add-PopupText $Popup ([ref]$y) 'Нет подключённых провайдеров' $Popup.Font $muted 14 ($script:popupWidth - 28) | Out-Null
  }

  foreach ($row in $list) {
    $plan = ''
    if ($row.usage -and $row.usage.plan) { $plan = "План: $($row.usage.plan)" }
    Add-PopupSplit $Popup ([ref]$y) (Get-ProviderTitle $row) $plan $nameFont $ink $muted
    $account = $null
    foreach ($item in @($row.accounts)) {
      if ($item -and $item.isDefault) { $account = $item; break }
      if (-not $account -and $item) { $account = $item }
    }
    if ($account -and $account.label) {
      Add-PopupText $Popup ([ref]$y) ([string]$account.label) $small $muted 14 ($script:popupWidth - 28) | Out-Null
    }

    $windows = @()
    if ($row.usage -and $row.usage.windows) { $windows = @($row.usage.windows) }
    if ($row.error) {
      Add-PopupText $Popup ([ref]$y) 'Не удалось загрузить' $small ([System.Drawing.Color]::FromArgb(248, 113, 113)) 14 ($script:popupWidth - 28) | Out-Null
    } elseif ($row.usage -and $row.usage.error) {
      Add-PopupText $Popup ([ref]$y) ([string]$row.usage.error) $small $muted 14 ($script:popupWidth - 28) | Out-Null
    } elseif ($windows.Count -eq 0) {
      Add-PopupText $Popup ([ref]$y) 'Нет данных о квоте' $small $muted 14 ($script:popupWidth - 28) | Out-Null
    } else {
      foreach ($window in $windows) {
        if (-not $window) { continue }
        $used = 0
        if ($null -ne $window.usedPercent) { $used = [double]$window.usedPercent }
        Add-PopupSplit $Popup ([ref]$y) (Get-WindowLabel $window) (Format-Remaining $used) $small $muted $ink
        Add-UsageBar $Popup ([ref]$y) $used
        $reset = Format-Reset $window
        $resetLabel = Add-PopupText $Popup ([ref]$y) ($(if ($reset) { $reset.Text } else { 'время сброса неизвестно' })) $small $muted 14 ($script:popupWidth - 28)
        if ($reset.Tip) {
          $hover = $reset.Tip
          $resetLabel.Add_MouseEnter({ $this.Text = $hover })
          $resetLabel.Add_MouseLeave({ $this.Text = $reset.Text })
        }
        $y += 4
      }
    }
    $y += 8
  }

  $height = [math]::Min(640, [math]::Max(72, $y + 8))
  $Popup.ClientSize = New-Object System.Drawing.Size($script:popupWidth, $height)
  Move-UsagePopup $Popup
}

function Move-UsagePopup($Popup) {
  $cursor = [System.Windows.Forms.Cursor]::Position
  $area = [System.Windows.Forms.Screen]::FromPoint($cursor).WorkingArea
  $x = $cursor.X - [int]($Popup.Width / 2)
  if ($x + $Popup.Width -gt $area.Right - 4) { $x = $area.Right - $Popup.Width - 4 }
  if ($x -lt $area.Left + 4) { $x = $area.Left + 4 }
  $y = $cursor.Y - $Popup.Height - 12
  if ($y -lt $area.Top + 4) { $y = [math]::Min($cursor.Y + 16, $area.Bottom - $Popup.Height - 4) }
  $Popup.Location = New-Object System.Drawing.Point($x, $y)
}

function Start-UsageFetch {
  if ($script:fetch) { return }
  $shell = [powershell]::Create()
  [void]$shell.AddScript({
    param($ListenPort)
    $ProgressPreference = 'SilentlyContinue'
    $ErrorActionPreference = 'Stop'
    $payload = Invoke-RestMethod -Uri "http://127.0.0.1:$ListenPort/api/usage"
    $result = @()
    foreach ($provider in @($payload.providers)) {
      if (-not $provider) { continue }
      $result += [pscustomobject]@{ id = $provider.id; label = $provider.label; accounts = @($provider.accounts | Where-Object { $_ }); usage = $provider.usage; error = $provider.error }
    }
    if ($result.Count -eq 0) { return '[]' }
    $json = ConvertTo-Json -InputObject @($result) -Depth 6 -Compress
    if ($result.Count -eq 1) { return "[$json]" }
    return $json
  }).AddArgument($Port)
  $handle = $shell.BeginInvoke()
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 100
  $script:fetch = @{ PowerShell = $shell; Handle = $handle; Timer = $timer }
  $timer.Add_Tick({
    if (-not $script:fetch -or -not $script:fetch.Handle.IsCompleted) { return }
    $popup = $script:popup
    $shell = $script:fetch.PowerShell
    $handle = $script:fetch.Handle
    $script:fetch.Timer.Stop()
    $script:fetch = $null
    try {
      $output = @($shell.EndInvoke($handle) | Where-Object { $_ })
      $json = [string]$output[-1]
      if ([string]::IsNullOrWhiteSpace($json) -or $json -eq '[]' -or $json -eq 'null') {
        $rows = @()
      } else {
        $rows = @((ConvertFrom-Json $json) | Where-Object { $_ })
      }
      $script:usageRows = $rows
      $script:usageCachedAt = Get-Date
      if ($popup -and -not $popup.IsDisposed) { Set-PopupContent $popup $rows '' }
    } catch {
      if ($popup -and -not $popup.IsDisposed -and -not $script:usageRows) { Set-PopupContent $popup $null 'Не удалось получить квоты' }
    } finally {
      $shell.Dispose()
    }
  })
  $timer.Start()
}

function Show-UsagePopup {
  $script:suppressDismiss = $false
  if ($script:popup -and -not $script:popup.IsDisposed) {
    $script:popup.Close()
    return
  }

  $popup = New-Object System.Windows.Forms.Form
  $script:popup = $popup
  $popup.FormBorderStyle = 'None'
  $popup.ShowInTaskbar = $false
  $popup.TopMost = $true
  $popup.StartPosition = 'Manual'
  $popup.BackColor = [System.Drawing.Color]::FromArgb(22, 27, 34)
  $popup.ForeColor = [System.Drawing.Color]::FromArgb(230, 237, 243)
  $popup.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $popup.ClientSize = New-Object System.Drawing.Size($script:popupWidth, 88)
  $popup.Tag = Get-Date
  $closeButton = New-Object System.Windows.Forms.Button
  $closeButton.Text = '×'
  $closeButton.Font = New-Object System.Drawing.Font('Segoe UI', 12)
  $closeButton.FlatStyle = 'Flat'
  $closeButton.FlatAppearance.BorderSize = 0
  $closeButton.BackColor = $popup.BackColor
  $closeButton.ForeColor = [System.Drawing.Color]::FromArgb(139, 148, 158)
  $closeButton.Size = New-Object System.Drawing.Size(28, 24)
  $closeButton.Location = New-Object System.Drawing.Point(($script:popupWidth - 32), 8)
  $closeButton.Anchor = 'Top, Right'
  $closeButton.TabStop = $false
  $closeButton.Cursor = [System.Windows.Forms.Cursors]::Hand
  $closeButton.AccessibleName = 'Закрыть'
  $closeButton.Add_MouseEnter({ $this.ForeColor = [System.Drawing.Color]::FromArgb(230, 237, 243) })
  $closeButton.Add_MouseLeave({ $this.ForeColor = [System.Drawing.Color]::FromArgb(139, 148, 158) })
  $closeButton.Add_Click({ if (-not $popup.IsDisposed) { $popup.Close() } })
  $popup.Controls.Add($closeButton)
  $closeButton.BringToFront()
  $popup.Tag = @{ ShownAt = Get-Date; CloseButton = $closeButton }
  $popup.Add_Paint({
    param($sender, $event)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(48, 54, 61))
    $event.Graphics.DrawRectangle($pen, 0, 0, ($sender.Width - 1), ($sender.Height - 1))
    $pen.Dispose()
  })
  $popup.Add_Deactivate({
    if ($popup.IsDisposed) { return }
    if (((Get-Date) - [datetime]$popup.Tag.ShownAt).TotalMilliseconds -lt 400) { $popup.Activate(); return }
    $script:dismissPopup = $popup
    $script:dismissTimer.Start()
  })
  $popup.Add_FormClosed({ $script:popup = $null })

  $fresh = $script:usageRows -and ((Get-Date) - $script:usageCachedAt).TotalSeconds -lt 300
  if ($script:usageRows) { Set-PopupContent $popup $script:usageRows '' }
  else { Set-PopupContent $popup $null 'Загрузка…' }
  $popup.Show()
  $popup.Activate()
  if (-not $fresh) { Start-UsageFetch }
}

$open.Add_Click({ Open-Settings })
$close.Add_Click({ Close-App })

$clickTimer = New-Object System.Windows.Forms.Timer
$clickTimer.Interval = [System.Windows.Forms.SystemInformation]::DoubleClickTime
$clickTimer.Add_Tick({
  $clickTimer.Stop()
  Show-UsagePopup
})
$script:dismissTimer = New-Object System.Windows.Forms.Timer
$script:dismissTimer.Interval = 200
$script:dismissTimer.Add_Tick({
  $script:dismissTimer.Stop()
  if ($script:suppressDismiss) { $script:suppressDismiss = $false; return }
  if ($script:dismissPopup -and -not $script:dismissPopup.IsDisposed) { $script:dismissPopup.Close() }
  $script:dismissPopup = $null
})
$notify.Add_MouseUp({
  param($sender, $event)
  if ($event.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  $script:suppressDismiss = $true
  if ($clickTimer.Enabled) { $clickTimer.Stop(); return }
  $clickTimer.Start()
})
$notify.Add_DoubleClick({
  $clickTimer.Stop()
  $script:suppressDismiss = $false
  if ($script:popup -and -not $script:popup.IsDisposed) { $script:popup.Close() }
  Open-Settings
})

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleIcon {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}
'@
function Set-ProgramIcon {
  $window = (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue).MainWindowHandle
  if (-not $window -or $window -eq [IntPtr]::Zero) { return }
  [void][ConsoleIcon]::SendMessage($window, 0x0080, [IntPtr]1, $icon.Handle)
  [void][ConsoleIcon]::SendMessage($window, 0x0080, [IntPtr]0, $icon.Handle)
}
Set-ProgramIcon

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$iconTries = 0
$timer.Add_Tick({
  if ($iconTries -lt 5) { $script:iconTries++; Set-ProgramIcon }
  if (-not (Test-OurServer $ServerPid)) { Close-App }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
Stop-UsageFetch
$notify.Dispose()
$icon.Dispose()
