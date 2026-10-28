$ErrorActionPreference = "Stop"
$bridge = Join-Path $PSScriptRoot "..\tools\kristine-paint-local-bridge.ps1"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($bridge, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Hardware-Bridge hat PowerShell-Syntaxfehler" }

# Nur reine Funktionen aus der Bridge laden; niemals Listener/Drucker starten.
$needed = @("ConvertTo-SafeLabelText", "ConvertTo-FreeLabelLines", "New-FreeReturnLabelZpl")
$definitions = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true)
foreach ($name in $needed) {
    $fn = $definitions | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if (-not $fn) { throw "ZPL-Funktion fehlt: $name" }
    Invoke-Expression $fn.Extent.Text
}

$big = ConvertTo-FreeLabelLines @("60 g / 20 kg", "Putz", "2026") "Groß"
$small = ConvertTo-FreeLabelLines @("Erdgelb", "20 kg") "Klein"
$zpl = New-FreeReturnLabelZpl $big $small "0" "normal"
if ([regex]::Matches($zpl, "\^FD").Count -ne 5) { throw "Erwartet werden fünf Textfelder" }
foreach ($line in @("60 g / 20 kg", "Putz", "2026", "Erdgelb", "20 kg")) {
    if (-not $zpl.Contains("^FD$line^FS")) { throw "Textzeile fehlt: $line" }
}
if (-not $zpl.Contains("^PQ1,0,0,N")) { throw "Es darf nur ein Etikettensatz gedruckt werden" }

$blocked = $false
try { [void](ConvertTo-FreeLabelLines @("eins", "zwei", "drei", "vier") "Test") }
catch { $blocked = $true }
if (-not $blocked) { throw "Mehr als drei Zeilen wurden akzeptiert" }

$blocked = $false
try { [void](ConvertTo-FreeLabelLines @("^XA") "Test") }
catch { $blocked = $true }
# Ungültige ZPL-Steuerzeichen werden aus der Druckfolge entfernt.
$safe = ConvertTo-FreeLabelLines @("^XA", "gut") "Test"
if ($safe[0].Contains("^")) { throw "Unsichere ZPL-Steuerzeichen wurden übernommen" }
Write-Output "paint free multiline ZPL test ok"
