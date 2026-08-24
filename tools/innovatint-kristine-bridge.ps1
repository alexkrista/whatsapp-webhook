param(
    [ValidateSet('Test','Worker','Install')]
    [string]$Mode = 'Test',

    [string]$Query = 'Stock 37',
    [int]$ColourId = 0,

    [string]$InnovatintBaseUrl = 'http://127.0.0.1:9502',
    [string]$KristineBaseUrl = 'https://protokoll.krista.at',
    [string]$BridgeToken = $env:KRISTINE_LG_BRIDGE_TOKEN,

    [int]$PollSeconds = 2
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-InnovatintPost {
    param(
        [Parameter(Mandatory=$true)][string]$Service,
        [Parameter(Mandatory=$true)][hashtable]$Body
    )

    $uri = "$InnovatintBaseUrl/suite6/test/$Service"
    $result = Invoke-RestMethod -Uri $uri -Method Post -Body $Body -TimeoutSec 15
    if ($null -ne $result.error) {
        throw "Innovatint $Service meldet Fehler: $($result.error)"
    }
    return $result.r
}

function Search-InnovatintColours {
    param([Parameter(Mandatory=$true)][string]$Text)

    $body = @{
        method               = 'colours_search'
        callsCounter         = '1'
        filter               = $Text
        productID            = ''
        maxResults           = '80'
        compOnly             = 'False'
        matchType            = '1'
        cardID               = ''
        barcode              = ''
        mostUsed             = 'False'
        measuredOnly         = 'False'
        startingFrom         = ''
        cardMode             = 'False'
        cardsInfo            = 'True'
        mostUsedMaxResults   = ''
        matchAllCodes        = 'False'
        preferredCardsFirst  = 'True'
        cardsOnly            = 'False'
        zoneID               = ''
    }

    $rows = @(Invoke-InnovatintPost -Service 'colours_search' -Body $body)

    return @($rows | ForEach-Object {
        $card = ''
        $cardId = $null
        if ($null -ne $_.preferredCard) {
            $card = [string]$_.preferredCard.name
            $cardId = $_.preferredCard.id
        }
        [pscustomobject]@{
            id         = [int]$_.id
            code       = [string]$_.code
            uniqueCode = [string]$_.uniqueCode
            rgb        = $_.rgb
            card       = $card
            cardId     = $cardId
            compatible = [bool]$_.comp
        }
    })
}

function Get-InnovatintProductsForColour {
    param([Parameter(Mandatory=$true)][int]$Id)

    $body = @{
        method             = 'products_search'
        callsCounter       = '1'
        filter             = ''
        colourID           = [string]$Id
        maxResults         = '100'
        matchType          = '1'
        compOnly           = 'True'
        checkMatching      = 'True'
        startingFrom       = ''
        mostUsed           = 'False'
        mostUsedMaxResults = ''
        excludeDisabled    = 'True'
        tags               = ''
        compatibleFirst    = 'True'
        preferredFirst     = 'True'
        zoneID             = ''
    }

    $rows = @(Invoke-InnovatintPost -Service 'products_search' -Body $body)

    return @($rows |
        Where-Object { $_.comp -eq $true -and $_.enabled -ne $false } |
        ForEach-Object {
            [pscustomobject]@{
                id        = [int]$_.id
                name      = [string]$_.name
                baseCode  = [string]$_.baseCode
                preferred = [bool]$_.preferred
                enabled   = [bool]$_.enabled
            }
        })
}

function Test-InnovatintConnection {
    try {
        $r = Invoke-WebRequest -Uri "$InnovatintBaseUrl/suite6" -UseBasicParsing -TimeoutSec 5
        return ($r.StatusCode -eq 200)
    }
    catch {
        return $false
    }
}

function Get-BridgeHeaders {
    if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
        throw 'KRISTINE_LG_BRIDGE_TOKEN fehlt.'
    }
    return @{ 'X-LG-Bridge-Token' = $BridgeToken }
}

function Send-Heartbeat {
    param([bool]$InnovatintOnline)

    try {
        $body = @{
            machine          = $env:COMPUTERNAME
            innovatintOnline = $InnovatintOnline
            bridgeVersion    = '1.0.0'
            timestamp        = (Get-Date).ToString('o')
        } | ConvertTo-Json -Compress

        $params = @{
            Uri         = "$KristineBaseUrl/admin/api/paint/bridge/heartbeat"
            Method      = 'Post'
            Headers     = (Get-BridgeHeaders)
            ContentType = 'application/json'
            Body        = $body
            TimeoutSec  = 10
        }
        Invoke-RestMethod @params | Out-Null
    }
    catch {
        Write-Warning "Heartbeat fehlgeschlagen: $($_.Exception.Message)"
    }
}

function Get-NextBridgeRequest {
    try {
        $params = @{
            Uri        = "$KristineBaseUrl/admin/api/paint/bridge/next"
            Method     = 'Get'
            Headers    = (Get-BridgeHeaders)
            TimeoutSec = 15
        }
        return Invoke-RestMethod @params
    }
    catch {
        Write-Warning "KRISTINE nicht erreichbar: $($_.Exception.Message)"
        return $null
    }
}

function Send-BridgeResult {
    param(
        [Parameter(Mandatory=$true)][string]$RequestId,
        [Parameter(Mandatory=$true)][bool]$Ok,
        $Data = $null,
        [string]$ErrorText = ''
    )

    $body = @{
        requestId = $RequestId
        ok        = $Ok
        data      = $Data
        error     = $ErrorText
        machine   = $env:COMPUTERNAME
        timestamp = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 12 -Compress

    $params = @{
        Uri         = "$KristineBaseUrl/admin/api/paint/bridge/result"
        Method      = 'Post'
        Headers     = (Get-BridgeHeaders)
        ContentType = 'application/json'
        Body        = $body
        TimeoutSec  = 15
    }
    Invoke-RestMethod @params | Out-Null
}

function Process-BridgeRequest {
    param($Request)

    if (-not $Request -or -not $Request.requestId) { return }
    $requestId = [string]$Request.requestId

    try {
        switch ([string]$Request.operation) {
            'searchColours' {
                $text = [string]$Request.query
                if ([string]::IsNullOrWhiteSpace($text)) { throw 'Suchtext fehlt.' }
                $data = Search-InnovatintColours -Text $text
                Send-BridgeResult -RequestId $requestId -Ok $true -Data $data
            }
            'productsForColour' {
                $id = [int]$Request.colourId
                if ($id -le 0) { throw 'colourId fehlt.' }
                $data = Get-InnovatintProductsForColour -Id $id
                Send-BridgeResult -RequestId $requestId -Ok $true -Data $data
            }
            default {
                throw "Unbekannte Operation: $($Request.operation)"
            }
        }
    }
    catch {
        try {
            Send-BridgeResult -RequestId $requestId -Ok $false -ErrorText $_.Exception.Message
        }
        catch {
            Write-Warning "Fehlerantwort konnte nicht gesendet werden: $($_.Exception.Message)"
        }
    }
}

function Install-Bridge {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Install muss in PowerShell als Administrator ausgefuehrt werden.'
    }
    if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
        throw 'Beim Installieren BridgeToken angeben oder KRISTINE_LG_BRIDGE_TOKEN vorher setzen.'
    }

    $dir = 'C:\KRISTINE'
    $target = Join-Path $dir 'innovatint-kristine-bridge.ps1'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item -LiteralPath $PSCommandPath -Destination $target -Force
    [Environment]::SetEnvironmentVariable('KRISTINE_LG_BRIDGE_TOKEN', $BridgeToken, 'Machine')

    $taskName = 'KRISTINE Innovatint Bridge'
    $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$target`" -Mode Worker -KristineBaseUrl `"$KristineBaseUrl`" -InnovatintBaseUrl `"$InnovatintBaseUrl`""
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName

    Write-Host "Installiert: $target"
    Write-Host "Autostart:    $taskName"
}

if ($Mode -eq 'Install') {
    Install-Bridge
    exit 0
}

if ($Mode -eq 'Test') {
    Write-Host "Pruefe Innovatint unter $InnovatintBaseUrl ..."
    if (-not (Test-InnovatintConnection)) {
        throw 'Innovatint/Suite6 ist lokal nicht erreichbar.'
    }

    if ($ColourId -gt 0) {
        Get-InnovatintProductsForColour -Id $ColourId | Format-Table name,baseCode,id -AutoSize
        exit 0
    }

    Write-Host "Suche Farbton: $Query"
    $colours = @(Search-InnovatintColours -Text $Query)
    if ($colours.Count -eq 0) {
        Write-Host 'Kein Farbton gefunden.'
        exit 0
    }

    $colours | Format-Table id,code,card -AutoSize

    if ($colours.Count -eq 1) {
        Write-Host "`nMischbare Produkte fuer $($colours[0].code):"
        Get-InnovatintProductsForColour -Id $colours[0].id | Format-Table name,baseCode,id -AutoSize
    }
    exit 0
}

Write-Host 'KRISTINE Little Greene Bridge startet.'
Write-Host "Mischmaschine: $env:COMPUTERNAME"
Write-Host "Innovatint:    $InnovatintBaseUrl"
Write-Host "KRISTINE:      $KristineBaseUrl"

if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
    throw 'KRISTINE_LG_BRIDGE_TOKEN fehlt.'
}

$lastHeartbeat = [datetime]::MinValue
while ($true) {
    $online = Test-InnovatintConnection

    if ((Get-Date) - $lastHeartbeat -gt [timespan]::FromMinutes(1)) {
        Send-Heartbeat -InnovatintOnline $online
        $lastHeartbeat = Get-Date
    }

    if ($online) {
        $request = Get-NextBridgeRequest
        if ($request -and $request.requestId) {
            Process-BridgeRequest -Request $request
            continue
        }
    }

    Start-Sleep -Seconds ([math]::Max(1, $PollSeconds))
}
