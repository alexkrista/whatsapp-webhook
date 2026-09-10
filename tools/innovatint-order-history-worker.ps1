param([ValidateSet('Watch','Once','Fixture')][string]$Mode='Watch',[string]$FixtureFile='')
$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$root=$PSScriptRoot
$stateFile=Join-Path $root 'history-state.json'
$base='http://127.0.0.1:9502'
function Read-Api([string]$service,[hashtable]$body) {
  if($service -notin @('orderitems_search','order_load')) {throw 'Nur Leseabrufe erlaubt'}
  $body.method=$service; $body.callsCounter='1'
  $reply=Invoke-RestMethod -Uri ($base+'/suite6/test/'+$service) -Method Post -Body $body -TimeoutSec 30
  if($reply.error -or $reply.service -ne $service){throw ('Ungueltige Antwort von '+$service)}
  return $reply.r
}
function Doses($order,[string]$machine) {
  $result=@()
  foreach($item in @($order.items)) {
    $details=@($item.cansTintedDetail | Where-Object {$null -ne $_})
    $count=[double]$item.cansTinted
    if($count -eq 0){continue}
    if($count -lt 0 -or $count -ne [math]::Floor($count) -or $details.Count -ne $count){throw ('Dosierungen nicht eindeutig: Auftrag '+$order.id)}
    $seen=@{}
    foreach($dose in $details) {
      $time=[string]$dose.dispenseTime
      if($time -notmatch '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'){throw 'Dosierzeit fehlt oder hat ein unbekanntes Format'}
      $date=[datetime]::ParseExact($time,'yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
      $iso=$date.ToString('yyyy-MM-ddTHH:mm:ss')+'Z'
      if(-not $seen.ContainsKey($time)){$seen[$time]=0};$seen[$time]++
      $review=(-not $item.productName -or -not $item.formula.baseCode -or -not $item.can.name -or $null -ne $item.parentID)
      $result+=@{id=('dose|'+$machine+'|'+$order.id+'|'+$item.id+'|'+$time+'|'+$seen[$time]);orderNo=[string]$order.id;completedAt=$iso;productName=[string]$item.productName;baseCode=[string]$item.formula.baseCode;baseName=[string]$item.formula.baseCode;size=[string]$item.can.name;colourCode=[string]$item.colourCode;colourName=[string]$item.colourName;quantity=1;ean=[string]$item.barcode;status='completed-dose';requiresReview=[bool]$review}
    }
  }
  return $result
}
if($Mode -eq 'Fixture') {
  $fixture=Get-Content -LiteralPath $FixtureFile -Raw -Encoding UTF8|ConvertFrom-Json
  $all=@();foreach($entry in @($fixture)){$all+=@(Doses $entry.response.r 'test-machine')}
  $all|ConvertTo-Json -Depth 8
  exit 0
}
function Save-State($state) {
  $tmp=$stateFile+'.tmp'
  $state|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $stateFile -Force
}
function Sync-Once {
  $client=New-Object Net.Sockets.TcpClient
  try {
    $attempt=$client.ConnectAsync('127.0.0.1',9502)
    try {$ready=$attempt.Wait(1200) -and $client.Connected} catch {$ready=$false}
  } finally {$client.Dispose()}
  if(-not $ready){
    $paused=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')+' | PAUSE | Innovatint ist ausgeschaltet; kein Fehler.'
    $paused|Set-Content -LiteralPath (Join-Path $root 'Status.txt') -Encoding UTF8
    Write-Host $paused
    return
  }
  $state=@{initialized=$false;signatures=@{}}
  if(Test-Path -LiteralPath $stateFile){
    $old=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json
    $state.initialized=[bool]$old.initialized
    foreach($prop in $old.signatures.PSObject.Properties){$state.signatures[$prop.Name]=[string]$prop.Value}
  }
  $config=Get-Content -LiteralPath (Join-Path $root 'connection.json') -Raw -Encoding UTF8|ConvertFrom-Json
  $secure=Get-Content -LiteralPath (Join-Path $root 'connection.key') -Raw|ConvertTo-SecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try{$token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  $body=@{filter='';matchType='1';customerID='';startDate='';endDate='';maxResults='0';status='';source='';localOnly='False';startingFrom='';orderByStatus='False';visibleOnly='False';productName='';baseCode='';canName=''}
  $rows=@(Read-Api 'orderitems_search' $body)
  $events=@();$next=@{};foreach($key in $state.signatures.Keys){$next[$key]=$state.signatures[$key]}
  foreach($group in @($rows|Group-Object orderID)) {
    if(-not $group.Name){throw 'Auftrags-ID fehlt'}
    $signature=($group.Group|Sort-Object itemID|ForEach-Object {([string]$_.itemID)+'|'+$_.modificationDate+'|'+$_.status+'|'+$_.lotSize}) -join ';'
    $id=[string]$group.Name
    if($state.signatures[$id] -eq $signature){continue}
    $order=Read-Api 'order_load' @{orderID=$id;editing='False';updateFormula='False';barcode=''}
    $events+=@(Doses $order ([string]$config.machine))
    $next[$id]=$signature
  }
  if($events.Count -gt 5000){throw 'Mehr als 5000 Dosierungen: Aufteilung erforderlich'}
  $groups=@(@{baseline=$false;rows=@($events)})
  if(-not $state.initialized){
    $cutoff=[datetimeoffset]::Parse([string]$config.activatedAt)
    $older=@($events|Where-Object {[datetimeoffset]::Parse($_.completedAt) -le $cutoff})
    $newer=@($events|Where-Object {[datetimeoffset]::Parse($_.completedAt) -gt $cutoff})
    $groups=@(@{baseline=$true;rows=$older},@{baseline=$false;rows=$newer})
  }
  $added=0
  foreach($batch in $groups){
    $payload=@{machine=[string]$config.machine;rows=@($batch.rows);baseline=[bool]$batch.baseline;createTasks=$true;source='verified-order-load'}|ConvertTo-Json -Depth 12 -Compress
    $answer=Invoke-RestMethod -Uri (([string]$config.url)+'/admin/api/paint/bridge/history') -Method Post -Headers @{'x-lg-bridge-token'=$token} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 60
    if(-not $answer.ok){throw 'KRISTINE hat die Uebernahme nicht bestaetigt'}
    $added+=[int]$answer.added
  }
  Save-State @{initialized=$true;signatures=$next;lastSuccess=[datetime]::UtcNow.ToString('o')}
  $message=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')+' | OK | '+$added+' neu | Historie beim Start: '+(-not $state.initialized)
  $message|Set-Content -LiteralPath (Join-Path $root 'Status.txt') -Encoding UTF8
  Write-Host $message
}
$mutex=New-Object Threading.Mutex($false,'Local\KRISTINEHistorySync')
if(-not $mutex.WaitOne(0)){exit 0}
try {
  do {
    $now=Get-Date
    $inside=($now.TimeOfDay -ge [timespan]::Parse('06:15:00') -and $now.TimeOfDay -le [timespan]::Parse('18:30:00'))
    try {if($Mode -eq 'Once' -or $inside){Sync-Once}} catch {
      $message=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')+' | FEHLER | '+$_.Exception.Message
      $message|Set-Content -LiteralPath (Join-Path $root 'Status.txt') -Encoding UTF8
      Write-Host $message
      if($Mode -eq 'Once'){exit 1}
    }
    if($Mode -eq 'Watch'){Start-Sleep -Seconds 60}
  } while($Mode -eq 'Watch')
} finally {$mutex.ReleaseMutex();$mutex.Dispose()}
