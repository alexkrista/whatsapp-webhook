# FMC250 erster Hardwaretest

1. FMC250 mit SIM in Traccar sichtbar machen.
2. Fahrzeug in KRISTINE mit Traccar Device-ID/IMEI koppeln.
3. NFC-URL erzeugen und auf NTAG schreiben.
4. Zündung/READY manuell simulieren bzw. echten Eingang testen.
5. Sofortiger NFC-Scan: kein Warnpiepen.
6. Ohne Scan: nach 20 Sekunden Warnpiepen.
7. Später Scan: Pieper sofort aus, Fahrer an aktive Fahrt hängen.
8. Zündung aus: Fahrt schließen.
9. Fahrt ohne Fahrer: als offen/unresolved speichern und am Folgetag zuordnen.
10. CAN getrennt prüfen: echten Kilometerstand/Rohwert mit Fahrzeugtacho vergleichen; Einheit erst danach in die km-Auswertung übernehmen.

Wichtig: Moving/Stopped-Ereignisse sind keine Zündung und dürfen Fahrten nicht öffnen oder schließen.
