# Kristine: verbindliche Architekturentscheidungen und Fachmodell
Stand: 06.10.2026. Fachliche Entscheidungen von Alexander bestätigt.

## Verbindlich
- Ziel: PostgreSQL auf Render. Kristine führt alle neuen Geschäftsdaten.
- WinWorker und Obelisk werden nicht mehr operativ verwendet. Beide sind Altbestände.
- Lesende Anbindungen bleiben für vollständige Übernahme im festgelegten Datenumfang und Abgleich bestehen. Laufende Importe erst nach erfolgreicher Prüfung abschalten; Originale als lesbare Archive erhalten.
- Bis zum Monatsabschluss verwenden Kriszeit und Baustellenzeit dieselben fachlichen Zeitblöcke.
- Monatsabschluss erzeugt einen unabhängigen, festgeschriebenen Kriszeit-Stand. Spätere Baustellenänderungen verändern diesen Stand nicht.
- Start-, Mittag-, Abend-, Pausen- und Berechnungsregeln bleiben bei der Speicherumstellung erhalten. Die neu bestätigte Entkopplung erfolgt am Monatsabschluss; vorhandene Tagesfreigabe-/Abkopplungspfade müssen dazu gesondert angepasst und geprüft werden.

## Zielmodell: technische Ausarbeitung
Die folgenden Tabellen sind ein Zielentwurf, noch keine ausgeführten Migrationen. Ausgestaltung anhand der echten Quellschemata verifizieren.

| Bereich | Tabellen / Beziehungen |
|---|---|
| Herkunft und Import | source_systems, import_runs, source_records, external_references, reconciliation_results |
| Stammdaten | parties, party_roles, contact_people, addresses, employees, employee_external_ids |
| Baustellen | projects, project_parties, project_addresses, project_status_history, collections, collection_members |
| Planung | assignments, absences, worktime_models |
| Zeit | time_events, time_segments, time_segment_revisions, day_reviews, day_closes |
| Monatsabschluss | payroll_month_closes, payroll_snapshot_segments, payroll_snapshot_totals |
| Angebote und Aufträge | offers, offer_lines, orders, order_lines, order_schedules |
| Ausgangsbelege | outgoing_invoices, outgoing_invoice_lines, invoice_order_links |
| Eingangsbelege und Zahlung | incoming_invoices, incoming_invoice_lines, payments, bank_transactions, payment_allocations |
| Regie | regie_reports, regie_people, regie_material_lines |
| Material und Lager | products, supplier_products, price_history, purchase_orders, purchase_order_lines, goods_receipts, stock_movements |
| Dokumente | documents, document_versions, project_documents, invoice_documents, regie_documents |
| Aufgaben und Kommunikation | tasks, task_project_links, messages, audit_events |

Primärschlüssel sind stabile interne IDs. Baustellennummer, Belegnummer und externe Personalnummer sind separate Fachkennungen; führende Nullen bleiben erhalten. Mehrere Firmen/Betriebe müssen über eine ausdrückliche Unternehmenszuordnung getrennt werden; Eindeutigkeit gilt im passenden Unternehmenskontext.

Ein Kontakt kann Kunde und Lieferant sein. Gleichnamigkeit allein führt nicht zu Zusammenführung. Externe Referenzen sind eindeutig nach Quellsystem, Quellinstanz und Entitätstyp plus externer ID; ein Kristine-Datensatz kann mehrere Referenzen besitzen. Externe Referenzen werden auf konkrete Fachtabellen mit Fremdschlüsseln abgebildet, nicht durch ungesicherte freie Ziel-ID-Felder.

Fachliche Beträge/Mengen als NUMERIC mit definierter Einheit und Währung; keine binären Float-Summen. Arbeitsdatum und lokale Uhrzeit sind von Ereignis-Zeitstempeln zu trennen; Geschäftszeitzone Europe/Vienna. Abgeleitete Werte sind reproduzierbar und tragen eine Berechnungsregel-Version.

## Zeit und Monatsabschluss
1. Ereignisse bleiben nachvollziehbar; bearbeitbare Zeitblöcke tragen Mitarbeiter, Datum, Tätigkeit/Baustelle, Quelle und Revision.
2. Während des offenen Monats beziehen Kriszeit und Baustellenansicht ihre Werte aus denselben Zeitblöcken. Unterschiedliche bestehende Auswertungsregeln bleiben ausdrücklich versioniert.
3. Tagesprüfung/Tagesabschluss prüft und bestätigt den Tag. Er erzeugt keine zweite unabhängige Kriszeit-Kopie und darf gemäß bestehendem Code kein künstliches Ausstempelereignis erzeugen.
4. Monatsabschluss liest einen konsistenten Stand, validiert offene Punkte und erzeugt in einer Transaktion Abschluss plus eigene Snapshot-Zeilen und Summen. Der Snapshot enthält Werte, Zuordnungen, verwendete Regeln und Ursprungsrevisionen; seine Anzeige berechnet sich nicht erneut aus veränderbaren Stamm- oder Baustellendaten.
5. Alle Zeit-Schreibpfade und der Monatsabschluss müssen denselben Sperr-/Versionsmechanismus je Mitarbeiter und Monat verwenden. Ein Abschluss darf nicht parallel mit unbemerkten Korrekturen entstehen.
6. Nach Abschluss bleiben Baustellenblöcke mit Änderungshistorie bearbeitbar. Der abgeschlossene Kriszeit-Snapshot ist unveränderlich. Abweichungen zwischen damaligem Abschluss und aktueller Baustellenzeit sind nachvollziehbar.
7. Datenbankschutz muss UPDATE/DELETE der abgeschlossenen Snapshot-Zeilen verhindern. Rückwirkende Kriszeit-Korrekturen benötigen einen gesonderten, noch zu definierenden Korrekturprozess; keine automatische Wiederöffnung oder Überschreibung.

## Altbestände
- Quellstruktur vollständig inventarisieren, einschließlich Dokumente, Archive und Quell-IDs; Obelisk-Schema und konkrete Entitätstypen sind noch unbekannt.
- Originalexporte unverändert sichern. Staging bewahrt Herkunft, Rohwerte, Quellhash und Importlauf.
- Fachlich zuordnen, Originalnummern behalten und Verknüpfungen auflösen. Bereits bestehende Kristine-Zuordnungen berücksichtigen.
- Dubletten als Kandidaten behandeln; sichere ID-Zuordnungen verwenden. Uneindeutige Zuordnungen werden sichtbar zurückgestellt. Gleicher Betrag oder gleicher Name genügt nicht.
- Wiederholte Importe aktualisieren dieselbe Quellreferenz; sie erzeugen keine zusätzlichen Stunden, Belege oder Umsätze.
- Geprüfte Kristine-Änderungen dürfen nicht vom Altimport überschrieben werden. Quellwerte bleiben in Staging erhalten, Konflikte werden ausgewiesen.
- Historische WinWorker-/Obelisk-Stunden und abgeschlossene Lohnstände nicht als neue laufende Kristine-Zeitereignisse importieren. Keine erfundenen Ereignisse oder Abschlüsse.
- Abgleich: Datensätze, Referenzen, Stunden und fachlich vergleichbare Netto-/Bruttobeträge je Unternehmen, Zeitraum und Quelltyp. Fehlende/ungeklärte Zuordnungen separat berichten; Dokumenthashes prüfen.
- Mehrere bestehende Zeit-Schreibpfade halten nur 20.000 Ereignisse. Archiv-/Backupprüfung ist erforderlich; fehlende Historie niemals als vollständig übernommen ausweisen.

## Dokumentablage
PDFs, Fotos und andere Binärdateien bleiben zunächst in der bestehenden Dateiablage; PostgreSQL führt ihre Metadaten, Versionen, Prüfsummen und Beziehungen. Bestehende URLs und Berechtigungen berücksichtigen. Die SQL-Migration enthält keine automatische Verlagerung aller Binärdateien.

## Umsetzung und Abnahmekriterien
- Der bestehende JSONB-Dokumentstore ist nur eine Kompatibilitäts-/Staging-Vorstufe. Er ersetzt nicht das Fachmodell.
- Erst Quellschemata und konkrete Feldabbildungen, dann normalisierte DDL und Importer.
- Echte PostgreSQL-Tests: wiederholter Import, Fremdschlüssel, Dubletten, parallele Änderungen, atomarer Monatsabschluss und Snapshot-Unveränderlichkeit.
- Sämtliche Leser/Schreiber eines zusammenhängenden Datenbereichs gemeinsam umstellen; keine unkoordinierten Doppel-Schreibpfade.
- Isolierte Testdatenbank, produktnaher Backup-Test, dokumentierter finaler Abgleich und Rückfallweg vor Live-Umschaltung.
- Noch nicht umgesetzt: normalisierte Tabellen, Altimport, Monatsabschluss-Regel und produktive SQL-Anbindung. Der bisherige Entwurf umfasst Inventur, isolierten Dokumentstore und acht lokale Tests; echte PostgreSQL-Integration steht aus.
