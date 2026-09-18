# KRISTINE SQL-Grundlage

Diese Struktur wird zuerst als **Schattenbestand** aufgebaut. Die bestehende
Dateiablage bleibt bis zur gemeinsamen Kontrolle die führende Quelle.

## Sicherheitsregeln

1. Kein Löschen oder Überschreiben der bestehenden JSON-/PDF-Daten.
2. Jeder Import bekommt eine `source_import_id`, eine Herkunft und einen Hash.
3. Importierte Einzelbuchungen sind über `(source_system, source_key)` eindeutig.
4. Korrekturen erfolgen als neue Revision; die Änderung landet zusätzlich im
   `audit_log`.
5. Oberflächen lesen erst nach bestandenem Vergleich und ausdrücklicher
   Freigabe aus SQL.

## Einführung

1. **Schema anlegen** – Migrationen in numerischer Reihenfolge ausführen.
2. **Schattenimport** – Baustellen, Budgets und Stunden nur nach SQL kopieren.
3. **Kontrolle** – `controls/001_hours_consistency.sql` ausführen und die
   Abweichungen je Baustelle gemeinsam prüfen.
4. **Doppel-Schreiben** – erst nach null ungeklärten Abweichungen.
5. **Lesen aus SQL** – einzeln je Fachbereich freigeben, beginnend mit der
   Baustellen-/Stundenübersicht.

## Festgelegte Stundenregel v1

- `Angebot`, `Fertig – nicht abgerechnet`, `Abgerechnet`, `Geschlossen`:
  keine offenen Auftragsstunden.
- `Auftrag`: das gesamte Soll zählt als offen.
- `Laufend`: Soll minus tatsächlich erfasste Stunden, mindestens null.
- Regie und Auftrag werden getrennt gespeichert, aber für den gesamten
  Baustellenfortschritt gemeinsam berücksichtigt.
- Sammelmappen erscheinen einmal. Ihre Mitglieder werden in der
  Portfoliosumme nicht zusätzlich gezählt.

Diese Regel bildet die Beschriftung „Auftrag + Reststunden laufend“ wörtlich
ab. Vor einer Live-Schaltung wird sie mit echten Beispielen kontrolliert.
