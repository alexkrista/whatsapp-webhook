
Änderungen
Bug 1 – `fertig`
Ende wird beim Eingang der WhatsApp-Nachricht persistiert.
WhatsApp-Zeitstempel statt späterem Bestätigungszeitpunkt.
Status wird sofort auf „Tagesabschluss offen“ gestellt.
Tagesabschluss-Bestätigung hat keinen Zugriff mehr auf die Buchungs-Endzeit.
Idempotenz für doppelte Webhook-Zustellung vorgesehen.
Bug 2 – Urlaub aus KRISPLAN
Soll-/Ist-Abgleich statt blindem erneutem Erzeugen.
Gelöschte und verkürzte Quellen entfernen verwaiste Tageszeilen.
Tage mit 0 Sollminuten werden nicht erzeugt; dadurch kein Urlaub am Wochenende.
Löschen im Tagesabschluss ändert auch die KRISPLAN-Quelle.
Manuell erfasste Zeilen bleiben vom Reconcile unberührt.