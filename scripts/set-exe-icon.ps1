param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Icon
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExeIcon {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EndUpdateResource(IntPtr update, bool discard);
}
'@

$bytes = [System.IO.File]::ReadAllBytes($Icon)
$count = [BitConverter]::ToUInt16($bytes, 4)
if ([BitConverter]::ToUInt16($bytes, 2) -ne 1 -or $count -lt 1) { throw 'Invalid ICO file' }
$images = @()
for ($index = 0; $index -lt $count; $index++) {
  $entry = 6 + ($index * 16)
  $size = [BitConverter]::ToUInt32($bytes, $entry + 8)
  $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
  $data = New-Object byte[] $size
  [Array]::Copy($bytes, $offset, $data, 0, $size)
  $images += [pscustomobject]@{
    Width = $bytes[$entry]
    Height = $bytes[$entry + 1]
    Colors = $bytes[$entry + 2]
    Planes = [BitConverter]::ToUInt16($bytes, $entry + 4)
    BitCount = [BitConverter]::ToUInt16($bytes, $entry + 6)
    Data = $data
    Id = $index + 1
  }
}

$group = New-Object System.Collections.Generic.List[byte]
$group.AddRange([byte[]](0, 0, 1, 0))
$group.AddRange([BitConverter]::GetBytes([uint16]$images.Count))
foreach ($image in $images) {
  $group.Add($image.Width)
  $group.Add($image.Height)
  $group.Add($image.Colors)
  $group.Add(0)
  $group.AddRange([BitConverter]::GetBytes([uint16]$image.Planes))
  $group.AddRange([BitConverter]::GetBytes([uint16]$image.BitCount))
  $group.AddRange([BitConverter]::GetBytes([uint32]$image.Data.Length))
  $group.AddRange([BitConverter]::GetBytes([uint16]$image.Id))
}

$update = [ExeIcon]::BeginUpdateResource($Exe, $false)
if ($update -eq [IntPtr]::Zero) { throw "BeginUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
  foreach ($image in $images) {
    $ok = [ExeIcon]::UpdateResource($update, [IntPtr]3, [IntPtr]$image.Id, 0, $image.Data, $image.Data.Length)
    if (-not $ok) { throw "UpdateResource icon $($image.Id) failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  }
  $groupBytes = $group.ToArray()
  $ok = [ExeIcon]::UpdateResource($update, [IntPtr]14, [IntPtr]1, 0, $groupBytes, $groupBytes.Length)
  if (-not $ok) { throw "UpdateResource group failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  if (-not [ExeIcon]::EndUpdateResource($update, $false)) { throw "EndUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $update = [IntPtr]::Zero
} finally {
  if ($update -ne [IntPtr]::Zero) { [void][ExeIcon]::EndUpdateResource($update, $true) }
}
