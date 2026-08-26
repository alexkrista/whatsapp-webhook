$ErrorActionPreference = 'Stop'

$TaskName = 'KRISTA Dienstemanager'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $RepoRoot 'krista_service_manager_bg.py'
$Port = 8765

Write-Host ''
Write-Host 'KRISTA Dienstemanager wird als Windows-SYSTEM-Dienst eingerichtet ...' -ForegroundColor Cyan

if (-not (Test-Path $Runner)) {
    throw "Runner fehlt: $Runner"
}

$PythonExe = ''
try {
    $PythonExe = (& py -3 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1).Trim()
} catch {}
if (-not $PythonExe) {
    try { $PythonExe = (Get-Command python -ErrorAction Stop).Source } catch {}
}
if (-not $PythonExe -or -not (Test-Path $PythonExe)) {
    throw 'Python wurde nicht gefunden.'
}

# Alten Benutzer-Prozess beenden, damit Port 8765 frei ist.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'krista_service_manager(_bg)?\.py' } |
    ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
Start-Sleep -Milliseconds 900

$ActionArgs = @{
    Execute = $PythonExe
    Argument = ('"' + $Runner + '"')
    WorkingDirectory = $RepoRoot
}
$Action = New-ScheduledTaskAction @ActionArgs
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$SettingsArgs = @{
    StartWhenAvailable = $true
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    MultipleInstances = 'IgnoreNew'
    RestartCount = 5
    RestartInterval = (New-TimeSpan -Minutes 1)
}
$Settings = New-ScheduledTaskSettingsSet @SettingsArgs

$RegisterArgs = @{
    TaskName = $TaskName
    Action = $Action
    Trigger = $Trigger
    Principal = $Principal
    Settings = $Settings
    Description = 'KRISTA lokaler Dienstemanager. Startet und ueberwacht lokale KRISTA-Dienste.'
    Force = $true
}
Register-ScheduledTask @RegisterArgs | Out-Null
Start-ScheduledTask -TaskName $TaskName

$Ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
        if ($Health.ok) {
            $Ready = $true
            break
        }
    } catch {}
}

if (-not $Ready) {
    $State = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
    throw "Dienstemanager wurde eingerichtet, antwortet aber nicht auf Port $Port. Task-Status: $State"
}

Write-Host ''
Write-Host 'OK - KRISTA Dienstemanager laeuft jetzt als SYSTEM im Hintergrund.' -ForegroundColor Green
Write-Host 'Autostart bei Windows-Start ist eingerichtet.' -ForegroundColor Green
Write-Host 'Jetzt KRISADMIN -> Dienste -> Aktualisieren.' -ForegroundColor White
Write-Host ''
Start-Sleep -Seconds 4
