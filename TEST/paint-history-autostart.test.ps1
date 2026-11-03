$ErrorActionPreference="Stop"
$scriptPath=Join-Path $PSScriptRoot "..\tools\repair-innovatint-history-autostart.ps1"
$script=Get-Content -LiteralPath $scriptPath -Raw -Encoding UTF8
$tokens=$null;$errors=$null
[void][Management.Automation.Language.Parser]::ParseInput($script,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) {
  $errors|Format-List
  throw "Repair script syntax invalid"
}
foreach ($text in @(
  "KRISTINE Innovatint History Sync","connection.key","ConvertTo-SecureString",
  "HistorySync","-Mode Once","Mode -eq 'Once'", "PT1M",
  "PT12H15M","TASK_LOGON_INTERACTIVE_TOKEN",
  "RegisterTaskDefinition","NoImmediateSync","Mode\s+Watch"
)) {
  if (-not $script.Contains($text)) {throw "Safeguard or behaviour missing: $text"}
}
# Testen der Task-Scheduler-COM-Einstellungen, OHNE einen Task zu installieren
# oder eine echte Mischmaschine zu kontaktieren.
$schedule=New-Object -ComObject "Schedule.Service"
$schedule.Connect()
$task=$schedule.NewTask(0)
$task.Principal.UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$task.Principal.LogonType=3
$task.Settings.StartWhenAvailable=$true
$task.Settings.MultipleInstances=2
$task.Settings.ExecutionTimeLimit="PT30M"
$task.Settings.RestartCount=3
$task.Settings.RestartInterval="PT1M"
$trigger=$task.Triggers.Create(2)
$trigger.StartBoundary=(Get-Date -Hour 6 -Minute 15 -Second 0).ToString("s")
$trigger.DaysInterval=1
$trigger.Repetition.Interval="PT1M"
$trigger.Repetition.Duration="PT12H15M"
$trigger.Enabled=$true
$login=$task.Triggers.Create(9)
$login.UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$login.Delay="PT20S"
$login.Enabled=$true
$action=$task.Actions.Create(0)
$action.Path=Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$action.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Test\worker.ps1" -Mode Once'
$taskXml=[string]$task.XmlText
Write-Output ("Task XML (read-only test): " + $taskXml.Substring(0,[Math]::Min(3500,$taskXml.Length)))
if ($taskXml -notmatch "PT12H15M" -or $taskXml -notmatch "PT1M" -or $taskXml -notmatch "LogonTrigger" -or $taskXml -notmatch "ScheduleByDay") {
  throw "Task Scheduler did not produce expected daily/logon XML"
}
if ($taskXml -notmatch "InteractiveToken") {throw "Task must execute as currently logged-on user (DPAPI)"}
Write-Output "HistorySync repair COM schedule verified: no task installed; no live data used"
