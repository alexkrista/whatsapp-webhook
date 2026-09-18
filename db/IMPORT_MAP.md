# Zuordnung Altbestand → SQL

| Altbestand | SQL-Ziel | Behandlung |
|---|---|---|
| Baustellenordner + `.meta.json` | `jobs` | Nummer bleibt Primärschlüssel, Original in `source_payload` |
| Auftragskalkulation | `job_budgets` | Geld in Cent, Zeiten in Minuten |
| Sammelmappen | `job_collections`, `job_collection_members` | Mitglied darf nur einmal zugeordnet sein |
| KRISZEIT-Zeitereignisse | `work_segments` | eindeutiger Quellschlüssel, keine stille Verdichtung |
| Tagesabschluss/Archivsegmente | `work_segments` | archivierte Segmente ersetzen keine Rohdaten ohne Revision |
| WW-Stunden | `work_segments` | Quelle `WW`, Überschneidung wird im Kontrolllauf ausgewiesen |
| Mitarbeiterstamm | `employees` | aktiv plus Beschäftigungsbeginn/-ende |
| Angebotsentwurf | `offers` | versioniert je Baustelle |
| freigegebene Original-PDF | `offer_documents` | SHA-256, niemals überschreiben |
| Kundenbeauftragung | `offer_acceptances` | bindet exakt eine Dokumentversion |
| Änderungen/Korrekturen | `audit_log` | vorher/nachher, Akteur, Zeitpunkt, Bezug |

## Noch bewusst offen

- Welche Quelle bei einer WW-/KRISTINE-Überschneidung fachlich Vorrang hat.
- Ob Regiestunden beim Status `Auftrag` schon vom Gesamt-Soll abzuziehen sind.
  Regel v1 zählt laut Beschriftung das gesamte Soll; das wird gemeinsam geprüft.
- Welche alten Aufgaben als erledigt/archiviert gelten. Keine Aufgabe wird beim
  ersten Import gelöscht.
