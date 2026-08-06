param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"

$releaseRoot = Join-Path "Releases" $Project
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

$zipBaseName = "${Project}_${Version}"
$zipPath = Join-Path $releaseRoot "$zipBaseName.zip"
$tagName = $zipBaseName -replace "[^a-zA-Z0-9._-]", "_"

switch ($Project) {
    "KRISTINE_GO" {
        $files = @(
            "public\kristine-go.html",
            "public\kristine-go.css",
            "public\kristine-go.js",
            "README.md",
            "Version.txt"
        )
    }
    "Tagesreport" {
        $files = @(
            "daily-report.js",
            "README.md",
            "Version.txt"
        )
    }
    "Materialworkflow" {
        $files = @(
            "public\material-admin.html",
            "public\material-request-admin.html",
            "material-master.js",
            "README.md",
            "Version.txt"
        )
    }
    default {
        throw "Unknown project: $Project"
    }
}

@(
    "Project: $Project",
    "Version: $Version",
    "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
) | Set-Content -Path "Version.txt" -Encoding UTF8

$existingFiles = @($files | Where-Object { Test-Path $_ })

if ($existingFiles.Count -eq 0) {
    throw "No release files found."
}

Compress-Archive -Path $existingFiles -DestinationPath $zipPath -Force

git add .
git commit -m "Release $zipBaseName"

if ($LASTEXITCODE -ne 0) {
    throw "Git commit failed."
}

git push

if ($LASTEXITCODE -ne 0) {
    throw "Git push failed."
}

if (-not (git tag --list $tagName)) {
    git tag $tagName
    git push origin $tagName
}

Write-Host ""
Write-Host "RELEASE CREATED"
Write-Host "ZIP: $zipPath"
Write-Host "TAG: $tagName"
Write-Host ""
