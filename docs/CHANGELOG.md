# Build 0023.10

## Behoben

- Aufgaben-WhatsApp läuft über denselben zentralen Sender wie normale Kristine-Nachrichten.
- Der Aufgaben-Endpunkt verlangt keine eigene `phone_number_id` mehr.
- Die zentrale Versandfunktion verwendet in dieser Reihenfolge:
  1. explizit übergebene Sender-ID,
  2. `KRISTINE_PHONE_NUMBER_ID` / `WHATSAPP_PHONE_NUMBER_ID`,
  3. Sender-ID des zuletzt eingegangenen echten WhatsApp-Webhooks.
- Österreichische Mitarbeiter-Telefonnummern werden für Meta internationalisiert.
- Render zeigt jetzt vor dem Versand, bei Erfolg und bei Fehler klare Logzeilen.
- Reply-Button-IDs für `Anrufen` und `Erledigt` sind eindeutig.

## Nicht geändert

- Planung
- Zeiterfassung
- Tagesabschluss
- Regie
- PDF-Protokoll
