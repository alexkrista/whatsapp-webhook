param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 3306,
  [string]$Database = "innovatint",
  [string]$User = "root",
  [string]$Password = "",
  [string]$Colour = "",
  [string]$Product = "",
  [string]$HistoryTime = "",
  [string]$OutFile = "$env:USERPROFILE\Desktop\innovatint-history-treffer.txt"
)

$ErrorActionPreference = "Stop"

function Find-MysqlExe {
  $candidates = @(
    "C:\Program Files (x86)\MariaDB\bin\mysql.exe",
    "C:\Program Files\MariaDB\bin\mysql.exe",
    "C:\Program Files\MariaDB 10.1\bin\mysql.exe",
    "C:\Program Files\MariaDB 10.2\bin\mysql.exe",
    "C:\Program Files\MariaDB 10.3\bin\mysql.exe",
    "C:\Program Files\MariaDB 10.4\bin\mysql.exe",
    "C:\Program Files\MariaDB 10.5\bin\mysql.exe",
    "C:\Program Files\MariaDB 10.6\bin\mysql.exe",
    "C:\Program Files\MariaDB 10.11\bin\mysql.exe",
    "C:\Program Files (x86)\MariaDB 10.1\bin\mysql.exe",
    "C:\Program Files (x86)\MariaDB 10.2\bin\mysql.exe",
    "C:\Program Files (x86)\MariaDB 10.3\bin\mysql.exe",
    "C:\Program Files (x86)\MariaDB 10.4\bin\mysql.exe",
    "C:\Program Files (x86)\MariaDB 10.5\bin\mysql.exe",
    "C:\Program Files (x86)\MariaDB 10.6\bin\mysql.exe",
    "C:\Program Files (x86)\MariaDB 10.11\bin\mysql.exe"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  $cmd = Get-Command mysql.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $found = Get-ChildItem "C:\Program Files","C:\Program Files (x86)" -Filter mysql.exe -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.FullName }
  throw "mysql.exe nicht gefunden"
}

function Sql-Escape([string]$v) {
  if ($null -eq $v) { return "" }
  return $v.Replace("\\", "\\\\").Replace("'", "''")
}

$MysqlPath = Find-MysqlExe
$script:DbPassword = $Password

function Invoke-MysqlRaw([string]$Sql, [bool]$AllowPrompt = $true) {
  $args = @("-h", $HostName, "-P", "$Port", "-u", $User, "--batch", "--raw", "--skip-column-names", "--connect-timeout=5")
  if ($script:DbPassword) { $args += "--password=$($script:DbPassword)" }
  $args += @("-D", $Database, "-e", $Sql)
  $raw = & $MysqlPath @args 2>&1
  if ($LASTEXITCODE -eq 0) { return @($raw) }

  $message = ($raw -join "`n")
  if ($AllowPrompt -and !$script:DbPassword -and $message -match "Access denied") {
    $secure = Read-Host "MariaDB-Passwort für $User (wird NICHT gespeichert)" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $script:DbPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    return Invoke-MysqlRaw -Sql $Sql -AllowPrompt $false
  }
  throw $message
}

function Invoke-Mysql([string]$Sql) {
  # Jede Abfrage wird explizit als READ ONLY gestartet. Im Skript gibt es nur SELECT/SHOW/DESCRIBE.
  return Invoke-MysqlRaw "SET SESSION TRANSACTION READ ONLY; $Sql"
}

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$Text = "") { $lines.Add($Text); Write-Host $Text }

Add-Line "KRISTINE · Innovatint History DB Probe (STRICT READ ONLY)"
Add-Line "Zeit: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Add-Line "Server: $HostName`:$Port · DB: $Database · mysql: $MysqlPath"
Add-Line "Es werden KEINE INSERT/UPDATE/DELETE/DDL-Befehle ausgeführt."
Add-Line ""

$version = Invoke-Mysql "SELECT VERSION();"
Add-Line "MariaDB/MySQL Version: $($version -join ' ')"
Add-Line ""

$dbEsc = Sql-Escape $Database

# 1) Tabellen + grobe Größe
Add-Line "=== ALLE TABELLEN ==="
$tableRows = Invoke-Mysql @"
SELECT TABLE_NAME,COALESCE(TABLE_ROWS,0)
FROM information_schema.TABLES
WHERE TABLE_SCHEMA='$dbEsc' AND TABLE_TYPE='BASE TABLE'
ORDER BY TABLE_NAME;
"@
$tableInfo = @()
foreach ($row in $tableRows) {
  $p = $row -split "`t", 2
  if ($p.Count -lt 1) { continue }
  $tableInfo += [pscustomobject]@{ Table=$p[0]; Rows=if($p.Count -gt 1){[long]($p[1] -as [long])}else{0} }
  Add-Line ("{0}`t~{1} Zeilen" -f $p[0], (if($p.Count -gt 1){$p[1]}else{"?"}))
}
Add-Line ""

# 2) Spalten-Metadaten laden und Kandidaten bewerten
$columnRows = Invoke-Mysql @"
SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,ORDINAL_POSITION
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA='$dbEsc'
ORDER BY TABLE_NAME,ORDINAL_POSITION;
"@
$columnsByTable = @{}
foreach ($row in $columnRows) {
  $p = $row -split "`t", 4
  if ($p.Count -lt 3) { continue }
  if (-not $columnsByTable.ContainsKey($p[0])) { $columnsByTable[$p[0]] = @() }
  $columnsByTable[$p[0]] += [pscustomobject]@{ Name=$p[1]; Type=$p[2]; Pos=if($p.Count -gt 3){[int]$p[3]}else{0} }
}

function Candidate-Score([string]$Table, $Columns) {
  $score = 0
  if ($Table -match '(?i)history|order|dispens|tint|transaction|job|ticket|sale|queue|batch|mix') { $score += 12 }
  foreach ($c in $Columns) {
    $n = $c.Name
    if ($n -match '(?i)history|order|dispens|tint|transaction|job|ticket|sale|queue|batch|mix') { $score += 5 }
    if ($n -match '(?i)date|time|created|modified|completed|timestamp') { $score += 2 }
    if ($n -match '(?i)colour|color|product|formula|base|can|size|customer') { $score += 1 }
  }
  return $score
}

$candidates = @()
foreach ($t in $tableInfo) {
  $cols = @($columnsByTable[$t.Table])
  $score = Candidate-Score $t.Table $cols
  if ($score -gt 0) {
    $candidates += [pscustomobject]@{ Table=$t.Table; Rows=$t.Rows; Score=$score; Columns=$cols }
  }
}
$candidates = @($candidates | Sort-Object @{Expression='Score';Descending=$true}, @{Expression='Rows';Descending=$true}, Table)

Add-Line "=== HISTORY-KANDIDATEN ==="
foreach ($c in ($candidates | Select-Object -First 30)) {
  $names = ($c.Columns | ForEach-Object { "$($_.Name):$($_.Type)" }) -join ", "
  Add-Line ("SCORE {0,2} · {1} · ~{2} Zeilen" -f $c.Score,$c.Table,$c.Rows)
  Add-Line ("  " + $names)
}
Add-Line ""

# 3) Aus den stärksten Kandidaten kleine, gekürzte Beispieldatensätze lesen.
# BLOB/BINARY wird bewusst ausgelassen; Textfelder werden auf 160 Zeichen gekürzt.
Add-Line "=== BEISPIELDATEN DER STÄRKSTEN KANDIDATEN ==="
foreach ($c in ($candidates | Select-Object -First 12)) {
  $safeCols = @($c.Columns | Where-Object { $_.Type -notmatch '(?i)blob|binary|varbinary|geometry' } | Select-Object -First 14)
  if (-not $safeCols.Count) { continue }
  $selectParts = @()
  foreach ($col in $safeCols) {
    $cn = $col.Name.Replace('`','``')
    $selectParts += "LEFT(REPLACE(REPLACE(CAST(``$cn`` AS CHAR),CHAR(13),' '),CHAR(10),' '),160)"
  }
  $dateCol = $safeCols | Where-Object { $_.Type -match '(?i)datetime|timestamp|date' -and $_.Name -match '(?i)dispens|tint|complete|modified|created|date|time|timestamp' } | Select-Object -First 1
  if (-not $dateCol) { $dateCol = $safeCols | Where-Object { $_.Type -match '(?i)datetime|timestamp|date' } | Select-Object -First 1 }
  $order = if ($dateCol) { " ORDER BY ``$($dateCol.Name.Replace('`','``'))`` DESC" } else { "" }
  $tableEsc = $c.Table.Replace('`','``')
  Add-Line ("--- {0} ---" -f $c.Table)
  Add-Line ("SPALTEN: " + (($safeCols | ForEach-Object Name) -join " | "))
  try {
    $samples = Invoke-Mysql ("SELECT " + ($selectParts -join ",") + " FROM ``$tableEsc``" + $order + " LIMIT 3;")
    if (-not $samples.Count) { Add-Line "  (leer)" }
    foreach ($s in $samples) { Add-Line ("  " + $s) }
  } catch { Add-Line ("  WARN: " + $_.Exception.Message) }
}
Add-Line ""

# 4) Optional: gezielte Suche nach bekanntem Farb-/Produkttext.
$needles = @($Colour,$Product) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
if ($needles.Count) {
  Add-Line "=== TEXT-TREFFER ==="
  foreach ($table in $columnsByTable.Keys) {
    foreach ($col in @($columnsByTable[$table] | Where-Object { $_.Type -match '(?i)char|text|enum|set' })) {
      $conditions = @()
      foreach ($needle in $needles) { $conditions += "``$($col.Name.Replace('`','``'))`` LIKE '%$(Sql-Escape $needle)%'" }
      try {
        $tableEsc = $table.Replace('`','``')
        $countRaw = Invoke-Mysql ("SELECT COUNT(*) FROM ``$tableEsc`` WHERE " + ($conditions -join " OR ") + ";")
        $count = [int](($countRaw | Select-Object -First 1) -as [int])
        if ($count -gt 0) {
          Add-Line "TREFFER $table.$($col.Name) · $count Zeile(n)"
          $sample = Invoke-Mysql ("SELECT LEFT(REPLACE(REPLACE(CAST(``$($col.Name.Replace('`','``'))`` AS CHAR),CHAR(13),' '),CHAR(10),' '),240) FROM ``$tableEsc`` WHERE " + ($conditions -join " OR ") + " LIMIT 5;")
          foreach ($s in $sample) { Add-Line "  $s" }
        }
      } catch {}
    }
  }
  Add-Line ""
}

# 5) Optional: gezielte Suche rund um einen bekannten Mischzeitpunkt.
if (-not [string]::IsNullOrWhiteSpace($HistoryTime)) {
  $timeEsc = Sql-Escape $HistoryTime
  Add-Line "=== ZEIT-TREFFER (+/- 15 SEKUNDEN) ==="
  foreach ($table in $columnsByTable.Keys) {
    foreach ($col in @($columnsByTable[$table] | Where-Object { $_.Type -match '(?i)datetime|timestamp' })) {
      try {
        $tableEsc = $table.Replace('`','``')
        $colEsc = $col.Name.Replace('`','``')
        $countRaw = Invoke-Mysql "SELECT COUNT(*) FROM ``$tableEsc`` WHERE ``$colEsc`` BETWEEN DATE_SUB('$timeEsc', INTERVAL 15 SECOND) AND DATE_ADD('$timeEsc', INTERVAL 15 SECOND);"
        $count = [int](($countRaw | Select-Object -First 1) -as [int])
        if ($count -gt 0) { Add-Line "ZEIT $table.$($col.Name) · $count Zeile(n)" }
      } catch {}
    }
  }
  Add-Line ""
}

[System.IO.File]::WriteAllLines($OutFile, $lines, [System.Text.UTF8Encoding]::new($false))
Add-Line "FERTIG: $OutFile"
Add-Line "Bitte nur diese TXT-Datei zurückschicken; Passwort wird darin nie gespeichert."
