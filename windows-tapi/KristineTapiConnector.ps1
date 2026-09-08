param(
  [switch]$ListLines,
  [string]$Dial,
  [string]$IncomingPhone,
  [string]$IncomingState = "RING",
  [string]$IncomingCallId,
  [string]$IncomingExtension,
  [string]$RedirectingPhone
)

$ErrorActionPreference = "Stop"
$ConnectorVersion = "1.1.0"
$ListenPort = 17834
$AllowedOrigins = @("https://protokoll.krista.at")
$InstallDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $InstallDirectory "config.json"
$LogPath = Join-Path $InstallDirectory "connector.log"
$script:Tapi = $null
$script:TapiAddress = $null
$script:SelectedLineName = ""
$script:ActiveCalls = [System.Collections.ArrayList]::new()
$script:IncomingEvents = [System.Collections.ArrayList]::new()
$script:NextEventId = 1

function Write-ConnectorLog([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Get-ConnectorConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
  try {
    return Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-ConnectorLog "Konfiguration konnte nicht gelesen werden: $($_.Exception.Message)"
  }
  return $null
}

function Get-ConfiguredLineName {
  $config = Get-ConnectorConfig
  if ($config.lineName) { return [string]$config.lineName }
  return "CTI Client TAPI-Connector"
}

function Get-LocalSecret {
  $config = Get-ConnectorConfig
  return [string]$config.localSecret
}

function Get-TapiAddresses {
  if (-not $script:Tapi) {
    $script:Tapi = New-Object -ComObject "TAPI.TAPI"
    $script:Tapi.Initialize()
  }
  $addresses = @()
  foreach ($address in @($script:Tapi.Addresses)) {
    $addresses += $address
  }
  return $addresses
}

function Select-TapiAddress {
  $wanted = Get-ConfiguredLineName
  $addresses = @(Get-TapiAddresses)
  $match = $addresses | Where-Object { [string]$_.AddressName -eq $wanted } | Select-Object -First 1
  if (-not $match) {
    $snomLines = @($addresses | Where-Object { [string]$_.AddressName -match "snom" })
    if ($snomLines.Count -eq 1) { $match = $snomLines[0] }
  }
  if (-not $match) {
    $available = ($addresses | ForEach-Object { [string]$_.AddressName }) -join ", "
    throw "TAPI-Leitung '$wanted' nicht gefunden. Verfuegbar: $available"
  }
  $script:TapiAddress = $match
  $script:SelectedLineName = [string]$match.AddressName
  return $match
}

function Normalize-PhoneNumber([string]$Phone) {
  $normalized = ($Phone -replace "[^0-9+#*]", "")
  if ($normalized.Length -lt 2 -or $normalized.Length -gt 40) {
    throw "Ungueltige Telefonnummer."
  }
  return $normalized
}

function Publish-IncomingEvent {
  param(
    [string]$Phone,
    [string]$State,
    [string]$CallId,
    [string]$Extension,
    [string]$Redirecting
  )
  $secret = Get-LocalSecret
  if (-not $secret) { throw "Lokaler Sicherheitsschlüssel fehlt. Connector bitte neu installieren." }
  $payload = @{
    phone = Normalize-PhoneNumber $Phone
    state = ([string]$State).Trim().ToUpperInvariant()
    callId = ([string]$CallId).Trim().Substring(0, [Math]::Min(([string]$CallId).Trim().Length, 120))
    extension = ([string]$Extension).Trim().Substring(0, [Math]::Min(([string]$Extension).Trim().Length, 40))
    redirectingPhone = ([string]$Redirecting).Trim().Substring(0, [Math]::Min(([string]$Redirecting).Trim().Length, 80))
  }
  Invoke-RestMethod -Uri "http://127.0.0.1:$ListenPort/event" -Method Post -Headers @{ "X-Kristine-Local-Key" = $secret } -ContentType "application/json; charset=utf-8" -Body ($payload | ConvertTo-Json -Compress) | Out-Null
}

function Add-IncomingEvent($Payload) {
  $phone = Normalize-PhoneNumber ([string]$Payload.phone)
  $state = ([string]$Payload.state).Trim().ToUpperInvariant()
  if ($state -notin @("DIAL", "RING", "CONN", "BUSY", "DISC", "IDLE")) { $state = "RING" }
  $event = [ordered]@{
    id = $script:NextEventId
    receivedAt = (Get-Date).ToUniversalTime().ToString("o")
    phone = $phone
    state = $state
    callId = ([string]$Payload.callId).Trim().Substring(0, [Math]::Min(([string]$Payload.callId).Trim().Length, 120))
    extension = ([string]$Payload.extension).Trim().Substring(0, [Math]::Min(([string]$Payload.extension).Trim().Length, 40))
    redirectingPhone = ([string]$Payload.redirectingPhone).Trim().Substring(0, [Math]::Min(([string]$Payload.redirectingPhone).Trim().Length, 80))
  }
  $script:NextEventId += 1
  [void]$script:IncomingEvents.Add($event)
  while ($script:IncomingEvents.Count -gt 100) { $script:IncomingEvents.RemoveAt(0) }
  Write-ConnectorLog "Eingehender Anruf ($state) fuer Nebenstelle '$($event.extension)' empfangen."
  return $event
}

function Invoke-TapiDial([string]$Phone) {
  $number = Normalize-PhoneNumber $Phone
  if (-not $script:TapiAddress) { $null = Select-TapiAddress }

  # LINEADDRESSTYPE_PHONENUMBER = 1, TAPIMEDIATYPE_AUDIO = 8.
  $call = $script:TapiAddress.CreateCall($number, 1, 8)
  $call.Connect($false)
  [void]$script:ActiveCalls.Add($call)
  while ($script:ActiveCalls.Count -gt 20) { $script:ActiveCalls.RemoveAt(0) }
  Write-ConnectorLog "Waehlen ueber '$script:SelectedLineName' gestartet."
  return $number
}

function Convert-ToJsonBytes($Value) {
  return [System.Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Compress -Depth 5))
}

function Send-HttpResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    $Body,
    [string]$Origin = ""
  )
  $bodyBytes = Convert-ToJsonBytes $Body
  $headers = @(
    "HTTP/1.1 $StatusCode $StatusText",
    "Content-Type: application/json; charset=utf-8",
    "Content-Length: $($bodyBytes.Length)",
    "Cache-Control: no-store",
    "Connection: close"
  )
  if ($AllowedOrigins -contains $Origin) {
    $headers += "Access-Control-Allow-Origin: $Origin"
    $headers += "Vary: Origin"
    $headers += "Access-Control-Allow-Methods: GET, POST, OPTIONS"
    $headers += "Access-Control-Allow-Headers: Content-Type, X-Kristine-TAPI"
    $headers += "Access-Control-Allow-Private-Network: true"
  }
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes(($headers -join "`r`n") + "`r`n`r`n")
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  $Stream.Write($bodyBytes, 0, $bodyBytes.Length)
  $Stream.Flush()
}

function Read-HttpRequest([System.Net.Sockets.NetworkStream]$Stream) {
  $reader = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::UTF8, $false, 4096, $true)
  $requestLine = $reader.ReadLine()
  if (-not $requestLine) { throw "Leere Anfrage." }
  $parts = $requestLine.Split(" ")
  if ($parts.Count -lt 2) { throw "Ungueltige HTTP-Anfrage." }
  $headers = @{}
  while ($true) {
    $line = $reader.ReadLine()
    if ([string]::IsNullOrEmpty($line)) { break }
    $separator = $line.IndexOf(":")
    if ($separator -gt 0) {
      $headers[$line.Substring(0, $separator).Trim().ToLowerInvariant()] = $line.Substring($separator + 1).Trim()
    }
  }
  $length = 0
  if ($headers.ContainsKey("content-length")) { $length = [int]$headers["content-length"] }
  if ($length -gt 4096) { throw "Anfrage ist zu gross." }
  $body = ""
  if ($length -gt 0) {
    $buffer = New-Object char[] $length
    $read = 0
    while ($read -lt $length) {
      $count = $reader.Read($buffer, $read, $length - $read)
      if ($count -le 0) { break }
      $read += $count
    }
    $body = -join $buffer[0..($read - 1)]
  }
  $target = $parts[1]
  return @{ Method = $parts[0].ToUpperInvariant(); Path = $target.Split("?")[0]; Query = $(if ($target.Contains("?")) { $target.Substring($target.IndexOf("?") + 1) } else { "" }); Headers = $headers; Body = $body }
}

function Handle-Client([System.Net.Sockets.TcpClient]$Client) {
  $stream = $Client.GetStream()
  try {
    $request = Read-HttpRequest $stream
    $origin = [string]$request.Headers["origin"]
    $localSecret = Get-LocalSecret
    $isLocalEvent = $localSecret -and $request.Method -eq "POST" -and $request.Path -eq "/event" -and [string]$request.Headers["x-kristine-local-key"] -eq $localSecret
    if (-not $isLocalEvent -and -not ($AllowedOrigins -contains $origin)) {
      Send-HttpResponse $stream 403 "Forbidden" @{ error = "Ursprung nicht erlaubt." }
      return
    }
    if ($isLocalEvent) {
      $payload = $request.Body | ConvertFrom-Json
      $event = Add-IncomingEvent $payload
      Send-HttpResponse $stream 200 "OK" @{ ok = $true; event = $event }
      return
    }
    if ($request.Method -eq "OPTIONS") {
      Send-HttpResponse $stream 200 "OK" @{} $origin
      return
    }
    if ($request.Method -eq "GET" -and $request.Path -eq "/status") {
      if (-not $script:TapiAddress) { $null = Select-TapiAddress }
      Send-HttpResponse $stream 200 "OK" @{ ready = $true; lineName = $script:SelectedLineName; version = $ConnectorVersion } $origin
      return
    }
    if ($request.Method -eq "GET" -and $request.Path -eq "/events") {
      $after = 0
      if ([string]$request.Query -match "(?:^|&)after=(\d+)") { $after = [int64]$Matches[1] }
      $events = @($script:IncomingEvents | Where-Object { [int64]$_.id -gt $after })
      Send-HttpResponse $stream 200 "OK" @{ ok = $true; events = $events; latestId = $script:NextEventId - 1 } $origin
      return
    }
    if ($request.Method -eq "POST" -and $request.Path -eq "/dial") {
      if ([string]$request.Headers["x-kristine-tapi"] -ne "1") {
        Send-HttpResponse $stream 403 "Forbidden" @{ error = "Sicherheitskopf fehlt." } $origin
        return
      }
      $payload = $request.Body | ConvertFrom-Json
      $number = Invoke-TapiDial ([string]$payload.phone)
      Send-HttpResponse $stream 200 "OK" @{ ok = $true; phone = $number; lineName = $script:SelectedLineName } $origin
      return
    }
    Send-HttpResponse $stream 404 "Not Found" @{ error = "Nicht gefunden." } $origin
  } catch {
    Write-ConnectorLog "Fehler: $($_.Exception.Message)"
    try { Send-HttpResponse $stream 500 "Internal Server Error" @{ error = $_.Exception.Message } ([string]$request.Headers["origin"]) } catch {}
  } finally {
    $stream.Dispose()
    $Client.Dispose()
  }
}

if ($IncomingPhone) {
  try {
    Publish-IncomingEvent -Phone $IncomingPhone -State $IncomingState -CallId $IncomingCallId -Extension $IncomingExtension -Redirecting $RedirectingPhone
  } catch {
    Write-ConnectorLog "Eingehender Anruf konnte nicht gemeldet werden: $($_.Exception.Message)"
    throw
  }
  exit 0
}

if ($ListLines) {
  Get-TapiAddresses | ForEach-Object { [string]$_.AddressName }
  if ($script:Tapi) { $script:Tapi.Shutdown() }
  exit 0
}

if ($Dial) {
  $result = Invoke-TapiDial $Dial
  Write-Output "Anruf gestartet: $result ueber $script:SelectedLineName"
  exit 0
}

try {
  $null = Select-TapiAddress
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $ListenPort)
  $listener.Start()
  Write-ConnectorLog "Connector $ConnectorVersion gestartet auf 127.0.0.1:$ListenPort mit '$script:SelectedLineName'."
  while ($true) {
    $client = $listener.AcceptTcpClient()
    Handle-Client $client
  }
} catch {
  Write-ConnectorLog "Connector beendet: $($_.Exception.Message)"
  throw
} finally {
  if ($listener) { $listener.Stop() }
  if ($script:Tapi) { $script:Tapi.Shutdown() }
}
