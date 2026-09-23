# Revolut Privat in KRISTINE

KRISTINE liest über Enable Banking ausschließlich den Kontostand und gebuchte Bewegungen des privaten Revolut-Kontos. Es gibt keine Zahlungsfunktion und keinen Datei-Upload zur Bank. Die Verbindung für Revolut Business bleibt getrennt.

## Einrichtung auf Render

Folgende Werte werden als geschützte Umgebungsvariablen beim Webdienst hinterlegt:

- `ENABLE_BANKING_APP_ID`: die ID der aktiven Anwendung **Kristine Banking** im Enable-Banking-Portal.
- `ENABLE_BANKING_EXPECTED_IBAN`: die vollständige IBAN des gewünschten privaten Revolut-Kontos.
- `ENABLE_BANKING_PRIVATE_KEY`: der private PEM-Schlüssel genau dieser Anwendung. Alternativ verweist `ENABLE_BANKING_PRIVATE_KEY_FILE` auf eine geschützte PEM-Datei auf dem dauerhaft gespeicherten Serverlaufwerk. Den Schlüssel niemals in Git, ein Browserformular oder den Chat einfügen.
- `ENABLE_BANKING_ACTIVE=1`: schaltet API-Aufrufe frei. Erst nach Annahme des Kostenangebots setzen.

Im Enable-Banking-Portal muss `https://protokoll.krista.at/banking/enablebanking/callback` als Rücksprungadresse eingetragen bleiben. KRISTINE akzeptiert nur das Konto mit der hinterlegten IBAN. Der Server braucht ein dauerhaftes `DATA_DIR` (Render-Laufwerk). Die Sitzungsdaten und der Zwischenspeicher liegen unter `_kristine/enable-banking-personal.json` mit Dateirechten `0600`; diese Datei gehört in die reguläre Datensicherung.

## Erstmalige Verbindung

Als KRISTINE-Administrator `/banking/enablebanking` öffnen, **Konto freigeben** wählen und die Freigabe bei Revolut abschließen. Die Verknüpfung der IBAN im Enable-Banking-Portal allein reicht nicht aus: KRISTINE benötigt den Freigabecode über die Rücksprungadresse und tauscht ihn gegen eine Banksitzung. Nach Ablauf der Bankfreigabe **Bankfreigabe erneuern** wählen.

Beim Öffnen der Ansicht prüft KRISTINE höchstens einmal in 24 Stunden auf neue gebuchte Bewegungen und einen aktuellen Kontostand. Die Ansicht **Revolut Privat** im lokalen Brain liest diese geschützten Daten und übernimmt neue Bewegungen anhand ihrer stabilen Kennung in den vorhandenen Bankabgleich. Es wird keine Zahlung ausgelöst. Ist die Bank vorübergehend nicht erreichbar, bleiben zuletzt abgerufene Daten mit ihrem Zeitstempel sichtbar; ein Fehler wird angezeigt. Der erste Abruf umfasst die letzten 90 Tage, spätere Abrufe behalten bereits gespeicherte Bewegungen bei.
