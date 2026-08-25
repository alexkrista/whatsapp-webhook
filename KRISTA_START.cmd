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
  echo Python wurde nicht gefunden.
  pause
  exit /b 1
)

powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command ^
  "$env:KRISTA_SERVICE_MANAGER_PORT='8765'; Start-Process -WindowStyle Hidden -FilePath '%PYEXE%' -ArgumentList @('%~dp0krista_service_manager_bg.py') -WorkingDirectory '%~dp0'" >nul 2>&1

echo KRISTA Dienste laufen im Hintergrund.
echo Test: http://127.0.0.1:8765/healthz
timeout /t 3 /nobreak >nul
endlocal
