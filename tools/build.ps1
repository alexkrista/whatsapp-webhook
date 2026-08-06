Clear-Host

Write-Host ""
Write-Host "======================================="
Write-Host "        KRISTA BUILD SYSTEM"
Write-Host "======================================="
Write-Host ""
Write-Host "1 - KRISTINE GO"
Write-Host "2 - Tagesreport"
Write-Host "3 - Materialworkflow"
Write-Host "0 - Ende"
Write-Host ""

$wahl = Read-Host "Auswahl"

switch ($wahl) {
    "1" { $project = "KRISTINE_GO" }
    "2" { $project = "Tagesreport" }
    "3" { $project = "Materialworkflow" }
    default { exit }
}

$datum = Get-Date -Format "yyyy.MM.dd"

$beschreibung = Read-Host "Beschreibung"

$version = "$datum - $beschreibung"

Write-Host ""
Write-Host "Projekt : $project"
Write-Host "Version : $version"
Write-Host ""

$ok = Read-Host "Release erstellen? (J/N)"

if ($ok -ne "J") {
    exit
}

.\tools\release.ps1 -Project $project -Version $version