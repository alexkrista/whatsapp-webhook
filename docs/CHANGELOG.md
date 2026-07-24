# Build 0023.12 – Aufgaben-WhatsApp Diagnose

## Geändert
- Fünfstufiges Logging vom Aufgaben-Speichern bis zur Meta-API.
- Vollständige Meta-Fehlerausgabe mit Status, Code, Subcode und fbtrace_id.
- Browser zeigt die echte Fehlerursache statt nur einer Sammelmeldung.
- Geschlossenes 24-Stunden-Fenster wird ausdrücklich erkannt.
- Wiederhergestellte `public/kristine.html` ist im ZIP enthalten.

## Test
1. ZIP pfadtreu hochladen.
2. Neue Aufgabe an einen Mitarbeiter anlegen.
3. Im Render-Log nach `TASK-WA 1/5` bis `5/5` suchen.
4. Bei Fehler die Zeile `WhatsApp API response` senden.
