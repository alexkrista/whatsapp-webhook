$ErrorActionPreference='Stop'
$target=Join-Path $env:LOCALAPPDATA 'KRISTINE\HistorySync'
$worker=Join-Path $target 'innovatint-order-history-worker.ps1'
New-Item -ItemType Directory -Path $target -Force|Out-Null
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -like ('*'+$worker+'*')} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'innovatint-order-history-worker.ps1') -Destination $worker -Force
$config=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Verbindung.json') -Raw -Encoding UTF8|ConvertFrom-Json
$secure=ConvertTo-SecureString ([string]$config.token) -AsPlainText -Force
ConvertFrom-SecureString $secure|Set-Content -LiteralPath (Join-Path $target 'connection.key') -Encoding ASCII
@{url=[string]$config.url;machine=$env:COMPUTERNAME}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $target 'connection.json') -Encoding UTF8
Write-Host 'Erste Uebernahme der vorhandenen Historie. Kein Lagerabzug. Bitte warten ...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $worker -Mode Once
if($LASTEXITCODE -ne 0){throw 'Erste Uebernahme fehlgeschlagen. Bitte die angezeigte Meldung schicken.'}
$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force|Out-Null
$value='powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$worker+'" -Mode Watch'
Set-ItemProperty -Path $runKey -Name 'KRISTINEHistorySync' -Value $value
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$worker+'"'),'-Mode','Watch')
Write-Host 'FERTIG: Mischhistorie verbunden. Kontrolle taeglich 06:15-18:30 jede Minute. Autostart eingerichtet.'
Write-Host ('Statusdatei: '+(Join-Path $target 'Status.txt'))
