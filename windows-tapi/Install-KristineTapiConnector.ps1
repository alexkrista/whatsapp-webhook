param(
  [string]$LineName = "snom Line 1"
)

$ErrorActionPreference = "Stop"
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetDirectory = Join-Path $env:LOCALAPPDATA "KristineTapiConnector"
$ConnectorSource = Join-Path $SourceDirectory "KristineTapiConnector.ps1"
$ConnectorTarget = Join-Path $TargetDirectory "KristineTapiConnector.ps1"
$ConfigTarget = Join-Path $TargetDirectory "config.json"

if (-not (Test-Path -LiteralPath $ConnectorSource)) {
  throw "KristineTapiConnector.ps1 liegt nicht neben dem Installationsskript."
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
Copy-Item -LiteralPath $ConnectorSource -Destination $ConnectorTarget -Force
@{ lineName = $LineName } | ConvertTo-Json | Set-Content -LiteralPath $ConfigTarget -Encoding UTF8

$shell = New-Object -ComObject WScript.Shell
$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "Kristine TAPI Connector.lnk"
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ConnectorTarget`""
$shortcut.WorkingDirectory = $TargetDirectory
$shortcut.Description = "Kristine TAPI Connector"
$shortcut.Save()

Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
  Where-Object { $_.CommandLine -like "*$ConnectorTarget*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $TargetDirectory -WindowStyle Hidden
Start-Sleep -Seconds 2

Write-Host "Kristine TAPI Connector wurde installiert und gestartet."
Write-Host "TAPI-Leitung: $LineName"
Write-Host "Installation: $TargetDirectory"
Write-Host "Bitte Kristine im Browser neu laden und einen Anruf testen."
