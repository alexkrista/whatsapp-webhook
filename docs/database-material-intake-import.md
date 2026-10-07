# Materialien, Lieferanten und Rechnungseingang

Migration 014 bildet Materialstamm und Lieferanten in eigenen Importtabellen mit expliziten Artikelnummern, Materialcodes, Preisen, Bestand, Lieferantenkennungen und Originalstatus ab. Rechnungseingänge behalten Route, Dateireferenz, Prüfsumme, Bearbeitungsstatus sowie Löschzeitpunkt und Löschgrund. Gelöschte Einträge werden nicht reaktiviert. Der Import erzeugt keine Rechnungsbuchung oder Lagerbewegung.

Jede Tabellenzeile hängt an einer unveränderlichen vollständigen JSON-Quelldateiversion. Positionen bleiben erhalten, auch bei fehlenden oder doppelten Quellkennungen. Alte und neue Materialdateien bleiben durch Quellpfad und Version getrennt. Ein geänderter Quellstand ergänzt eine neue Version; identische Wiederholungen erzeugen keine neuen Fachzeilen. Das vollständige Original bleibt neben expliziten Fachspalten erhalten. Nicht interpretierbare Zahlen werden NULL mit Prüfgrund; fehlende Preise bleiben offen, explizite Nullpreise bleiben Null. Geldwerte verwenden PostgreSQL numeric ohne Berechnung in JavaScript.

Die Snapshot-Sicherung wird vor dem Fachimport abgeschlossen. Scheitert die Fachtransaktion, bleibt diese Originalquelle für Diagnose erhalten; Fachzeilen werden vollständig zurückgerollt. Vor einem produktiven Cutover sind neueste Versionen, Datei-Verfügbarkeit und die aktiven Domain-Zuordnungen gesondert abzugleichen.

## Live-Import

Live am 2026-10-07: 514 Materialzeilen (328 aktuell, 186 früher), 24 Lieferanten und 62 Rechnungseingänge erstellt und geprüft, 600 Fachzeilen insgesamt. 325 ursprüngliche Import-Prüfmarker aufgrund des boolean-Festpreiskennzeichens (mit Migration 016 fachlich korrigiert; keine fehlenden Verkaufspreise); historische Materialdatei ohne Prüfmarker. 65 vollständige Quelldateien erneut geprüft; Quelldateien unverändert. Originalbackup `/var/data/_sql-import-originals/material-intake-1791380125561`.

## Korrektur des Festpreiskennzeichens

`fixedSalePrice` ist bei 325 aktuellen Materialien ein boolean-Schalter. Migration 016 speichert ihn als `fixed_sale_price_enabled` und erzeugt `source_review_reasons` als korrigierte Fachprüfung. Die ursprünglichen Importmarker bleiben unverändert als Audit erhalten. Der Importer behandelt boolean-Werte nicht mehr als Beträge. Alle 514 Verkaufspreise werden zusätzlich direkt mit der Originalquelle verglichen; es werden keine neuen Preise berechnet.
