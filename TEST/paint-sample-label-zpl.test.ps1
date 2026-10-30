$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$bridgePath = Join-Path $root "tools/kristine-paint-local-bridge.ps1"
$samplePath = Join-Path $root "tools/kristine-paint-sample-label.ps1"
$logoPath = Join-Path $root "tools/krista-sample-logo-gfa.txt"

foreach ($f in @($bridgePath,$samplePath)) {
  $tokens=$null;$errors=$null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$tokens,[ref]$errors)
  if ($errors.Count -gt 0) { throw "Syntaxfehler in $f" }
}
$source = Get-Content -LiteralPath $bridgePath -Raw
$tokens=$null;$errors=$null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
$convert = $ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "ConvertTo-SafeLabelText"
},$true) | Select-Object -First 1
if (-not $convert) { throw "SafeLabelText-Funktion fehlt" }
Invoke-Expression $convert.Extent.Text
. $samplePath

$zpl=New-SampleReturnLabelZpl "Slaked Lime 105" "Intelligent Matt"
if ($zpl -notmatch 'Slaked Lime 105' -or $zpl -notmatch 'Intelligent Matt') {
  throw "Farbe oder Material fehlt"
}
if ($zpl -notmatch '\^FO147,313\^A0N,19,12\^FD\d{2}\.\d{2}\.\d{4}\^FS') {
  throw "Fixes Druckdatum links unten fehlt"
}
$graphicLine = Get-Content $logoPath | Where-Object { $_ -match '^\^GFA,' } | Select-Object -First 1
if (-not $graphicLine -or $zpl -notmatch [regex]::Escape("^FO326,296$graphicLine^FS")) {
  throw "Original KRISTA Logo rechts unten fehlt"
}
if ($zpl -notmatch '\^PQ1,0,0,N' -or $zpl -match '\^FO(0?[0-9]|1[01][0-9]),') {
  throw "Kleines Etikett darf kein Druckfeld enthalten"
}
$colourOccurrences=[regex]::Matches($zpl,'\^FDSlaked Lime 105\^FS').Count
if ($colourOccurrences -ne 2) { throw "Farbe nicht fett doppelt aufgedruckt" }
$bad=$false
try { [void](New-SampleReturnLabelZpl "Farbe" "Material mit ^XA") }catch{$bad=$true}
if (-not $bad) { throw "Unsichere Eingabe akzeptiert" }
$bad=$false
try { [void](New-SampleReturnLabelZpl "Farbe Farbe Farbe Farbe Farbe Farbe Farbe" "Material") }catch{$bad=$true}
if (-not $bad) { throw "Zu langen Farbton akzeptiert" }
Write-Output "sample label ZPL test ok (nur gross; festes Datum/Logo)"
