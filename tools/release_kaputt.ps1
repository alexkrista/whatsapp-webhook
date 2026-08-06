param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$startTime = Get-Date

$releaseRoot = Join-Path -Path "Releases" -ChildPath $Project
$zipBaseName = "${Project}_${Version}"
$zipPath = Join-Path -Path $releaseRoot -ChildPath "$zipBaseName.zip"
$tagName = $zipBaseName -replace '[^a-zA-Z0-9._-]', '_'

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

$versionContent = @(
    "Projekt : $Project"
    "Version : $Version"
    "Datum   : $(Get-Date -Format 'dd.MM.yyyy HH:mm')"
    ""
    "Freigegeben"
)

$versionContent | Set-Content -Path "Version.txt" -Encoding UTF8

switch ($Project) {
    "KRISTINE_GO" {
        $files = @(
            "public\kristine-go.html"
            "public\kristine-go.css"
            "public\kristine-go.js"
            "README.md"
            "CHANGELOG.md"
            "Version.txt"
        )
    }

    "Tagesreport" {
        $files = @(
            "daily-report.js"
            "README.md"
            "CHANGELOG.md"
            "Version.txt"
        )
    }

    "Materialworkflow" {
        $files = @(
            "public\material-admin.html"
            "public\material-request-admin.html"
            "material-master.js"
            "README.md"
            "CHANGELOG.md"
            "Version.txt"
        )
    }

    default {
        Write-Host ""
        Write-Host "Unbekanntes Projekt: $Project" -ForegroundColor Red
        exit 1
    }
}

$existingFiles = @($files | Where-Object { Test-Path $_ })

if ($existingFiles.Count -eq 0) {
    Write-Host ""
    Write-Host "Keine passenden Dateien gefunden." -ForegroundColor Red
    exit 1
}

Compress-Archive -Path $existingFiles -DestinationPath $zipPath -Force

git add .

$gitChanges = git status --porcelain

if ($gitChanges) {
    git commit -m "Release $zipBaseName"

    if ($LASTEXITCODE -ne 0) {
        throw "Git-Commit fehlgeschlagen."
    }

    git push

    if ($LASTEXITCODE -ne 0) {
        throw "Git-Push fehlgeschlagen."
    }
}
else {
    Write-Host ""
    Write-Host "Keine neuen Git-Änderungen vorhanden." -ForegroundColor Yellow
}

$existingTag = git tag --list $tagName

if ($existingTag) {
    Write-Host ""
    Write-Host "Git-Tag existiert bereits: $tagName" -ForegroundColor Yellow
}
else {
    git tag $tagName

    if ($LASTEXITCODE -ne 0) {
        throw "Git-Tag konnte nicht erstellt werden."
    }

    git push origin $tagName

    if ($LASTEXITCODE -ne 0) {
        throw "Git-Tag konnte nicht hochgeladen werden."
    }
}

$duration = (Get-Date) - $startTime

$duration = (Get-Date) - $startTime

Write-Host ''
Write-Host '============================================'
Write-Host 'RELEASE ERSTELLT'
Write-Host '--------------------------------------------'
Write-Host ('Projekt : {0}' -f $Project)
Write-Host ('Version : {0}' -f $Version)
Write-Host ('ZIP     : {0}' -f $zipPath)
Write-Host ('TAG     : {0}' -f $tagName)
Write-Host ('Dateien : {0}' -f $existingFiles.Count)
Write-Host ('Dauer   : {0} Sekunden' -f ([math]::Round($duration.TotalSeconds, 1)))
Write-Host '============================================'
Write-Host ''