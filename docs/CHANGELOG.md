# Build 0023.11 – Aufgaben-WhatsApp Sender-Fix

## Behoben
- Die WhatsApp-Sender-ID wird bei jedem echten Webhook dauerhaft unter `/var/data/_kristine/whatsapp-sender.json` gespeichert.
- Proaktive Aufgabenmeldungen verwenden die Sender-ID in dieser Reihenfolge: übergebener Wert → Render-ENV → gespeicherte Webhook-ID.
- Ein Render-Neustart verliert die zuletzt erkannte Sender-ID nicht mehr.
- Der Aufgaben-Endpunkt schreibt jetzt immer sichtbar ins Render-Log, wie viele neue Aufgaben erkannt wurden.
- Fehlende Mitarbeitertelefonnummern und fehlende Sender-Konfiguration werden eindeutig geloggt.

## Test
- `node --check server.js`
- `node --check kristine.js`
