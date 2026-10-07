# Dokumentdateien vor SQL-Umstellung

Der Import registriert jede vorhandene Geschäftsdatei mit eigenem Quellpfad, SHA-256, Bytezahl und MIME-Typ in `documents`, `document_versions`, `external_references` und – nur bei exakter bekannter Projekt-ID – `project_documents`. Gleiche Inhalte an verschiedenen Pfaden bleiben getrennte Dokumente. Nicht zuordenbare Projektpfade bleiben im Quellmanifest sichtbar.

Die Bytes werden vor dem SQL-Import in private, nach SHA-256 benannte Originalobjekte unter `/var/data/_sql-import-originals/document-objects` kopiert und erneut gelesen/geprüft. SQL enthält den Storage-Key. Änderungen erzeugen eine neue Version; alte Objekte und Versionen bleiben erhalten. Das ist keine externe Sicherung: Originalobjekte liegen auf derselben Render-Disk.

Unterstützt: PDF, JPEG, PNG, OGG, WAV, WebM, MSG, EML, P7M, BIN, DOCX, XLSX. JSON-Dateien übernimmt der separate Snapshot-Import. Symlinks, unbekannte Endungen, Zugangsdaten und Sitzungsverzeichnisse werden protokolliert und nicht verfolgt. Es werden keine Belege freigegeben, Rechnungen gebucht oder Nachrichten gesendet.

Test: binäre Nullbytes, gleiche Inhalte an getrennten Pfaden, unveränderte Wiederholung, neue Version nach Dateiänderung, historischer Objekt-Readback, Symlinks, Pfadvalidierung und unveränderliche Dokumentversionen.
