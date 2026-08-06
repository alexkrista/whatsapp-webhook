param(
    [Parameter(Mandatory=$true)]
    [string]$Project,

    [Parameter(Mandatory=$true)]
    [string]$Version
)

$releaseRoot = "Releases\$Project"
$releaseName = "${Project}_${Version}"
$releasePath = Join-Path $releaseRoot "$releaseName.zip"

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

$version = @"
Projekt : $Project
Version : $Version
Datum   : $(Get-Date -Format "dd.MM.yyyy HH:mm")

Freigegeben
"@

$version | Set-Content Version.txt -Encoding UTF8

$files = @(
    "public\kristine-go.html",
    "public\kristine-go.css",
    "public\kristine-go.js",
    "README.md",
    "CHANGELOG.md",
    "Version.txt"
)

$existing = $files | Where-Object { Test-Path $_ }

if ($existing.Count -eq 0) {
    Write-Host ""
    Write-Host "Keine Dateien gefunden!"
    exit
}

Compress-Archive `
    -Path $existing `
    -DestinationPath $releasePath `
    -Force

git add .
git commit -m "Release $releaseName"

git push

git tag $releaseName
git push origin $releaseName

Write-Host ""
Write-Host "========================================="
Write-Host " Release erstellt"
Write-Host "-----------------------------------------"
Write-Host " ZIP : $releasePath"
Write-Host " TAG : $releaseName"
Write-Host "========================================="