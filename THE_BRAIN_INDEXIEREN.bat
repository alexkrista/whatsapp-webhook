@echo off
setlocal
title KRISTINE - THE BRAIN NACHT INDEXER

set "PROJECT_DIR=N:\OneDrive\Dokumente\GitHub\whatsapp-webhook"
set "INDEXER=brain-night-indexer.py"

cd /d "%PROJECT_DIR%" || (
  echo Projektordner nicht gefunden:
  echo %PROJECT_DIR%
  pause
  exit /b 1
)

echo.
echo ==========================================
echo  KRISTINE - THE BRAIN NACHT INDEXER
echo ==========================================
echo.
echo Quelle 1:
echo \\srv-db01\WWDaten\PDF Output\Farben_Krista\Kundenexemplare
echo.
echo Quelle 2:
echo \\srv-db01\WWDaten\Dokman\{FF8BE8FE-F2DA-409B-B71B-8737C40B510F}
echo.
echo Index:
echo N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db
echo.
echo Der Index wird VORHER automatisch gesichert.
echo Vorhandene PDFs werden nicht unnötig neu gelesen.
echo Dokman _Original + bearbeitete Datei zaehlen als EIN Beleg.
echo.
echo ACHTUNG:
echo Dieses Fenster waehrend des Laufs offen lassen.
echo Energiesparmodus des PCs sollte fuer heute deaktiviert sein.
echo.
pause

python "%INDEXER%"

echo.
echo ==========================================
echo  INDEXLAUF BEENDET
echo ==========================================
echo.
echo Logs liegen unter:
echo N:\OneDrive\Dokumente\Kristine\Daten\index_logs
echo.
pause
endlocal
