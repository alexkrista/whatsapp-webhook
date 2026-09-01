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

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  $cmd = Get-Command mysql.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  $roots = @("C:\Program Files", "C:\Program Files (x86)")
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $found = Get-ChildItem -LiteralPath $root -Filter mysql.exe -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
      return $found.FullName
    }
  }

  throw "mysql.exe not found"
}

function Sql-Escape {
  param([string]$Value)
  if ($null -eq $Value) { return "" }
  return $Value.Replace("\", "\\").Replace("'", "''")
}

function Sql-Identifier {
  param([string]$Name)
  $tick = [string][char]96
  $escaped = $Name.Replace($tick, ($tick + $tick))
  return $tick + $escaped + $tick
}

$MysqlPath = Find-MysqlExe
$script:DbPassword = $Password

function Invoke-MysqlRaw {
  param(
    [string]$Sql,
    [bool]$AllowPrompt = $true
  )

  $mysqlArgs = @(
    "-h", $HostName,
    "-P", [string]$Port,
    "-u", $User,
    "--batch",
    "--raw",
    "--skip-column-names",
    "--connect-timeout=5"
  )

  if (-not [string]::IsNullOrEmpty($script:DbPassword)) {
    $mysqlArgs += "--password=$($script:DbPassword)"
  }

  $mysqlArgs += @("-D", $Database, "-e", $Sql)
  $raw = & $MysqlPath @mysqlArgs 2>&1

  if ($LASTEXITCODE -eq 0) {
    return @($raw)
  }

  $message = ($raw -join [Environment]::NewLine)
  if ($AllowPrompt -and [string]::IsNullOrEmpty($script:DbPassword) -and $message -match "Access denied") {
    $secure = Read-Host "MariaDB password for $User (not stored)" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $script:DbPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
    return Invoke-MysqlRaw -Sql $Sql -AllowPrompt $false
  }

  throw $message
}

function Assert-ReadOnlySql {
  param([string]$Sql)
  $trimmed = $Sql.TrimStart()
  if ($trimmed -notmatch '^(?is)(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b') {
    throw "Safety stop: only SELECT/SHOW/DESCRIBE/EXPLAIN are allowed"
  }
  if ($trimmed -match '(?is)\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|LOAD\s+DATA|INTO\s+OUTFILE|INTO\s+DUMPFILE)\b') {
    throw "Safety stop: write keyword detected"
  }
}

function Invoke-Mysql {
  param([string]$Sql)
  Assert-ReadOnlySql -Sql $Sql
  return Invoke-MysqlRaw -Sql $Sql
}

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line {
  param([string]$Text = "")
  $lines.Add($Text)
  Write-Host $Text
}

Add-Line "KRISTINE - Innovatint History DB Probe - READ ONLY"
Add-Line ("Time: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
Add-Line ("Server: " + $HostName + ":" + $Port + " - DB: " + $Database)
Add-Line ("mysql.exe: " + $MysqlPath)
Add-Line "This script contains only SELECT/SHOW/DESCRIBE/EXPLAIN queries."
Add-Line ""

$version = Invoke-Mysql -Sql "SELECT VERSION();"
Add-Line ("MariaDB/MySQL version: " + ($version -join " "))
Add-Line ""

$dbEsc = Sql-Escape -Value $Database

Add-Line "=== ALL TABLES ==="
$tableSql = "SELECT TABLE_NAME,COALESCE(TABLE_ROWS,0) FROM information_schema.TABLES WHERE TABLE_SCHEMA='" + $dbEsc + "' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;"
$tableRows = Invoke-Mysql -Sql $tableSql
$tableInfo = @()

foreach ($row in $tableRows) {
  $parts = $row -split "`t", 2
  if ($parts.Count -lt 1) { continue }

  $rowCount = 0
  if ($parts.Count -gt 1) {
    [void][long]::TryParse([string]$parts[1], [ref]$rowCount)
  }

  $tableInfo += [pscustomobject]@{
    Table = [string]$parts[0]
    Rows = [long]$rowCount
  }

  Add-Line (([string]$parts[0]) + "`t~" + $rowCount + " rows")
}
Add-Line ""

Add-Line "=== COLUMN METADATA ==="
$columnSql = "SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='" + $dbEsc + "' ORDER BY TABLE_NAME,ORDINAL_POSITION;"
$columnRows = Invoke-Mysql -Sql $columnSql
$columnsByTable = @{}

foreach ($row in $columnRows) {
  $parts = $row -split "`t", 4
  if ($parts.Count -lt 3) { continue }

  $tableName = [string]$parts[0]
  if (-not $columnsByTable.ContainsKey($tableName)) {
    $columnsByTable[$tableName] = @()
  }

  $position = 0
  if ($parts.Count -gt 3) {
    [void][int]::TryParse([string]$parts[3], [ref]$position)
  }

  $columnsByTable[$tableName] += [pscustomobject]@{
    Name = [string]$parts[1]
    Type = [string]$parts[2]
    Pos = [int]$position
  }
}
Add-Line ("Tables with column metadata: " + $columnsByTable.Keys.Count)
Add-Line ""

function Get-CandidateScore {
  param(
    [string]$TableName,
    $Columns
  )

  $score = 0
  if ($TableName -match '(?i)history|order|dispens|tint|transaction|job|ticket|sale|queue|batch|mix') {
    $score += 12
  }

  foreach ($column in $Columns) {
    $name = [string]$column.Name
    if ($name -match '(?i)history|order|dispens|tint|transaction|job|ticket|sale|queue|batch|mix') { $score += 5 }
    if ($name -match '(?i)date|time|created|modified|completed|timestamp') { $score += 2 }
    if ($name -match '(?i)colour|color|product|formula|base|can|size|customer') { $score += 1 }
  }

  return $score
}

$candidates = @()
foreach ($tableEntry in $tableInfo) {
  $tableName = [string]$tableEntry.Table
  $cols = @()
  if ($columnsByTable.ContainsKey($tableName)) {
    $cols = @($columnsByTable[$tableName])
  }

  $score = Get-CandidateScore -TableName $tableName -Columns $cols
  if ($score -gt 0) {
    $candidates += [pscustomobject]@{
      Table = $tableName
      Rows = [long]$tableEntry.Rows
      Score = [int]$score
      Columns = $cols
    }
  }
}

$candidates = @($candidates | Sort-Object -Property @{Expression='Score';Descending=$true}, @{Expression='Rows';Descending=$true}, @{Expression='Table';Descending=$false})

Add-Line "=== HISTORY CANDIDATES ==="
$topCandidates = @($candidates | Select-Object -First 30)
foreach ($candidate in $topCandidates) {
  $columnDescriptions = @()
  foreach ($column in $candidate.Columns) {
    $columnDescriptions += ([string]$column.Name + ":" + [string]$column.Type)
  }
  Add-Line ("SCORE " + $candidate.Score + " - " + $candidate.Table + " - ~" + $candidate.Rows + " rows")
  Add-Line ("  " + ($columnDescriptions -join ", "))
}
Add-Line ""

Add-Line "=== SAMPLE DATA FROM TOP CANDIDATES ==="
$sampleCandidates = @($candidates | Select-Object -First 12)
foreach ($candidate in $sampleCandidates) {
  $safeCols = @($candidate.Columns | Where-Object { $_.Type -notmatch '(?i)blob|binary|varbinary|geometry' } | Select-Object -First 14)
  if ($safeCols.Count -eq 0) { continue }

  $selectParts = @()
  $safeColNames = @()
  foreach ($column in $safeCols) {
    $columnName = [string]$column.Name
    $safeColNames += $columnName
    $quotedColumn = Sql-Identifier -Name $columnName
    $selectParts += ("LEFT(REPLACE(REPLACE(CAST(" + $quotedColumn + " AS CHAR),CHAR(13),' '),CHAR(10),' '),160)")
  }

  $dateCol = $null
  foreach ($column in $safeCols) {
    if ($column.Type -match '(?i)datetime|timestamp|date' -and $column.Name -match '(?i)dispens|tint|complete|modified|created|date|time|timestamp') {
      $dateCol = $column
      break
    }
  }
  if ($null -eq $dateCol) {
    foreach ($column in $safeCols) {
      if ($column.Type -match '(?i)datetime|timestamp|date') {
        $dateCol = $column
        break
      }
    }
  }

  $orderSql = ""
  if ($null -ne $dateCol) {
    $orderSql = " ORDER BY " + (Sql-Identifier -Name ([string]$dateCol.Name)) + " DESC"
  }

  $quotedTable = Sql-Identifier -Name ([string]$candidate.Table)
  Add-Line ("--- " + $candidate.Table + " ---")
  Add-Line ("COLUMNS: " + ($safeColNames -join " | "))

  try {
    $sampleSql = "SELECT " + ($selectParts -join ",") + " FROM " + $quotedTable + $orderSql + " LIMIT 3;"
    $samples = @(Invoke-Mysql -Sql $sampleSql)
    if ($samples.Count -eq 0) {
      Add-Line "  (empty)"
    }
    foreach ($sample in $samples) {
      Add-Line ("  " + [string]$sample)
    }
  }
  catch {
    Add-Line ("  WARN: " + $_.Exception.Message)
  }
}
Add-Line ""

$needles = @()
if (-not [string]::IsNullOrWhiteSpace($Colour)) { $needles += $Colour }
if (-not [string]::IsNullOrWhiteSpace($Product)) { $needles += $Product }

if ($needles.Count -gt 0) {
  Add-Line "=== TEXT HITS ==="
  foreach ($tableName in $columnsByTable.Keys) {
    $textColumns = @($columnsByTable[$tableName] | Where-Object { $_.Type -match '(?i)char|text|enum|set' })
    foreach ($column in $textColumns) {
      $quotedTable = Sql-Identifier -Name ([string]$tableName)
      $quotedColumn = Sql-Identifier -Name ([string]$column.Name)
      $conditions = @()
      foreach ($needle in $needles) {
        $conditions += ($quotedColumn + " LIKE '%" + (Sql-Escape -Value ([string]$needle)) + "%'")
      }

      try {
        $countSql = "SELECT COUNT(*) FROM " + $quotedTable + " WHERE " + ($conditions -join " OR ") + ";"
        $countRows = @(Invoke-Mysql -Sql $countSql)
        $count = 0
        if ($countRows.Count -gt 0) {
          [void][int]::TryParse([string]$countRows[0], [ref]$count)
        }

        if ($count -gt 0) {
          Add-Line ("HIT " + $tableName + "." + $column.Name + " - " + $count + " row(s)")
          $sampleSql = "SELECT LEFT(REPLACE(REPLACE(CAST(" + $quotedColumn + " AS CHAR),CHAR(13),' '),CHAR(10),' '),240) FROM " + $quotedTable + " WHERE " + ($conditions -join " OR ") + " LIMIT 5;"
          $samples = @(Invoke-Mysql -Sql $sampleSql)
          foreach ($sample in $samples) {
            Add-Line ("  " + [string]$sample)
          }
        }
      }
      catch {
      }
    }
  }
  Add-Line ""
}

if (-not [string]::IsNullOrWhiteSpace($HistoryTime)) {
  $timeEsc = Sql-Escape -Value $HistoryTime
  Add-Line "=== TIME HITS (+/- 15 SECONDS) ==="
  foreach ($tableName in $columnsByTable.Keys) {
    $dateColumns = @($columnsByTable[$tableName] | Where-Object { $_.Type -match '(?i)datetime|timestamp' })
    foreach ($column in $dateColumns) {
      try {
        $quotedTable = Sql-Identifier -Name ([string]$tableName)
        $quotedColumn = Sql-Identifier -Name ([string]$column.Name)
        $countSql = "SELECT COUNT(*) FROM " + $quotedTable + " WHERE " + $quotedColumn + " BETWEEN DATE_SUB('" + $timeEsc + "', INTERVAL 15 SECOND) AND DATE_ADD('" + $timeEsc + "', INTERVAL 15 SECOND);"
        $countRows = @(Invoke-Mysql -Sql $countSql)
        $count = 0
        if ($countRows.Count -gt 0) {
          [void][int]::TryParse([string]$countRows[0], [ref]$count)
        }
        if ($count -gt 0) {
          Add-Line ("TIME " + $tableName + "." + $column.Name + " - " + $count + " row(s)")
        }
      }
      catch {
      }
    }
  }
  Add-Line ""
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($OutFile, $lines, $utf8NoBom)
Add-Line ("DONE: " + $OutFile)
Add-Line "Please send only this TXT file back. The database password is never written to it."
