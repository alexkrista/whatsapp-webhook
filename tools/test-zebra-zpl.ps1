param(
  [string]$PrinterName = "ZDesigner ZD220-203dpi ZPL",
  [string]$Text = "KRISTINE TEST"
)

$ErrorActionPreference = "Stop"

$printer = Get-Printer -Name $PrinterName -ErrorAction Stop
if ($printer.PrinterStatus -eq 'Offline') {
  throw "Printer ist offline: $PrinterName"
}

$source = @'
using System;
using System.Runtime.InteropServices;

public static class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In] DOCINFOA di);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
}
'@

if (-not ('RawPrinterHelper' -as [type])) {
  Add-Type -TypeDefinition $source -Language CSharp
}

# ZD220 mit 203 dpi: ca. 8 dots/mm.
# Gesamtbreite 58 mm = 464 dots.
# Bereich 1: 16 x 40 mm = 128 x 320 dots.
# Bereich 2: 42 x 44 mm = 336 x 352 dots, direkt anschliessend.
# KORREKTUR: Gegenueber dem letzten Test ALLES in die Gegenrichtung:
# - Bereiche UNTEN buendig: links beginnt 4 mm spaeter als rechts.
# - komplette Gruppe ca. 5 mm tiefer in Vorschubrichtung.
# ^LT40 verschiebt den Druck um ca. 5 mm in Vorschubrichtung.
$zpl = @"
^XA
^PW464
^LL352
^LT40
^LH0,0
^FO1,33^GB126,318,2^FS
^FO129,1^GB334,350,2^FS
^FO127,0^GB2,352,2^FS
^FO18,62^A0N,32,32^FD1^FS
^FO10,114^A0N,20,20^FD16 x 40^FS
^FO150,28^A0N,36,36^FD$Text^FS
^FO150,86^A0N,24,24^FD42 x 44 mm^FS
^FO150,132^A0N,22,22^FD58 mm Gesamtbreite^FS
^XZ
"@

$bytes = [System.Text.Encoding]::ASCII.GetBytes($zpl)

$hPrinter = [IntPtr]::Zero
if (-not [RawPrinterHelper]::OpenPrinter($PrinterName, [ref]$hPrinter, [IntPtr]::Zero)) {
  throw "OpenPrinter fehlgeschlagen. Win32: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$ptr = [IntPtr]::Zero
try {
  $di = New-Object RawPrinterHelper+DOCINFOA
  $di.pDocName = "KRISTINE Zebra Format-Test 58mm"
  $di.pDataType = "RAW"

  if (-not [RawPrinterHelper]::StartDocPrinter($hPrinter, 1, $di)) {
    throw "StartDocPrinter fehlgeschlagen. Win32: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  try {
    if (-not [RawPrinterHelper]::StartPagePrinter($hPrinter)) {
      throw "StartPagePrinter fehlgeschlagen. Win32: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    try {
      $ptr = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
      $written = 0
      if (-not [RawPrinterHelper]::WritePrinter($hPrinter, $ptr, $bytes.Length, [ref]$written)) {
        throw "WritePrinter fehlgeschlagen. Win32: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
      }
      if ($written -ne $bytes.Length) {
        throw "Unvollstaendig gedruckt: $written von $($bytes.Length) Bytes"
      }
    }
    finally {
      if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($ptr) }
      [void][RawPrinterHelper]::EndPagePrinter($hPrinter)
    }
  }
  finally {
    [void][RawPrinterHelper]::EndDocPrinter($hPrinter)
  }
}
finally {
  if ($hPrinter -ne [IntPtr]::Zero) { [void][RawPrinterHelper]::ClosePrinter($hPrinter) }
}

Write-Host "OK: RAW-ZPL an '$PrinterName' gesendet."
Write-Host "Format: 58 mm breit | links 16 x 40 mm | rechts 42 x 44 mm | unten buendig | +5 mm Y-Offset"
Write-Host "Port: $($printer.PortName) | Treiber: $($printer.DriverName) | Status: $($printer.PrinterStatus)"
