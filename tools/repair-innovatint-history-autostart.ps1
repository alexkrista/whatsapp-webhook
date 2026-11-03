param([switch]$CheckOnly, [switch]$NoImmediateSync)

# Repair for the ORIGINAL Innovatint history worker, NOT the Zebra label bridge.
# Run in a NORMAL PowerShell window as the user who operates Innovatint
# (usually LG). This task uses that user's existing DPAPI-encrypted token.
$ErrorActionPreference = "Stop"
$taskName = "KRISTINE Innovatint History Sync"
$root = Join-Path $env:LOCALAPPDATA "KRISTINE\HistorySync"
$worker = Join-Path $root "innovatint-order-history-worker.ps1"
$connection = Join-Path $root "connection.json"
$encryptedKey = Join-Path $root "connection.key"
$statusFile = Join-Path $root "Status.txt"
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name

Write-Host "KRISTINE | Mischhistorie - dauerhaften Autostart pruefen" -ForegroundColor Cyan
Write-Host "Windows-Benutzer: $account"
Write-Host "HistorySync-Ordner: $root"

foreach ($file in @($worker,$connection,$encryptedKey)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "HistorySync fehlt: $file. Erstinstallation muss unter dem bisherigen Misch-PC-Benutzer erfolgen. Keine bestehenden Dateien werden geloescht."
    }
}

# Sicherstellen, dass der aktuelle Windows-Benutzer denselben DPAPI-Schluessel
# lesen kann wie der vorhandene Worker. Token niemals anzeigen oder versenden.
try {
    $keyText = (Get-Content -LiteralPath $encryptedKey -Raw).Trim()
    $verifyKey = ConvertTo-SecureString $keyText -ErrorAction Stop
    if (-not $verifyKey -or $verifyKey.Length -lt 16) { throw "Schluessel unvollstaendig" }
} catch {
    throw "Der verschluesselte HistorySync-Schluessel gehoert zu einem anderen Windows-Benutzer. Nicht als anderer Administrator ausfuehren; bitte als bisheriger Misch-PC-Benutzer LG anmelden."
}
$config = Get-Content -LiteralPath $connection -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$config.url) -or
    -not ([string]$config.url).StartsWith("https://") -or
    [string]::IsNullOrWhiteSpace([string]$config.machine)) {
    throw "HistorySync-Verbindung unvollstaendig. Keine Aenderung."
}
$code = Get-Content -LiteralPath $worker -Raw -Encoding UTF8
if ($code -notmatch "function Sync-Once" -or $code -notmatch "Mode -eq 'Once'") {
    throw "HistorySync-Worker nicht erkannt. Keine Aenderung."
}

$service = New-Object -ComObject "Schedule.Service"
$service.Connect()
$taskFolder = $service.GetFolder("\")
if ($CheckOnly) {
    try {
        $existing = $taskFolder.GetTask("\$taskName")
        Write-Host ("Task: " + $existing.Name + " | State: " + $existing.State)
        Write-Host ("Letzter Start: " + $existing.LastRunTime + " | Ergebnis: " + $existing.LastTaskResult)
    } catch { Write-Host "Noch kein dauerhaft geplanter Task eingerichtet." }
    if (Test-Path -LiteralPath $statusFile) {
        Get-Content -LiteralPath $statusFile -Tail 3
    }
    exit 0
}

$definition = $service.NewTask(0)
$definition.RegistrationInfo.Author = $account
$definition.RegistrationInfo.Description = "KRISTINE Mischhistorie: jede Minute waehrend der Arbeitszeit nach Innovatint schauen; fehlende Mischungen ohne doppelten Lagerabgang nachholen."
$definition.Principal.UserId = $account
$definition.Principal.LogonType = 3  # TASK_LOGON_INTERACTIVE_TOKEN: ohne Kennwort, unter LG
$definition.Principal.RunLevel = 0   # Kein Administrator erforderlich
$definition.Settings.Enabled = $true
$definition.Settings.StartWhenAvailable = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.AllowDemandStart = $true
$definition.Settings.MultipleInstances = 2  # TASK_INSTANCES_IGNORE_NEW
$definition.Settings.ExecutionTimeLimit = "PT30M"
$definition.Settings.RestartCount = 3
$definition.Settings.RestartInterval = "PT1M"

# 06:15-18:30, taeglich alle 60 Sekunden. Im Gegensatz zum alten HKCU\Run
# startet Windows fuer jede Runde einen frischen Worker: kein verlorener
# Dauerprozess nach Neustart/Crash/Abmeldung.
$daily = $definition.Triggers.Create(2)  # TASK_TRIGGER_DAILY
$daily.StartBoundary = (Get-Date -Hour 6 -Minute 15 -Second 0).ToString("s")
$daily.DaysInterval = 1
$daily.Repetition.Interval = "PT1M"
$daily.Repetition.Duration = "PT12H15M"
$daily.Repetition.StopAtDurationEnd = $false
$daily.Enabled = $true

# Nach interaktiver Windows-Anmeldung eine sofortige Nachholrunde ausfuehren.
$logon = $definition.Triggers.Create(9)  # TASK_TRIGGER_LOGON
$logon.UserId = $account
$logon.Delay = "PT20S"
$logon.Enabled = $true

$action = $definition.Actions.Create(0)  # TASK_ACTION_EXEC
$action.Path = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $worker + '" -Mode Once'
$action.WorkingDirectory = $root

# Bestehenden Task dieses Namens aktualisieren, ohne Historie/Token/State zu aendern.
$registered = $taskFolder.RegisterTaskDefinition(
    $taskName, $definition, 6, $account, $null, 3, $null
)
Write-Host "AUTOSTART eingerichtet: alle 60 Sekunden von 06:15 bis 18:30 und bei LG-Anmeldung." -ForegroundColor Green
Write-Host "Eingesetzter Task: $($registered.Name)"
Write-Host "Daten, Token und bereits importierte Mischungen wurden NICHT geloescht."

# Nur den frueheren reinen Dauerlauf-Autostart entfernen, wenn er zu
# diesem exakten Worker gehoert. So kaempfen nicht 2 Autostarts gegeneinander.
$run = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
try {
    $legacy = (Get-ItemProperty -Path $run -Name "KRISTINEHistorySync" -ErrorAction SilentlyContinue).KRISTINEHistorySync
    if ($legacy -and $legacy.IndexOf($worker,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $legacy -match "\-Mode\s+Watch") {
        Remove-ItemProperty -Path $run -Name "KRISTINEHistorySync" -ErrorAction Stop
        Write-Host "Alten nur bei Anmeldung gestarteten Dauerlauf-Autostart ersetzt."
    }
} catch {
    Write-Warning ("Alten Run-Autostart nicht entfernt: " + $_.Exception.Message)
}

# Nach der Planung genau EINEN realen Nachhol-Check ausfuehren.
# Der Worker sendet nur neue, eindeutige Misch-History-Eintraege.
# Alle Lager-Abgaenge erfolgen erst nach manueller Zuordnung in KRISTINE.
if (-not $NoImmediateSync) {
    Write-Host "HEUTIGE MISCHUNGEN NACHHOLEN:" -ForegroundColor Cyan
    & $action.Path -NoProfile -ExecutionPolicy Bypass -File $worker -Mode Once
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Einmalige HistorySync-Runde fehlgeschlagen; Task bleibt installiert."
    }
}
if (Test-Path -LiteralPath $statusFile) {
    Write-Host "Letzte HistorySync-Meldung:"
    Get-Content -LiteralPath $statusFile -Tail 2
}
Write-Host "Danach KRISTINE > Mischungen > Neu laden."
