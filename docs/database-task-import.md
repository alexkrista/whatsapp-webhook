# Aufgabenimport

Migration 008 ergänzt Aufgaben um Notiz, Abschlusszeit, ursprüngliche Ersteller-/Bearbeiter-/Baustellen-IDs und Prüfvermerke. Eine zusätzliche Tabelle speichert Termine mit lokalem Datum und Uhrzeit, ohne eine nicht belegte Zeitzone zu erfinden.

Der Import normalisiert Titel, Typ, Priorität, Status, Fälligkeit, Kontaktangaben, Notiz, belegte Zeitstempel und bestehende Mitarbeiter-/Baustellenverweise. Verknüpfungen erfolgen ausschließlich über Quellen-IDs im selben Unternehmen und derselben Quelleninstanz. Nicht aufgelöste IDs bleiben gespeichert und werden markiert; System-Ersteller werden nicht als Mitarbeiter angelegt. Zeitstempel ohne Zeitzone bleiben im Original erhalten; `created_at` ist in diesen Fällen der Importzeitpunkt mit Prüfvermerk.

Die vollständige Datei samt Formatierung und jeder Aufgaben-Datensatz werden unverändert archiviert. Besichtigungsprotokolle, Kundenstamm-Snapshots und Portal-Zusatzfelder bleiben in dieser Quelle erhalten; ihre weitere Normalisierung ist noch offen. Es werden keine Dateien verschoben, Termine in externe Kalender geschrieben oder Benachrichtigungen ausgelöst.

Import und Feld-/Zuordnungs-/Terminprüfungen laufen in einer Transaktion. Der bestehende Datenbanktrigger erzeugt die erste unveränderliche Aufgabenrevision. Wiederholungen prüfen die Ziele und erzeugen keine Duplikate; geänderte Quellen oder Ziele erfordern einen eigenen Abgleich und führen zum Rückrollen. Schemaänderung und Datenimport sind getrennte Transaktionen. Die Anwendung bleibt auf JSON; vor einer SQL-Umschaltung sind Änderungen seit dem Snapshot abzugleichen.
