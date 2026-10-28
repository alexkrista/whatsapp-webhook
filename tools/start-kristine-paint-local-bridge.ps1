param(
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$serviceName = "KRISTINEPaintBridge"

try {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service) {
    if ($service.Status -ne "Running") {
      try {
        Start-Service -Name $serviceName -ErrorAction Stop
      }
      catch {
        if ($Elevated) { throw }
        # Windows-Dienste brauchen fuer einen manuellen Start ggf. Adminrechte.
        # Nur der fest eingetragene Dienst wird gestartet, nie ein URL-Parameter.
        $self = $MyInvocation.MyCommand.Path
        $argsLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $self + '" -Elevated'
        Start-Process -FilePath "powershell.exe" -ArgumentList $argsLine -Verb RunAs -ErrorAction Stop
      }
    }
    exit 0
  }

  # Rueckwaertskompatibilitaet: alter Misch-PC-Installer ohne Windows-Dienst.
  $legacy = Join-Path $env:LOCALAPPDATA "KRISTINE\PaintLocalBridge\kristine-paint-local-bridge.ps1"
  if (-not (Test-Path -LiteralPath $legacy)) {
    throw "Weder KRISTINE-Windows-Dienst noch lokale Hardware-Bridge installiert."
  }

  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:17831/health" -TimeoutSec 2
    if ($health.ok) { exit 0 }
  }
  catch {}

  $argsLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $legacy + '"'
  Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList $argsLine -ErrorAction Stop
  exit 0
}
catch {
  $log = Join-Path $env:TEMP "kristine-paint-start-error.log"
  "$(Get-Date -Format s) $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding UTF8
  exit 1
}
