@echo off
setlocal
cd /d "%~dp0"

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

echo KRISTA Dienstemanager wird gestartet ...
start "KRISTA Dienstemanager" /min %PYEXE% "%~dp0krista_service_manager.py"
timeout /t 2 /nobreak >nul

echo Fertig. In KRISADMIN auf "Dienste" klicken.
timeout /t 3 /nobreak >nul
endlocal
