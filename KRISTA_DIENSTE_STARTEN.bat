@echo off
setlocal
cd /d "%~dp0"

set "KRISTA_SERVICE_MANAGER_PORT=8765"
set "PYEXE="
where py >nul 2>&1 && set "PYEXE=py -3"
if not defined PYEXE (
  where python >nul 2>&1 && set "PYEXE=python"
)

if not defined PYEXE (
  echo Python wurde nicht gefunden.
  echo Bitte den Brain Connector wie bisher starten.
  pause
  exit /b 1
)

echo KRISTA Dienstemanager wird auf Port %KRISTA_SERVICE_MANAGER_PORT% gestartet ...
start "KRISTA Dienstemanager" /min %PYEXE% "%~dp0krista_service_manager.py"
timeout /t 2 /nobreak >nul

echo Fertig. Test: http://127.0.0.1:%KRISTA_SERVICE_MANAGER_PORT%/healthz
echo Danach in KRISADMIN auf "Dienste" klicken.
timeout /t 4 /nobreak >nul
endlocal
