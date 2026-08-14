$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Write-Host "KRISTINE · THE BRAIN · NIGHT INDEXER" -ForegroundColor Cyan
Write-Host "Bestehendes KRISTINE_SQL_PASSWORD wird verwendet."
Write-Host ""
# Optional:
# $env:MOSER_PROJECT_ROOTS = "N:\Pfad\zum\Moser-Ordner"
# $env:KRISTINE_PDF_ROOTS = "N:\Archiv1;N:\Archiv2"
# $env:FINK_SQL_SERVER = "SERVER\INSTANZ"
# $env:FINK_SQL_USER = "kristine_reader"
# $env:FINK_SQL_PASSWORD = "..."
# $env:FINK_DATABASES = "FinkDb1,FinkDb2"
python .\brain-night-indexer.py
