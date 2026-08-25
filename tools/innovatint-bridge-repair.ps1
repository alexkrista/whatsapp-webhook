param(
    [string]$TaskName = 'KRISTINE Innovatint Bridge'
)

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Bitte PowerShell als Administrator starten.'
}

Write-Host 'KRISTINE Innovatint Bridge absichern ...'

# Misch-PC am Netz darf den Bridge-Prozess nicht durch Standby/Ruhezustand verlieren.
# Der Bildschirm darf sich weiterhin abschalten.
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$taskNow = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host ''
Write-Host ('Task:       ' + $taskNow.TaskName)
Write-Host ('Status:     ' + $taskNow.State)
Write-Host ('Letzter Lauf: ' + $info.LastRunTime)
Write-Host ('Resultat:   ' + $info.LastTaskResult)
Write-Host ''
Write-Host 'Netzbetrieb: Standby AUS, Ruhezustand AUS. Bildschirm darf weiterhin ausgehen.'
Write-Host 'KRISTINE sollte innerhalb von ca. 60 Sekunden wieder Mischmaschine LIVE anzeigen.'
