$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$installerPath = Join-Path $root "tools\install-kristine-paint-windows-service.ps1"
$bridgePath = Join-Path $root "tools\kristine-paint-local-bridge.ps1"

$installer = Get-Content -LiteralPath $installerPath -Raw
$bridge = Get-Content -LiteralPath $bridgePath -Raw
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "Windows-Installer hat PowerShell-Syntaxfehler" }

$versionMatch = [regex]::Match($installer, '\$expectedVersion\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"')
if (-not $versionMatch.Success) { throw "Installer hat keine auslesbare Sollversion" }
$expectedVersion = $versionMatch.Groups[1].Value

# Version muss aus expectedVersion abgeleitet werden; keine altspezifische
# 1.5-Pruefung im Installationsablauf stehen lassen.
if (-not $installer.Contains('[regex]::Escape($expectedVersion)')) {
  throw "Versionstest ist nicht dynamisch an die Sollversion gebunden"
}
if ($installer.Contains('$bridgeSource -notmatch "version = ')) {
  throw "Veraltete fest verdrahtete Versionspruefung gefunden"
}
$versionPattern = "(?m)^\s*version\s*=\s*'" + [regex]::Escape($expectedVersion) + "'\s*$"
if (-not [regex]::IsMatch($bridge, $versionPattern)) {
  throw "Installer erwartet $expectedVersion, die lokale Bridge enthaelt eine andere Version"
}
$other = "0.0.0"
if ([regex]::IsMatch($bridge, "(?m)^\s*version\s*=\s*'" + [regex]::Escape($other) + "'\s*$")) {
  throw "Falsche Bridge-Version wird akzeptiert"
}

# Fehlschlag VOR der Dienstanlage darf niemals einen bestehenden Dienst
# loeschen, zuruecksetzen oder eine zweite Benutzer-Bridge starten.
if (-not $installer.Contains('$createdNewService = $false') -or
    -not $installer.Contains('if ($createdNewService) {') -or
    -not $installer.Contains('elseif ($previousServiceExists) {') -or
    -not $installer.Contains('if ($legacyStopped -and (Test-Path $legacyPath)) {')) {
  throw "Preflight-Rollback ist nicht gegen unbeabsichtigte Aenderungen abgesichert"
}
Write-Output "paint windows service installer version & rollback test ok"
