# Build 0023.14 – Zentraler Kristine-WhatsApp-Sender

## Änderung
- Alle WhatsApp-Nachrichten verwenden vorrangig die zuletzt durch einen echten Kristine-Webhook bestätigte `phone_number_id`.
- Aufgaben, Morgenstatus, Erinnerungen und normale Antworten laufen damit über dieselbe aktive Kristine-Nummer.
- Render-ENV und übergebene IDs bleiben ausschließlich als Fallback erhalten.
- Startlog zeigt die verwendete Priorität und die letzten sechs Stellen der aktiven Sender-ID.

## Erwarteter Test
- Aufgaben-Log und normale Kristine-Nachricht müssen dieselbe `senderIdTail` anzeigen.
- In der aktuellen Umgebung soll dies `822135` sein.
