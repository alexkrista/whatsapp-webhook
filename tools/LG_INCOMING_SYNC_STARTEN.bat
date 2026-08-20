@echo off
setlocal
cd /d "%~dp0.."
where py >nul 2>&1
if %errorlevel%==0 (
  py -3 tools\lg-incoming-sync.py
) else (
  python tools\lg-incoming-sync.py
)
pause
