@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LOCALAPPDATA%\KristineTapiConnector\KristineTapiConnector.ps1" -IncomingPhone "+436641234567" -IncomingState "RING" -IncomingCallId "kristine-test" -IncomingExtension "Test"
if errorlevel 1 (
  echo Test fehlgeschlagen. Bitte zuerst Installieren.cmd ausfuehren.
) else (
  echo Testanruf wurde an Kristine gemeldet.
)
pause
