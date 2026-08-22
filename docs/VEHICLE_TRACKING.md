# KRISTINE Fahrzeugtracking – FMC250 / Traccar / NFC

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
