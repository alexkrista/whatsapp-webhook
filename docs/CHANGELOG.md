# Build 0023.13 – PHONE_NUMBER_ID ENV Fix

## Ursache
Render enthält die funktionierende WhatsApp-Sender-ID unter `PHONE_NUMBER_ID`. Der Aufgabenversand las bisher nur `WHATSAPP_PHONE_NUMBER_ID` und `KRISTINE_PHONE_NUMBER_ID`.

## Änderung
- Zentrale Sender-ID akzeptiert jetzt in dieser Reihenfolge:
  1. `PHONE_NUMBER_ID`
  2. `WHATSAPP_PHONE_NUMBER_ID`
  3. `KRISTINE_PHONE_NUMBER_ID`
  4. gespeicherte Sender-ID aus dem letzten Webhook
- Morgenstatus verwendet dieselbe zentrale Sender-ID.
- Versionsanzeige auf Build 0023.13 aktualisiert.

## Betroffene Dateien
- `server.js`
- `public/kristine.html`
- `version.json`

## Test
- `node --check server.js`
- `node --check kristine.js`
