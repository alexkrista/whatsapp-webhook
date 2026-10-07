# Importumfang vor dem Cutover

## Umfang und Grenzen

Alle erreichbaren Geschäfts-JSON/JSONL-Quellen auf `/var/data` werden mit vollständigem Originaltext, SHA-256 und einem Laufmanifest versioniert in SQL gesichert. Geschäftsdateien werden bytegenau in private Originalobjekte kopiert; SQL enthält deren versionierte Storage-Keys. Zugangsdaten, Sitzungen, technische Backup-/Temporärdateien bleiben ausgeschlossen. Projektalias `2606109 -> 26099` darf nicht als zweites Projekt oder doppelte Datei interpretiert werden.

Originalsicherung und Fachübernahme sind unterschiedliche Prüfungen. Noch ausschließlich als Originalquellen vorhandene Bereiche – etwa GPS/Fahrtenbücher, Besuche, Mitarbeiterdokumente, Unternehmensregeln, Outlook-Protokolle und weitere WinWorker-Cacheinhalte – sind damit in SQL bewahrt, aber noch nicht vollständig in aktive Domain-Tabellen und produktive Lese-/Schreibpfade umgesetzt. Ein vollständiger Originalbestand erlaubt noch keinen produktiven SQL-Cutover.

## In diesem Schritt strukturiert importiert

- 1.106 Tagesdatensätze: 78 Abschlüsse, 407 Freigaben, 262 Korrekturen, 359 Reviews; 669 historische Änderungsschritte. 13 Datensätze mit Zuordnungsprüfung.
- 72 Regieberichte mit 232 Mitarbeitereinträgen, 139 Materialpositionen, 128 Anhangseinträgen.
- 1.590 Dokumentdateien, 946.811.405 Bytes, mit unabhängiger Originalobjekt-Prüfung; 873 exakte Projektverknüpfungen, 94 noch nicht zuordenbare Projektpfade. Andere Dateien sind allgemeine Geschäftsdateien ohne projektbezogenen Quellpfad.
- 328 aktuelle Materialien und 186 frühere Materialstände, 24 Lieferanten, 62 Rechnungseingänge. 325 aktuelle Materialien besitzen ein boolean-Festpreiskennzeichen. Die zunächst fehlerhaften Preisprüfmarker wurden durch Migration 016 fachlich korrigiert; die vorhandenen Verkaufspreise bleiben erhalten. Historische, deaktivierte, zusammengeführte und gelöschte Datensätze bleiben in ihrem ursprünglichen Status.
- 149.714 Farbkatalog- und Farbgeschäftseinträge einschließlich früherem Katalog erstellt und geprüft; keine Lager-, Bestell-, Druck- oder Zahlungsaktion.

## Externe Quellen

Am 2026-10-07 waren die konfigurierten externen Archivquellen von Render nicht erreichbar: lokaler Connector mit `ECONNREFUSED`, Brain-Adresse mit `ENOTFOUND`. Vorhandene WinWorker-Caches sind Originalquellen, kein Beweis für einen vollständigen WinWorker- oder Obelisk-Export. Für Vollständigkeit werden ein vollständiger Export oder ein erreichbarer, autorisierter Archivdienst und ein Vergleich seines Bestands mit dem SQL-Manifest benötigt.

## Betrieb

Die Anwendung schreibt weiterhin JSON. Importierte Stände sind überprüfte Momentaufnahmen; neue Daten benötigen einen erneuten Delta-Abgleich. PR 147 bleibt Entwurf. Keine Migration in `main` gemergt, kein Storage-Cutover. Dokumentoriginale auf derselben Render-Disk sind keine externe Disaster-Recovery-Sicherung.

Die 256-MB-Datenbank startete während des ersten großen Farbimports neu; das Log belegt automatische Wiederherstellung, die genaue Ursache ist nicht gesichert. Danach war die Farb-Fachtabelle leer. Der Import nutzt nun höchstens 200 Originaldatensätze pro SQL-Paket, ohne JSON-Zahlen zuvor in JavaScript-Zahlen umzuwandeln.

## Abschlussprüfung der erreichbaren Originalquellen

Am 2026-10-07 wurden 941 Geschäfts-JSON/JSONL-Dateien mit 94.245.347 Bytes aus einem frischen Dateisystemlauf erneut gelesen und in SQL geprüft. 32 neue Dateiversionen wurden ergänzt, 909 unveränderte wiederverwendet; 0 Parsing-Prüffälle. Vollständiges Laufmanifest plus Ausschlüsse und Projektalias separat in SQL erhalten. Alle 1.590 Dokumente wurden erneut aus Dateien und Originalobjekten gehasht und ohne neue Fachversionen geprüft. Backup und Ergebnisse: `/var/data/_sql-import-originals/coverage-1791380893052`. Vier während dieses Durchlaufs weitergeschriebene Quellen wurden als separater Delta-Durchlauf nachgezogen; das ersetzt noch keinen automatischen SQL-Schreibpfad.

Validierung: 53 Tests im abschließenden vollständigen Lauf bestanden, einschließlich Farbimport mit mehr als 200 Einträgen, Dateiquellen-Sammler und Festpreiskennzeichen-Korrektur. Alle Migrationen 001–016 gemeinsam in frischer PGlite-Datenbank angewendet: 108 Tabellen im Schema `kristine`. PGlite prüft SQL-Invarianten, ersetzt aber keine PostgreSQL-Server-/Parallelitätsprüfung. Die Live-Importe wurden zusätzlich gegen die tatsächliche Render-Datenbank gelesen/geprüft.

Der abschließende Delta-Durchlauf über vier während des Imports geänderte Quellen wurde am 2026-10-07 um 13:51:03 UTC geprüft; unmittelbar nach dieser Prüfung waren 0 weitere Änderungen dieser vier Quellen offen. Das ist ein dokumentierter Snapshotzeitpunkt, keine laufende Synchronisation.

Live-Prüfung der Materialkorrektur: 514 Zeilen, 325 boolean-Schalter, 0 korrigierte Quellprüffälle, 0 Schalterabweichungen, 0 Preisabweichungen. Quelltext, Raw-Payload und ursprüngliche Importmarker wurden erhalten.


## Nachtrag am 2026-10-07, 15:30 UTC

Der live erreichbare SQL-Bestand wurde erneut geprüft: 108 Tabellen. Eine neue Inventur enthielt 944 Geschäfts-JSON/JSONL-Dateien und 94.348.110 Bytes. 40 neue Originaldateiversionen (7.733.961 Bytes) wurden gesichert, importiert und exakt aus SQL zurückgelesen; ein weiterer begrenzter Nachtrag ergänzte sechs Versionen (2.154.152 Bytes). Beide Läufe hatten 0 Parsing-Prüffälle. Während des ersten Imports änderten sich drei Quellen weiter; beim zweiten Nachtrag waren zwei seiner sechs Quellen erneut verändert. Das ist ausdrücklich keine laufende Synchronisation und keine vollständige Normalisierung dieser Änderungen.

Der neue Materialstamm wurde zusätzlich strukturiert als eigene Quellversion übernommen: 329 Zeilen, 0 Quellprüffälle. Live-Abgleich gegen die Raw-Payload: 0 Verkaufspreisabweichungen, 0 Festpreisschalterabweichungen. Die 329 neuen Fachzeilen sind ein neuer versionierter Materialstand, keine 329 zusätzlichen aktuellen Artikel. Alte Stände bleiben erhalten.

Dokumente: 1.592 Dateien mit 946.976.347 Bytes erneut gehasht, in unabhängigen Originalobjekten geprüft und gegen SQL gelesen. Zwei neue Dokumente/Versionen ergänzt; 1.590 vorhandene Versionen wiederverwendet. 875 exakte Projektverknüpfungen. Die 94 unverknüpften Projektpfade verteilen sich auf `022` (8 Dateien) und `unknown` (86 Dateien); keine automatische Vermutung einer Baustelle.

Prüfnachweise und Inventare: `/var/data/_sql-import-originals/delta-1791386721702` und `/var/data/_sql-import-originals/delta-1791386915596`; abschließende Preis-/Schalterprüfung am 15:30:21 UTC. SQL-Importläufe `9c500e2f-c284-4567-8e67-d8d9213fb423`, `7172724b-e681-4c48-93bc-fc3493efff3d`, Material-Snapshot `cdda268a-d83c-49fe-8813-4fbfe799202a`, Dokumentlauf `dfa2f773-fbc3-44ee-bfe9-3f289d17bac5`.

Weiter offen: Fachabgleich geänderter Zeit-, Tages-, Kontakt- und Projektdatensätze; weitere aktive Domain-Zuordnungen; vollständiger externer WinWorker-/Obelisk-Bestand; ungeklärte Dokumentzuordnungen. Der produktive JSON-Betrieb bleibt unverändert. Kein Merge, Anwendungsdeploy oder Storage-Cutover.


## Versionierter Fachabgleich am 2026-10-07, 15:56 UTC

Migrationen 017–019 ergänzen unveränderliche Fachversionen und vollständige Snapshot-Mitgliedschaften für Tagesdaten, Zeitquellen sowie Kontakte/Baustellen. Aktuelle Sichten wählen den letzten validierten vollständigen Lauf; entfernte Quell-IDs verlassen die aktuelle Sicht, ihre Historie bleibt erhalten. Projektkontakte werden pro Lauf mit der aktuellen Kontaktversion verknüpft, auch wenn die Projektdatei unverändert ist. Bereits vorhandene kanonische Namen/Adressen und alte Importstände werden nicht überschrieben; neue eindeutige Quell-IDs erhalten kanonische Zuordnungen.

Live-Abgleich um 15:48:42 UTC: 1.108 Tagesdatensätze (79 Abschlüsse, 407 Freigaben, 263 Korrekturen, 359 Reviews), 670 historische Schritte, 14 Datensätze mit Prüfhinweisen. 1.685 aktuelle Zeitereignisse, davon 63 erstmals übernommen, 408 Archivtage und 758 Archivblöcke. 119 Ereignisse und 39 Blöcke mit Prüfhinweisen. Wiederholung: 0 zusätzliche Tagesversionen, Zeitereignisse oder Archivversionen. Alle sechs Quellen unmittelbar danach unverändert. Nachweise: `/var/data/_sql-import-originals/reconciliation-1791388026112`. SQL-DATE wird für den Vergleich als Text gelesen; der zunächst erkannte Zeitzonenfehler führte zu einem vollständigen Transaktionsrollback und wurde vor dem erfolgreichen Lauf korrigiert.

Kontakt-/Projektabgleich um 15:56:44 UTC: 29 Kontakte, 92 Baustellen, 13 Kontaktmitglieder und 219 Projektkontaktbeziehungen vollständig rückgelesen. Drei neue kanonische Kontakte und zwei neue kanonische Baustellen ergänzt. 0 unaufgelöste explizite Kontaktreferenzen; 21 Baustellen ohne Quelladresse. 41 Kontakt-/Projektversionen tragen Prüfhinweise; diese Zahl ist keine Zahl fehlender Kontaktreferenzen. Wiederholung: 0 neue kanonische Datensätze und 0 neue Fachversionen, alle Beziehungen erneut geprüft. Quellen unmittelbar nach dem Lauf unverändert. Nachweise: `/var/data/_sql-import-originals/master-reconciliation-1791388599392`. Lauf `d974c916-26b6-4e03-b6c3-dc9e9d80704c`, Wiederholung `780cc72c-1205-4890-9428-7ebca4153eea`.

Validierung: 55 Tests bestanden, einschließlich gemeinsam angewandter Migrationen 001–019, historischer Replay-/Entfernungsfälle, Firmen-/Quellen-Grenzen, unveränderlicher Historie und Rollback neuer kanonischer Kontakte/Baustellen bei ungültigen Beziehungen. Live-Daten bleiben geprüfte Momentaufnahmen; keine automatische Synchronisation und kein produktiver SQL-Lese-/Schreibpfad. Weitere Domain-Zuordnungen, fachliche Prüfhinweise, Dokumentpfade und externe WinWorker-/Obelisk-Vollständigkeit bleiben offen. PR 147 bleibt Entwurf; kein Merge, Anwendungsdeploy oder Storage-Cutover.


### Nachträgliche exakte Projektauflösung

Migration 020 ergänzt separate `resolved_imported_*`-Sichten. Sie behalten die ursprüngliche `project_id` und liefern eine zusätzliche `resolved_project_id` über exakte Quell-ID, Firma und Quellinstanz. Keine Namensähnlichkeit, keine Änderung historischer Importmarker. Live wurden ein Tagesdatensatz, sechs Zeitereignisse und zwei Archivblöcke zusätzlich zugeordnet. Verbleibend: ein Tagesdatensatz mit `express_20260909_edi-mock-mrepugda-hvqi_1788929518281`; 34 Zeitereignisse (`022`: 4, `26086`: 8, `26087`: 10, `ish_lochau`: 12); 37 Archivblöcke (`022`: 30, `26086`: 2, `26087`: 4, `up_913`: 1). Die IDs fehlen im erreichbaren kanonischen Projektstamm; technische Sonder-IDs benötigen fachliche Prüfung. Keine automatisch erfundene Baustelle.

Live: 124 Tabellen; Migration 020 fügt nur Sichten hinzu. Abschließender vollständiger Testlauf: 56 Tests bestanden, Migrationen 001–020 gemeinsam geprüft. Ein zusätzlicher Test bestätigt spätere Zuordnung, unveränderte Originalwerte und Schutz vor gleichlautender ID aus einer anderen Quellinstanz. Die neuen Sichten sind noch keine produktiven App-Lesepfade. Ein erneuter Import mit inzwischen geänderten kanonischen Zuordnungen benötigt einen gesonderten Umgang mit der ursprünglichen unveränderlichen Projektion; die Auflösungssichten lösen diese Leserzuordnung, ersetzen aber keine laufende Importsteuerung.


## Besichtigungen und Mitarbeiterergänzungen, 2026-10-07, 20:29 CEST

Migration 021 ergänzt sieben unveränderliche Tabellen mit Firmen-/Quellen-Grenzen und vollständiger aktueller Laufmitgliedschaft. Live übernommen und rückgelesen: sechs Besichtigungen mit strukturierten Kunden-/Kontaktangaben, Terminfeldern, Besprechung, Leistungsbeschreibung, Schätzung, nächsten Schritten und Konversionsstatus; 30 chronologisch geordnete Verlaufseinträge; 35 Datei-/Audioverweise mit Originalmetadaten, Einwilligungszeit, Transkript und etwaigem Transkriptionsfehler. Kundenstamm und weitere unbekannte Quellfelder bleiben im vollständigen Original erhalten. Vertragsbetrag und numerische Originalwerte werden ohne vorgeschaltete JavaScript-Rundung bewahrt.

Zusätzlich 12 Mitarbeiter-Arbeitsregelstände (Aktivitätsmodus und BUAK-boolean einschließlich `false`) sowie sieben Kontakt-E-Mails versioniert importiert. 0 nicht auflösbare explizite Projektbezüge bei Besichtigungen und 0 nicht auflösbare Mitarbeiterbezüge. Keine Arbeitszeit-/Lohnberechnung und keine Änderung produktiver Regeln.

Wiederholung derselben drei Dateien: 0 neue Besichtigungs- oder Mitarbeiter-Fachversionen. Direkt danach 0 Änderungen an den drei Quelltexten. Snapshot um 18:29:01 UTC / 20:29:01 CEST; Importlauf `6201919a-d829-4c47-b702-7e38ab867d9c`, Wiederholung `4aa0224d-e7e0-4937-a063-707d183d5bbb`. Originale, Manifest und Ergebnis: `/var/data/_sql-import-originals/supplemental-1791397739600`.

Anhangprüfung um 20:30 CEST: Alle 35 referenzierten Originaldateien vorhanden, 35 Quell-Prüfsummen identisch, 35 passende SQL-Dokumentversionen und 35 unabhängige Originalobjekte mit identischem Hash. 0 fehlende Dateien, 0 mehrdeutige Pfade, 0 Hashabweichungen. Nachweis `asset-check.json` im selben Verzeichnis.

Validierung: Abschließender vollständiger Lauf mit 57 bestandenen Tests. Alle Migrationen 001–021 gemeinsam angewendet; Test prüft Dezimalwerte außerhalb der JavaScript-Zahlengenauigkeit, vollständige Originaltexte, `false`-Kennzeichen, Protokollrevisionen, A→B→A-Wiederholung, entfernte aktuelle Datensätze, Firmen-/Quellen-Grenzen, Rollback und unveränderliche Historie. Produktionsbetrieb bleibt JSON. Weitere Bereiche, insbesondere GPS/Fahrtenbuch, detaillierte Mitarbeiterprofile, Unternehmensregeln und externe Archiv-Vollständigkeit, bleiben offen; keine behauptete vollständige Migration.
