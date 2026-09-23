# KRISTINE Fahrzeugtracking – FMC250 / Traccar / NFC

## KRISDRIVE 1.3 – Fahrtenbuch

Beim Fahrzeug öffnet **Fahrtenbuch öffnen** die Fahrtenliste. Zeitraum wählen
(bis zu 93 Tage), Fahrer und Fahrtart ergänzen, bei Geschäftsfahrten Start, Ziel
und Zweck/Kunde/Baustelle eintragen. Unvollständige Einträge können als offene
Ergänzungen gespeichert werden. Privatfahrten zeigen/exportieren keine Ziele,
Koordinaten oder Zwecke. PDF und CSV enthalten den angezeigten Zeitraum und
die Summen nach Fahrtart. Kilometerstände können bei Bedarf paarweise korrigiert
werden; die ursprünglich übernommenen Werte bleiben gespeichert.

Start und Ziel werden auch in bereits gespeicherten Fahrten ergänzt:

- Adressen werden einheitlich als **Straße, Ort** angezeigt, ohne Hausnummer,
  Postleitzahl, Bundesland oder Land. Das gilt auch für die Fahrzeugkarte und
  die Exporte; ursprüngliche GPS-Angaben bleiben im Datensatz erhalten.
- **Ziel einer Fahrt = Start der nächsten Fahrt:** Beide Seiten verwenden eine
  gemeinsame Ortsangabe, auch wenn der Tracker zwei unterschiedliche Namen liefert.
  Ohne Korrektur gilt die Ankunft. Eine spätere Ortskorrektur an Start oder Ziel
  gilt für beide Seiten. Eine Straßenadresse hat Vorrang vor reinen Koordinaten.
- Bereits bekannte Adressen desselben Fahrzeugs werden bei erneuten Besuchen
  desselben Standorts verwendet (nächster bekannter GPS-Punkt bis 40 m).
  Die Zuordnung gilt in der Ansicht sowie in PDF und CSV, auch ohne GPS-Verbindung.
- Fehlt ein GPS-Punkt im Traccar-Fahrtbericht, wird seine originale Positions-ID
  gezielt nachgeschlagen. Ein nicht aufgezeichneter erster Start wird nicht aus
  dem Ziel derselben Fahrt oder einer späteren Position erfunden.
- Privatfahrten werden weder als Adressquelle noch zum Verknüpfen benachbarter
  Fahrten verwendet. Überlappende Fahrten werden ebenfalls nicht verknüpft.
- Fahrer/Zweck speichern schreibt unveränderte Ortsangaben nicht als manuelle
  Korrektur fest. Alte gespeicherte Koordinaten-Platzhalter verdecken keine
  später aufgelöste GPS-Adresse mehr.

- Bestehender `TRACCAR_BASE_URL`/`TRACCAR_TOKEN` reicht aus; keine neue Anmeldung.
- `GET /kristine/api/krisdrive/logbook?vehicleId=…&from=YYYY-MM-DD&to=YYYY-MM-DD`
  liest `/api/reports/trips` für den zugeordneten Tracker. Tagesgrenzen gelten in
  Europe/Vienna, einschließlich Sommer-/Winterzeit. Normale Fahrten über
  Mitternacht werden mit je einem Tag Vor-/Nachlauf vollständig abgefragt.
- `PATCH /kristine/api/krisdrive/logbook/:vehicleId/:rideId` speichert Ergänzungen
  mit Versionsprüfung. Alle Routen verwenden die bestehende Admin-Anmeldung.
- `GET /kristine/api/krisdrive/logbook/export.pdf` bzw. `export.csv` nutzt dieselben
  Filter. CSV schützt Textfelder vor Interpretation als Tabellenformel.
- Persistenz: `/_kristine/vehicle-tracking/logbook/<vehicle-hash>.json`, mit
  ursprünglichem GPS-Datensatz, aktuellem Datensatz, Ergänzungen und
  Änderungsverlauf. Schreibvorgänge sind pro Fahrzeug serialisiert und atomar.
  Bestehende Tracking-/Zündungsdaten werden nicht umgeschrieben.
- Bei einem GPS-Ausfall bleiben gespeicherte Fahrten verfügbar; Ausfall und
  letzter erfolgreicher Abruf stehen auch im Export. Lokale Zündungsfahrten
  dienen als Ersatz und werden bei eindeutiger Übereinstimmung mit dem
  Traccar-Bericht verknüpft, ohne ihre Ergänzungen zu verlieren.
- Traccar `distance`, `odometer`, `obdOdometer` und `totalDistance` sind Meter
  und werden durch 1.000 geteilt. Ein unbekanntes `totalMileage` wird nicht
  als CAN-Kilometerstand interpretiert. In der Liveansicht steht der Quellentyp
  am Zähler; eine fehlende Adresse gilt nicht mehr als fehlende GPS-Position.

Quellen: [Traccar API](https://www.traccar.org/api-reference/),
[Positionsattribute](https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/model/Position.java),
[Fahrtbericht](https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/reports/model/TripReportItem.java).

Prüfung: `node --test TEST/krisdrive-logbook.test.js TEST/employee-login-auth.test.js TEST/access-status-session.test.js`.
Zusätzlich den Ablauf Fahrzeug → Fahrtenbuch → Geschäftlich/Privat → Speichern
→ erneuter Abruf → PDF/CSV auf Desktop und schmalem Bildschirm prüfen.

## Ziel

Fahrzeug wird getrackt, nicht das Mitarbeiter-Handy. Fahrer meldet sich per NFC am Fahrzeug an.

Ablauf:

1. Zündung/READY an → FMC250 meldet Fahrtbeginn.
2. KRISTINE öffnet eine Fahrtsession und startet 20 Sekunden Karenz.
3. Fahrer scannt NFC-Tag am Auto → Mitarbeiter-ID kommt aus KRISTINE GO auf diesem Handy.
4. Bei rechtzeitigem Scan bleibt der Pieper aus.
5. Ohne Fahrer nach 20 Sekunden fordert KRISTINE über Traccar den Buzzer an.
6. Späterer NFC-Scan setzt den Fahrer und schaltet den Buzzer aus.
7. Zündung/READY aus → Fahrt wird geschlossen.
8. Fahrten ohne Fahrer bleiben `unresolvedDriver=true` und können am Folgetag in KRISTOOL zugeordnet werden.

## Render-Umgebungsvariablen

Noch **nicht** setzen, bis Traccar steht:

- `VEHICLE_TRACKING_SECRET` – langer zufälliger Schlüssel für Traccar → KRISTINE Forwarding.
- `TRACCAR_BASE_URL` – z. B. `https://gps.example.at`.
- `TRACCAR_TOKEN` – Traccar API-Token.
- `TRACCAR_BUZZER_ON_COMMAND` – Teltonika-Kommandotext nach Hardwaretest.
- `TRACCAR_BUZZER_OFF_COMMAND` – Teltonika-Kommandotext nach Hardwaretest.
- `VEHICLE_BUZZER_DELAY_MS=20000` – standardmäßig 20 Sekunden.

## Traccar Forwarding

Positions:

- URL: `https://<kristine-host>/kristine/api/vehicle-tracking/traccar/position`
- Typ: JSON
- Header: `X-Kristine-Tracker-Key: <VEHICLE_TRACKING_SECRET>`

Events:

- URL: `https://<kristine-host>/kristine/api/vehicle-tracking/traccar/event`
- Typ: JSON
- Header: `X-Kristine-Tracker-Key: <VEHICLE_TRACKING_SECRET>`

Traccar unterstützt Position- und Event-Forwarding getrennt. Für die Buzzer-Ansteuerung verwendet KRISTINE `/api/commands/send` mit einem Custom Command.

## Fahrzeug koppeln

Der bestehende KRISTINE-Fahrzeugstamm bleibt führend (`/_system/vehicles.json`). Tracking-Zusatzdaten liegen getrennt unter:

`/_kristine/vehicle-tracking/tracker-config.json`

Admin-Endpunkte:

- `GET /kristine/api/vehicle-tracking/status`
- `GET /kristine/api/vehicle-tracking/config`
- `PUT /kristine/api/vehicle-tracking/config/:vehicleId`
- `GET /kristine/api/vehicle-tracking/rides?unresolved=1`
- `POST /kristine/api/vehicle-tracking/rides/:rideId/driver`
- `POST /kristine/api/vehicle-tracking/test/ignition`
- `POST /kristine/api/vehicle-tracking/test/buzzer`

Beim ersten `PUT` wird automatisch ein zufälliger NFC-Token erzeugt und die fertige URL zurückgegeben. Genau diese URL wird später auf den NTAG geschrieben.

## Noch offen bis Hardware da ist

- FMC250 IMEI / Traccar Device-ID eintragen.
- CAN-Werte des jeweiligen Fahrzeugs identifizieren (echter Odometer besonders wichtig).
- Zündungs-/READY-Signal festlegen: CAN oder DIN1.
- Teltonika `setdigout`/Puls-Kommando am echten Pieper verifizieren und dann als ENV setzen.
- KRISTOOL-UI: offene Fahrerfragen am Folgetag anzeigen. Backend dafür ist bereits vorbereitet.
