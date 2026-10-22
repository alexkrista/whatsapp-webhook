# Baustellen-Metadatenimport

Migration 005 ergänzt den SQL-Bestand ohne neue Tabellen. Ein fehlender Status bleibt NULL und muss über `status_missing` zur Prüfung markiert sein. Leere Namen bleiben unverändert und tragen `name_missing`. Abgelehnte Angebote haben Angebotsstatus 1 und `offer_outcome = rejected`; sie werden nicht als angenommene oder geschlossene Aufträge ausgegeben. Spätere SQL-Leser müssen diese Felder berücksichtigen.

`import-project-metadata.js` übernimmt explizite Ordner-IDs, ohne Namensabgleich. Die vollständige `.meta.json` bleibt bytegetreu als UTF-8-Original und JSONB erhalten, auch wenn keine jobId im Dokument steht. Wiederholung derselben Quelle erzeugt keine doppelten Baustellen. Geänderte Quellen oder Nummernkollisionen brechen den gesamten Datenimport ab.

`run-project-metadata-import.cjs` ist ein ausdrücklich gestartetes Operator-Skript für den geprüften Bestand mit 90 Metadaten-Dateien. Es sichert Originale auf dem bestehenden Datenträger, prüft Firmen- und Quellenzuordnung, führt Migration 005 aus und kontrolliert nach dem Import alle Felder, Originaltexte und Prüfsummen. Die Schemaänderung und der Datenimport sind getrennte Transaktionen. Bei einem Datenimportfehler bleibt die Schemaergänzung bestehen; die Datenimporttransaktion wird zurückgerollt. Änderungen an JSON während des Imports werden am Ende gezählt; vor einer späteren Anwendungsumstellung ist ein erneuter Abgleich nötig.

Das Skript ändert keine JSON-Quelldateien und schaltet die laufende Anwendung nicht um. Zusätzliche Metadaten sind vollständig archiviert, aber noch nicht als Adressen, Kontakte oder Kalkulationswerte in Fachtabellen aufgeteilt.

Validierung: 39 PostgreSQL-Tests mit PGlite bestanden, einschließlich fehlender Stammdaten, Angebotsablehnung, exakter Originaltexte, Wiederholung und atomarem Rückrollen. Mehrverbindungs- und Anwendungsintegrationstests stehen vor der späteren Live-Umstellung noch aus.
