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
    } finally { $br.Close() }
  } finally { $fs.Close() }
}

if (-not (Test-Path -LiteralPath $DbPath)) { throw "SQLite DB not found: $DbPath" }
if (-not (Test-Path -LiteralPath $SqliteDll)) { throw "sqlite3.dll not found: $SqliteDll" }

$machine = Get-PeMachine -Path $SqliteDll
if (-not $Relaunched -and $machine -eq 0x14c -and [IntPtr]::Size -eq 8) {
  $ps32 = Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $ps32)) { throw "32-bit PowerShell not found: $ps32" }
  & $ps32 -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -DbPath $DbPath -SqliteDll $SqliteDll -OutFile $OutFile -Relaunched
  exit $LASTEXITCODE
}

$dllEsc = $SqliteDll.Replace('\','\\').Replace('"','\"')
$source = @"
using System;
using System.Runtime.InteropServices;
public static class KristineNativeSqliteV2 {
  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Ansi)]
  public static extern int sqlite3_open_v2(string filename, out IntPtr db, int flags, IntPtr zVfs);
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
  param([IntPtr]$Ptr,[int]$Length)
  if ($Ptr -eq [IntPtr]::Zero -or $Length -le 0) { return "" }
  $bytes = New-Object byte[] $Length
  [Runtime.InteropServices.Marshal]::Copy($Ptr,$bytes,0,$Length)
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
$rc = [KristineNativeSqliteV2]::sqlite3_open_v2($DbPath,[ref]$db,$SQLITE_OPEN_READONLY,[IntPtr]::Zero)
if ($rc -ne 0 -or $db -eq [IntPtr]::Zero) {
  $msg = if ($db -ne [IntPtr]::Zero) { PtrTo-Ansi ([KristineNativeSqliteV2]::sqlite3_errmsg($db)) } else { "open failed" }
  throw "SQLite open READ ONLY failed: $rc $msg"
}

function Invoke-SqliteQuery {
  param([string]$Sql)
  if ($Sql.TrimStart() -notmatch '^(?i)(SELECT|PRAGMA)\b') { throw "Safety stop: only SELECT/PRAGMA allowed" }
  $stmt = [IntPtr]::Zero
  $prep = [KristineNativeSqliteV2]::sqlite3_prepare_v2($db,$Sql,-1,[ref]$stmt,[IntPtr]::Zero)
  if ($prep -ne 0) {
    $msg = PtrTo-Ansi ([KristineNativeSqliteV2]::sqlite3_errmsg($db))
    throw "SQLite prepare failed: $prep $msg | SQL: $Sql"
  }
  try {
    $cc = [KristineNativeSqliteV2]::sqlite3_column_count($stmt)
    $rows = New-Object 'System.Collections.Generic.List[object]'
    while ($true) {
      $step = [KristineNativeSqliteV2]::sqlite3_step($stmt)
      if ($step -eq 101) { break }
      if ($step -ne 100) {
        $msg = PtrTo-Ansi ([KristineNativeSqliteV2]::sqlite3_errmsg($db))
        throw "SQLite step failed: $step $msg | SQL: $Sql"
      }
      $row = @()
      for ($i=0;$i -lt $cc;$i++) {
        $ptr = [KristineNativeSqliteV2]::sqlite3_column_text($stmt,$i)
        $len = [KristineNativeSqliteV2]::sqlite3_column_bytes($stmt,$i)
        $row += (PtrTo-Utf8 -Ptr $ptr -Length $len)
      }
      $rows.Add([object]$row)
    }
    return @($rows.ToArray())
  } finally { [void][KristineNativeSqliteV2]::sqlite3_finalize($stmt) }
}

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line { param([string]$Text="") $lines.Add($Text); Write-Host $Text }

try {
  Add-Line "KRISTINE - Native SQLite History Probe V2 - STRICT READ ONLY"
  Add-Line ("Time: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  Add-Line ("DB: " + $DbPath)
  Add-Line ("sqlite3.dll: " + $SqliteDll)
  Add-Line ("Process bitness: " + ([IntPtr]::Size*8) + " bit")
  Add-Line "Open flags: SQLITE_OPEN_READONLY; VFS=NULL. Queries: SELECT/PRAGMA only."
  Add-Line ""

  $tables = @()
  foreach ($r in @(Invoke-SqliteQuery "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")) {
    if ($r.Count -gt 0) { $tables += [string]$r[0] }
  }
  Add-Line "=== ALL TABLES ==="
  $info = @()
  foreach ($t in $tables) {
    $count = 0
    try {
      $cr = @(Invoke-SqliteQuery ("SELECT COUNT(*) FROM " + (Quote-Identifier $t) + ";"))
      if ($cr.Count -gt 0) { [void][long]::TryParse([string]$cr[0][0],[ref]$count) }
    } catch {}
    Add-Line ($t + "`t" + $count + " rows")
    $cols = @()
    try {
      foreach ($r in @(Invoke-SqliteQuery ("PRAGMA table_info(" + (Quote-Identifier $t) + ");"))) {
        if ($r.Count -ge 3) { $cols += [pscustomobject]@{Name=[string]$r[1];Type=[string]$r[2]} }
      }
    } catch {}
    $score = 0
    if ($t -match '(?i)history|order|dispens|tint|transaction|job|ticket|sale|queue|batch|mix|stat') { $score += 12 }
    foreach ($c in $cols) {
      if ($c.Name -match '(?i)history|order|dispens|tint|transaction|job|ticket|sale|queue|batch|mix') { $score += 5 }
      if ($c.Name -match '(?i)date|time|created|modified|completed|timestamp') { $score += 2 }
      if ($c.Name -match '(?i)colour|color|product|formula|base|can|size|customer|volume|amount') { $score += 1 }
    }
    $info += [pscustomobject]@{Table=$t;Rows=$count;Score=$score;Columns=$cols}
  }
  Add-Line ""

  $candidates = @($info | Where-Object {$_.Score -gt 0} | Sort-Object -Property @{Expression='Score';Descending=$true},@{Expression='Rows';Descending=$true},Table)
  Add-Line "=== HISTORY CANDIDATES ==="
  foreach ($c in @($candidates | Select-Object -First 30)) {
    Add-Line ("SCORE " + $c.Score + " - " + $c.Table + " - " + $c.Rows + " rows")
    Add-Line ("  " + (($c.Columns | ForEach-Object { $_.Name + ':' + $_.Type }) -join ', '))
  }
  Add-Line ""

  Add-Line "=== SAMPLE DATA FROM TOP CANDIDATES ==="
  foreach ($c in @($candidates | Select-Object -First 12)) {
    $usable = @($c.Columns | Where-Object {$_.Type -notmatch '(?i)blob|binary'} | Select-Object -First 12)
    if ($usable.Count -eq 0) { continue }
    $names = @($usable | ForEach-Object {[string]$_.Name})
    $select = @($names | ForEach-Object {Quote-Identifier $_}) -join ','
    $sql = "SELECT " + $select + " FROM " + (Quote-Identifier ([string]$c.Table)) + " LIMIT 5;"
    Add-Line ("--- " + $c.Table + " ---")
    Add-Line ("COLUMNS: " + ($names -join ' | '))
    try {
      foreach ($r in @(Invoke-SqliteQuery $sql)) {
        $vals = @()
        foreach ($v in $r) {
          $s = ([string]$v).Replace("`r",' ').Replace("`n",' ')
          if ($s.Length -gt 180) { $s = $s.Substring(0,180) + ' ...' }
          $vals += $s
        }
        Add-Line ("  " + ($vals -join "`t"))
      }
    } catch { Add-Line ("  WARN: " + $_.Exception.Message) }
  }

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($OutFile,$lines,$utf8)
  Add-Line ("DONE: " + $OutFile)
} finally {
  if ($db -ne [IntPtr]::Zero) { [void][KristineNativeSqliteV2]::sqlite3_close($db) }
}
