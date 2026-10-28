param(
  [string]$ScalePort = "COM4",
  [int]$ListenPort = 17831,
  [string]$PrinterName = "ZDesigner ZD220-203dpi ZPL"
)

# Einmalige Einrichtung am MISCH-PC als Administrator.
# Installiert einen echten Windows-Dienst + lokalen URL-Starter fuer KRISTINE.
# Die bisherige Benutzer-Bridge bleibt als Rueckfall erhalten, bis der neue
# Dienst seine /health-Pruefung und den Drucker-Check bestanden hat.

$ErrorActionPreference = "Stop"
$serviceName = "KRISTINEPaintBridge"
$expectedVersion = "1.5.0"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Bitte PowerShell am MISCH-PC als Administrator starten und diesen Installer erneut ausfuehren."
}
if ($ScalePort -notmatch '^COM[0-9]{1,3}$') { throw "Ungueltiger Waagen-Port: $ScalePort" }
if ($ListenPort -lt 1024 -or $ListenPort -gt 65535) { throw "Ungueltiger HTTP-Port" }
if (-not $PrinterName -or $PrinterName -match '["\r\n]') { throw "Ungueltiger Druckername" }

$root = Join-Path $env:ProgramData "KRISTINE\PaintLocalBridge"
$serviceExe = Join-Path $root "kristine-paint-service.exe"
$bridgePath = Join-Path $root "kristine-paint-local-bridge.ps1"
$launcherPath = Join-Path $root "start-kristine-paint-local-bridge.ps1"
$configPath = Join-Path $root "service.args"
$legacyPath = Join-Path $env:LOCALAPPDATA "KRISTINE\PaintLocalBridge\kristine-paint-local-bridge.ps1"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$sourceBase = "https://raw.githubusercontent.com/alexkrista/whatsapp-webhook/main/tools"
New-Item -Path $root -ItemType Directory -Force | Out-Null

# Alle Bestandteile herunterladen und kompilieren, BEVOR ein laufender
# Druckdienst unterbrochen wird.
$stage = Join-Path $env:TEMP ("kristine-paint-stage-" + [Guid]::NewGuid().ToString("N"))
New-Item -Path $stage -ItemType Directory -Force | Out-Null

$wasServiceRunning = $false
$wasLegacyRunning = $false
$previousRunValue = $null
$previousServiceExists = $false
$oldHealth = $null
$startedNewService = $false

try {
  foreach ($file in @(
    "kristine-paint-local-bridge.ps1",
    "kristine-paint-windows-service.cs",
    "start-kristine-paint-local-bridge.ps1"
  )) {
    Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/$file" -OutFile (Join-Path $stage $file)
  }

  $bridgeSource = Get-Content -LiteralPath (Join-Path $stage "kristine-paint-local-bridge.ps1") -Raw
  if ($bridgeSource -notmatch "version = '1\.5\.0'") {
    throw "Unerwartete Bridge-Version. Keine Umstellung."
  }

  $compiler = New-Object Microsoft.CSharp.CSharpCodeProvider
  $settings = New-Object System.CodeDom.Compiler.CompilerParameters
  $settings.GenerateExecutable = $true
  $settings.IncludeDebugInformation = $false
  $settings.OutputAssembly = (Join-Path $stage "kristine-paint-service.exe")
  [void]$settings.ReferencedAssemblies.Add("System.dll")
  [void]$settings.ReferencedAssemblies.Add("System.Core.dll")
  [void]$settings.ReferencedAssemblies.Add("System.ServiceProcess.dll")
  $source = Get-Content -LiteralPath (Join-Path $stage "kristine-paint-windows-service.cs") -Raw
  $result = $compiler.CompileAssemblyFromSource($settings, $source)
  if ($result.Errors.HasErrors) {
    throw "Der Windows-Dienst konnte nicht kompiliert werden: $($result.Errors | Out-String)"
  }

  $oldService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  $previousServiceExists = $null -ne $oldService
  $wasServiceRunning = $oldService -and $oldService.Status -eq "Running"
  try {
    $oldHealth = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$ListenPort/health" -TimeoutSec 2
  } catch {}

  $previousRunValue = (Get-ItemProperty -Path $runKey -Name "KRISTINEPaintLocalBridge" -ErrorAction SilentlyContinue).KRISTINEPaintLocalBridge

  # Nur einen eindeutig identifizierten KRISTINE-Prozess auf dem Port anfassen.
  $ownerPid = $null
  $conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { $ownerPid = [int]$conn.OwningProcess }
  if ($ownerPid) {
    $ownerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction Stop
    $commandLine = [string]$ownerProcess.CommandLine
    if ($commandLine -notmatch 'kristine-paint-local-bridge\.ps1') {
      throw "Port $ListenPort wird von einem anderen Programm verwendet. Keine Umstellung."
    }
    if (-not $wasServiceRunning) {
      # Der alte Benutzer-Autostart gehört zum Drucker-Benutzerkonto.
      # Bei einer Admin-Anmeldung mit anderem Konto könnten weder der
      # ursprüngliche Autostart noch der Rollback zuverlässig greifen.
      # Deshalb vor dem ersten Stop zwingend dieselbe Windows-SID prüfen.
      $ownerInfo = Invoke-CimMethod -InputObject $ownerProcess -MethodName GetOwnerSid -ErrorAction Stop
      $runningSid = [string]$ownerInfo.Sid
      $installerSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      if (-not $runningSid -or $runningSid -ne $installerSid) {
        throw "Der Misch-PC-Dienst laeuft unter einem anderen Windows-Benutzer. Bitte den Installer mit demselben Benutzerkonto als Administrator starten. Der laufende Druck bleibt unveraendert."
      }
    }
    $wasLegacyRunning = -not $wasServiceRunning
  }

  if ($wasServiceRunning) {
    Stop-Service -Name $serviceName -ErrorAction Stop
    (Get-Service -Name $serviceName).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(10))
  }
  if ($ownerPid) {
    $stillRunning = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($stillRunning) {
      Stop-Process -Id $ownerPid -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 800
    }
  }

  # Bestehende Dienstdateien fuer Rueckfall sichern.
  foreach ($file in @("kristine-paint-service.exe", "kristine-paint-local-bridge.ps1", "service.args")) {
    $original = Join-Path $root $file
    if (Test-Path $original) { Copy-Item -LiteralPath $original -Destination "$original.bak" -Force }
  }

  Copy-Item (Join-Path $stage "kristine-paint-service.exe") $serviceExe -Force
  Copy-Item (Join-Path $stage "kristine-paint-local-bridge.ps1") $bridgePath -Force
  Copy-Item (Join-Path $stage "start-kristine-paint-local-bridge.ps1") $launcherPath -Force
  @($ScalePort, [string]$ListenPort, $PrinterName) | Set-Content -LiteralPath $configPath -Encoding UTF8

  if (-not $previousServiceExists) {
    New-Service -Name $serviceName -DisplayName "KRISTINE Restfarben - Zebra und Waage" -BinaryPathName ('"' + $serviceExe + '"') -StartupType Automatic | Out-Null
  } else {
    & sc.exe config $serviceName start= auto | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Dienstkonfiguration fehlgeschlagen." }
  }
  & sc.exe description $serviceName "Lokale KRISTINE-Bridge fuer Zebra ZD220 und Sartorius-Waage am Misch-PC." | Out-Null
  & sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

  Start-Service -Name $serviceName -ErrorAction Stop
  $startedNewService = $true

  $health = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(16)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$ListenPort/health" -TimeoutSec 2
      if ($health.ok -and [string]$health.version -eq $expectedVersion) { break }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $health -or -not $health.ok -or [string]$health.version -ne $expectedVersion) {
    throw "Neuer Dienst liefert keine gueltige Version 1.5.0."
  }
  if ($oldHealth -and $oldHealth.printer.available -and -not $health.printer.available) {
    throw "Der Dienst sieht den Zebra-Drucker nicht; Rueckkehr zur bisherigen Benutzer-Bridge."
  }
  if ($oldHealth -and $oldHealth.scale.available -and -not $health.scale.available) {
    throw "Der Dienst sieht die Waage nicht; Rueckkehr zur bisherigen Benutzer-Bridge."
  }

  # Erst nach erfolgreicher Gesundheitspruefung den alten Benutzer-Autostart
  # entfernen (verhindert Portkonflikte bei der naechsten Anmeldung).
  if ($previousRunValue) {
    Remove-ItemProperty -Path $runKey -Name "KRISTINEPaintLocalBridge" -ErrorAction Stop
  }

  # Kristine-Webseite kann ueber einen lokalen URL-Handler gezielt nur
  # den vordefinierten Starter aufrufen (keine frei uebergebenen Befehle).
  $protocol = "HKCU:\Software\Classes\kristinepaint"
  $command = "$protocol\shell\open\command"
  New-Item -Path $command -Force | Out-Null
  Set-Item -Path $protocol -Value "URL:KRISTINE Paint Bridge"
  New-ItemProperty -Path $protocol -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
  $commandValue = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
  Set-Item -Path $command -Value $commandValue

  Write-Host ""
  Write-Host "KRISTINE Restfarben als Windows-Dienst eingerichtet."
  Write-Host "Dienstname: $serviceName | Starttyp: Automatisch"
  Write-Host "Bridge-Version: $($health.version)"
  Write-Host "Zebra verfuegbar: $($health.printer.available) | Waage verfuegbar: $($health.scale.available)"
  Write-Host "Der Startbutton in KRISTINE funktioniert auf diesem Windows-Benutzer."
  Write-Host "Die Bedienseite ggf. mit Strg+F5 neu laden."
}
catch {
  $failure = $_
  Write-Warning "Umstellung nicht abgeschlossen: $($failure.Exception.Message)"
  try {
    if ($startedNewService) {
      Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
      (Get-Service -Name $serviceName).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(8))
    }
  } catch {}
  # Wenn der Dienst erstmalig angelegt wurde, aber nicht sauber startet,
  # den unbenutzbaren Dienst wieder entfernen. Sonst würde der alte
  # Benutzer-Installer künftig fälschlich auf den defekten Dienst umleiten.
  if (-not $previousServiceExists) {
    try {
      if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
        & sc.exe delete $serviceName | Out-Null
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "Nicht gestarteten Dienst bitte manuell entfernen (sc.exe delete $serviceName)."
        }
      }
    }
    catch { Write-Warning "Nicht gestarteten Dienst bitte manuell entfernen: $_" }
  }
  else {
    # Bei Aktualisierung des bestehenden Dienstes Dateien zurückstellen,
    # auch wenn der bisherige Dienst vor der Aktualisierung gestoppt war.
    try {
      foreach ($file in @("kristine-paint-service.exe","kristine-paint-local-bridge.ps1","service.args")) {
        $original = Join-Path $root $file
        if (Test-Path "$original.bak") { Copy-Item -LiteralPath "$original.bak" -Destination $original -Force }
      }
      if ($wasServiceRunning) { Start-Service -Name $serviceName -ErrorAction Stop }
    }
    catch { Write-Warning "Vorherigen Dienst bitte manuell prüfen: $_" }
  }
  if ($wasLegacyRunning -and (Test-Path $legacyPath)) {
    # Rückfall auf die bereits vorher laufende Benutzer-Bridge.
    try {
      $legacyArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $legacyPath + '"'
      Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList $legacyArgs
    }
    catch { Write-Warning "Bisherige Bridge bitte manuell starten: $_" }
  }
  # Falls die Umstellung nach dem Entfernen des Benutzer-Autostarts
  # gescheitert ist, den vorherigen Registry-Eintrag wiederherstellen.
  if ($previousRunValue) {
    try {
      $current = (Get-ItemProperty -Path $runKey -Name "KRISTINEPaintLocalBridge" -ErrorAction SilentlyContinue).KRISTINEPaintLocalBridge
      if (-not $current) {
        New-Item -Path $runKey -Force | Out-Null
        Set-ItemProperty -Path $runKey -Name "KRISTINEPaintLocalBridge" -Value $previousRunValue -ErrorAction Stop
      }
    }
    catch { Write-Warning "Alten Autostart bitte pruefen: $_" }
  }
  throw $failure
}
finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
