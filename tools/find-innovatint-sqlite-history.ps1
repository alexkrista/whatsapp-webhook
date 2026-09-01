param(
  [string]$DbPath = "C:\wuser\Innovatint\devdata.db",
  [string]$OutFile = "$env:USERPROFILE\Desktop\innovatint-sqlite-history.txt"
)

$ErrorActionPreference = "Stop"

function Test-PythonExe {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  if ($Path -match '(?i)\\WindowsApps\\') { return $false }

  $oldPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "SilentlyContinue"
    $output = & $Path -c "import sys,sqlite3; sys.stdout.write(sys.executable)" 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0 -and -not [string]::IsNullOrWhiteSpace(($output -join ''))) { return $true }
  }
  catch {}
  finally { $ErrorActionPreference = $oldPreference }
  return $false
}

function Find-PythonExe {
  $candidates = @(
    "C:\wuser\Python27\python.exe",
    "C:\wuser\Python27\bin\python.exe",
    "C:\wuser\Innovatint\python.exe",
    "C:\wuser\Innovatint\Python27\python.exe",
    "C:\wuser\Innovatint\python\python.exe",
    "C:\wuser\Innovatint\runtime\python.exe",
    "C:\Python27\python.exe",
    "C:\Program Files (x86)\Python27\python.exe",
    "C:\Program Files\Python27\python.exe",
    "C:\Program Files (x86)\CPSColor\Python27\python.exe",
    "C:\Program Files\CPSColor\Python27\python.exe",
    "C:\Program Files (x86)\Innovatint\Python27\python.exe",
    "C:\Program Files (x86)\Datacolor\Python27\python.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-PythonExe -Path $candidate) { return $candidate }
  }

  # Innovatint/Suite6 bringt Python oft eingebettet an einem nicht standardisierten Ort mit.
  # Deshalb zuerst lokal in den bekannten Programmverzeichnissen suchen und NICHT den
  # Microsoft-Store-App-Alias aus WindowsApps verwenden.
  $roots = @(
    "C:\wuser",
    "C:\Program Files (x86)\Innovatint",
    "C:\Program Files\Innovatint",
    "C:\Program Files (x86)\CPSColor",
    "C:\Program Files\CPSColor",
    "C:\Program Files (x86)\Datacolor",
    "C:\Program Files\Datacolor",
    "C:\Program Files (x86)\Chromaflo",
    "C:\Program Files\Chromaflo"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $found = @(Get-ChildItem -LiteralPath $root -Filter python.exe -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($item in $found) {
      if (Test-PythonExe -Path $item.FullName) { return $item.FullName }
    }
  }

  foreach ($name in @("python.exe","python2.exe","python3.exe")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and (Test-PythonExe -Path $cmd.Source)) { return $cmd.Source }
  }

  throw "Echtes python.exe mit sqlite3-Unterstuetzung nicht gefunden. Microsoft-Store-App-Alias wird absichtlich ignoriert."
}

if (-not (Test-Path -LiteralPath $DbPath)) {
  throw "SQLite DB not found: $DbPath"
}

$python = Find-PythonExe
Write-Host ("Python gefunden: " + $python)
$tempPy = Join-Path $env:TEMP ("kristine_sqlite_history_" + [guid]::NewGuid().ToString("N") + ".py")

$py = @'
from __future__ import print_function
import sys, sqlite3, re, os

DB = sys.argv[1]
OUT = sys.argv[2]

KEY_RE = re.compile(r'(history|order|dispens|tint|transaction|job|ticket|sale|queue|batch|mix)', re.I)
DATE_RE = re.compile(r'(date|time|created|modified|completed|timestamp)', re.I)
DATA_RE = re.compile(r'(colour|color|product|formula|base|can|size|customer)', re.I)


def qident(name):
    return '"' + str(name).replace('"','""') + '"'


def clean(v, limit=180):
    if v is None:
        return ''
    try:
        if isinstance(v, bytes):
            v = v.decode('utf-8', 'replace')
    except Exception:
        pass
    s = str(v).replace('\r',' ').replace('\n',' ')
    return s[:limit]

lines = []
def out(s=''):
    lines.append(s)
    try:
        print(s)
    except Exception:
        pass

out('KRISTINE - Innovatint SQLite History Probe - READ ONLY')
out('DB: ' + DB)
out('Python: ' + sys.executable)
out('This probe executes PRAGMA/SELECT only and sets PRAGMA query_only=ON.')
out('')

con = sqlite3.connect(DB)
try:
    try:
        con.execute('PRAGMA query_only=ON')
    except Exception:
        pass
    con.text_factory = str
    cur = con.cursor()

    tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    out('=== ALL TABLES ===')
    for t in tables:
        try:
            count = cur.execute('SELECT COUNT(*) FROM ' + qident(t)).fetchone()[0]
        except Exception:
            count = '?'
        out('%s\t%s rows' % (t, count))
    out('')

    candidates = []
    for t in tables:
        try:
            cols = cur.execute('PRAGMA table_info(' + qident(t) + ')').fetchall()
        except Exception:
            cols = []
        score = 12 if KEY_RE.search(t) else 0
        for c in cols:
            name = c[1]
            if KEY_RE.search(name): score += 5
            if DATE_RE.search(name): score += 2
            if DATA_RE.search(name): score += 1
        if score:
            try:
                count = cur.execute('SELECT COUNT(*) FROM ' + qident(t)).fetchone()[0]
            except Exception:
                count = 0
            candidates.append((score, count, t, cols))

    candidates.sort(key=lambda x:(-x[0], -int(x[1] or 0), x[2].lower()))
    out('=== HISTORY CANDIDATES ===')
    for score, count, t, cols in candidates[:30]:
        out('SCORE %s - %s - %s rows' % (score, t, count))
        out('  ' + ', '.join('%s:%s' % (c[1], c[2]) for c in cols))
    out('')

    out('=== SAMPLE DATA FROM TOP CANDIDATES ===')
    for score, count, t, cols in candidates[:15]:
        usable = [c for c in cols if str(c[2] or '').lower() not in ('blob',)][:14]
        if not usable:
            continue
        names = [c[1] for c in usable]
        date_cols = [n for n in names if DATE_RE.search(n)]
        order = (' ORDER BY ' + qident(date_cols[0]) + ' DESC') if date_cols else ''
        sql = 'SELECT ' + ','.join(qident(n) for n in names) + ' FROM ' + qident(t) + order + ' LIMIT 5'
        out('--- %s ---' % t)
        out('COLUMNS: ' + ' | '.join(names))
        try:
            rows = cur.execute(sql).fetchall()
            if not rows:
                out('  (empty)')
            for row in rows:
                out('  ' + '\t'.join(clean(v) for v in row))
        except Exception as e:
            out('  WARN: ' + clean(e, 300))
    out('')

finally:
    try:
        con.close()
    except Exception:
        pass

with open(OUT, 'wb') as f:
    data = ('\n'.join(lines) + '\n').encode('utf-8')
    f.write(data)
'@

try {
  [System.IO.File]::WriteAllText($tempPy, $py, (New-Object System.Text.UTF8Encoding($false)))
  & $python $tempPy $DbPath $OutFile
  if ($LASTEXITCODE -ne 0) { throw "Python probe failed with exit code $LASTEXITCODE" }
}
finally {
  Remove-Item -LiteralPath $tempPy -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "DONE: $OutFile"
Write-Host "Bitte diese TXT-Datei hier hochladen."
