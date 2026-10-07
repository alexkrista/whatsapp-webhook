# Importumfang vor dem Cutover

## Umfang und Grenzen

Alle erreichbaren Geschäfts-JSON/JSONL-Quellen auf `/var/data` werden mit vollständigem Originaltext, SHA-256 und einem Laufmanifest versioniert in SQL gesichert. Geschäftsdateien werden bytegenau in private Originalobjekte kopiert; SQL enthält deren versionierte Storage-Keys. Zugangsdaten, Sitzungen, technische Backup-/Temporärdateien bleiben ausgeschlossen. Projektalias `2606109 -> 26099` darf nicht als zweites Projekt oder doppelte Datei interpretiert werden.

Originalsicherung und Fachübernahme sind unterschiedliche Prüfungen. Noch ausschließlich als Originalquellen vorhandene Bereiche – etwa GPS/Fahrtenbücher, Besuche, Mitarbeiterdokumente, Unternehmensregeln, Outlook-Protokolle und weitere WinWorker-Cacheinhalte – sind damit in SQL bewahrt, aber noch nicht vollständig in aktive Domain-Tabellen und produktive Lese-/Schreibpfade umgesetzt. Ein vollständiger Originalbestand erlaubt noch keinen produktiven SQL-Cutover.

## In diesem Schritt strukturiert importiert

- 1.106 Tagesdatensätze: 78 Abschlüsse, 407 Freigaben, 262 Korrekturen, 359 Reviews; 669 historische Änderungsschritte. 13 Datensätze mit Zuordnungsprüfung.
- 72 Regieberichte mit 232 Mitarbeitereinträgen, 139 Materialpositionen, 128 Anhangseinträgen.
- 1.590 Dokumentdateien, 946.811.405 Bytes, mit unabhängiger Originalobjekt-Prüfung; 873 exakte Projektverknüpfungen, 94 noch nicht zuordenbare Projektpfade. Andere Dateien sind allgemeine Geschäftsdateien ohne projektbezogenen Quellpfad.
- 328 aktuelle Materialien und 186 frühere Materialstände, 24 Lieferanten, 62 Rechnungseingänge. 325 aktuelle Materialien besitzen keinen verwertbaren Verkaufspreis und bleiben offen. Historische, deaktivierte, zusammengeführte und gelöschte Datensätze bleiben in ihrem ursprünglichen Status.
- 149.714 Farbkatalog- und Farbgeschäftseinträge einschließlich früherem Katalog erstellt und geprüft; keine Lager-, Bestell-, Druck- oder Zahlungsaktion.

## Externe Quellen

Am 2026-10-07 waren die konfigurierten externen Archivquellen von Render nicht erreichbar: lokaler Connector mit `ECONNREFUSED`, Brain-Adresse mit `ENOTFOUND`. Vorhandene WinWorker-Caches sind Originalquellen, kein Beweis für einen vollständigen WinWorker- oder Obelisk-Export. Für Vollständigkeit werden ein vollständiger Export oder ein erreichbarer, autorisierter Archivdienst und ein Vergleich seines Bestands mit dem SQL-Manifest benötigt.

## Betrieb

Die Anwendung schreibt weiterhin JSON. Importierte Stände sind überprüfte Momentaufnahmen; neue Daten benötigen einen erneuten Delta-Abgleich. PR 147 bleibt Entwurf. Keine Migration in `main` gemergt, kein Storage-Cutover. Dokumentoriginale auf derselben Render-Disk sind keine externe Disaster-Recovery-Sicherung.

Die 256-MB-Datenbank startete während des ersten großen Farbimports neu; das Log belegt automatische Wiederherstellung, die genaue Ursache ist nicht gesichert. Danach war die Farb-Fachtabelle leer. Der Import nutzt nun höchstens 200 Originaldatensätze pro SQL-Paket, ohne JSON-Zahlen zuvor in JavaScript-Zahlen umzuwandeln.

## Abschlussprüfung der erreichbaren Originalquellen

Am 2026-10-07 wurden 941 Geschäfts-JSON/JSONL-Dateien mit 94.245.347 Bytes aus einem frischen Dateisystemlauf erneut gelesen und in SQL geprüft. 32 neue Dateiversionen wurden ergänzt, 909 unveränderte wiederverwendet; 0 Parsing-Prüffälle. Vollständiges Laufmanifest plus Ausschlüsse und Projektalias separat in SQL erhalten. Alle 1.590 Dokumente wurden erneut aus Dateien und Originalobjekten gehasht und ohne neue Fachversionen geprüft. Backup und Ergebnisse: `/var/data/_sql-import-originals/coverage-1791380893052`. Vier während dieses Durchlaufs weitergeschriebene Quellen wurden als separater Delta-Durchlauf nachgezogen; das ersetzt noch keinen automatischen SQL-Schreibpfad.

Validierung: 51 PostgreSQL/PGlite-Tests im vollständigen Lauf bestanden; nach Paketumstellung gezielter Farbimport-Test mit mehr als 200 Einträgen bestanden; zusätzlicher Dateiquellen-Sammlertest bestanden. Alle Migrationen 001–015 gemeinsam in frischer PGlite-Datenbank angewendet: 108 Tabellen im Schema `kristine`. PGlite prüft SQL-Invarianten, ersetzt aber keine PostgreSQL-Server-/Parallelitätsprüfung. Die Live-Importe wurden zusätzlich gegen die tatsächliche Render-Datenbank gelesen/geprüft.
