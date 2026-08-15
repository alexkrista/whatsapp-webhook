$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Write-Host "KRISTINE · WW DOCUMENT DISCOVERY" -ForegroundColor Cyan
python -u .\ww-document-discovery.py
