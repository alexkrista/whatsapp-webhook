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

$zpl = "^XA^PW600^LL300^FO40,40^A0N,42,42^FD$Text^FS^FO40,105^A0N,28,28^FDZebra ZD220 via KRISTINE^FS^FO40,160^GB500,2,2^FS^XZ"
$bytes = [System.Text.Encoding]::ASCII.GetBytes($zpl)

$hPrinter = [IntPtr]::Zero
if (-not [RawPrinterHelper]::OpenPrinter($PrinterName, [ref]$hPrinter, [IntPtr]::Zero)) {
  throw "OpenPrinter fehlgeschlagen. Win32: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$ptr = [IntPtr]::Zero
try {
  $di = New-Object RawPrinterHelper+DOCINFOA
  $di.pDocName = "KRISTINE Zebra Test"
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
Write-Host "Port: $($printer.PortName) | Treiber: $($printer.DriverName) | Status: $($printer.PrinterStatus)"
