param(
  [string]$ScalePort = "COM4",
  [int]$ListenPort = 17831,
  [string]$PrinterName = "ZDesigner ZD220-203dpi ZPL"
)

$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:LOCALAPPDATA "KRISTINE\PaintLocalBridge"
$bridgePath = Join-Path $installDir "kristine-paint-local-bridge.ps1"
$sourceUrl = "https://raw.githubusercontent.com/alexkrista/whatsapp-webhook/main/tools/kristine-paint-local-bridge.ps1"

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $sourceUrl -OutFile $bridgePath

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "KRISTINEPaintLocalBridge"
$runValue = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$bridgePath`" -ScalePort `"$ScalePort`" -ListenPort $ListenPort -PrinterName `"$PrinterName`""
New-Item -Path $runKey -Force | Out-Null
Set-ItemProperty -Path $runKey -Name $runName -Value $runValue

$alreadyRunning = $false
try {
  $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$ListenPort/health" -TimeoutSec 2
  if ($health.ok) { $alreadyRunning = $true }
} catch {}

if (-not $alreadyRunning) {
  Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$bridgePath`"",
    "-ScalePort", "`"$ScalePort`"",
    "-ListenPort", "$ListenPort",
    "-PrinterName", "`"$PrinterName`""
  )
}

$deadline = [DateTime]::UtcNow.AddSeconds(8)
$healthResult = $null
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $healthResult = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$ListenPort/health" -TimeoutSec 2
    if ($healthResult.ok) { break }
  } catch {}
  Start-Sleep -Milliseconds 400
}

if (-not $healthResult -or -not $healthResult.ok) {
  throw "Hardware Bridge konnte nicht gestartet werden. Teste manuell: powershell -ExecutionPolicy Bypass -File `"$bridgePath`""
}

Write-Host ""
Write-Host "KRISTINE Restfarben Hardware Bridge installiert und gestartet."
Write-Host "Autostart: aktueller Windows-Benutzer"
Write-Host "Waage: $ScalePort | Drucker: $PrinterName"
Write-Host "Lokale Adresse: http://127.0.0.1:$ListenPort"
Write-Host "Scale available: $($healthResult.scale.available) | Printer available: $($healthResult.printer.available)"
