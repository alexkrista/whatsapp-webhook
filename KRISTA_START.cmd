@echo off
setlocal
cd /d "%~dp0"
set "INSTALLER=%~dp0krista_service_install.ps1"

if not exist "%INSTALLER%" (
  echo KRISTA Installer fehlt: %INSTALLER%
  pause
  exit /b 1
)

echo KRISTA Dienste werden mit Windows-Administratorrechten eingerichtet ...
echo Es erscheint einmal die Windows-Sicherheitsabfrage.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%INSTALLER%'; $a='-NoProfile -ExecutionPolicy Bypass -File ""'+$p+'""'; $x=Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $a -Wait -PassThru; exit $x.ExitCode"

if errorlevel 1 (
  echo.
  echo KRISTA Dienste konnten nicht eingerichtet werden.
  echo Bitte die Windows-Sicherheitsabfrage mit Ja bestaetigen.
  pause
  exit /b 1
)

echo.
echo KRISTA Dienste sind eingerichtet und laufen im Hintergrund.
echo In KRISADMIN auf Dienste - Aktualisieren klicken.
timeout /t 3 /nobreak >nul
endlocal
