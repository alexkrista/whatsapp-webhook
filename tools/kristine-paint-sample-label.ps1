# Nur Funktionen. Wird durch die lokale KRISTINE-Hardware-Bridge geladen.
# Musteretikett: ausschliesslich grosse Etikettenflaeche (42 x 44 mm).
function Split-SampleLabelLines([string]$Text, [int]$LineLength, [string]$Field) {
  if (-not $Text -or $Text.Length -gt 70 -or $Text -match '[\r\n\^\~]') {
    throw "$Field fehlt oder enthaelt ungueltige Zeichen"
  }
  $clean = ConvertTo-SafeLabelText $Text 70
  if (-not $clean) { throw "$Field darf nicht leer sein" }
  $words = $clean -split '\s+'
  $lines = New-Object System.Collections.Generic.List[string]
  $current = ""
  foreach ($word in $words) {
    if ($word.Length -gt $LineLength) { throw "$($Field): ein Wort ist zu lang" }
    $candidate = if ($current) { "$current $word" } else { $word }
    if ($candidate.Length -le $LineLength) { $current = $candidate }
    else {
      if ($current) { $lines.Add($current) }
      $current = $word
    }
  }
  if ($current) { $lines.Add($current) }
  if ($lines.Count -gt 2) { throw "$($Field): maximal zwei Zeilen" }
  return ,$lines.ToArray()
}

function New-SampleReturnLabelZpl([string]$Colour, [string]$Material) {
  $colourLines = Split-SampleLabelLines $Colour 18 "Farbe"
  $materialLines = Split-SampleLabelLines $Material 28 "Material"
  $graphicPath = Join-Path $PSScriptRoot "krista-sample-logo-gfa.txt"
  if (-not (Test-Path -LiteralPath $graphicPath)) { throw "KRISTA-Logo fehlt. Bridge neu installieren." }
  $graphic = Get-Content -LiteralPath $graphicPath | Where-Object { $_ -match '^\^GFA,' } | Select-Object -First 1
  if (-not $graphic -or $graphic -cnotmatch ('^\^GFA,640,640,16,[A-F0-9]' + [char]123 + '1280' + [char]125 + '$')) {
    throw "KRISTA-Logo ungueltig. Druck abgebrochen."
  }

  $zpl = New-Object System.Collections.Generic.List[string]
  foreach ($line in @('^XA','^PW464','^LL352','^LT40','^LH0,0')) { $zpl.Add($line) }
  # Farbton gross und fett; zweiter Druck um einen Bildpunkt versetzt.
  $maxColour = ($colourLines | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
  $colorHeight = [int][Math]::Min(60,[Math]::Floor(495 / [Math]::Max(9,$maxColour)))
  $colorWidth = [int][Math]::Round($colorHeight * .58)
  $y = if ($colourLines.Count -eq 1) { 130 } else { 91 }
  foreach ($line in $colourLines) {
    $zpl.Add("^FO145,$y^FB300,1,0,C,0^A0N,$colorHeight,$colorWidth^FD$line^FS")
    $boldY = $y + 1
    $zpl.Add("^FO146,$boldY^FB299,1,0,C,0^A0N,$colorHeight,$colorWidth^FD$line^FS")
    $y += $colorHeight + 12
  }
  # Material direkt darunter. Die Fusszeile bleibt unberuehrt.
  $maxMaterial = ($materialLines | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
  $materialHeight = [int][Math]::Min(26,[Math]::Floor(450 / [Math]::Max(12,$maxMaterial)))
  $materialWidth = [int][Math]::Round($materialHeight * .57)
  $y = if ($materialLines.Count -eq 1) { 229 } else { 217 }
  foreach ($line in $materialLines) {
    $zpl.Add("^FO145,$y^FB300,1,0,C,0^A0N,$materialHeight,$materialWidth^FD$line^FS")
    $y += $materialHeight + 5
  }
  # Fix: links unten Druckdatum, rechts unten das unveraenderliche KRISTA-Logo.
  $date = [DateTime]::Now.ToString('dd.MM.yyyy',[Globalization.CultureInfo]::InvariantCulture)
  $zpl.Add("^FO147,313^A0N,19,12^FD$date^FS")
  $zpl.Add("^FO326,296$graphic^FS")
  # Kein Feld auf dem links liegenden kleinen Etikett.
  $zpl.Add('^PQ1,0,0,N')
  $zpl.Add('^XZ')
  return ($zpl -join [Environment]::NewLine)
}
