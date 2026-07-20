Build 0016 – Planungskarten & Stunden
Neue Kartentypen in der Planung: Baustelle, Urlaub, Arzt, Krank, Aufräumen und Werkstatt.
Sonderkarten brauchen keine Baustelle und können wie Baustellenkarten gezogen und kopiert werden.
Jede Karte besitzt editierbare Planstunden und zeigt diese direkt an.
Tages-, Wochen- und Monatsübersichten zeigen die geplanten Gesamtstunden.
Bestehende Baustellenkarten und Drag-&-Drop bleiben erhalten.
Geändert: `public/kristine.html`, `kristine.js`.
Phase 1.03 – Tagesabschluss
Neu
`Fertig` beendet den offenen Arbeits-, Pausen- oder Mittagsblock und zeigt eine kompakte Tagesübersicht.
Zeitblöcke werden aus den heutigen `time-events.json`-Einträgen des Mitarbeiters gebildet.
Abschlussdialog: `Passt` → Material/Fotos → Regie → Feierabend.
`Ändern` nimmt eine Korrekturmeldung für Chef/Büro auf.
`Abbrechen` entfernt den vorläufigen Ende-Eintrag und setzt die Arbeitszeit fort.
Keine offenen Zeiten, kein `[object Object]` und keine fremden Mitarbeiterdaten in der Übersicht.
Test
[x] Start → Pause → Weiter → Fertig
[x] Passt → Nein Material/Fotos → Nein Regie
[x] Syntaxprüfung `kristine.js`
[x] Syntaxprüfung `server.js`
Build 0014.1 – Fehlerkorrektur Mitarbeitermodus
Behoben
Bei fehlender Tageseinteilung kann ein Mitarbeiter einen Teil des Baustellennamens eingeben.
Eine eindeutige Eingabe wie `ish` findet automatisch `ish_lochau`.
Die gefundene Baustelle wird als tatsächliche Tageseinteilung gespeichert.
Der anschließende Befehl `Start` beginnt auf dieser Baustelle.
Die wiederholte Frage „Wo wurdest du eingeteilt?“ wird verhindert.
Test
[ ] `start` ohne Einteilung
[ ] Antwort `ish`
[ ] Kristine schlägt beziehungsweise übernimmt `ish_lochau`
[ ] `Start`
[ ] Arbeitsbeginn wird auf `ish_lochau` gespeichert
[ ] Keine erneute Frage nach der Baustelle
Behoben
Bei fehlender Tageseinteilung kann ein Mitarbeiter einen Teil des Baustellennamens eingeben.
Eine eindeutige Eingabe wie `ish` findet automatisch `ish_lochau`.
Die gefundene Baustelle wird als aktuelle Arbeitseinteilung gespeichert.
Der anschließende Befehl `Start` beginnt auf dieser Baustelle.
Die wiederholte Frage „Wo wurdest du eingeteilt?“ wird verhindert.
Bei einer abweichenden Baustelle erhält der Chef eine WhatsApp-Nachricht.
P1.04 – Material, Fotos und Regie-Vormerkung
Neu
Material und Baustellenfotos werden im Tagesabschluss getrennt abgefragt.
Material kann per Text, Sprachnachricht oder Foto erfasst werden.
Mehrere Materialeinträge sind möglich; Abschluss mit „fertig“.
Mehrere Baustellenfotos können hochgeladen werden; Abschluss mit „fertig“.
Regie bleibt eine Vormerkung und kann kurz per Text oder Sprache beschrieben werden.
Medien werden unter `_kristine/review-media` gespeichert; Einträge unter `day-review-entries.json`.
Nicht verändert
Baustellensuche
Start, Pause, Mittag und Weiter
Baustellenwechsel
Tagesübersicht vor der Bestätigung
P2.02c – Planung RC1 (2026-07-19)
Neu
Planungskarten lassen sich in Tag-, Wochen- und Monatsansicht per Drag & Drop auf einen anderen Tag verschieben.
Mit Strg/Alt beim Ziehen wird eine Karte kopiert statt verschoben.
Kopierbutton je Karte: morgen, restliche Werktage, nächste Woche oder frei wählbares Datum.
Anzeige der eingeplanten aktiven Mitarbeiter als `x/y MA` pro Tag und für die sichtbare Woche.
Anzeige der Mitarbeiterzahl je Baustelle und Tag.
Drag & Drop und Kopieren speichern die Planung automatisch.
Geändert
`public/kristine.html`
`docs/CHANGELOG.md`
Nicht geändert
WhatsApp-/Kristine-Dialoglogik
Leitstand
Server- und Datenstruktur
Build 0018 – Mitarbeiter- und Baustellenplanung
Neue Umschaltung in der Planung: Mitarbeiter / Baustellen.
Mitarbeiteransicht zeigt je Mitarbeiter und Tag alle zugeordneten Karten.
Baustellenansicht zeigt je Baustelle/Betriebskarte und Tag alle zugeordneten Mitarbeiter.
Drag & Drop in der Mitarbeiteransicht ändert Mitarbeiter und Datum.
Drag & Drop in der Baustellenansicht ändert Baustelle/Kartentyp und Datum.
Beide Ansichten verwenden weiterhin denselben assignments-Datensatz.
Monatsansicht bleibt als gemeinsame Kalenderübersicht erhalten.
