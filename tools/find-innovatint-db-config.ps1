param(
  [string]$OutFile = "$env:USERPROFILE\Desktop\innovatint-db-config-fund.txt"
)

$ErrorActionPreference = "SilentlyContinue"

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line {
  param([string]$Text = "")
  $lines.Add($Text)
  Write-Host $Text
}

function Redact-Secrets {
  param([string]$Text)
  if ($null -eq $Text) { return "" }
  $s = [string]$Text

  # key=value / key: value
  $s = [regex]::Replace($s, '(?i)(password|passwd|pwd|pass)\s*([=:])\s*([^;\s,}\]]+|"[^"]*"|''[^'']*'')', '$1$2<REDACTED>')
  # XML tags
  $s = [regex]::Replace($s, '(?is)<(password|passwd|pwd|pass)>.*?</\1>', '<$1><REDACTED></$1>')
  # JSON-style values with whitespace
  $s = [regex]::Replace($s, '(?i)("(?:password|passwd|pwd|pass)"\s*:\s*)"[^"]*"', '$1"<REDACTED>"')
  # URI credentials mysql://user:password@host
  $s = [regex]::Replace($s, '(?i)(mysql|mariadb)://([^:/@\s]+):([^@\s]+)@', '$1://$2:<REDACTED>@')
  # CLI option
  $s = [regex]::Replace($s, '(?i)--password(?:=|\s+)([^\s]+)', '--password=<REDACTED>')
  return $s
}

Add-Line "KRISTINE - Innovatint DB Config Finder"
Add-Line ("Time: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
Add-Line "Nur lokale Suche. Es werden keine Dateien veraendert und keine Passwoerter ausgegeben."
Add-Line ""

$roots = New-Object System.Collections.Generic.List[string]
foreach ($root in @(
  'C:\ProgramData\CPSColor',
  'C:\ProgramData\Innovatint',
  'C:\ProgramData\Datacolor',
  'C:\ProgramData\Chromaflo',
  'C:\Program Files (x86)\CPSColor',
  'C:\Program Files\CPSColor',
  'C:\Program Files (x86)\Innovatint',
  'C:\Program Files\Innovatint',
  'C:\Program Files (x86)\Datacolor',
  'C:\Program Files\Datacolor',
  'C:\Program Files (x86)\Chromaflo',
  'C:\Program Files\Chromaflo',
  "$env:APPDATA\CPSColor",
  "$env:APPDATA\Innovatint",
  "$env:LOCALAPPDATA\CPSColor",
  "$env:LOCALAPPDATA\Innovatint"
)) {
  if (-not [string]::IsNullOrWhiteSpace($root) -and (Test-Path -LiteralPath $root)) {
    if (-not $roots.Contains($root)) { $roots.Add($root) }
  }
}

Add-Line "=== SUCHORTE ==="
foreach ($root in $roots) { Add-Line $root }
Add-Line ""

Add-Line "=== LAUFENDE PROZESSE / DIENSTE ==="
try {
  $procs = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '(?i)innovatint|cps|mysql|maria|python' -or $_.CommandLine -match '(?i)innovatint|cpscolor|mysql|maria|9502|3306'
  }
  foreach ($p in $procs) {
    $cmd = Redact-Secrets ([string]$p.CommandLine)
    if ($cmd.Length -gt 500) { $cmd = $cmd.Substring(0,500) + ' ...' }
    Add-Line ("PROC " + $p.ProcessId + " | " + $p.Name + " | " + $cmd)
  }
} catch {}
try {
  $services = Get-CimInstance Win32_Service | Where-Object {
    $_.Name -match '(?i)innovatint|cps|mysql|maria' -or $_.DisplayName -match '(?i)innovatint|cps|mysql|maria' -or $_.PathName -match '(?i)innovatint|cpscolor|mysql|maria'
  }
  foreach ($svc in $services) {
    Add-Line ("SVC " + $svc.Name + " | " + $svc.State + " | " + (Redact-Secrets ([string]$svc.PathName)))
  }
} catch {}
Add-Line ""

$extensions = @('.ini','.cfg','.conf','.config','.xml','.json','.yaml','.yml','.properties','.txt','.py','.js','.htm','.html')
$termRegex = '(?i)mysql|mariadb|3306|innovatint|database|datasource|connection|string|dbhost|dbserver|dbuser|username|password|passwd|pwd'
$fileCount = 0
$hitFiles = 0

Add-Line "=== CONFIG-TREFFER (PASSWOERTER AUSGEBLENDET) ==="
foreach ($root in $roots) {
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
    $_.Length -le 3145728 -and $extensions -contains $_.Extension.ToLowerInvariant()
  })

  foreach ($file in $files) {
    $fileCount++
    $text = $null
    try { $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop } catch { continue }
    if ([string]::IsNullOrEmpty($text) -or $text -notmatch $termRegex) { continue }

    $matches = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($text -split "`r?`n")) {
      if ($line -match $termRegex) {
        $safe = (Redact-Secrets $line).Trim()
        if ($safe.Length -gt 360) { $safe = $safe.Substring(0,360) + ' ...' }
        if (-not [string]::IsNullOrWhiteSpace($safe) -and -not $matches.Contains($safe)) { $matches.Add($safe) }
        if ($matches.Count -ge 12) { break }
      }
    }

    if ($matches.Count -eq 0) { continue }
    $hitFiles++
    Add-Line ("FILE " + $file.FullName)
    foreach ($m in $matches) { Add-Line ("  " + $m) }
    Add-Line ""
  }
}

Add-Line "=== REGISTRY-HINWEISE (PASSWOERTER AUSGEBLENDET) ==="
foreach ($base in @('HKLM:\SOFTWARE','HKLM:\SOFTWARE\WOW6432Node','HKCU:\SOFTWARE')) {
  try {
    $keys = Get-ChildItem -LiteralPath $base -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)cps|innovatint|datacolor|chromaflo' }
    foreach ($key in @($keys | Select-Object -First 80)) {
      try {
        $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($prop in $props.PSObject.Properties) {
          if ($prop.Name -match '^PS' -or $null -eq $prop.Value) { continue }
          $value = Redact-Secrets ([string]$prop.Value)
          if (($prop.Name + ' ' + $value) -match $termRegex) {
            if ($value.Length -gt 220) { $value = $value.Substring(0,220) + ' ...' }
            $parts.Add($prop.Name + '=' + $value)
          }
        }
        if ($parts.Count -gt 0) {
          Add-Line ("REG " + $key.Name)
          foreach ($part in $parts) { Add-Line ("  " + $part) }
        }
      } catch {}
    }
  } catch {}
}
Add-Line ""

Add-Line ("Scanned files: " + $fileCount + " | candidate files: " + $hitFiles)
Add-Line "DONE"
Add-Line "Bitte nur diese TXT-Datei hier hochladen. Passwoerter werden vom Skript vor der Ausgabe entfernt."

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($OutFile, $lines, $utf8NoBom)
