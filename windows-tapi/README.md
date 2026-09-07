# Kristine TAPI Connector

Der lokale Connector verbindet die auf Render betriebene Kristine-Weboberfläche
mit dem bereits installierten Windows-TAPI-Treiber `xtelsio TAPI for snom`.
Telefonnummern werden ausschließlich über `127.0.0.1` an die konfigurierte
TAPI-Leitung übergeben. NFON-Zugangsdaten werden lokal nicht benötigt.

## Voraussetzungen

- Windows-PC im selben Netzwerk wie das Snom-Telefon
- installierter und funktionsfähiger `xtelsio TAPI for snom`-Treiber
- TAPI-Leitung, normalerweise `snom Line 1`
- Windows PowerShell 5.1

## Vorprüfung

In PowerShell im entpackten Ordner:

```powershell
powershell -ExecutionPolicy Bypass -File .\KristineTapiConnector.ps1 -ListLines
powershell -ExecutionPolicy Bypass -File .\KristineTapiConnector.ps1 -Dial "+431234567"
```

Beim zweiten Befehl muss das Snom-Telefon direkt wählen. Für den Test eine
zulässige Telefonnummer einsetzen.

## Installation

PowerShell im entpackten Ordner öffnen und ausführen:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-KristineTapiConnector.ps1
```

Falls die Leitung anders heißt:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-KristineTapiConnector.ps1 -LineName "snom Line 1"
```

Der Connector wird unter `%LOCALAPPDATA%\KristineTapiConnector` installiert,
sofort gestartet und beim Windows-Login automatisch geladen. Administratorrechte
sind nicht erforderlich.

## Sicherheit

- Der Dienst lauscht nur auf `127.0.0.1:17834` und ist nicht aus dem Netzwerk
  erreichbar.
- Anfragen werden nur vom Ursprung `https://protokoll.krista.at` akzeptiert.
- Der Wählendpunkt verlangt einen zusätzlichen Sicherheitskopf und akzeptiert
  nur Telefonnummernzeichen.
- Es werden weder API-Passwörter noch Tokens gespeichert.

## Fehlerdiagnose

Das Protokoll liegt unter
`%LOCALAPPDATA%\KristineTapiConnector\connector.log`.

Zum Entfernen:

```powershell
powershell -ExecutionPolicy Bypass -File .\Uninstall-KristineTapiConnector.ps1
```
