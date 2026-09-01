param(
  [string]$DbPath = "C:\wuser\EVOlocal\stats\stats_db_v_1.db",
  [string]$SqliteDll = "C:\wuser\Innovatint\python\DLLs\sqlite3.dll",
  [string]$OutFile = "$env:USERPROFILE\Desktop\innovatint-tint-history.txt",
  [int]$Limit = 100,
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
if ($Limit -lt 1) { $Limit = 100 }
if ($Limit -gt 1000) { $Limit = 1000 }

$machine = Get-PeMachine -Path $SqliteDll
if (-not $Relaunched -and $machine -eq 0x14c -and [IntPtr]::Size -eq 8) {
  $ps32 = Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $ps32)) { throw "32-bit PowerShell not found: $ps32" }
  & $ps32 -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -DbPath $DbPath -SqliteDll $SqliteDll -OutFile $OutFile -Limit $Limit -Relaunched
  exit $LASTEXITCODE
}

$dllEsc = $SqliteDll.Replace('\','\\').Replace('"','\"')
$source = @"
using System;
using System.Runtime.InteropServices;
public static class KristineTintHistorySqlite {
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

$db = [IntPtr]::Zero
$SQLITE_OPEN_READONLY = 1
$rc = [KristineTintHistorySqlite]::sqlite3_open_v2($DbPath,[ref]$db,$SQLITE_OPEN_READONLY,[IntPtr]::Zero)
if ($rc -ne 0 -or $db -eq [IntPtr]::Zero) {
  $msg = if ($db -ne [IntPtr]::Zero) { PtrTo-Ansi ([KristineTintHistorySqlite]::sqlite3_errmsg($db)) } else { "open failed" }
  throw "SQLite open READ ONLY failed: $rc $msg"
}

function Invoke-SqliteQuery {
  param([string]$Sql)
  if ($Sql.TrimStart() -notmatch '^(?i)SELECT\b') { throw "Safety stop: only SELECT allowed" }
  $stmt = [IntPtr]::Zero
  $prep = [KristineTintHistorySqlite]::sqlite3_prepare_v2($db,$Sql,-1,[ref]$stmt,[IntPtr]::Zero)
  if ($prep -ne 0) {
    $msg = PtrTo-Ansi ([KristineTintHistorySqlite]::sqlite3_errmsg($db))
    throw "SQLite prepare failed: $prep $msg"
  }
  try {
    $cc = [KristineTintHistorySqlite]::sqlite3_column_count($stmt)
    $rows = New-Object 'System.Collections.Generic.List[object]'
    while ($true) {
      $step = [KristineTintHistorySqlite]::sqlite3_step($stmt)
      if ($step -eq 101) { break }
      if ($step -ne 100) {
        $msg = PtrTo-Ansi ([KristineTintHistorySqlite]::sqlite3_errmsg($db))
        throw "SQLite step failed: $step $msg"
      }
      $row = @()
      for ($i=0;$i -lt $cc;$i++) {
        $ptr = [KristineTintHistorySqlite]::sqlite3_column_text($stmt,$i)
        $len = [KristineTintHistorySqlite]::sqlite3_column_bytes($stmt,$i)
        $row += (PtrTo-Utf8 -Ptr $ptr -Length $len)
      }
      $rows.Add([object]$row)
    }
    return @($rows.ToArray())
  } finally {
    [void][KristineTintHistorySqlite]::sqlite3_finalize($stmt)
  }
}

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line { param([string]$Text="") $lines.Add($Text); Write-Host $Text }

try {
  Add-Line "KRISTINE - Innovatint TINT History - STRICT READ ONLY"
  Add-Line ("Time: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  Add-Line ("DB: " + $DbPath)
  Add-Line ("sqlite3.dll: " + $SqliteDll)
  Add-Line ("Process bitness: " + ([IntPtr]::Size*8) + " bit")
  Add-Line "DB opened SQLITE_OPEN_READONLY; SELECT only."
  Add-Line ""

  $countRows = @(Invoke-SqliteQuery "SELECT COUNT(*) FROM events WHERE UPPER(event_name)='TINT';")
  $tintCount = if ($countRows.Count -gt 0) { [string]$countRows[0][0] } else { "0" }
  Add-Line ("TINT events total: " + $tintCount)
  Add-Line ""

  Add-Line "=== EVENT TYPES ==="
  foreach ($r in @(Invoke-SqliteQuery "SELECT event_name, COUNT(*) FROM events GROUP BY event_name ORDER BY COUNT(*) DESC, event_name;")) {
    Add-Line (([string]$r[0]) + "`t" + ([string]$r[1]))
  }
  Add-Line ""

  Add-Line "=== CIRCUIT / COLORANT MAP ==="
  foreach ($r in @(Invoke-SqliteQuery "SELECT ci.id,ci.disp_tb_id,ci.module_id,ci.canister_id,COALESCE(ci.colorant_code,''),COALESCE(d.serial_number,''),COALESCE(d.description,'') FROM circuit_items ci LEFT JOIN dispensers d ON d.id=ci.disp_tb_id ORDER BY ci.id;")) {
    Add-Line ("circuit="+$r[0]+" | dispenser="+$r[1]+" | module="+$r[2]+" | canister="+$r[3]+" | colorant="+$r[4]+" | serial="+$r[5]+" | "+$r[6])
  }
  Add-Line ""

  Add-Line ("=== LAST " + $Limit + " TINT EVENTS WITH COLORANT USAGE ===")
  $sql = @"
SELECT
  e.id,
  e.date_time,
  e.disp_tb_id,
  COALESCE(d.serial_number,''),
  COALESCE(d.description,''),
  cu.circuit_tb_id,
  COALESCE(ci.colorant_code,''),
  COALESCE(ci.module_id,''),
  COALESCE(ci.canister_id,''),
  COALESCE(cu.amount,''),
  COALESCE(cu.unit,''),
  COALESCE(cu.dosed_amount,''),
  COALESCE(cu.result,''),
  COALESCE(cu.strategy,'')
FROM events e
LEFT JOIN dispensers d ON d.id=e.disp_tb_id
LEFT JOIN colorant_usage cu ON cu.events_tb_id=e.id
LEFT JOIN circuit_items ci ON ci.id=cu.circuit_tb_id
WHERE UPPER(e.event_name)='TINT'
  AND e.id IN (
    SELECT id FROM events WHERE UPPER(event_name)='TINT' ORDER BY date_time DESC,id DESC LIMIT $Limit
  )
ORDER BY e.date_time DESC,e.id DESC,cu.circuit_tb_id;
"@

  $lastEvent = $null
  foreach ($r in @(Invoke-SqliteQuery $sql)) {
    $eventId = [string]$r[0]
    if ($eventId -ne $lastEvent) {
      Add-Line ""
      Add-Line ("TINT #"+$eventId+" | "+$r[1]+" | dispenser="+$r[2]+" | serial="+$r[3]+" | "+$r[4])
      $lastEvent = $eventId
    }
    Add-Line ("  circuit="+$r[5]+" | colorant="+$r[6]+" | module="+$r[7]+" | canister="+$r[8]+" | amount="+$r[9]+" | unit="+$r[10]+" | dosed="+$r[11]+" | result="+$r[12]+" | strategy="+$r[13])
  }

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($OutFile,$lines,$utf8)
  Add-Line ""
  Add-Line ("DONE: " + $OutFile)
} finally {
  if ($db -ne [IntPtr]::Zero) { [void][KristineTintHistorySqlite]::sqlite3_close($db) }
}
