# Personen, Aufgaben und Kommunikation

Migration `004-people-communications.sql` ergänzt 28 Fachtabellen. Zusammen mit 002 und 003 sind damit 92 Fachtabellen definiert. Die Migration ist für eine isolierte Testdatenbank bestimmt; sie wird nicht beim Anwendungsstart ausgeführt. Die Anwendung verwendet diese Tabellen noch nicht.

| Bereich | Tabellen |
| --- | --- |
| Ansprechpartner | contact_people, party_contact_links, project_contact_links |
| Mitarbeiter | employee_profiles, employee_employment_periods, employee_clothing_sizes, employee_clothing_issues |
| Personaldokumente | employee_documents, employee_document_pages, employee_document_checks |
| Aufgaben | tasks, task_assignments, task_comments, task_appointments, task_reminders, task_events |
| Kommunikation | communication_accounts, conversations, messages, message_provider_references, message_recipients, message_attachments, message_delivery_events, inbox_items |
| Verknüpfungen | task_message_links, message_project_links |
| Kundenwünsche | customer_portal_points, customer_portal_point_events |

Alle fachlichen Verknüpfungen verwenden Firmen-ID und interne UUID gemeinsam. WinWorker-/Obelisk-IDs werden über die bestehende Herkunftstabelle auf Ansprechpartner, Aufgaben, Nachrichten, Personaldokumente oder Posteingangseinträge abgebildet. Namen lösen beim Import keine automatische Personenverschmelzung aus.

Ansprechpartner müssen Personen sein; dieselbe Person kann mehreren Firmen und Projekten zugeordnet werden. Mitarbeiterprofile enthalten optionale Geburtstags-, Sozialversicherungs- und Kollektivvertragsangaben. Beschäftigungsperioden speichern Beginn, Ende, Beschäftigungsgrad, Wochenstunden und Gehalt ohne neue Zeitberechnungsregeln. Überlappende historische Perioden werden noch nicht automatisch bereinigt. Führerschein-/Passseiten verweisen auf konkrete Dokumentversionen. Kontrollen speichern Prüf- und nächste Fälligkeit; eine automatische Halbjahres-Erinnerung ist noch nicht angeschlossen.

Aufgabentypen entsprechen Rückruf, Angebot, Problem, Termin, Reklamation, Sonstiges sowie Kundenwunsch und Wareneingang. Prioritäten entsprechen normal, heute und sofort. Pro Aufgabe gibt es höchstens einen aktiven Mitarbeiter als Verantwortlichen. Jede Aufgabenänderung erzeugt eine neue Revision und einen unveränderlichen Snapshot. Kommentare sind interne Aufgabennotizen; Kundenereignisse haben ein eigenes Feld für öffentlichen Text. Die Anwendung muss diese Trennung auch bei der Ausgabe einhalten. Unaufgelöste alte Ersteller-/Mitarbeiternamen bleiben als Herkunftsangabe erhalten.

Nachrichten, Empfänger, Anlagen und Zustellereignisse sind unveränderlich. Anlagen referenzieren exakte Dokumentversionen. Nachrichtenschlüssel verhindern doppelte Importe innerhalb einer Firma; Provider-IDs werden zusätzlich je Kommunikationskonto eindeutig gespeichert. Konten enthalten keine Zugangsdaten. Zustellereignisse dokumentieren Vorgänge, lösen aber keinen Versand aus. Termin- und Erinnerungstabellen starten keine Hintergrundprozesse.

Ein Kundenwunsch verweist eindeutig auf eine Aufgabe derselben Baustelle. Intern erledigt, kundenbestätigt und wieder geöffnet sind getrennte Ereignisse. Ein Aufgabenabschluss erzeugt keine automatische Kundenbestätigung. Portalzugang, Berechtigungen und Freigabe von Personaldokumenten sind nicht Teil dieser Migration.

## Validierung und noch offene Arbeiten

`TEST/database-people.pg.cjs` führt 002–004 in einer frischen PostgreSQL-Engine aus. Geprüft werden Firmen-/Personenbindung, optionale Mitarbeiterdaten, Datumsgrenzen, Verantwortliche, Aufgabenrevisionen, Nachrichtendubletten, Unveränderlichkeit, Dokumentversionen und Kundenbestätigung. Es sind Schema- und Integritätstests mit PGlite; Parallelzugriffe mit mehreren Verbindungen auf Render sind noch separat zu prüfen.

Noch ausstehend: JSON-Importer und Zuordnungsprüfung, Zugriffsrechte auf Personalunterlagen, Anschluss der bestehenden Aufgaben-/Nachrichten-/Portal-Endpunkte, Besuchsprotokolle, Versandwarteschlange samt Wiederholungslogik, fachliche Zustellereignis-Prüfungen und der Abgleich der importierten Historie. Keine Echtkundendaten importiert und keine Live-Datenbank geändert.
