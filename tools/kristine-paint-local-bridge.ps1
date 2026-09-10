param(
  [string]$ScalePort = "COM4",
  [int]$ListenPort = 17831,
  [string]$PrinterName = "ZDesigner ZD220-203dpi ZPL"
)

$ErrorActionPreference = "Stop"

if (-not ('KristineRawPrinterHelper' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class KristineRawPrinterHelper {
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
'@ -Language CSharp
}

function ConvertTo-SafeLabelText([object]$Value, [int]$MaxLength = 40) {
  $text = [string]$Value
  $text = $text.Replace('Ä','Ae').Replace('Ö','Oe').Replace('Ü','Ue').Replace('ä','ae').Replace('ö','oe').Replace('ü','ue').Replace('ß','ss')
  $text = $text -replace '[^A-Za-z0-9 .:/_\-]', ''
  if ($text.Length -gt $MaxLength) { $text = $text.Substring(0, $MaxLength) }
  return $text.Trim()
}

function Get-PmaWeight {
  $port = New-Object System.IO.Ports.SerialPort
  $port.PortName = $ScalePort
  $port.BaudRate = 2400
  $port.DataBits = 7
  $port.Parity = [System.IO.Ports.Parity]::Odd
  $port.StopBits = [System.IO.Ports.StopBits]::One
  $port.Handshake = [System.IO.Ports.Handshake]::None
  $port.ReadTimeout = 5000
  $port.WriteTimeout = 2000
  $port.DtrEnable = $false
  $port.RtsEnable = $false
  $port.Encoding = [System.Text.Encoding]::ASCII

  try {
    $port.Open()
    $port.DiscardInBuffer()
    $port.DiscardOutBuffer()
    $request = [byte[]](0x1B, 0x50) # Sartorius SBI: ESC P = Gewicht ausgeben
    $port.Write($request, 0, $request.Length)

    $deadline = [DateTime]::UtcNow.AddMilliseconds(5000)
    $bytes = New-Object System.Collections.Generic.List[byte]
    do {
      Start-Sleep -Milliseconds 80
      while ($port.BytesToRead -gt 0) { $bytes.Add([byte]$port.ReadByte()) }
      if ($bytes.Count -gt 0) {
        $probe = [System.Text.Encoding]::ASCII.GetString($bytes.ToArray())
        if ($probe.Contains("`n") -or $probe.Contains("`r")) { break }
      }
    } while ([DateTime]::UtcNow -lt $deadline)

    if ($bytes.Count -eq 0) { throw "Keine Antwort von $ScalePort" }
    $raw = [System.Text.Encoding]::ASCII.GetString($bytes.ToArray())
    $m = [regex]::Match($raw, '([-+]?\s*\d+(?:[\.,]\d+)?)\s*(kg|g)\b', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $m.Success) { throw "Gewicht konnte nicht gelesen werden: $($raw.Trim())" }

    $numberText = ($m.Groups[1].Value -replace '\s+', '').Replace(',', '.')
    $value = [double]::Parse($numberText, [Globalization.CultureInfo]::InvariantCulture)
    $unit = $m.Groups[2].Value.ToLowerInvariant()
    $weightKg = if ($unit -eq 'kg') { $value } else { $value / 1000.0 }
    if ($weightKg -le 0) { throw "Waage zeigt kein positives Gewicht" }

    return [ordered]@{
      ok = $true
      port = $ScalePort
      weightKg = [math]::Round($weightKg, 4)
      weightG = [math]::Round($weightKg * 1000.0, 1)
      display = (($m.Value -replace '\s+', ' ').Trim())
      raw = $raw.Trim()
    }
  }
  finally {
    if ($port -and $port.IsOpen) { $port.Close() }
    if ($port) { $port.Dispose() }
  }
}

function New-ReturnLabelZpl([string]$Big, [string]$Small, [string]$Job) {
  $bigText = ConvertTo-SafeLabelText $Big 16
  $smallText = ConvertTo-SafeLabelText $Small 24
  $jobText = ConvertTo-SafeLabelText $Job 44
  if (-not $bigText) { throw "Archivnummer fehlt" }
  if (-not $smallText) { throw "Datum fehlt" }

  $len = $bigText.Length
  # Archivnummer bewusst ca. 6 Druckpunkte groesser als bisher.
  $fontH = 174
  $fontW = 111
  if ($len -ge 3) { $fontH = 166; $fontW = 92 }
  if ($len -ge 4) { $fontH = 156; $fontW = 74 }
  if ($len -ge 5) { $fontH = 144; $fontW = 61 }
  if ($len -ge 7) { $fontH = 124; $fontW = 48 }

  # Kalibriertes Medium am ZD220:
  # Gesamt 58 mm, links 16 x 40 mm, rechts 42 x 44 mm, UNTEN buendig, ^LT40.
  # Links beginnt deshalb 4 mm (=32 dots) tiefer.
  # Grosses Etikett: Datum klein oben, Archivnummer maximal gross + doppelt gedruckt (=fetter), Baustelle klein unten.
  # Kleines Etikett: Archivnummer zuerst und Datum DIREKT DANACH in derselben gedrehten Zeile.
  # Beide Texte bleiben vollstaendig im 16-mm-Bereich; dadurch laeuft LG 1 nicht mehr ins grosse Etikett.
  # ^PQ1 erzwingt genau einen Etiketten-Satz pro Druckauftrag.
  $jobLine = ""
  if ($jobText) {
    $jobLine = "^FO145,276^FB310,2,2,C,0^A0N,18,18^FD$jobText^FS"
  }

  return @"
^XA
^PW464
^LL352
^LT40
^LH0,0
^FO150,48^FB300,1,0,C,0^A0N,20,20^FD$smallText^FS
^FO128,92^FB336,1,0,C,0^A0N,$fontH,$fontW^FD$bigText^FS
^FO129,93^FB334,1,0,C,0^A0N,$fontH,$fontW^FD$bigText^FS
$jobLine
^FO68,58^A0R,50,50^FD$bigText^FS
^FO82,168^A0R,22,22^FD$smallText^FS
^PQ1,0,0,N
^XZ
"@
}

function Send-RawZpl([string]$Zpl) {
  $printer = Get-Printer -Name $PrinterName -ErrorAction Stop
  if ($printer.PrinterStatus -eq 'Offline') { throw "Drucker ist offline: $PrinterName" }

  $bytes = [System.Text.Encoding]::ASCII.GetBytes($Zpl)
  $hPrinter = [IntPtr]::Zero
  if (-not [KristineRawPrinterHelper]::OpenPrinter($PrinterName, [ref]$hPrinter, [IntPtr]::Zero)) {
    throw "OpenPrinter fehlgeschlagen. Win32: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  $ptr = [IntPtr]::Zero
  try {
    $di = New-Object KristineRawPrinterHelper+DOCINFOA
    $di.pDocName = "KRISTINE Restfarbe"
    $di.pDataType = "RAW"
    if (-not [KristineRawPrinterHelper]::StartDocPrinter($hPrinter, 1, $di)) { throw "StartDocPrinter fehlgeschlagen" }
    try {
      if (-not [KristineRawPrinterHelper]::StartPagePrinter($hPrinter)) { throw "StartPagePrinter fehlgeschlagen" }
      try {
        $ptr = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
        $written = 0
        if (-not [KristineRawPrinterHelper]::WritePrinter($hPrinter, $ptr, $bytes.Length, [ref]$written)) { throw "WritePrinter fehlgeschlagen" }
        if ($written -ne $bytes.Length) { throw "Druck unvollstaendig: $written/$($bytes.Length) Bytes" }
      }
      finally {
        if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($ptr); $ptr = [IntPtr]::Zero }
        [void][KristineRawPrinterHelper]::EndPagePrinter($hPrinter)
      }
    }
    finally { [void][KristineRawPrinterHelper]::EndDocPrinter($hPrinter) }
  }
  finally {
    if ($hPrinter -ne [IntPtr]::Zero) { [void][KristineRawPrinterHelper]::ClosePrinter($hPrinter) }
  }
}

function Write-HttpJson($Stream, [int]$StatusCode, $Body) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  $payload = [System.Text.Encoding]::UTF8.GetBytes($json)
  $reason = if ($StatusCode -eq 200) { 'OK' } elseif ($StatusCode -eq 400) { 'Bad Request' } elseif ($StatusCode -eq 404) { 'Not Found' } else { 'Internal Server Error' }
  $headers = "HTTP/1.1 $StatusCode $reason`r`n" +
             "Content-Type: application/json; charset=utf-8`r`n" +
             "Content-Length: $($payload.Length)`r`n" +
             "Access-Control-Allow-Origin: *`r`n" +
             "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n" +
             "Access-Control-Allow-Headers: Content-Type`r`n" +
             "Access-Control-Allow-Private-Network: true`r`n" +
             "Cache-Control: no-store`r`n" +
             "Connection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  $Stream.Write($payload, 0, $payload.Length)
  $Stream.Flush()
}

function Read-HttpRequest($Stream) {
  $reader = New-Object System.IO.StreamReader($Stream, [System.Text.Encoding]::UTF8, $false, 4096, $true)
  $line = $reader.ReadLine()
  if (-not $line) { return $null }
  $parts = $line.Split(' ')
  if ($parts.Length -lt 2) { throw "Ungueltige HTTP-Anfrage" }
  $headers = @{}
  while ($true) {
    $h = $reader.ReadLine()
    if ($null -eq $h -or $h -eq '') { break }
    $p = $h.IndexOf(':')
    if ($p -gt 0) { $headers[$h.Substring(0,$p).Trim().ToLowerInvariant()] = $h.Substring($p + 1).Trim() }
  }
  $length = 0
  if ($headers.ContainsKey('content-length')) { [void][int]::TryParse($headers['content-length'], [ref]$length) }
  $body = ''
  if ($length -gt 0) {
    $buffer = New-Object char[] $length
    $read = 0
    while ($read -lt $length) {
      $n = $reader.Read($buffer, $read, $length - $read)
      if ($n -le 0) { break }
      $read += $n
    }
    if ($read -gt 0) { $body = -join $buffer[0..($read-1)] }
  }
  return [pscustomobject]@{ Method=$parts[0].ToUpperInvariant(); Target=$parts[1]; Headers=$headers; Body=$body }
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $ListenPort)
$listener.Start()
Write-Host "KRISTINE Restfarben Hardware Bridge"
Write-Host "Nur lokal: http://127.0.0.1:$ListenPort"
Write-Host "Waage: $ScalePort | Zebra: $PrinterName"
Write-Host "Scanner: HID/Tastatur direkt im Browser"
Write-Host ""

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 8000
      $client.SendTimeout = 8000
      $stream = $client.GetStream()
      $request = Read-HttpRequest $stream
      if (-not $request) { continue }

      if ($request.Method -eq 'OPTIONS') {
        Write-HttpJson $stream 200 ([ordered]@{ ok=$true })
        continue
      }

      $path = ($request.Target -split '\?', 2)[0]
      try {
        if ($request.Method -eq 'GET' -and $path -eq '/health') {
          $ports = [System.IO.Ports.SerialPort]::GetPortNames()
          $printerOk = $false
          try { $printerOk = $null -ne (Get-Printer -Name $PrinterName -ErrorAction Stop) } catch {}
          Write-HttpJson $stream 200 ([ordered]@{
            ok = $true
            service = 'KRISTINE Restfarben Hardware Bridge'
            version = '1.2.0'
            scale = [ordered]@{ port=$ScalePort; available=($ports -contains $ScalePort) }
            printer = [ordered]@{ name=$PrinterName; available=$printerOk }
          })
        }
        elseif ($request.Method -eq 'GET' -and $path -eq '/weight') {
          Write-HttpJson $stream 200 (Get-PmaWeight)
        }
        elseif ($request.Method -eq 'POST' -and $path -eq '/print') {
          if (-not $request.Body) { throw "JSON-Body fehlt" }
          $data = $request.Body | ConvertFrom-Json
          $big = ConvertTo-SafeLabelText $data.big 16
          $small = ConvertTo-SafeLabelText $data.small 24
          $job = ConvertTo-SafeLabelText $data.job 44
          Send-RawZpl (New-ReturnLabelZpl $big $small $job)
          Write-HttpJson $stream 200 ([ordered]@{ ok=$true; big=$big; small=$small; job=$job; printer=$PrinterName })
        }
        else {
          Write-HttpJson $stream 404 ([ordered]@{ ok=$false; error='Not found' })
        }
      }
      catch {
        Write-HttpJson $stream 500 ([ordered]@{ ok=$false; error=[string]$_.Exception.Message })
      }
    }
    catch {}
    finally {
      if ($stream) { $stream.Dispose() }
      $client.Close()
      $client.Dispose()
    }
  }
}
finally {
  $listener.Stop()
}
