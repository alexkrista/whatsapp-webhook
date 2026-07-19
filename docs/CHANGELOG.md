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