# Build 0023.17 – Sinnvolle Erinnerungen & natürliche Befehle

## Geändert
- 07:00-Erinnerungen gehen nur noch an Mitarbeiter, die an diesem Tag tatsächlich arbeiten sollen.
- Keine Mitarbeiter-Erinnerung an Samstag, Sonntag, Feiertagen, Betriebsurlaub, Urlaub, Krankenstand oder Zeitausgleich.
- Individuelle Arbeitszeitmodelle werden berücksichtigt, z. B. freier Freitag im Winter.
- Wer an einem freien Tag dennoch startet, erscheint im Chefbericht korrekt als aktiv.
- Der 08:00-Chefbericht wird weiterhin auch an freien Tagen versendet und unterscheidet aktiv, frei/abwesend, später und offen.
- Arbeitsbeginn versteht weiterhin: `Start`, `Beginn`, `Los`.
- Arbeitsende versteht zusätzlich: `Ende`, `Stopp`, `Stop`, `Fertig`, `Feierabend`, `Schluss`.

## Betroffene Dateien
- `morning-status.js`
- `kristine.js`
- `version.json`

## Prüfung
- `node --check server.js`
- `node --check kristine.js`
- `node --check morning-status.js`
