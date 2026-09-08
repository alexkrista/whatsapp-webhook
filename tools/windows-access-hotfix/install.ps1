$ErrorActionPreference = "Stop"

$zutrittTarget = "C:\Kristine\Zutritt\kristine_zutritt.py"
$bridgeTarget = "C:\Kristine\AccessBridge\access_bridge.py"
$running = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match "kristine_zutritt\.py|access_bridge\.py"
}

if ($running) {
    Write-Host "KRISTINE Zutritt und Access Bridge werden beendet ..." -ForegroundColor Yellow
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
foreach ($target in @($zutrittTarget, $bridgeTarget)) {
    $folder = Split-Path $target
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    if (Test-Path $target) {
        Copy-Item $target "$target.$stamp.bak" -Force
    }
}

Copy-Item (Join-Path $PSScriptRoot "kristine_zutritt.py") $zutrittTarget -Force
Copy-Item (Join-Path $PSScriptRoot "access_bridge.py") $bridgeTarget -Force

Write-Host "Chip-Lese-Hotfix wurde installiert." -ForegroundColor Green
Write-Host "Der Tibbo wird jetzt nur waehrend 'Chip einlesen' und nur alle 5 Sekunden abgefragt."
Write-Host "Bitte den PC jetzt neu starten."
