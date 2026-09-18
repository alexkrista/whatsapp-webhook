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

## Stundenregeln für die gemeinsame Kontrolle

- `Angebot`, `Fertig – nicht abgerechnet`, `Abgerechnet`, `Geschlossen` zählen
  in beiden Varianten nicht.
- Variante **Rest aktiv**: Bei `Auftrag` und `Laufend` gilt Soll minus Ist.
  Das entspricht aktuell der Baustellenliste (940,4 h am 18.09.2026).
- Variante **Auftrag voll**: Bei `Auftrag` gilt das gesamte Soll, bei `Laufend`
  Soll minus Ist. Das entspricht wörtlich „Auftrag + Reststunden laufend“.
- Regie und Auftrag werden getrennt gespeichert, aber für den gesamten
  Baustellenfortschritt gemeinsam berücksichtigt.
- Sammelmappen erscheinen einmal. Ihre Mitglieder werden in der
  Portfoliosumme nicht zusätzlich gezählt.

SQL weist beide Werte aus. Welche Variante die verbindliche Kennzahl wird,
entscheiden wir erst nach der Kontrolle echter Baustellen.
