param(
  [string]$ConfigFile = 'C:\wuser\Innovatint\production.ini',
  [string]$OutFile = "$env:USERPROFILE\Desktop\innovatint-db-verbindung.txt"
)

$ErrorActionPreference = 'Stop'

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line {
  param([string]$Text = '')
  $lines.Add($Text)
  Write-Host $Text
}

function Redact-Line {
  param([string]$Line)
  if ($null -eq $Line) { return '' }
  $s = [string]$Line

  # Klassische key=value / key: value Passwortfelder
  $s = [regex]::Replace($s, '(?i)(password|passwd|pwd|pass|dbpass|dbpassword)\s*([=:])\s*([^;\s,}\]]+|"[^"]*"|''[^'']*'')', '$1$2<REDACTED>')

  # URL-Formen wie mysql://user:secret@host/db oder mysql+pymysql://...
  $s = [regex]::Replace($s, '(?i)((?:mysql|mariadb)(?:\+[a-z0-9_]+)?://[^:/@\s]+:)([^@\s]+)(@)', '$1<REDACTED>$3')

  # Allgemeine SQLAlchemy/Paste Connection-URLs mit user:pass@, falls Scheme anders ist
  $s = [regex]::Replace($s, '(?i)([a-z][a-z0-9+._-]*://[^:/@\s]+:)([^@\s]+)(@)', '$1<REDACTED>$3')

  # CLI-Optionen
  $s = [regex]::Replace($s, '(?i)--password(?:=|\s+)([^\s]+)', '--password=<REDACTED>')

  return $s
}

function Looks-Relevant {
  param([string]$Line)
  if ([string]::IsNullOrWhiteSpace($Line)) { return $false }
  return $Line -match '(?i)mysql|mariadb|3306|sqlalchemy|database|datasource|connection|dbhost|dbserver|dbuser|username|user\s*=|host\s*=|port\s*=|production\.ini|include|config'
}

Add-Line 'KRISTINE - Innovatint DB Connection Finder'
Add-Line ('Time: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Add-Line ('Config: ' + $ConfigFile)
Add-Line 'Nur LESEN. Passwortwerte werden vor der Ausgabe entfernt.'
Add-Line ''

if (-not (Test-Path -LiteralPath $ConfigFile)) {
  Add-Line 'FEHLER: production.ini nicht gefunden.'
  Add-Line 'Bitte Screenshot/Datei nicht manuell öffnen oder kopieren.'
  [System.IO.File]::WriteAllLines($OutFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
  exit 2
}

$content = Get-Content -LiteralPath $ConfigFile -ErrorAction Stop
Add-Line '=== RELEVANTE ZEILEN AUS production.ini (PASSWORT AUSGEBLENDET) ==='
$hits = 0
foreach ($line in $content) {
  if (Looks-Relevant -Line $line) {
    Add-Line ('  ' + (Redact-Line -Line $line).Trim())
    $hits++
  }
}
if ($hits -eq 0) { Add-Line '  (keine offensichtlichen DB-Zeilen gefunden)' }
Add-Line ''

# Falls production.ini weitere lokale Konfigurationsdateien referenziert, nur deren Pfade melden.
Add-Line '=== REFERENZIERTE LOKALE KONFIGURATIONEN ==='
$seen = New-Object System.Collections.Generic.HashSet[string]
foreach ($line in $content) {
  foreach ($m in [regex]::Matches([string]$line, '(?i)([A-Z]:\\[^\r\n"'']+\.(?:ini|cfg|conf|config|xml|json|yaml|yml))')) {
    $p = $m.Groups[1].Value.Trim()
    if ($seen.Add($p)) { Add-Line ('  ' + $p) }
  }
}
if ($seen.Count -eq 0) { Add-Line '  (keine weiteren lokalen Config-Dateien referenziert)' }
Add-Line ''

Add-Line 'DONE'
Add-Line 'Bitte nur innovatint-db-verbindung.txt hochladen. Das Passwort steht dort nicht im Klartext.'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($OutFile, $lines, $utf8NoBom)
