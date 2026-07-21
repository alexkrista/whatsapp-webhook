# Build 0020.10a – Leitstand Mitarbeiteraktion

- Aktive Mitarbeiter im Leitstand anklickbar
- Dialog mit Status, Baustelle, Arbeits- und Pausenzeit
- Manuelle Feierabend-Nachfrage an genau einen Mitarbeiter
- Neue Admin-API für die gezielte Nachfrage

## Build 0020.10 – Erinnerungen & Automatik

- Mittagserinnerung auf Basis des Arbeitsmodells.
- „Pause“ in der Mittagszeit wird als Mittag oder normale Pause geklärt.
- Nach Ende der Mittagspause fragt Kristine, ob bereits wieder gearbeitet wird und seit wann.
- Um 17:30 Uhr erhält der Chef eine Liste noch aktiver Mitarbeiter.
- Die Mitarbeiter werden direkt gefragt, ob sie noch arbeiten; vergessener Feierabend kann rückwirkend korrigiert werden.

## Build 0020.9c – Offene Arbeiten bei Baustellen

- Aufgaben mit Baustellenbezug in der Baustellenkarte sichtbar.
- Offen-/Erledigt-Zähler und Detaildialog ergänzt.
- Erledigt-Status überall synchron.
- Aufgabenereignisse in die Baustellenchronik eingebunden.
- Warnung vor dem Schließen bei offenen Arbeiten.

# Build 0020.9b – Offene Arbeiten anklickbar

- Leitstand: offene Arbeiten anklickbar.
- Detaildialog und Erledigt-Workflow ergänzt.
- Ersteller-Felder für spätere Rückmeldung vorbereitet.
- Keine Änderungen an Planung, Urlaub, Zeitmodellen oder Tagesreport.

# Build 0020.3 – Speicher-Fix

- Fehlende API-Routen für Feiertage wiederhergestellt.
- Österreichische Feiertage können neu geladen und dauerhaft gespeichert werden.
- Betriebsurlaub kann dauerhaft gespeichert werden.
- Zeitmodelle können wieder geladen und gespeichert werden.
- Standardmodelle Sommer/Winter werden bei leerer Datei automatisch erzeugt.

# Build 0020.2 – Stunden-Engine & Jahresplanung

## Behoben
- Pausen werden nach ihren echten Zeitfenstern 09:00–09:15 und 12:00–12:30 nur dem überlappenden Baustellensegment abgezogen.
- Freitag 07:00–14:15 ergibt wieder korrekt 7,0 Stunden.
- Beschäftigungsgrad und Arbeitsmodell sind getrennt; der Beschäftigungsgrad verändert die Plan-/Sollstunden nicht automatisch.

## Neu
- Urlaub, Krank, Arzt und Feiertag werden als Ganztageswert mit 7,8 Stunden geführt.
- Werkstatt und Aufräumen bleiben unproduktiv und können als Zeitfenster erfasst werden.
- Jahresplanung der produktiven Kapazität nach Arbeitsmodell, Feiertagen, Betriebsurlaub und geplantem Urlaub.
- Kalkulationsbasis bleibt unverändert bei 1.650 Stunden; Plan und tatsächliches Ist werden nur verglichen.

# Datei: docs/CHANGELOG.md

## Build 0020.1
- Pause wird einmal beim größten Tagessegment abgezogen.
- Mehrere Segmente derselben Baustelle/Mitarbeiter werden in einer Karte gebündelt.
- Sortierung Eingeteilt berücksichtigt auch Urlaub/Krank und andere Karten.
- Tageskopf zeigt geplant/verfügbar.
- Admin erhält den Standardreiter Laufend.


## Build 0016 – Planungskarten & Stunden

- Neue Kartentypen in der Planung: Baustelle, Urlaub, Arzt, Krank, Aufräumen und Werkstatt.
- Sonderkarten brauchen keine Baustelle und können wie Baustellenkarten gezogen und kopiert werden.
- Jede Karte besitzt editierbare Planstunden und zeigt diese direkt an.
- Tages-, Wochen- und Monatsübersichten zeigen die geplanten Gesamtstunden.
- Bestehende Baustellenkarten und Drag-&-Drop bleiben erhalten.
- Geändert: `public/kristine.html`, `kristine.js`.

# Phase 1.03 – Tagesabschluss

## Neu

- `Fertig` beendet den offenen Arbeits-, Pausen- oder Mittagsblock und zeigt eine kompakte Tagesübersicht.
- Zeitblöcke werden aus den heutigen `time-events.json`-Einträgen des Mitarbeiters gebildet.
- Abschlussdialog: `Passt` → Material/Fotos → Regie → Feierabend.
- `Ändern` nimmt eine Korrekturmeldung für Chef/Büro auf.
- `Abbrechen` entfernt den vorläufigen Ende-Eintrag und setzt die Arbeitszeit fort.
- Keine offenen Zeiten, kein `[object Object]` und keine fremden Mitarbeiterdaten in der Übersicht.

## Test

- [x] Start → Pause → Weiter → Fertig
- [x] Passt → Nein Material/Fotos → Nein Regie
- [x] Syntaxprüfung `kristine.js`
- [x] Syntaxprüfung `server.js`

# Build 0014.1 – Fehlerkorrektur Mitarbeitermodus

## Behoben

- Bei fehlender Tageseinteilung kann ein Mitarbeiter einen Teil des Baustellennamens eingeben.
- Eine eindeutige Eingabe wie `ish` findet automatisch `ish_lochau`.
- Die gefundene Baustelle wird als tatsächliche Tageseinteilung gespeichert.
- Der anschließende Befehl `Start` beginnt auf dieser Baustelle.
- Die wiederholte Frage „Wo wurdest du eingeteilt?“ wird verhindert.

## Test

- [ ] `start` ohne Einteilung
- [ ] Antwort `ish`
- [ ] Kristine schlägt beziehungsweise übernimmt `ish_lochau`
- [ ] `Start`
- [ ] Arbeitsbeginn wird auf `ish_lochau` gespeichert
- [ ] Keine erneute Frage nach der Baustelle
## Behoben

- Bei fehlender Tageseinteilung kann ein Mitarbeiter einen Teil des Baustellennamens eingeben.
- Eine eindeutige Eingabe wie `ish` findet automatisch `ish_lochau`.
- Die gefundene Baustelle wird als aktuelle Arbeitseinteilung gespeichert.
- Der anschließende Befehl `Start` beginnt auf dieser Baustelle.
- Die wiederholte Frage „Wo wurdest du eingeteilt?“ wird verhindert.
- Bei einer abweichenden Baustelle erhält der **Chef** eine WhatsApp-Nachricht.
# P1.04 – Material, Fotos und Regie-Vormerkung

## Neu
- Material und Baustellenfotos werden im Tagesabschluss getrennt abgefragt.
- Material kann per Text, Sprachnachricht oder Foto erfasst werden.
- Mehrere Materialeinträge sind möglich; Abschluss mit „fertig“.
- Mehrere Baustellenfotos können hochgeladen werden; Abschluss mit „fertig“.
- Regie bleibt eine Vormerkung und kann kurz per Text oder Sprache beschrieben werden.
- Medien werden unter `_kristine/review-media` gespeichert; Einträge unter `day-review-entries.json`.

## Nicht verändert
- Baustellensuche
- Start, Pause, Mittag und Weiter
- Baustellenwechsel
- Tagesübersicht vor der Bestätigung

## P2.02c – Planung RC1 (2026-07-19)

### Neu
- Planungskarten lassen sich in Tag-, Wochen- und Monatsansicht per Drag & Drop auf einen anderen Tag verschieben.
- Mit Strg/Alt beim Ziehen wird eine Karte kopiert statt verschoben.
- Kopierbutton je Karte: morgen, restliche Werktage, nächste Woche oder frei wählbares Datum.
- Anzeige der eingeplanten aktiven Mitarbeiter als `x/y MA` pro Tag und für die sichtbare Woche.
- Anzeige der Mitarbeiterzahl je Baustelle und Tag.
- Drag & Drop und Kopieren speichern die Planung automatisch.

### Geändert
- `public/kristine.html`
- `docs/CHANGELOG.md`

### Nicht geändert
- WhatsApp-/Kristine-Dialoglogik
- Leitstand
- Server- und Datenstruktur

## Build 0018 – Mitarbeiter- und Baustellenplanung
- Neue Umschaltung in der Planung: **Mitarbeiter** / **Baustellen**.
- Mitarbeiteransicht zeigt je Mitarbeiter und Tag alle zugeordneten Karten.
- Baustellenansicht zeigt je Baustelle/Betriebskarte und Tag alle zugeordneten Mitarbeiter.
- Drag & Drop in der Mitarbeiteransicht ändert Mitarbeiter und Datum.
- Drag & Drop in der Baustellenansicht ändert Baustelle/Kartentyp und Datum.
- Beide Ansichten verwenden weiterhin denselben assignments-Datensatz.
- Monatsansicht bleibt als gemeinsame Kalenderübersicht erhalten.

# Build 0019a – Planung & Übersicht

## Planung
- Baustellenansicht mit Sortierung: Eingeteilt, Status, Neueste, Älteste, A–Z und Z–A.
- Gewählte Sortierung wird im Browser beibehalten.
- Standard ist „Eingeteilt“.

## Mitarbeiterübersicht
- Linke Mitarbeiterkarte zeigt Soll, Plan, Geleistet und Rest.
- Bei Überplanung wird die Differenz deutlich ausgewiesen.
- Sollstunden werden aus dem zugeordneten Arbeitszeitmodell und dem jeweiligen Datum ermittelt.

## Kartenanzeige
- Baustellenkarten zeigen Planstunden und bereits geleistete Stunden auf dieser Baustelle.
- Urlaub, Krank und Arzt verwenden 7,8 Stunden je Tag.
- Bei mehreren Baustellenkarten am selben Tag bleibt vorläufig die konkrete Von-bis-Zeit maßgeblich; die automatische Zeitsegmentplanung folgt in Build 0019b.

# Build 0020 – Intelligente Zeitfensterplanung

## Planung
- Die erste Baustelle eines Mitarbeiters übernimmt automatisch den vollständigen Arbeitstag aus dem Zeitmodell.
- Bei einer zweiten oder weiteren Baustelle öffnet sich eine Von-bis-Abfrage.
- Das neue Zeitfenster schneidet den betreffenden Zeitraum automatisch aus bestehenden Baustellensegmenten heraus.
- Bestehende Baustellen können dadurch vor und nach einem eingeschobenen Einsatz weiterlaufen.
- Mehrere Segmente derselben Baustelle pro Tag sind möglich.
- Direkt angrenzende Segmente derselben Baustelle werden automatisch zusammengeführt.
- Beim Verschieben auf einen anderen Mitarbeiter oder Tag wird dieselbe Segmentlogik verwendet.
- Zeitfenster außerhalb des Modelltags erzeugen eine Warnung, blockieren die Planung aber nicht.

## Karten
- Baustellenkarten zeigen kompakt Zeitfenster und berechnete Segmentstunden.
- Unproduktive Ganztagskarten bleiben mit 7,8 Stunden bewertet.

## Daten
- Bestehende assignments-Datenstruktur bleibt kompatibel; jedes Zeitsegment ist weiterhin ein eigener Assignment-Datensatz.


## Build 0020.4 – Segmentstunden-Fix
- Fehler behoben: gespeicherte Modell-/Altstunden (z. B. 9,25 oder 10,0) wurden statt der Segmentdauer angezeigt.
- Baustellenkarten rechnen jetzt zuerst strikt aus `from`/`to`.
- Beispiele: 07:00–13:00 = 5,25 h; 13:00–15:00 = 2,0 h; 15:00–17:00 = 2,0 h.


## Build 0020.6 – Konfigurationsmodul
- Vier alte Spalten durch ein ruhiges Akkordeon ersetzt.
- Arbeitsmodelle mit Pause/Mittag sowie Brutto/Netto ausgebaut.
- Feiertage und Betriebsurlaub kompakt verwaltbar und nach Speichern einklappbar.

## Build 0020.7 – Tagesreport auf aktuellem Stand
- Basis bleibt Build 0020.6 mit Abwesenheiten & Betrieb sowie Konfigurationsmodul.
- Tagesreport-Modul aus Build 0019 ergänzt.
- Button „Tagesreport gestern“ im Leitstand ergänzt.
- Admin-Token wird beim Öffnen des Reports mitgegeben; dadurch kein „Forbidden“ aus der Kristine-Oberfläche.
- Automatische Erzeugung täglich um 05:30 Uhr für den Vortag.

## Build 0020.8 – Datenquellen & Sortierung
- Baustellenliste „Neueste zuerst“ sortiert jetzt nach der jüngsten echten Buchung/Aktivität, nicht nur nach dem letzten Ordnerdatum.
- Geleistete Auftragsstunden werden zusätzlich aus den Kristine-Zeitereignissen berechnet; Baustellen wie Fink_Loos_M3 zeigen dadurch ihre tatsächlich erfassten Stunden.
- Betriebskarten rechts zeigen echte Jahressummen aus der Planung statt festem 0,0-h-Platzhalter.
- Urlaub, Krank, Arzt, Aufräumen, Werkstatt, Schulung, Material holen, Lager und Besprechung sind anklickbar und wählen direkt den Kartentyp.
