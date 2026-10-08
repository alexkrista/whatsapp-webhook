# KRISTINE 2.0 – Umstellung ohne Betriebsunterbrechung

Stand: 08.10.2026. Eigenständiger Entwicklungszweig auf Basis der SQL-Vorarbeiten aus PR #147.
**Kein Live-Deploy, kein Storage-Cutover, kein automatischer Datenbankwechsel.**

## Zielbild

KRISTINE 2.0 bündelt Organisation, Planung, KRISZEIT, KRISTOWER, KRISADMIN, THE BRAIN, Aufgaben, Dokumente und KRISDRIVE. Die bestehende Bedienlogik und Fachregeln bleiben erhalten; die Datenhaltung wird verlässlich und domänenübergreifend konsistent.

1. **Ein Produktkopf:** Das bestehende Design aus KRISTINE dient als Vorlage. Gleiche globale Ziele in Render und Brain. Kopf auf Desktop und Smartphone beim Scrollen sichtbar; mobiles Menü begrenzt in der Höhe. Bestehende lokale Detail- und Modalfenster haben ihren eigenen Scrollbereich.
2. **Eine führende Quelle je fachlichem Sachverhalt:** Keine unabhängig berechneten oder konkurrierenden Kopien von offenen Posten, Zeitblöcken, Projektzuordnungen, Stammdaten und Status. Jede Kennzahl benennt Quelle, Stichtag, Definition und Filter; Anzeigevarianten greifen auf dieselbe geprüfte Berechnung zu.
3. **PostgreSQL als künftiges produktives Speichersystem:** Die Tabellen und verifizierten Momentaufnahmen aus PR #147 sind eine Vorstufe. Alle zusammengehörigen aktiven Lese- und Schreibpfade müssen vor dem Umschalten implementiert und getestet sein.
4. **Unveränderte Fachregeln:** Tagesabschluss, Mittag/Abend, Finkzeit-Export, Regieberichte, Zahlungen, Monatsabschluss und Mitarbeiterzuordnungen dürfen durch den Speicherwechsel nicht nebenbei verändert werden.

## Historische Personalzeiten: harter Schnitt

- OBELISK bleibt **ausschließlich lesbare historische Quelle für Personalzeiten bis einschließlich 30.09.2026**.
- KRISZEIT ist **ab 01.10.2026** die alleinige operative Personalzeiterfassung.
- **Keine Übernahme von OBELISK-Zeitdaten in KRISTINE/PostgreSQL/aktuelle KRISZEIT-Tabellen.** Eine historische Anzeige liest OBELISK separat und verbindet die Darstellung über die unveränderte Personalnummer.
- Aktive und ehemalige Mitarbeiter sollen historisch auffindbar bleiben; inaktive Mitarbeiter werden nicht automatisch für die Einsatzplanung aktiviert.
- Keine zukünftigen OBELISK-Plan-/Saldenwerte als geleistete Arbeitszeit interpretieren.

## Paralleler Testbetrieb statt Dual-Write

Die bestehende Produktion arbeitet bis zur geprüften Umschaltung mit ihrer derzeitigen Quelle. Die Entwicklung läuft auf einem separaten GitHub-Zweig und später auf einem **isolierten Render-Testdienst samt separatem Testdatenbestand**. Die Testinstanz darf nicht versehentlich produktive Dateien, Kreditoren- oder Bankdaten ändern und keine echten E-Mails, WhatsApp-Nachrichten, Zahlungsläufe, Fahrzeug-/Zutrittsbefehle oder Zeitfreigaben auslösen.

Zulässig sind: kontrollierte, unveränderliche Produktions-Snapshots in die Testumgebung; rein lesende Vergleichsabfragen; künstliche Testbuchungen ausschließlich in der isolierten SQL-Testdatenbank. Nicht zulässig ist ein unkontrollierter zweiter Schreiber auf die Produktivdaten oder ein dauerhafter paralleler JSON- und SQL-Schreibpfad mit voneinander abweichenden Zuständen.

## Abnahmephasen

- **Phase A – Stabilität:** Die Render-Serverabbrüche vom 08.10.2026 (Exit-Code 1, 17:33/17:58 MESZ) diagnostizieren. Ursache ist derzeit noch nicht nachgewiesen; vor Produktionsumschaltung lösen.
- **Phase B – gemeinsamer Kopf:** Navigation zwischen allen Hauptbereichen Desktop/Mobil prüfen; Scrollen, Planungs-Kopf, Kalender, Detailseiten, Anmeldekontext und Brain-Rücksprung. Diese Änderung ist die erste Umsetzung im vorliegenden Zweig.
- **Phase C – SQL-Testumgebung:** Getrennte Datenbank/Disk/Umgebungsvariablen und nachweislich deaktivierte Außenwirkungen. Vollständige Quellinventur mit Hashes und Änderungsständen; Wiederholbarkeit ohne Duplikate.
- **Phase D – fachliche SQL-Anbindung:** Zusammengehörige Domänen schrittweise samt Lese- und Schreibwegen implementieren, einschließlich konkurrierender Änderungen und Rücknahme. OP-Auswertungen Brain/Toolbar müssen bei identischer Definition dasselbe Ergebnis liefern. KRISZEIT- und Baustellenzeiten dürfen sich nicht unbemerkt auseinanderentwickeln.
- **Phase E – Freigabe:** Vollständige Sicherung außerhalb des Render-Produktionsdatenträgers und Rücksicherungstest; kontrollierter Schreibstopp, letzter Deltaabgleich, dokumentierte Soll-Ist-Prüfung, explizite Freigabe. Erst danach produktiven SQL-Schreibpfad aktivieren und JSON-Schreiber für die umgestellten Domänen abschalten.

## Offene Punkte für einen echten SQL-Go-live

- Vollständige produktive SQL-Leser/Schreiber und Tests unter echter PostgreSQL-Parallelität.
- Prüfhinweise zu Projekt-/Kontakt- und Dokumentzuordnungen; aktueller, vollständiger Deltaabgleich.
- Restore-Test, Abschluss-Snapshot-Schutz und eindeutiger Rollback-Plan.
- Nachvollziehbare Ursache für Render-Serverabbrüche.
- Produktive Freigabe erst nach Abnahme; ein erfolgreiches Deployment oder ein gesetztes `DATABASE_URL` allein ist **keine** Abnahme.

## Umfang dieses ersten Implementierungsschritts

- Gemeinsamen vorhandenen KRISTA-Produktkopf auf Desktop/Mobil sticky gemacht.
- Höhe des Kopfs dynamisch für untergeordnete Planungsleisten bekannt gemacht.
- THE BRAIN um KRISDRIVE ergänzt, Reihenfolge und Aussehen der Navigation angeglichen.
- Regressionstests für Mobile-Menü, Höhenmessung, Navigationsvollständigkeit und Planungsabstände.
- Keine Änderungen an produktiven Zeit-/Geld-/Datenbankschreibwegen.
