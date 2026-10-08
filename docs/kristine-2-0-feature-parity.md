# KRISTINE 2.0 – Funktionsparität und KGO-Bestandsschutz

Stand: 08.10.2026 – verbindliche Vorgabe für die schrittweise SQL-Umstellung.
**Kein Funktionsverlust. Keine stille Änderung bestehender Arbeitsabläufe. Kein Go-live bei ungeprüften Kernfunktionen.**

## Grundsatz

Die bisherige produktive KRISTINE bleibt funktional der Referenzstand. Die neue SQL-Version darf vorhandene Anzeigen, API-Endpunkte, Hintergrundarbeiten, Sonderregeln oder Ein- und Ausgaben weder entfernen noch unbemerkt anders berechnen. Verbesserungen sind willkommen, aber erst nach fachlich und technisch geprüftem Gleichstand. Die Liste ist ein **Prüfrahmen, keine Behauptung, dass alle Einträge bereits getestet sind**.

Für jeden produktiven Bereich vor der Umschaltung erfassen:
- Einstiegspunkte und Benutzerrollen (Web, Smartphone, WhatsApp, Admin, Brain)
- bestehende API-Verträge und notwendige Datenfelder einschließlich Schreib-, Lese- und Statuswirkung
- erlaubte Geschäftsregeln, Rundungen, Pausen, Sperren und historische Revisionen
- Dokumente, Bilder, Links, Export- und Druckausgaben
- automatische Abläufe (Erinnerungen, Hintergrundjobs, Kalender, Zahlungen, E-Mails), deren Wiederanlauf-/Doppelauslösungsschutz
- Ist-Daten vor/nach Test (Summen, IDs, Zeitblöcke, Rechnungs-/Projektstatus) sowie automatisierte und manuelle Abnahmeschritte.

## KGO / KRISTINE To Go: Phase 1 unverändert

Die produktive Mitarbeiteroberfläche `public/kristine-go.html`, `public/kristine-go.js` und Tagesabschlussseiten sollen **zunächst nicht neu gestaltet oder im Ablauf verändert** werden. KGO ist nicht nur ein Datensender: Es benötigt auch lesende API-Antworten, z. B. Baustelleneinteilung, Mitarbeiterkontext und Zeitstatus. Deshalb werden ausschließlich die dahinterliegenden Speicher-/Serverzugriffe angepasst, nicht die Benutzerführung.

Unverändert erhalten müssen insbesondere:
- Anmelden/Mitarbeiterkontext, aktuelle Baustelle und laufende Zeit
- Start, Pause/Sonderpause, Mittag, Ende, Baustellenwechsel und jeweilige bestehenden Regeln
- Vorher-/Nachher-Fotos, Materialabfrage und Tagesabschluss mit den bereits geltenden Korrektur-/Prüfregeln
- Aufgaben/Bestellungen, Bestätigungen, bestehende Zustands-/Fehlerbehandlung und Wiederaufnahme nach Netzunterbrechung
- Beibehaltung aller bisherigen Benachrichtigungs- und Exportabläufe.

**Spätere KGO-Änderungswünsche separat sammeln** und erst nach erfolgreichem KRISTINE-2.0-SQL-Betrieb umsetzen. Kein Vermischen der Themen im ersten Cutover.

## Prüfkatalog der vorhandenen KRISTINE-Welten

| Bereich | Zwingend zu erhalten und zu verifizieren |
|---|---|
| KRISTINE – Leitstand/Planung | Baustellen, Status 1–5, Mitarbeiter-/Tages-/Wochenzuordnung, mehrere Baustellen/Tag, Überplanung und Abwesenheiten |
| KRISZEIT | Erfassung ab 01.10.2026, Zeitblöcke, Korrekturen, Regeln, Tagesprüfung/-freigaben, Monatsabschluss, Finkzeit, Diäten, Bürozeiten |
| KRISTINE To Go | vollständiger bisheriger Mitarbeiterablauf und identische API-Antworten, nicht nur funktionierende Schreibaufrufe |
| THE BRAIN | historische/aktuelle Dokument- und Rechnungsabfrage, Suchfunktionen, Konto/OP-Ansichten, getrennte Archivquellen |
| KRISADMIN | Mitarbeiterstamm, aktive/inaktive Mitarbeiter, Fahrzeuge, Dokumente, Berechtigungen, Einstellungen |
| Baustellen/Akte/Regie | Fotoprotokolle, Projektakte, Angebote/Aufträge, Regieberichte, Kalkulation, Material, Rechnungen, Druck/Export |
| Kundenportal/Aufgaben | Kundenfreigaben, Projektmaterialien, Kundenwünsche/Aufgaben, Kommunikation und Abschlüsse |
| Banken/Finanzen | Eingangs-/Ausgangsrechnungen, Zuordnung, SEPA, CAMT, Revolut, Zahlungsstatus, Schutz vor Doppelbuchungen |
| KRISTOWER | Dashboard und Auswertungen mit einheitlichen Stichtagen, Definitionen und Datenquellen |
| KRISDRIVE/Farbwelt | Fahrten/Standorte, Lager/Farbmischung, Scans, Bestellungen sowie bestehende Schutz-/Freigabevorgänge |
| Nachrichten/Schnittstellen | WhatsApp, Outlook, Kalendersynchronisation, E-Mail, Druck/PDF, Bestands-Schnittstellen und Hintergrundjobs |

Die tatsächliche Vollständigkeit dieser Matrix muss durch eine Endpunkt-/Schreibpfad-Inventur im Quellcode bestätigt und laufend ergänzt werden.

## Harte Zeit-Grenze

**OBELISK** nur lesbare historische Personalzeiten **bis 30.09.2026**. Keine OBELISK-Zeitdatensätze nach KRISTINE, KRISZEIT oder PostgreSQL importieren. **KRISZEIT** ist ab **01.10.2026** allein operative Quelle. Die gemeinsame Personalnummer verbindet ausschließlich die Darstellung/Auswertung, auch für ehemalige Mitarbeiter.

## Abnahme vor dem Cutover

1. Vergleich derselben Testfälle in bisheriger KRISTINE und KRISTINE 2.0 (inkl. Tablet/Handy).
2. Identische fachliche Resultate für jeden unveränderten Ablauf, auch bei mehrfacher Ausführung, Neustart, Verbindungsabbruch und konkurrierender Bearbeitung.
3. Keine doppelten Schreibpfade oder aus Versehen ausgelöste E-Mails, WhatsApp-Nachrichten, Bank-, Fahrzeug- oder Zutrittsaktionen in der Testumgebung.
4. Snapshot aller Produktionsdaten, finaler Deltaabgleich, vollständiger Restore-/Rollback-Test und explizite Go-live-Freigabe.
5. Erst dann Umschalten zusammengehöriger aktiver Leser/Schreiber. Alte Version bleibt als Rückfallmöglichkeit dokumentiert.

**Freigaberegel: Wenn auch nur eine zwingende Produktivfunktion nicht erfolgreich geprüft wurde, bleibt der alte Betriebsmodus aktiv.**
