# NFON-Anbindung für Kristine

Stand: 7. September 2026

## Ziel

Kristine soll Telefonie-Ereignisse der drei Büroanschlüsse Bettina, Dunja und
Alex zentral verarbeiten. Die Integration bleibt gegenüber dem konkreten
NFON-Transport gekapselt, damit fachliche Funktionen nicht von CRM Connect,
TAPI oder einer Web-API abhängen.

## Bereits im Projekt vorhanden

- Aufgaben speichern `contactName`, `contactPhone`, `contactEmail` und optional
  einen `customerMaster` mit der Rolle `customer` oder `supplier`.
- Die Aufgabenmaske kann WinWorker-Adressen über The Brain auch anhand einer
  Telefonnummer suchen.
- NFON-Voicemail-E-Mails im MSG-Format werden im Kristine-Eingang erkannt. Ein
  Audioanhang kann transkribiert und anschließend mit einer Aufgabe verknüpft
  werden.
- Die vorhandene Voicemail-Verarbeitung ist kein Nachweis für einen
  API-basierten Abruf. Sie arbeitet mit importierten E-Mails und Anhängen.

## Noch nicht vorhanden

- NFON-API-Client und dokumentiertes Authentifizierungsverfahren
- Echtzeit-Ereignisse für eingehende, angenommene und beendete Anrufe
- serverseitiges Click-to-Dial
- zentrale, normalisierte Kontakt- und Telefonnummernzuordnung
- zentrale Anrufliste für die drei Anschlüsse
- Zuordnungsmaske für unbekannte Nummern
- NFON-seitige Steuerung von Rufgruppen, Betriebszeiten und Voicemail
- automatische Ableitung der Telefonverfügbarkeit aus Personal- und
  Abwesenheitsdaten

## Fachlicher Umfang

| Bereich | Gewünschtes Verhalten | Abhängigkeit |
| --- | --- | --- |
| Anruferkennung | Nummer normalisieren, Kunden und Lieferanten durchsuchen, Datensatz anzeigen | Eingehendes Anrufereignis |
| Click-to-Dial | Klick auf Telefonnummer startet Anruf am gewählten Anschluss | API-/CTI-Wählfunktion |
| Voicemail | Nachricht und Audio abrufen, transkribieren, Nummer zuordnen | Voicemail-Liste und Audioabruf oder bestehender E-Mail-Weg |
| Verfügbarkeit | Bettina, Dunja und Alex nach Anwesenheit, Urlaub und Feiertag routen | Routing-/Präsenz-Schreibzugriff |
| Anrufliste | Datum, Uhrzeit, Nummer, Richtung, Dauer, Status und Zuordnung speichern | Call Detail Records oder Anrufereignisse |
| Unbekannte Nummer | bestehenden Datensatz suchen, neu anlegen oder später zuordnen | lokale Kristine-Funktion |
| Aufgabenkontakt | Aufgabentelefonnummer nach Speichern automatisch verknüpfen oder als Kontakt anlegen | lokale Kristine-Funktion |

## Vorgesehene technische Trennung

1. `telephony-provider`: schmale Schnittstelle für Ereignisse, Wählen,
   Voicemail, Anruflisten, Präsenz und Routing.
2. `nfon-provider`: Implementierung ausschließlich anhand der offiziellen
   NFON-Dokumentation.
3. `phone-identity`: einheitliche Rufnummernnormalisierung und Suche über
   Kunden, Lieferanten und lokale Aufgabenkontakte.
4. `call-store`: dauerhaftes, idempotentes Anrufprotokoll mit externer
   Ereignis-ID und Zuordnungsstatus.
5. Kristine-Oberfläche: Anruf-Popup, Anrufliste und Maske für unbekannte
   Nummern.
6. `availability-policy`: fachliche Berechnung der Soll-Erreichbarkeit; die
   Übergabe an NFON erfolgt nur, wenn die API dies nachweislich unterstützt.

## Durch die offizielle CTI-API-Dokumentation bestätigt

- REST-Basis-URL `https://providersupportdata.cloud-cfg.com/v1`
- Anmeldung mit API-Username und API-Password; Access- und Refresh-Token
- Access-Token mit fünf Minuten Laufzeit
- Nebenstellen und Namen lesen
- Leitungs- und Präsenzstatus als Snapshot oder SSE-Datenstrom lesen
- ausgehenden Anruf für eine bestimmte Nebenstelle starten und abbrechen
- neue ein- und ausgehende Anrufereignisse in Echtzeit als SSE-Datenstrom lesen
- eindeutige Call-UUID, Richtung, Nebenstelle, Rufnummern, Status und Zeitpunkt

Die API liefert im Anrufdatenstrom nur Ereignisse, die nach Aufbau der
Verbindung auftreten. Eine rückwirkende Anrufhistorie ist nicht dokumentiert.
Kristine muss daher die Ereignisse ab Inbetriebnahme selbst dauerhaft speichern.

Nicht dokumentiert sind Voicemail-Abruf, Routing-Schreibzugriff, Rufgruppen- oder
Zeitprofiländerungen. Offiziell nicht unterstützt werden derzeit insbesondere
Gruppen-, Queue-, Skill- und weitergeleitete Anrufe sowie mehrere Geräte je
Nebenstelle. Das ist für die geplante Büro-Rufgruppe eine wesentliche Grenze.

## Noch bei NFON zu klären

Vor der Implementierung des Providers müssen folgende Punkte geklärt sein:

- Mandanten-, Benutzer-, Nebenstellen- und Rufgruppen-IDs
- Voicemail-Metadaten und Abruf der Audiodatei
- Schreibzugriff auf Präsenz, Weiterleitungen, Zeitprofile,
  Feiertage und Rufgruppen
- Berechtigungen, Lizenzen, Rate Limits, Aufbewahrung und Sandbox

API-Schlüssel, Client Secrets und Passwörter werden nicht im Repository
gespeichert. Sie werden später ausschließlich über die Laufzeitumgebung
bereitgestellt.

## Offene fachliche Entscheidungen

- Welche Kristine-Daten gelten als Anwesenheitsquelle: Einteilung,
  Zeitstempelung, Büroarbeitsplan oder Kombination?
- Welche Urlaubsquelle ist führend?
- Welche Betriebszeiten gelten je Wochentag?
- Österreichisches Bundesland für Feiertage (voraussichtlich Vorarlberg)
- Reihenfolge und Klingeldauer von Bettina, Dunja und Alex
- Verhalten bei besetzt, nicht angenommen und manueller Ausnahme
- Soll die vorhandene Voicemail-E-Mail-Verarbeitung als Rückfallweg bestehen
  bleiben?

## Sichere Reihenfolge

1. NFON-Dokumentation und Lizenzumfang prüfen.
2. Telefonnummernnormalisierung und lokales Kontaktregister ergänzen.
3. Provider-Schnittstelle und Test-Dummy implementieren.
4. NFON-Sandbox anbinden und eingehende Ereignisse protokollieren.
5. Anruferkennung und unbekannte Nummern umsetzen.
6. Click-to-Dial und Anrufliste aktivieren.
7. Voicemail-Abruf integrieren; E-Mail-Weg als Rückfall prüfen.
8. Verfügbarkeitsregeln zunächst nur berechnen und anzeigen.
9. Erst nach fachlicher Freigabe NFON-Routing automatisch verändern.

## Laufzeitkonfiguration

Die Zugangsdaten dürfen ausschließlich als geschützte Umgebungsvariablen
gesetzt werden:

- `NFON_API_USERNAME`
- `NFON_API_PASSWORD`
- `NFON_K_ACCOUNT`
- `NFON_OFFICE_EXTENSIONS`, Format
  `Bettina:101,Dunja:102,Alex:103`

Ohne vollständige Konfiguration bleibt Click-to-Dial in der Oberfläche
deaktiviert. Die normalen `tel:`-Links funktionieren weiterhin.

Sind Username, Password und K-Account gesetzt, kann der geschützte Endpunkt
`GET /kristine/api/nfon/extensions` die vorhandenen Nebenstellen zur sicheren
Zuordnung anzeigen. Anrufe bleiben gesperrt, bis `NFON_OFFICE_EXTENSIONS`
explizit gesetzt ist.
