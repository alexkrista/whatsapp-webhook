param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 3306,
  [string]$Database = "innovatint",
  [string]$User = "root",
  [string]$Password = "",
  [string]$Colour = "NCS S 3060-Y20R",
  [string]$Product = "Intelligent Matt Emulsion",
  [string]$HistoryTime = "2026-08-24 05:09:13",
  [string]$OutFile = "$env:USERPROFILE\Desktop\innovatint-history-treffer.txt"
)

$ErrorActionPreference = "Stop"

function Find-MysqlExe {
  $candidates = @(
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

$MysqlPath = Find-MysqlExe

function Sql-Escape([string]$v) {
  if ($null -eq $v) { return "" }
  return $v.Replace("\\", "\\\\").Replace("'", "''")
}

function Invoke-Mysql([string]$Sql) {
  $args = @("-h", $HostName, "-P", "$Port", "-u", $User, "--batch", "--raw", "--skip-column-names")
  if ($Password) { $args += "--password=$Password" }
  $args += @("-D", $Database, "-e", $Sql)
  $raw = & $MysqlPath @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($raw -join "`n") }
  return @($raw)
}

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$Text = "") { $lines.Add($Text); Write-Host $Text }

Add-Line "KRISTINE · Innovatint History Finder (READ ONLY)"
Add-Line "Zeit: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Add-Line "Server: $HostName`:$Port · DB: $Database · mysql: $MysqlPath"
Add-Line "Suche Farbe: $Colour"
Add-Line "Suche Produkt: $Product"
Add-Line "Suche History-Zeit: $HistoryTime"
Add-Line ""

# Verbindung und Datenbank nur lesend pruefen.
$version = Invoke-Mysql "SELECT VERSION();"
Add-Line "MariaDB/MySQL Version: $($version -join ' ')"
Add-Line ""

# Alle Tabellen einmal dokumentieren.
Add-Line "=== TABELLEN ==="
$tables = Invoke-Mysql "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$(Sql-Escape $Database)' ORDER BY TABLE_NAME;"
foreach ($t in $tables) { Add-Line $t }
Add-Line ""

# Textspalten durchsuchen. Das ist bewusst nur SELECT und aendert nichts.
Add-Line "=== TEXT-TREFFER ==="
$textCols = Invoke-Mysql @"
SELECT TABLE_NAME,COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA='$(Sql-Escape $Database)'
  AND DATA_TYPE IN ('char','varchar','text','tinytext','mediumtext','longtext')
ORDER BY TABLE_NAME,ORDINAL_POSITION;
"@

$needleColour = Sql-Escape $Colour
$needleProduct = Sql-Escape $Product
$seenText = New-Object System.Collections.Generic.HashSet[string]
foreach ($row in $textCols) {
  $p = $row -split "`t", 2
  if ($p.Count -lt 2) { continue }
  $table = $p[0]; $column = $p[1]
  $key = "$table.$column"
  try {
    $sql = "SELECT COUNT(*) FROM ``$table`` WHERE ``$column`` LIKE '%$needleColour%' OR ``$column`` LIKE '%$needleProduct%';"
    $countRaw = Invoke-Mysql $sql
    $count = 0
    [void][int]::TryParse(($countRaw | Select-Object -First 1), [ref]$count)
    if ($count -gt 0 -and $seenText.Add($key)) {
      Add-Line "TREFFER $key · $count Zeile(n)"
      $samples = Invoke-Mysql "SELECT LEFT(REPLACE(REPLACE(CAST(``$column`` AS CHAR),CHAR(13),' '),CHAR(10),' '),240) FROM ``$table`` WHERE ``$column`` LIKE '%$needleColour%' OR ``$column`` LIKE '%$needleProduct%' LIMIT 5;"
      foreach ($s in $samples) { Add-Line "  $s" }
    }
  } catch {
    Add-Line "WARN $key · $($_.Exception.Message)"
  }
}
Add-Line ""

# Zeitspalten rund um den bekannten CSV-Zeitpunkt durchsuchen (+/- 10 Sekunden).
Add-Line "=== ZEIT-TREFFER (+/- 10 SEKUNDEN) ==="
$dateCols = Invoke-Mysql @"
SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA='$(Sql-Escape $Database)'
  AND DATA_TYPE IN ('datetime','timestamp')
ORDER BY TABLE_NAME,ORDINAL_POSITION;
"@

$timeEsc = Sql-Escape $HistoryTime
foreach ($row in $dateCols) {
  $p = $row -split "`t", 3
  if ($p.Count -lt 2) { continue }
  $table = $p[0]; $column = $p[1]
  try {
    $countRaw = Invoke-Mysql "SELECT COUNT(*) FROM ``$table`` WHERE ``$column`` BETWEEN DATE_SUB('$timeEsc', INTERVAL 10 SECOND) AND DATE_ADD('$timeEsc', INTERVAL 10 SECOND);"
    $count = 0
    [void][int]::TryParse(($countRaw | Select-Object -First 1), [ref]$count)
    if ($count -gt 0) {
      Add-Line "ZEIT $table.$column · $count Zeile(n)"
      $samples = Invoke-Mysql "SELECT * FROM ``$table`` WHERE ``$column`` BETWEEN DATE_SUB('$timeEsc', INTERVAL 10 SECOND) AND DATE_ADD('$timeEsc', INTERVAL 10 SECOND) LIMIT 5;"
      foreach ($s in $samples) { Add-Line "  $s" }
    }
  } catch {
    Add-Line "WARN $table.$column · $($_.Exception.Message)"
  }
}
Add-Line ""

# Falls Datum als Text gespeichert wird: auch nach ISO-Datum und Farbwert in typischen Namen suchen.
Add-Line "=== VERDAECHTIGE TABELLENNAMEN ==="
foreach ($t in $tables) {
  if ($t -match '(?i)order|history|disp|tint|job|trans|queue|ticket|sale|customer|shop|local') { Add-Line $t }
}

[System.IO.File]::WriteAllLines($OutFile, $lines, [System.Text.UTF8Encoding]::new($false))
Add-Line ""
Add-Line "FERTIG: $OutFile"
