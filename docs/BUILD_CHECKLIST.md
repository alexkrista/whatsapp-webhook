# KRISTA Build-Checkliste

## Build 0023.10

- [x] Aktuelle `server.js` als Basis verwendet
- [x] Aktuelle `kristine.js` als Basis verwendet
- [x] Aufgabenversand nutzt dieselbe `sendWhatsAppKristineReply()`-Funktion
- [x] Kein eigener zwingender `phoneNumberId`-Sonderweg im Aufgabenmodul
- [x] Sender-ID: ENV oder zuletzt empfangener echter Webhook
- [x] Österreichische lokale Nummer `0...` wird zu `43...`
- [x] Button-IDs `anrufen` und `erledigt` fest definiert
- [x] Erfolgs- und Fehlerausgabe im Render-Log
- [x] JavaScript-Syntaxprüfung bestanden
- [ ] Live-Test: Aufgabe an Alexander
- [ ] Live-Test: Button Anrufen
- [ ] Live-Test: Button Erledigt


## Build 0023.18

- [x] Build 0023.17 als Basis verwendet
- [x] Gemeinsame Topbar als eigene JS-Komponente angelegt
- [x] Zentrales Farb- und Buttonsystem angelegt
- [x] Kontrollzentrum umgestellt
- [x] Kristine umgestellt
- [x] Aktive Modulmarkierung geprüft
- [x] Token wird in Hauptnavigation übernommen
- [x] Keine Backend-, WhatsApp- oder Datenlogik verändert
- [x] JavaScript-Syntaxprüfung bestanden
- [ ] Aktuelle Admin-HTML einsetzen und anbinden
- [ ] Sichtprüfung nach Deploy auf Desktop und Mobil
