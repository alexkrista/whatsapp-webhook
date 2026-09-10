param(
  [string]$PortName = "COM4",
  [int]$BaudRate = 2400,
  [int]$TimeoutMs = 6000
)

$ErrorActionPreference = "Stop"

Write-Host "KRISTINE - Sartorius PMA Evolution Gewichtstest"
Write-Host "Port: $PortName | 2400 Baud | 7O1 | Handshake None"
Write-Host "Der Test sendet nur SBI ESC P (Gewicht anfordern). Keine Tara, keine Einstellungen."
Write-Host ""

$port = New-Object System.IO.Ports.SerialPort
$port.PortName = $PortName
$port.BaudRate = $BaudRate
$port.DataBits = 7
$port.Parity = [System.IO.Ports.Parity]::Odd
$port.StopBits = [System.IO.Ports.StopBits]::One
$port.Handshake = [System.IO.Ports.Handshake]::None
$port.ReadTimeout = $TimeoutMs
$port.WriteTimeout = 2000
$port.DtrEnable = $false
$port.RtsEnable = $false
$port.Encoding = [System.Text.Encoding]::ASCII

try {
  $port.Open()
  $port.DiscardInBuffer()
  $port.DiscardOutBuffer()

  # Sartorius SBI: ESC P = aktuellen Gewichtswert an der Schnittstelle ausgeben.
  $request = [byte[]](0x1B, 0x50)
  $port.Write($request, 0, $request.Length)

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  $bytes = New-Object System.Collections.Generic.List[byte]
  do {
    Start-Sleep -Milliseconds 100
    while ($port.BytesToRead -gt 0) {
      $bytes.Add([byte]$port.ReadByte())
    }
    if ($bytes.Count -gt 0) {
      $textNow = [System.Text.Encoding]::ASCII.GetString($bytes.ToArray())
      if ($textNow.Contains("`n") -or $textNow.Contains("`r")) { break }
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  if ($bytes.Count -eq 0) {
    throw "Keine Antwort von $PortName innerhalb von $TimeoutMs ms. Waage stabil aufstellen und Schnittstellenparameter pruefen."
  }

  $raw = [System.Text.Encoding]::ASCII.GetString($bytes.ToArray())
  $visible = $raw.Replace("`r", "<CR>").Replace("`n", "<LF>")
  Write-Host ("RAW: " + $visible)

  $m = [regex]::Match($raw, '[-+]?\s*\d+(?:[\.,]\d+)?\s*(?:kg|g)\b', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($m.Success) {
    Write-Host ("GEWICHT: " + ($m.Value -replace '\s+',' ').Trim())
  } else {
    Write-Host "Antwort empfangen, Gewicht konnte noch nicht automatisch geparst werden. RAW-Zeile bitte hier zeigen."
  }
}
catch {
  if ($_.Exception.Message -match 'access.*denied|Zugriff.*verweigert|being used|verwendet') {
    throw "Port $PortName ist belegt. Innovatint/PMA-Software koennte die Waage bereits geoeffnet haben. Originalfehler: $($_.Exception.Message)"
  }
  throw
}
finally {
  if ($port -and $port.IsOpen) { $port.Close() }
  if ($port) { $port.Dispose() }
}
