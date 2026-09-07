$ErrorActionPreference = "Stop"
$TargetDirectory = Join-Path $env:LOCALAPPDATA "KristineTapiConnector"
$ConnectorTarget = Join-Path $TargetDirectory "KristineTapiConnector.ps1"
$ShortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "Kristine TAPI Connector.lnk"

Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
  Where-Object { $_.CommandLine -like "*$ConnectorTarget*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

if (Test-Path -LiteralPath $ShortcutPath) { Remove-Item -LiteralPath $ShortcutPath -Force }
if (Test-Path -LiteralPath $TargetDirectory) { Remove-Item -LiteralPath $TargetDirectory -Recurse -Force }

Write-Host "Kristine TAPI Connector wurde entfernt."
