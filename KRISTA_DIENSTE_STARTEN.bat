@echo off
setlocal
cd /d "%~dp0"

set "KRISTA_SERVICE_MANAGER_PORT=8765"
set "PYEXE="
for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if not defined PYEXE (
  for /f "delims=" %%P in ('where python 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
)

if not defined PYEXE (
  if /I not "%~1"=="--silent" (
    echo Python wurde nicht gefunden.
    echo Bitte den Brain Connector wie bisher starten.
    pause
  )
  exit /b 1
)

if /I not "%~1"=="--silent" (
  echo KRISTA Dienstemanager wird unsichtbar auf Port %KRISTA_SERVICE_MANAGER_PORT% gestartet ...
)

powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command ^
  "$env:KRISTA_SERVICE_MANAGER_PORT='%KRISTA_SERVICE_MANAGER_PORT%'; Start-Process -WindowStyle Hidden -FilePath '%PYEXE%' -ArgumentList @('%~dp0krista_service_manager_runner.py') -WorkingDirectory '%~dp0'" >nul 2>&1

if /I "%~1"=="--silent" exit /b 0

timeout /t 2 /nobreak >nul
echo Fertig. Der Dienstemanager laeuft jetzt im Hintergrund.
echo Windows-Autostart wird vom Dienstemanager automatisch eingerichtet.
echo Test: http://127.0.0.1:%KRISTA_SERVICE_MANAGER_PORT%/healthz
echo Danach in KRISADMIN auf "Dienste" klicken.
timeout /t 4 /nobreak >nul
endlocal
