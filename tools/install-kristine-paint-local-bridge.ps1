param(
  [string]$ScalePort = "COM4",
  [int]$ListenPort = 17831,
  [string]$PrinterName = "ZDesigner ZD220-203dpi ZPL"
)

$ErrorActionPreference = "Stop"
$expectedVersion = "1.5.0"

# Ein bereits installierter Windows-Dienst darf nicht durch eine zweite
# Benutzer-Bridge auf demselben Port ersetzt oder behindert werden.
$windowsService = Get-Service -Name "KRISTINEPaintBridge" -ErrorAction SilentlyContinue
if ($windowsService) {
  if ($windowsService.Status -ne "Running") {
    try { Start-Service -Name "KRISTINEPaintBridge" -ErrorAction Stop }
    catch { throw "KRISTINE laeuft jetzt als Windows-Dienst. Bitte unter Windows-Dienste den Dienst KRISTINE Restfarben pruefen: $($_.Exception.Message)" }
  }
  Write-Host "KRISTINE Restfarben laeuft als Windows-Dienst. Keine zweite Bridge gestartet."
  return
}

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

# Wenn bereits unsere alte Bridge auf dem Port laeuft, gezielt nur diesen Prozess neu starten.
$existingHealth = $null
try { $existingHealth = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$ListenPort/health" -TimeoutSec 2 } catch {}
if ($existingHealth -and $existingHealth.ok) {
  $ownerPid = $null
  try {
    $conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $ListenPort -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($conn) { $ownerPid = [int]$conn.OwningProcess }
  } catch {}

  if ($ownerPid) {
    $cmd = ""
    try { $cmd = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid").CommandLine } catch {}
    if ($cmd -match 'kristine-paint-local-bridge\.ps1') {
      Stop-Process -Id $ownerPid -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 500
    }
    elseif ([string]$existingHealth.service -eq 'KRISTINE Restfarben Hardware Bridge') {
      throw "KRISTINE Bridge laeuft auf Port $ListenPort, Prozess konnte aber nicht sicher identifiziert werden. Bitte Windows einmal neu starten."
    }
  }
}

Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$bridgePath`"",
  "-ScalePort", "`"$ScalePort`"",
  "-ListenPort", "$ListenPort",
  "-PrinterName", "`"$PrinterName`""
)

$deadline = [DateTime]::UtcNow.AddSeconds(10)
$healthResult = $null
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $healthResult = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$ListenPort/health" -TimeoutSec 2
    if ($healthResult.ok -and [string]$healthResult.version -eq $expectedVersion) { break }
  } catch {}
  Start-Sleep -Milliseconds 400
}

if (-not $healthResult -or -not $healthResult.ok) {
  throw "Hardware Bridge konnte nicht gestartet werden. Teste manuell: powershell -ExecutionPolicy Bypass -File `"$bridgePath`""
}
if ([string]$healthResult.version -ne $expectedVersion) {
  throw "Hardware Bridge laeuft noch in Version $($healthResult.version), erwartet wird $expectedVersion. Bitte Windows einmal neu starten."
}

# Startbutton in KRISTINE auch fuer die bisherige Benutzer-Bridge
# freischalten. Die URL kann ausschliesslich das feste lokale Skript starten.
$starterPath = Join-Path $installDir "start-kristine-paint-local-bridge.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/alexkrista/whatsapp-webhook/main/tools/start-kristine-paint-local-bridge.ps1" -OutFile $starterPath
$protocol = "HKCU:\Software\Classes\kristinepaint"
$command = "$protocol\shell\open\command"
New-Item -Path $command -Force | Out-Null
Set-Item -Path $protocol -Value "URL:KRISTINE Paint Bridge"
New-ItemProperty -Path $protocol -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
Set-Item -Path $command -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $starterPath + '"')

Write-Host ""
Write-Host "KRISTINE Restfarben Hardware Bridge aktualisiert und gestartet."
Write-Host "Version: $($healthResult.version)"
Write-Host "Autostart: aktueller Windows-Benutzer"
Write-Host "Waage: $ScalePort | Drucker: $PrinterName"
Write-Host "Lokale Adresse: http://127.0.0.1:$ListenPort"
Write-Host "Scale available: $($healthResult.scale.available) | Printer available: $($healthResult.printer.available)"
