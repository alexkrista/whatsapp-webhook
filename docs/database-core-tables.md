# Erste Fachtabellen: Migration 002

Diese Migration setzt den ersten normalisierten Tabellenblock des bestätigten Fachmodells um. Sie ist ein isolierter Entwurf, nicht live angewendet. Stammdatenfelder und Quellabbildung werden vor dem produktiven Import mit den echten Beständen verifiziert.

| Bereich | Tabellen |
|---|---|
| Unternehmen | companies |
| Herkunft / Staging | source_systems, source_instances, import_runs, source_records, source_record_versions, external_references |
| Kontakte | parties, party_roles, addresses, party_addresses |
| Mitarbeiter | employees, employee_external_ids |
| Baustellen | projects, project_parties, project_addresses, collections, collection_members |
| Planung | worktime_models, employee_worktime_models, assignments, absences |
| Zeiten | time_events, time_month_locks, time_segments, time_segment_revisions, day_closes |
| Monatsabschluss | payroll_month_closes, payroll_snapshot_segments |
| Dokumente | documents, document_versions, project_documents |

Gesamt: 32 Fachtabellen im Schema `kristine`. Der separate JSONB-Kompatibilitätsspeicher im Schema `kristine_storage` ist keine zusätzliche Fachtabelle.

## Datenintegrität

- Interne UUIDs und zusammengesetzte Unternehmens-Fremdschlüssel trennen Betriebe. Gleiche Baustellennummern sind in unterschiedlichen Betrieben möglich, innerhalb eines Betriebs eindeutig.
- Externe Kennungen bleiben Text, einschließlich führender Nullen. Quellreferenzen unterscheiden Quellsystem, Instanz, Entitätstyp und Original-ID. Wiederholte Importe verwenden dieselben Referenzen; die Importlogik muss dazu gezielt UPSERT verwenden.
- Eine Partei kann mehrere Rollen haben. Namen sind kein automatischer Dublettenschlüssel.
- Originalexporte/Hashes und Versionen werden separat gespeichert. Quelldateien müssen ebenfalls unverändert aufbewahrt werden. Das Schema führt keine automatischen Zusammenführungen oder fachlichen Konvertierungen aus.
- Verweise auf konkrete Zieltypen sind echte Fremdschlüssel. `external_references` unterstützt im ersten Block Partei, Mitarbeiter, Baustelle, Zeitblock und Dokument; weitere Zieltypen folgen mit ihren Fachtabellen.
- Baustellenstatus ist 1–5. Einteilungen erlauben mehrere Einträge pro Tag. Fehlende genaue Uhrzeiten bleiben NULL; künstliche Zeiten werden nicht erzeugt.
- Minutenwerte sind NUMERIC, keine Float-Werte. Arbeitsdatum, Beobachtungszeitstempel und gebuchte Lokalzeit bleiben unterschiedliche Angaben. Konkrete Berechnung erfolgt weiterhin in der Fachlogik.

## Monatsabschluss in der Datenbank

`time_segments` sind die gemeinsame Basis der offenen Kriszeit und Baustellenzeit. Jede Änderung erhöht die Revision und speichert eine historische Version. Zeitereignisse und Quellversionen sind append-only.

Ein Abschluss wird als Entwurf angelegt, mit eigenständigen Snapshot-Zeilen gefüllt und dann in derselben Anwendungstransaktion geschlossen. Die Anwendung muss zuerst `kristine.lock_time_month(company_id, employee_id, month_start)` aufrufen und danach die aktuellen Zeitblöcke lesen; nicht einen zuvor gelesenen Stand blind abschließen. Datenbanktrigger verwenden dieselbe Monatszeile als Sperre und lehnen unvollständige, veraltete oder verfälschte Snapshots und falsche Summen ab. Beginnen und beenden der Anwendungstransaktion ist Aufgabe des noch zu implementierenden Abschlussdiensts.

Abgeschlossene Zeilen und Abschlusskopf sind gegen INSERT-Ergänzung, UPDATE, DELETE und TRUNCATE geschützt. Baustellenkorrekturen und Löschungen bleiben mit Historie möglich, verändern aber den eigenständigen Snapshot nicht. Snapshot-Mitarbeitername, Personalnummer und Baustellenbezeichnungen werden als Werte gespeichert. Snapshot-Quell-IDs sind historische Referenzen ohne löschabhängigen Fremdschlüssel; ihre Zugehörigkeit und Werte werden vor dem Abschluss geprüft.

Historische Altbestands-Zeitblöcke mit `origin='legacy'` gehen nicht in neu erzeugte Kriszeit-Abschlüsse ein. Der Import darf ihnen keine künstliche Live-Herkunft geben. Historische Lohnabschlüsse brauchen ein gesondertes Importmodell und sind noch nicht implementiert.

Normale DML darf diese Schutzregeln nicht umgehen. Produktionsrollen dürfen keine Tabellen besitzen, Trigger deaktivieren, Schemas ändern oder Superuser-Rechte haben. Rollenkonfiguration und Tenant-Zugriffsschutz (Anwendungsautorisierung/RLS) sind noch nicht umgesetzt; die Firmen-Fremdschlüssel sind kein Ersatz dafür.

## Prüfung

Die SQL-Dateien werden gegen PGlite 0.5.8 ausgeführt, eine eingebettete PostgreSQL-Engine mit echten SQL-, Constraint-, Trigger- und Transaktionsprüfungen. Elf Szenarien prüfen Tabellenanlage, Kennungen, Unternehmensgrenzen, Quellversionen, Monatsabschluss, Unveränderlichkeit und den vorhandenen Dokumentstore. Node meldet zwölf Tests einschließlich des übergeordneten Tests. Dazu bestehen acht lokale Dateisystem-/Pool-Protokolltests.

Die zusätzliche GitHub-Workflow-Datei installiert die Testengine isoliert und führt ausschließlich diese Datenbanktests aus. Sie benötigt keine Render-Zugangsdaten und keine echten Datensätze. Lokal nach isolierter Installation:

    npm install --prefix /tmp/kristine-schema-test --no-save --ignore-scripts @electric-sql/pglite@0.5.8
    PGLITE_MODULE_PATH=/tmp/kristine-schema-test/node_modules/@electric-sql/pglite node --test TEST/database-core.pg.cjs

PGlite ist hier eine einzelne Sitzung. Echte parallele PostgreSQL-Verbindungen, Render-Konfiguration, Berechtigungen und Last sind damit noch nicht getestet. Diese Prüfungen sind vor produktiver Verwendung erforderlich. Totals/Kriszeit-Rundungen werden nicht neu berechnet; die Anwendung muss ihre bestehenden Regeln übernehmen.

## Ausstehende Blöcke

Angebote/Aufträge, Ein-/Ausgangsrechnungen, Zahlungszuordnungen, Regie, Produkte/Preishistorie und Bestellungen/Lager sind inzwischen im [zweiten Block](database-business-tables.md) umgesetzt; insgesamt bestehen 64 Fachtabellen. Aufgaben/Kommunikation, weitere Importziele, Kontaktpersonen und Reconciliation-Tabellen folgen. Auch Modellzeitraum-Überlappungen, Tagesprüfungen, interne UP-/Büro-Codes und konkrete Quellfeld-Abbildungen sind noch mit den vorhandenen Daten zu vervollständigen. Das Schema ist keine vollständige Ablöse aller bisherigen JSON-Felder.

Migration 002 ist eigenständig in einer leeren Testdatenbank ausführbar. Beide Migrationen sind absichtlich explizit und atomar; eine zweite Ausführung scheitert, statt unbemerkt ein anderes Schema zu akzeptieren. Ein versionierter Migration-Runner mit Prüfsummen und Datenbankidentitätsprüfung ist vor dem produktiven Betrieb erforderlich.

Noch keine Render-Datenbank angelegt, keine Live-Tabellen geändert, keine Altbestände importiert und kein Servercode auf SQL umgestellt.
