# Kristine TAPI Connector

Der lokale Connector verbindet die auf Render betriebene Kristine-Weboberfläche
mit dem bereits installierten Windows-TAPI-Treiber von xTelsio.
Telefonnummern werden ausschließlich über `127.0.0.1` an die konfigurierte
TAPI-Leitung übergeben. NFON-Zugangsdaten werden lokal nicht benötigt.

Ab Version 1.1 meldet xTelsio auch eingehende Anrufe an Kristine. Kristine sucht
die Telefonnummer in Baustellen, Kontakten und Aufgaben und zeigt das Ergebnis
sofort am jeweiligen Büro-PC an.

## Voraussetzungen

- Windows-PC im selben Netzwerk wie das Snom-Telefon
- installierter und funktionsfähiger `xtelsio TAPI for snom`-Treiber
- TAPI-Leitung, bei Krista `CTI Client TAPI-Connector`
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

Am einfachsten `Installieren.cmd` doppelklicken. Alternativ PowerShell im
entpackten Ordner öffnen und ausführen:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-KristineTapiConnector.ps1
```

Die bestehende Leitung bleibt bei einer Aktualisierung erhalten. Falls die
Leitung beim ersten Installieren anders heißt:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-KristineTapiConnector.ps1 -LineName "CTI Client TAPI-Connector"
```

Der Connector wird unter `%LOCALAPPDATA%\KristineTapiConnector` installiert,
sofort gestartet und beim Windows-Login automatisch geladen. Administratorrechte
sind nicht erforderlich.

## Eingehende Anrufe in xTelsio einrichten

Diese Einrichtung ist auf **Alex, Bettina und Dunja** jeweils einmal nötig.
Kristine muss im Browser geöffnet sein, damit das Fenster sofort sichtbar wird.

1. xTelsio öffnen und **Optionen → Interworking (andere Anwendungen starten/steuern)** wählen.
2. Eine neue Aktion für einen **eingehenden externen Anruf / RING** anlegen.
3. Als Aktion **Dokument/URL öffnen** beziehungsweise **Programm starten** wählen.
4. Programm:

   `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

5. Argumente:

   `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LOCALAPPDATA%\KristineTapiConnector\KristineTapiConnector.ps1" -IncomingPhone "%remote.number[+]%" -IncomingState "%call.state%" -IncomingCallId "%call.id%" -IncomingExtension "%local.exten%" -RedirectingPhone "%redirecting.number%"`

6. In den erweiterten Bedingungen **nur eingehende externe Anrufe** aktivieren
   und speichern.

Zum Testen von einem Handy die Büronummer anrufen. Bei einem Gruppenruf erscheint
die Erkennung auf allen drei eingerichteten PCs. Wenn xTelsio zusätzlich Aktionen
für `CONN` und `DISC` auslösen kann, können dieselben Programmargumente auch bei
diesen Zuständen verwendet werden; Kristine aktualisiert dann den Rufstatus.

Vor der xTelsio-Einrichtung kann `Eingehenden-Anruf-Testen.cmd` verwendet werden.
Bei geöffneter Kristine-Seite muss damit ein Testfenster erscheinen.

## Sicherheit

- Der Dienst lauscht nur auf `127.0.0.1:17834` und ist nicht aus dem Netzwerk
  erreichbar.
- Anfragen werden nur vom Ursprung `https://protokoll.krista.at` akzeptiert.
- xTelsio-Ereignisse benötigen einen bei der Installation zufällig erzeugten,
  nur lokal gespeicherten Sicherheitsschlüssel.
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
