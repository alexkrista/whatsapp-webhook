param(
  [string]$Label = "mix-test",
  [string]$OutFile = "$env:USERPROFILE\Desktop\innovatint-mix-dateiaenderungen.txt"
)

$ErrorActionPreference = "SilentlyContinue"

$roots = @(
  'C:\wuser\Innovatint',
  'C:\wuser\Innovatint_client',
  'C:\wuser\EVOlocal',
  'C:\wuser\Driver',
  'C:\ProgramData\Datacolor',
  'C:\ProgramData\Innovatint',
  'C:\Program Files (x86)\Innovatint',
  'C:\Program Files (x86)\Datacolor'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -Unique

function Get-Snapshot {
  $map = @{}
  foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
      $map[$_.FullName] = [pscustomobject]@{
        Path = $_.FullName
        Length = [int64]$_.Length
        LastWriteUtc = $_.LastWriteTimeUtc.Ticks
        LastWriteLocal = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss.fff')
      }
    }
  }
  return $map
}

Write-Host "KRISTINE - Innovatint Mischvorgang Datei-Watcher - READ ONLY"
Write-Host ("Label: " + $Label)
Write-Host ""
Write-Host "Snapshot VOR dem Mischvorgang wird erstellt ..."
$beforeTime = Get-Date
$before = Get-Snapshot
Write-Host ("Dateien erfasst: " + $before.Count)
Write-Host ""
Write-Host "JETZT genau EINEN bekannten Mischvorgang in Innovatint ausfuehren."
Write-Host "Danach hier ENTER druecken."
[void](Read-Host)

$afterTime = Get-Date
Write-Host "Snapshot NACH dem Mischvorgang wird erstellt ..."
$after = Get-Snapshot

$changes = New-Object System.Collections.Generic.List[object]
foreach ($path in $after.Keys) {
  $a = $after[$path]
  if (-not $before.ContainsKey($path)) {
    $changes.Add([pscustomobject]@{Type='CREATED';Path=$path;BeforeLength='';AfterLength=$a.Length;LastWrite=$a.LastWriteLocal})
    continue
  }
  $b = $before[$path]
  if ($a.Length -ne $b.Length -or $a.LastWriteUtc -ne $b.LastWriteUtc) {
    $changes.Add([pscustomobject]@{Type='CHANGED';Path=$path;BeforeLength=$b.Length;AfterLength=$a.Length;LastWrite=$a.LastWriteLocal})
  }
}
foreach ($path in $before.Keys) {
  if (-not $after.ContainsKey($path)) {
    $b = $before[$path]
    $changes.Add([pscustomobject]@{Type='DELETED';Path=$path;BeforeLength=$b.Length;AfterLength='';LastWrite=''})
  }
}

$changes = @($changes | Sort-Object Type,Path)
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('KRISTINE - Innovatint Mischvorgang Datei-Watcher - READ ONLY')
$lines.Add('Label: ' + $Label)
$lines.Add('Start: ' + $beforeTime.ToString('yyyy-MM-dd HH:mm:ss.fff'))
$lines.Add('Ende: ' + $afterTime.ToString('yyyy-MM-dd HH:mm:ss.fff'))
$lines.Add('Suchorte:')
foreach ($r in $roots) { $lines.Add('  ' + $r) }
$lines.Add('')
$lines.Add('Aenderungen: ' + $changes.Count)
$lines.Add('')
foreach ($c in $changes) {
  $lines.Add(($c.Type + ' | ' + $c.Path + ' | vorher=' + $c.BeforeLength + ' | nachher=' + $c.AfterLength + ' | write=' + $c.LastWrite))
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($OutFile,$lines,$utf8)

Write-Host ""
Write-Host ("Aenderungen gefunden: " + $changes.Count)
foreach ($c in $changes | Select-Object -First 40) {
  Write-Host ($c.Type + ' | ' + $c.Path)
}
if ($changes.Count -gt 40) { Write-Host ("... weitere " + ($changes.Count-40) + " in der TXT") }
Write-Host ""
Write-Host ("DONE: " + $OutFile)
Write-Host "Diese TXT hier hochladen."
