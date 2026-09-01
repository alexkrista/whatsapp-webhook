param(
  [string]$Root = 'N:\SdB',
  [string]$Url = 'https://protokoll.krista.at',
  [string]$ConfigPath = "$PSScriptRoot\sdb-agent-config.json",
  [string]$StatePath = "$PSScriptRoot\sdb-agent-state.json"
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Root)) { throw "SDB-Ordner nicht erreichbar: $Root" }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Agent-Konfiguration fehlt: $ConfigPath" }
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$token = [string]$config.token
if ($token.Length -lt 24) { throw 'SDB_AGENT_TOKEN fehlt oder ist zu kurz' }
$previous = @{}
if (Test-Path -LiteralPath $StatePath) {
  try { $saved = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json; $saved.PSObject.Properties | ForEach-Object { $previous[$_.Name] = $_.Value } } catch { $previous = @{} }
}
$state = @{}
$documents = [System.Collections.Generic.List[object]]::new()
Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.pdf' -ErrorAction SilentlyContinue | ForEach-Object {
  $relative = $_.FullName.Substring($Root.TrimEnd('\').Length).TrimStart('\')
  $key = "$($_.Length):$($_.LastWriteTimeUtc.Ticks)"
  $old = $previous[$relative]
  $hash = if ($old -and [string]$old.key -eq $key) { [string]$old.sha256 } else { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  $state[$relative] = @{ key = $key; sha256 = $hash }
  if (-not $old -or [string]$old.sha256 -ne $hash) { $documents.Add(@{ relativePath = $relative; sha256 = $hash; size = $_.Length; modifiedAt = $_.LastWriteTimeUtc.ToString('o') }) }
}
$payload = @{ agentVersion = '0.1.0-powershell'; documents = $documents } | ConvertTo-Json -Depth 6
$result = Invoke-RestMethod -Uri ($Url.TrimEnd('/') + '/agent/api/safety/sdb/sync') -Method Post -Headers @{ 'X-Kristine-Agent-Token' = $token } -ContentType 'application/json; charset=utf-8' -Body $payload -TimeoutSec 120
$temp = "$StatePath.tmp"
$state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temp -Encoding UTF8
Move-Item -LiteralPath $temp -Destination $StatePath -Force
[pscustomobject]@{ ok = $result.ok; scanned = $state.Count; changed = $documents.Count; accepted = $result.accepted; masterTotal = $result.total }
