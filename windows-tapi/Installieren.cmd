@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\Install-KristineTapiConnector.ps1"
echo.
pause
