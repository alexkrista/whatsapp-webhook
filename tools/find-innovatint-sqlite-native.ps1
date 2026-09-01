param(
  [string]$DbPath = "C:\wuser\EVOlocal\stats\stats_db_v_1.db",
  [string]$SqliteDll = "C:\wuser\Innovatint\python\DLLs\sqlite3.dll",
  [string]$OutFile = "$env:USERPROFILE\Desktop\innovatint-sqlite-history.txt",
  [switch]$Relaunched
)

$ErrorActionPreference = "Stop"

function Get-PeMachine {
  param([string]$Path)
  $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
  try {
    $br = New-Object System.IO.BinaryReader($fs)
    try {
      $fs.Seek(0x3C, [System.IO.SeekOrigin]::Begin) | Out-Null
      $peOffset = $br.ReadInt32()
      $fs.Seek($peOffset + 4, [System.IO.SeekOrigin]::Begin) | Out-Null
      return $br.ReadUInt16()
    }
    finally { $br.Close() }
  }
  finally { $fs.Close() }
}

if (-not (Test-Path -LiteralPath $DbPath)) {
  throw "SQLite DB not found: $DbPath"
}
if (-not (Test-Path -LiteralPath $SqliteDll)) {
  throw "sqlite3.dll not found: $SqliteDll"
}

# Innovatint ist meist 32 Bit. Falls die DLL x86 ist und dieses PowerShell 64 Bit,
# starten wir exakt dasselbe Skript einmal im 32-Bit-Windows-PowerShell neu.
$machine = Get-PeMachine -Path $SqliteDll
if (-not $Relaunched -and $machine -eq 0x14c -and [IntPtr]::Size -eq 8) {
  $ps32 = Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $ps32)) { throw "32-bit PowerShell not found: $ps32" }
  $args = @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath,
    '-DbPath',$DbPath,'-SqliteDll',$SqliteDll,'-OutFile',$OutFile,'-Relaunched'
  )
  & $ps32 @args
  exit $LASTEXITCODE
}

$dllEsc = $SqliteDll.Replace('\','\\').Replace('"','\"')
$source = @"
using System;
using System.Runtime.InteropServices;

public static class KristineNativeSqlite {
  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Ansi)]
  public static extern int sqlite3_open_v2(string filename, out IntPtr db, int flags, string zVfs);

  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern int sqlite3_close(IntPtr db);

  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Ansi)]
  public static extern int sqlite3_prepare_v2(IntPtr db, string sql, int nByte, out IntPtr stmt, IntPtr tail);

  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern int sqlite3_step(IntPtr stmt);

  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern int sqlite3_finalize(IntPtr stmt);

  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern int sqlite3_column_count(IntPtr stmt);

  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern IntPtr sqlite3_column_name(IntPtr stmt, int iCol);

  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern IntPtr sqlite3_column_text(IntPtr stmt, int iCol);

  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern int sqlite3_column_bytes(IntPtr stmt, int iCol);

  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern IntPtr sqlite3_errmsg(IntPtr db);
}
"@

Add-Type -TypeDefinition $source -Language CSharp

function PtrTo-Utf8 {
  param([IntPtr]$Ptr, [int]$Length)
  if ($Ptr -eq [IntPtr]::Zero -or $Length -le 0) { return "" }
  $bytes = New-Object byte[] $Length
  [Runtime.InteropServices.Marshal]::Copy($Ptr, $bytes, 0, $Length)
  return [Text.Encoding]::UTF8.GetString($bytes)
}

function PtrTo-Ansi {
  param([IntPtr]$Ptr)
  if ($Ptr -eq [IntPtr]::Zero) { return "" }
  return [Runtime.InteropServices.Marshal]::PtrToStringAnsi($Ptr)
}

function Quote-Identifier {
  param([string]$Name)
  return '"' + $Name.Replace('"','""') + '"'
}

$db = [IntPtr]::Zero
$SQLITE_OPEN_READONLY = 1
$rc = [KristineNativeSqlite]::sqlite3_open_v2($DbPath, [ref]$db, $SQLITE_OPEN_READONLY, $null)
if ($rc -ne 0 -or $db -eq [IntPtr]::Zero) {
  $msg = if ($db -ne [IntPtr]::Zero) { PtrTo-Ansi ([KristineNativeSqlite]::sqlite3_errmsg($db)) } else { "open failed" }
  throw "SQLite open READ ONLY failed: $rc $msg"
}

function Invoke-SqliteQuery {
  param([string]$Sql)
  $stmt = [IntPtr]::Zero
  $prep = [KristineNativeSqlite]::sqlite3_prepare_v2($db, $Sql, -1, [ref]$stmt, [IntPtr]::Zero)
  if ($prep -ne 0) {
    $msg = PtrTo-Ansi ([KristineNativeSqlite]::sqlite3_errmsg($db))
    throw "SQLite prepare failed: $prep $msg | SQL: $Sql"
  }
  try {
    $columnCount = [KristineNativeSqlite]::sqlite3_column_count($stmt)
    $columns = @()
    for ($i=0; $i -lt $columnCount; $i++) {
      $columns += (PtrTo-Ansi ([KristineNativeSqlite]::sqlite3_column_name($stmt, $i)))
    }
    $rows = New-Object 'System.Collections.Generic.List[object]'
    while ($true) {
      $step = [KristineNativeSqlite]::sqlite3_step($stmt)
      if ($step -eq 101) { break } # SQLITE_DONE
      if ($step -ne 100) { # SQLITE_ROW
        $msg = PtrTo-Ansi ([KristineNativeSqlite]::sqlite3_errmsg($db))
        throw "SQLite step failed: $step $msg | SQL: $Sql"
      }
      $row = @()
      for ($i=0; $i -lt $columnCount; $i++) {
        $ptr = [KristineNativeSqlite]::sqlite3_column_text($stmt, $i)
        $len = [KristineNativeSqlite]::sqlite3_column_bytes($stmt, $i)
        $row += (PtrTo-Utf8 -Ptr $ptr -Length $len)
      }
      $rows.Add([object]$row)
    }
    return [pscustomobject]@{ Columns=$columns; Rows=@($rows.ToArray()) }
  }
  finally {
    [void][KristineNativeSqlite]::sqlite3_finalize($stmt)
  }
}

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line {
  param([string]$Text = "")
  $lines.Add($Text)
  Write-Host $Text
}

try {
  Add-Line "KRISTINE - Native SQLite History Probe - STRICT READ ONLY"
  Add-Line ("Time: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  Add-Line ("DB: " + $DbPath)
  Add-Line ("sqlite3.dll: " + $SqliteDll)
  Add-Line ("Process bitness: " + ([IntPtr]::Size * 8) + " bit")
  Add-Line "DB wurde mit SQLITE_OPEN_READONLY geoeffnet. Keine Schreibbefehle."
  Add-Line ""

  $tablesQ = Invoke-SqliteQuery "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  $tables = @()
  foreach ($r in $tablesQ.Rows) { if ($r.Count -gt 0) { $tables += [string]$r[0] } }

  Add-Line "=== ALL TABLES ==="
  $tableInfo = @()
  foreach ($t in $tables) {
    $qt = Quote-Identifier $t
    $count = 0
    try {
      $cq = Invoke-SqliteQuery ("SELECT COUNT(*) FROM " + $qt + ";")
      if ($cq.Rows.Count -gt 0) { [void][long]::TryParse([string]$cq.Rows[0][0], [ref]$count) }
    } catch {}
    $tableInfo += [pscustomobject]@{ Table=$t; Rows=[long]$count }
    Add-Line ($t + "`t" + $count + " rows")
  }
  Add-Line ""

  $candidates = @()
  foreach ($ti in $tableInfo) {
    $t = [string]$ti.Table
    $qt = Quote-Identifier $t
    $cols = @()
    try {
      $pq = Invoke-SqliteQuery ("PRAGMA table_info(" + $qt + ");")
      foreach ($r in $pq.Rows) {
        if ($r.Count -ge 3) { $cols += [pscustomobject]@{ Name=[string]$r[1]; Type=[string]$r[2] } }
      }
    } catch {}

    $score = 0
    if ($t -match '(?i)history|order|dispens|tint|transaction|job|ticket|sale|queue|batch|mix|stat') { $score += 12 }
    foreach ($c in $cols) {
      $n = [string]$c.Name
      if ($n -match '(?i)history|order|dispens|tint|transaction|job|ticket|sale|queue|batch|mix') { $score += 5 }
      if ($n -match '(?i)date|time|created|modified|completed|timestamp') { $score += 2 }
      if ($n -match '(?i)colour|color|product|formula|base|can|size|customer|volume|amount') { $score += 1 }
    }
    if ($score -gt 0) {
      $candidates += [pscustomobject]@{ Table=$t; Rows=$ti.Rows; Score=$score; Columns=$cols }
    }
  }
  $candidates = @($candidates | Sort-Object -Property @{Expression='Score';Descending=$true}, @{Expression='Rows';Descending=$true}, @{Expression='Table';Descending=$false})

  Add-Line "=== HISTORY CANDIDATES ==="
  foreach ($c in @($candidates | Select-Object -First 30)) {
    $desc = @()
    foreach ($col in $c.Columns) { $desc += ([string]$col.Name + ":" + [string]$col.Type) }
    Add-Line ("SCORE " + $c.Score + " - " + $c.Table + " - " + $c.Rows + " rows")
    Add-Line ("  " + ($desc -join ', '))
  }
  Add-Line ""

  Add-Line "=== SAMPLE DATA FROM TOP CANDIDATES ==="
  foreach ($c in @($candidates | Select-Object -First 15)) {
    $usable = @($c.Columns | Where-Object { $_.Type -notmatch '(?i)blob|binary' } | Select-Object -First 14)
    if ($usable.Count -eq 0) { continue }
    $names = @($usable | ForEach-Object { [string]$_.Name })
    $select = @($names | ForEach-Object { Quote-Identifier $_ }) -join ','
    $order = ""
    $dateName = $null
    foreach ($n in $names) { if ($n -match '(?i)date|time|created|modified|completed|timestamp') { $dateName=$n; break } }
    if ($dateName) { $order = " ORDER BY " + (Quote-Identifier $dateName) + " DESC" }
    $sql = "SELECT " + $select + " FROM " + (Quote-Identifier ([string]$c.Table)) + $order + " LIMIT 5;"
    Add-Line ("--- " + $c.Table + " ---")
    Add-Line ("COLUMNS: " + ($names -join ' | '))
    try {
      $sq = Invoke-SqliteQuery $sql
      if ($sq.Rows.Count -eq 0) { Add-Line "  (empty)" }
      foreach ($r in $sq.Rows) {
        $vals = @()
        foreach ($v in $r) {
          $s = [string]$v
          $s = $s.Replace("`r",' ').Replace("`n",' ')
          if ($s.Length -gt 180) { $s = $s.Substring(0,180) + ' ...' }
          $vals += $s
        }
        Add-Line ("  " + ($vals -join "`t"))
      }
    }
    catch { Add-Line ("  WARN: " + $_.Exception.Message) }
  }
  Add-Line ""

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($OutFile, $lines, $utf8)
  Add-Line ("DONE: " + $OutFile)
}
finally {
  if ($db -ne [IntPtr]::Zero) { [void][KristineNativeSqlite]::sqlite3_close($db) }
}
