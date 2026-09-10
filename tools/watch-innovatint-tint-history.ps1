param(
  [string]$DbPath = "C:\wuser\EVOlocal\stats\stats_db_v_1.db",
  [string]$SqliteDll = "C:\wuser\Innovatint\python\DLLs\sqlite3.dll",
  [string]$OutFile = "$env:USERPROFILE\Desktop\mix-history-watch.txt",
  [switch]$Relaunched
)

$ErrorActionPreference = "Stop"

function Get-PeMachine {
  param([string]$Path)
  $fs = [System.IO.File]::Open($Path,'Open','Read','ReadWrite')
  try {
    $br = New-Object System.IO.BinaryReader($fs)
    try {
      $fs.Seek(0x3C,[System.IO.SeekOrigin]::Begin) | Out-Null
      $peOffset = $br.ReadInt32()
      $fs.Seek($peOffset + 4,[System.IO.SeekOrigin]::Begin) | Out-Null
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
public static class KristineHistoryWatchSqlite {
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
  public static extern IntPtr sqlite3_column_text(IntPtr stmt, int iCol);
  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern int sqlite3_column_bytes(IntPtr stmt, int iCol);
  [DllImport("$dllEsc", CallingConvention=CallingConvention.Cdecl)]
  public static extern IntPtr sqlite3_errmsg(IntPtr db);
}
"@

if (-not ('KristineHistoryWatchSqlite' -as [type])) {
  Add-Type -TypeDefinition $source -Language CSharp
}

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

$db = [IntPtr]::Zero
$SQLITE_OPEN_READONLY = 1
$rc = [KristineHistoryWatchSqlite]::sqlite3_open_v2($DbPath,[ref]$db,$SQLITE_OPEN_READONLY,[IntPtr]::Zero)
if ($rc -ne 0 -or $db -eq [IntPtr]::Zero) {
  $msg = if ($db -ne [IntPtr]::Zero) { PtrTo-Ansi ([KristineHistoryWatchSqlite]::sqlite3_errmsg($db)) } else { "open failed" }
  throw "SQLite open READ ONLY failed: $rc $msg"
}

function Invoke-SqliteSelect {
  param([string]$Sql)
  if ($Sql.TrimStart() -notmatch '^(?i)SELECT\b') { throw "Safety stop: SELECT only" }
  $stmt = [IntPtr]::Zero
  $prep = [KristineHistoryWatchSqlite]::sqlite3_prepare_v2($db,$Sql,-1,[ref]$stmt,[IntPtr]::Zero)
  if ($prep -ne 0) {
    $msg = PtrTo-Ansi ([KristineHistoryWatchSqlite]::sqlite3_errmsg($db))
    throw "SQLite prepare failed: $prep $msg | SQL: $Sql"
  }
  try {
    $cc = [KristineHistoryWatchSqlite]::sqlite3_column_count($stmt)
    $rows = New-Object 'System.Collections.Generic.List[object]'
    while ($true) {
      $step = [KristineHistoryWatchSqlite]::sqlite3_step($stmt)
      if ($step -eq 101) { break }
      if ($step -ne 100) {
        $msg = PtrTo-Ansi ([KristineHistoryWatchSqlite]::sqlite3_errmsg($db))
        throw "SQLite step failed: $step $msg | SQL: $Sql"
      }
      $row = @()
      for ($i=0;$i -lt $cc;$i++) {
        $ptr = [KristineHistoryWatchSqlite]::sqlite3_column_text($stmt,$i)
        $len = [KristineHistoryWatchSqlite]::sqlite3_column_bytes($stmt,$i)
        $row += (PtrTo-Utf8 -Ptr $ptr -Length $len)
      }
      $rows.Add([object]$row)
    }
    return @($rows.ToArray())
  } finally { [void][KristineHistoryWatchSqlite]::sqlite3_finalize($stmt) }
}

try {
  $baselineRows = @(Invoke-SqliteSelect "SELECT COALESCE(MAX(id),0) FROM events WHERE event_name='TINT';")
  $baseline = 0
  if ($baselineRows.Count -gt 0) { [void][long]::TryParse([string]$baselineRows[0][0],[ref]$baseline) }

  Write-Host "KRISTINE - Innovatint HISTORY Beobachtung - READ ONLY"
  Write-Host ("Start-TINT-ID: " + $baseline)
  Write-Host ""
  Write-Host "JETZT mischen. Es duerfen auch mehrere Dosen sein."
  Write-Host "Wenn fertig, hier ENTER druecken."
  [void](Read-Host)

  $events = @(Invoke-SqliteSelect ("SELECT id,date_time,disp_tb_id,exec_time FROM events WHERE event_name='TINT' AND id>" + $baseline + " ORDER BY id;"))
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('KRISTINE - Innovatint HISTORY Beobachtung - READ ONLY')
  $lines.Add('Start-TINT-ID: ' + $baseline)
  $lines.Add('Neue TINT-Events: ' + $events.Count)
  $lines.Add('')

  if ($events.Count -eq 0) {
    $lines.Add('(keine neuen TINT-Events gefunden)')
    Write-Host "Keine neuen TINT-Events gefunden."
  } else {
    Write-Host ("Neue TINT-Events: " + $events.Count)
    foreach ($e in $events) {
      $id = [long]$e[0]
      $date = [string]$e[1]
      $disp = [string]$e[2]
      $exec = [string]$e[3]
      $head = "TINT #$id | $date | dispenser=$disp | exec_time=$exec"
      $lines.Add($head)
      Write-Host $head

      $usageSql = @"
SELECT cu.circuit_tb_id,COALESCE(ci.colorant_code,''),COALESCE(ci.module_id,''),COALESCE(ci.canister_id,''),cu.amount,cu.dosed_amount,cu.result,cu.strategy
FROM colorant_usage cu
LEFT JOIN circuit_items ci ON ci.id=cu.circuit_tb_id
WHERE cu.events_tb_id=$id
ORDER BY cu.id;
"@
      $usage = @(Invoke-SqliteSelect $usageSql)
      foreach ($u in $usage) {
        $line = "  circuit=$($u[0]) | colorant=$($u[1]) | module=$($u[2]) | canister=$($u[3]) | amount=$($u[4]) | dosed=$($u[5]) | result=$($u[6]) | strategy=$($u[7])"
        $lines.Add($line)
        Write-Host $line
      }
      $lines.Add('')
    }
  }

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($OutFile,$lines,$utf8)
  Write-Host ""
  Write-Host ("DONE: " + $OutFile)
} finally {
  if ($db -ne [IntPtr]::Zero) { [void][KristineHistoryWatchSqlite]::sqlite3_close($db) }
}
