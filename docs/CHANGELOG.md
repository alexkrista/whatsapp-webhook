# Build 0023.15 – Kristine Oberfläche aufgeräumt

## Änderung
- Menüpunkt **Kristine-Chat** aus der Kristine-Oberfläche entfernt.
- Chat-Testbereich vollständig aus `public/kristine.html` entfernt.
- Bestehende Backend- und WhatsApp-Logik bleibt unverändert.
- Leitstand, Tageskorrektur und KRISTOOL verwenden nun eine gemeinsame Datumsfunktion statt des früheren Chat-Datumsfeldes.
- Planung, Leitstand, Aufgaben, Zeitmodelle und KRISTOOL bleiben erhalten.

## Betroffene Datei
- `public/kristine.html`
- `version.json`

## Prüfung
- Keine verbliebenen DOM-Zugriffe auf entfernte Chat-Felder.
- JavaScript-Syntax geprüft.
