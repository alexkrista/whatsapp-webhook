# KRISTINE – WhatsApp-Zuverlässigkeit / Diagnose 09.10.2026

**Separater Fehlerbehebungs-Zweig für `main`. Kein produktives Deployment durch diesen PR. KRISTINE 2.0 und KGO werden nicht umgeschaltet.**

## Beobachtungen, Stand 09.10.

- Der produktive Render-Dienst meldete mehrmals `server_failed` mit `nonZeroExit:1` (u. a. 07.10. 18:37 UTC sowie 08.10. 15:33 und 15:58 UTC).
- Die produktiven App-Logs enthalten wiederholt `ENOENT rename .../_kristine/vehicle-tracking/sessions.json.tmp-PID-TIMESTAMP -> sessions.json` (07.10. und 08.10.). Der bisherige temporäre Dateiname benutzte nur `process.pid` plus Millisekunde und war **nicht pro parallelem Speichervorgang eindeutig**.
- Für **07.10. und 08.10.** stehen jeweils `08:00 Chefstatus gesendet` und `15:00 Planung gesendet` in den Logs. Diese vier Sendungen gingen an dieselbe konfigurierte Empfängernummer und Meta lieferte jeweils HTTP-Erfolg plus `wamid` zurück. Der Payload-Typ war jeweils **`interactive`**.
- **Achtung:** Der bisherige Webhook in `server.js` ignorierte `value.statuses` komplett; er verarbeitete nur `value.messages`. Daher gab es weder eine archivierte Zustellbestätigung noch einen nachvollziehbaren Fehlstatus. **Der konkrete Grund, warum die vier Nachrichten auf dem Handy nicht ankamen, ist noch nicht nachgewiesen.**
- Für normale freie oder interaktive WhatsApp-Nachrichten außerhalb des 24-stündigen Servicefensters ist eine **genehmigte Meta-Vorlage** nötig (sonst möglich: Fehler 131047). Die vier automatischen Nachrichten verwendeten **keinen Template-Payload**. Dies ist eine starke, aber bislang nicht durch einen konkreten Meta-Fehlercode bestätigte Hypothese.
- Zusätzlich wurde am 07.10. ein `ENOENT` beim Outlook-Token-Schreiben protokolliert. Dessen Ursache ist getrennt zu prüfen.

## Dieser PR: vorsichtige technische Reparatur

1. Fahrzeug-Sitzungen verwenden eindeutige temporäre Dateinamen und eine pro-Prozess-Schreibwarteschlange. Das beseitigt denselben temporären Dateinamen bei gleichem PID/Millisekundenwert. Die Warteschlange serialisiert **nur das Schreiben**, nicht die komplette Lese-/Änderungs-Transaktion.
2. Unbehandelte Fehler im zeitgesteuerten Buzzer-Callback werden gemeldet, statt durch ein verworfenes Promise möglicherweise den gesamten Webserver zu beenden.
3. Jede akzeptierte WhatsApp-Sendung wird von der tatsächlichen Meta-Zustellung unterschieden. Der Webhook verarbeitet nun `statuses[]` (sent/delivered/read/failed), speichert Kennung **nur gehasht**, letzte sechs Stellen des Empfängers, Zweck und Fehlercode; keine Chatnachrichten und keine vollständigen Rufnummern.
4. Der admin-geschützte GET-Endpunkt `/admin/api/whatsapp/delivery` gibt ausschließlich diese Diagnoseinformationen wieder. Er sendet oder wiederholt keine Nachricht.

## Vor einem produktiven Merge

- GitHub-/lokale Regressionstests, Betreibersicherung und ein gezielter Rollout.
- Prüfen, ob Meta die WhatsApp-Statuscallbacks für die betreffende WhatsApp Business Account/Telefonnummer tatsächlich sendet. Fehlercodes (`131047`, `131026` usw.) aus den neuen Logs ableiten, nicht raten.
- Die Empfängernummer (im Log nur die letzten sechs Ziffern) mit der gewünschten Chefnummer bestätigen.
- **Genehmigte Utility-Vorlage(n) im WhatsApp Manager** für proaktiv versandte 06:45/08:00/15:00/11:00-Meldungen erstellen/freigeben und anschließend den Vorlagenversand bewusst implementieren und mit einem Empfänger testen. Keine spontane automatische Umstellung auf eine nicht existierende Vorlage.
- Kein automatischer Wiederholungsversand offener historischer Sendungen – Doppelmeldungen vermeiden.
- Langfristig Erinnerungen und Outbound-Queue vom Webprozess entkoppeln, robust über Neustarts fortsetzen und bei fehlender Zustellung über einen alternativen Kanal alarmieren.

**Wichtig:** Die hier vorbereitete technische Zustellkontrolle allein kann die Meta-24-Stunden-Regel nicht umgehen und garantiert noch keine WhatsApp-Zustellung.
