param(
    [ValidateSet('Probe','Sync','Worker','Install')]
    [string]$Mode = 'Probe',
    [string]$InnovatintBaseUrl = 'http://127.0.0.1:9502',
    [string]$KristineBaseUrl = 'https://protokoll.krista.at',
    [string]$BridgeToken = $env:KRISTINE_LG_BRIDGE_TOKEN,
    [string]$HistoryService = '',
    [int]$PollMinutes = 15
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$StatePath = 'C:\KRISTINE\innovatint-history-state.json'
$LogPath = 'C:\KRISTINE\innovatint-history-sync.log'

function Write-Log([string]$Text) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Text"
    Write-Host $line
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null
        Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    } catch {}
}

function Read-State {
    try { return Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return [pscustomobject]@{} }
}
function Save-State($State) {
    New-Item -ItemType Directory -Force -Path (Split-Path $StatePath) | Out-Null
    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Invoke-InnovatintPost([string]$Service, [hashtable]$Body) {
    $uri = "$InnovatintBaseUrl/suite6/test/$Service"
    $result = Invoke-RestMethod -Uri $uri -Method Post -Body $Body -TimeoutSec 20
    if ($null -ne $result.error -and [string]$result.error -ne '') { throw "Innovatint $Service: $($result.error)" }
    return $result.r
}

function Get-HistoryBody([datetime]$From, [datetime]$To, [string]$Service) {
    $fromIso = $From.ToString('yyyy-MM-ddTHH:mm:ss')
    $toIso = $To.ToString('yyyy-MM-ddTHH:mm:ss')
    $fromDate = $From.ToString('yyyy-MM-dd')
    $toDate = $To.ToString('yyyy-MM-dd')
    return @{
        method = $Service; callsCounter = '1'; filter = ''; search = ''; maxResults = '5000'; startingFrom = ''
        from = $fromIso; to = $toIso; fromDate = $fromDate; toDate = $toDate
        dateFrom = $fromDate; dateTo = $toDate; startDate = $fromDate; endDate = $toDate
        customOnly = 'False'; customFormulasOnly = 'False'; zoneID = ''
    }
}

function Get-NestedValue($Object, [string]$Path) {
    $current = $Object
    foreach ($part in $Path.Split('.')) {
        if ($null -eq $current) { return $null }
        $prop = $current.PSObject.Properties[$part]
        if ($null -eq $prop) { return $null }
        $current = $prop.Value
    }
    return $current
}

function Get-OrderDate($Row) {
    $paths = @('dispensedAt','dispenseAt','dispenseDateTime','tintedAt','completedAt','modificationDate','creationDate','createdAt','orderDateTime','orderDate','timestamp','modifiedAt')
    foreach ($path in $paths) {
        $v = Get-NestedValue $Row $path
        if ($null -eq $v -or [string]::IsNullOrWhiteSpace([string]$v)) { continue }
        $dt = [datetime]::MinValue
        if ([datetime]::TryParse([string]$v, [ref]$dt)) { return $dt }
    }
    return $null
}

function Looks-LikeOrder($Row) {
    if ($null -eq $Row) { return $false }
    foreach ($name in @('orderID','orderId','id','productName','colourCode','colorCode','baseCode','modificationDate','creationDate')) {
        if ($null -ne $Row.PSObject.Properties[$name]) { return $true }
    }
    return $false
}

function Find-HistoryServicesInFiles {
    $roots = @(
        'C:\Program Files (x86)\CPSColor', 'C:\Program Files\CPSColor',
        'C:\Program Files (x86)\Innovatint', 'C:\Program Files\Innovatint',
        'C:\ProgramData\CPSColor', 'C:\ProgramData\Innovatint'
    ) | Where-Object { Test-Path $_ }
    $hits = New-Object System.Collections.Generic.HashSet[string]
    foreach ($root in $roots) {
        try {
            Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Length -lt 5000000 -and $_.Extension -match '^\.(py|js|html|htm|txt|json)$' } |
                ForEach-Object {
                    try {
                        $text = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction Stop
                        foreach ($m in [regex]::Matches($text, '(?i)(?:suite6/test/)?([a-z0-9_]*(?:order|history)[a-z0-9_]*(?:search|list|get|details)[a-z0-9_]*)')) {
                            [void]$hits.Add($m.Groups[1].Value.ToLowerInvariant())
                        }
                    } catch {}
                }
        } catch {}
    }
    return @($hits)
}

function Resolve-HistoryService([datetime]$From, [datetime]$To) {
    $state = Read-State
    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($HistoryService)) { $candidates.Add($HistoryService) }
    if ($state.historyService) { $candidates.Add([string]$state.historyService) }
    foreach ($s in (Find-HistoryServicesInFiles)) { if (-not $candidates.Contains($s)) { $candidates.Add($s) } }
    foreach ($s in @('orders_search','order_search','history_orders_search','orders_history_search','order_history_search','history_search','orders_list','history_list')) {
        if (-not $candidates.Contains($s)) { $candidates.Add($s) }
    }

    foreach ($service in $candidates) {
        try {
            $raw = Invoke-InnovatintPost -Service $service -Body (Get-HistoryBody -From $From -To $To -Service $service)
            $rows = @($raw)
            if ($rows.Count -gt 0 -and ($rows | Where-Object { Looks-LikeOrder $_ } | Select-Object -First 1)) {
                return [pscustomobject]@{ service = $service; rows = $rows }
            }
        } catch {
            Write-Log "Probe $service: $($_.Exception.Message)"
        }
    }
    throw 'Kein History-Service erkannt. Probe-Log liegt unter C:\KRISTINE\innovatint-history-sync.log.'
}

function Get-SyncWindow {
    $state = Read-State
    $now = Get-Date
    if ($state.lastSuccessfulAt) {
        try { $from = ([datetime]$state.lastSuccessfulAt).AddMinutes(-30) } catch { $from = $now.Date.AddHours(6) }
    } else {
        $from = $now.Date.AddHours(6)
        if ($now -lt $from) { $from = $now.AddHours(-2) }
    }
    return [pscustomobject]@{ from = $from; to = $now; state = $state }
}

function Send-History($Rows, [datetime]$TaskCutoff, [string]$Service) {
    if ([string]::IsNullOrWhiteSpace($BridgeToken)) { throw 'KRISTINE_LG_BRIDGE_TOKEN fehlt.' }
    $payload = @{
        machine = $env:COMPUTERNAME
        rows = @($Rows)
        createTasks = $true
        taskCutoff = $TaskCutoff.ToString('o')
        source = $Service
    } | ConvertTo-Json -Depth 15 -Compress
    $headers = @{ 'X-LG-Bridge-Token' = $BridgeToken }
    return Invoke-RestMethod -Uri "$KristineBaseUrl/admin/api/paint/bridge/history" -Method Post -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 30
}

function Sync-Once {
    $window = Get-SyncWindow
    $resolved = Resolve-HistoryService -From $window.from -To $window.to
    $rows = @($resolved.rows)
    $dated = @($rows | ForEach-Object {
        $d = Get-OrderDate $_
        if ($null -ne $d -and $d -ge $window.from.AddMinutes(-1) -and $d -le $window.to.AddMinutes(5)) { $_ }
    })
    if ($dated.Count -gt 0) { $rows = $dated }
    elseif ($rows.Count -gt 200) { throw "History-Service liefert $($rows.Count) Datensaetze ohne erkennbares Datum; Sicherheitsabbruch." }

    $result = Send-History -Rows $rows -TaskCutoff $window.from -Service $resolved.service
    $state = $window.state
    $state | Add-Member -NotePropertyName historyService -NotePropertyValue $resolved.service -Force
    $state | Add-Member -NotePropertyName lastSuccessfulAt -NotePropertyValue (Get-Date).ToString('o') -Force
    $state | Add-Member -NotePropertyName lastSentRows -NotePropertyValue $rows.Count -Force
    $state | Add-Member -NotePropertyName lastAddedRows -NotePropertyValue ([int]$result.added) -Force
    Save-State $state
    Write-Log "History $($resolved.service): $($rows.Count) gelesen, $($result.added) neu, $($result.tasksCreated) Aufgaben."
    return $result
}

function In-WorkWindow {
    $now = Get-Date
    if ($now.DayOfWeek -in @([DayOfWeek]::Saturday,[DayOfWeek]::Sunday)) { return $false }
    return ($now.TimeOfDay -ge ([timespan]::FromHours(6)) -and $now.TimeOfDay -le ([timespan]::FromHours(18)))
}

function Install-HistorySync {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'PowerShell als Administrator starten.' }
    if ([string]::IsNullOrWhiteSpace($BridgeToken)) { throw 'KRISTINE_LG_BRIDGE_TOKEN fehlt.' }
    $dir = 'C:\KRISTINE'
    $target = Join-Path $dir 'innovatint-history-sync.ps1'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item -LiteralPath $PSCommandPath -Destination $target -Force
    [Environment]::SetEnvironmentVariable('KRISTINE_LG_BRIDGE_TOKEN', $BridgeToken, 'Machine')

    try { Stop-ScheduledTask -TaskName 'KRISTINE Innovatint Bridge' -ErrorAction SilentlyContinue } catch {}
    try { Disable-ScheduledTask -TaskName 'KRISTINE Innovatint Bridge' -ErrorAction SilentlyContinue | Out-Null } catch {}

    $args = "-NoProfile -ExecutionPolicy Bypass -File `"$target`" -Mode Worker -KristineBaseUrl `"$KristineBaseUrl`" -InnovatintBaseUrl `"$InnovatintBaseUrl`""
    if (-not [string]::IsNullOrWhiteSpace($HistoryService)) { $args += " -HistoryService `"$HistoryService`"" }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $args
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'KRISTINE Innovatint History Sync' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    Start-ScheduledTask -TaskName 'KRISTINE Innovatint History Sync'
    Write-Log 'Installiert: History-Sync. Alter Dauer-Live-Worker deaktiviert.'
}

if ($Mode -eq 'Install') { Install-HistorySync; exit 0 }
if ($Mode -eq 'Probe') {
    $from = (Get-Date).AddDays(-2); $to = Get-Date
    $resolved = Resolve-HistoryService -From $from -To $to
    Write-Host "GEFUNDEN: $($resolved.service) · $(@($resolved.rows).Count) Datensaetze"
    @($resolved.rows) | Select-Object -First 3 | ConvertTo-Json -Depth 12
    exit 0
}
if ($Mode -eq 'Sync') { Sync-Once | ConvertTo-Json -Depth 8; exit 0 }

Write-Log 'KRISTINE Innovatint History Worker gestartet.'
$lastRun = [datetime]::MinValue
while ($true) {
    if (In-WorkWindow -and ((Get-Date) - $lastRun).TotalMinutes -ge [math]::Max(5,$PollMinutes)) {
        try { Sync-Once | Out-Null } catch { Write-Log "SYNC FEHLER: $($_.Exception.Message)" }
        $lastRun = Get-Date
    }
    Start-Sleep -Seconds 60
}
