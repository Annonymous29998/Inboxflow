# GitHub windows-latest: custom IF icon, silent NSIS install, launch.
$ErrorActionPreference = 'Stop'
$desktop = Split-Path $PSScriptRoot -Parent
$release = Join-Path $desktop 'release'
$unpackedExe = Join-Path $release 'win-unpacked\InboxFlow.exe'

if (-not (Test-Path $unpackedExe)) { throw "Missing $unpackedExe" }

Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path $unpackedExe).Path)
if (-not $icon) { throw 'Could not extract icon from InboxFlow.exe' }
$bmp = $icon.ToBitmap()
$mint = 0
$dark = 0
$n = 0
for ($x = 0; $x -lt $bmp.Width; $x += 2) {
  for ($y = 0; $y -lt $bmp.Height; $y += 2) {
    $p = $bmp.GetPixel($x, $y)
    $n++
    if ($p.G -gt 140 -and $p.G -gt ($p.R + 20) -and $p.G -gt ($p.B + 20)) { $mint++ }
    if ($p.R -lt 45 -and $p.G -lt 55 -and $p.B -lt 45) { $dark++ }
  }
}
Write-Host "icon ${($bmp.Width)}x${($bmp.Height)} mint=$mint dark=$dark samples=$n"
if ($mint -lt 6 -or $dark -lt 12) {
  throw 'EXE icon is not the Inbox Flow IF mark (looks like Electron default or empty).'
}
Write-Host 'OK   custom Inbox Flow icon on InboxFlow.exe'

$setup = Get-ChildItem $release -Filter 'InboxFlow-Setup-*.exe' | Sort-Object Name | Select-Object -Last 1
if (-not $setup) { throw 'InboxFlow-Setup-*.exe missing' }
Write-Host "Silent install $($setup.Name)"
$pInstall = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -PassThru -Wait
if ($pInstall.ExitCode -ne 0 -and $null -ne $pInstall.ExitCode) {
  Write-Host "NSIS exit $($pInstall.ExitCode) (continuing if files exist)"
}

Get-Process InboxFlow, 'Inbox Flow' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$installed = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Inbox Flow\InboxFlow.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\inboxflow\InboxFlow.exe'),
  (Join-Path ${env:ProgramFiles} 'Inbox Flow\InboxFlow.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $installed) { throw 'Silent install did not create InboxFlow.exe' }
Write-Host "OK   installed $installed"

$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($installed)
Write-Host "FileDescription=$($info.FileDescription) Product=$($info.ProductName) Version=$($info.ProductVersion)"
if ($info.ProductName -notmatch 'Inbox') {
  throw "ProductName is '$($info.ProductName)' — expected Inbox Flow, not Electron"
}

$launched = Start-Process -FilePath $installed -PassThru
Start-Sleep -Seconds 25
$alive = Get-Process -Id $launched.Id -ErrorAction SilentlyContinue
if (-not $alive) {
  throw "InboxFlow.exe exited during launch (code $($launched.ExitCode))"
}
Write-Host 'OK   InboxFlow.exe stayed running after launch'
Get-Process InboxFlow, 'Inbox Flow' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host 'Windows smoke passed'
