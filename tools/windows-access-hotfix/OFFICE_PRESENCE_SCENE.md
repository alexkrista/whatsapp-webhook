# KRISTINE – GANTNER-Anwesenheit → Stiegenhaus / Little Greene / Musik

Stand: 2026-10-21. **Auslieferung standardmäßig ausgeschaltet.**
Dies ist ein eigener Dienst; weder Türöffner noch Zutrittszeitpläne werden verändert.

## Funktion
- Eine anwesende Person (Alex ODER Bettina ODER Dunja) reicht für EIN.
- Erst wenn alle drei false melden und der Zustand 120 Sekunden anhält: AUS.
- Jede fehlende/ungültige Anwesenheitsinformation bricht den Zyklus ab, ohne Schaltung.
- HCU-Aktoren ausschließlich mit dauerhaftem setSwitchState(on=true/false), nie mit Tasten-/Torimpulsen.
- Vor jedem Schalten werden Geräte-IDs, lesbare Namen und schaltbare Kanaltypen mit dem HCU-Systemzustand abgeglichen. Tor-/Türnamen sind gesperrt.
- Sonos: Play nur beim Wechsel auf Anwesenheit und nur wenn die ausgewählte Zone nicht bereits spielt. Pause bei Abwesenheit nur, wenn die Automatik die Wiedergabe gestartet hat. Es wird kein Musikdienst oder Radiosender erraten. Sonos muss bereits eine abspielbare Quelle haben.
- Der Zustand bleibt in einer eigenen Datei state.json; die Türsteuerung hat keine Abhängigkeit davon.

## Vor dem Einschalten zwingend zu klären
1. In welcher Homematic-IP-Zentrale hängen Stiegenhaus und Little Greene? Die am 21.10.2026 erreichbare HCU listet aktuell diese Bezeichnungen nicht; licht gang darf nicht ohne Bestätigung als Stiegenhaus angenommen werden.
2. Eindeutige HCU-Geräte-IDs, Kanalnummern und Anzeigenamen beider zu schaltender Lasten.
3. Welche konkrete Sonos-Zone soll Musik spielen? Der Büro-PC hat per SSDP noch keinen Sonos-Lautsprecher erkannt. IP und Quelle müssen bewusst festgelegt werden.
4. PC-ALEX02 muss im Firmennetz auf HCU und Sonos zugreifen können.

## Lokale Einrichtung
Auf PC-ALEX02: C:\Kristine\PresenceScenes\office_presence_scene.py
Die Vorlage office_presence_scene.example.json nach config.json kopieren und enabled: false belassen. Keine Zugangstokens kopieren: Das Modul liest die bestehenden, lokalen GANTNER- und HCU-Konfigurationen.

Trockenlauf, garantiert ohne Aktorschaltung:
python C:\Kristine\PresenceScenes\office_presence_scene.py --config C:\Kristine\PresenceScenes\config.json --dry-run

Nur nach bestätigter Zuordnung, Messung und Testfreigabe: enabled: true, dann
python C:\Kristine\PresenceScenes\office_presence_scene.py --config C:\Kristine\PresenceScenes\config.json --watch

Erst nach kontrolliertem EIN, AUS, manuellem Eingriff, Verbindungsausfall und Funktion der Zutrittsanlage einen geplanten automatischen Programmstart einrichten. Nicht ohne diesen Abnahmeschritt als Windows-Dienst installieren.

## Sicherheitsgrenzen
- Keine Kopplung an Tür-offen/Türfreigabe, sondern an Anwesenheit.
- Ausgänge sind bei fehlender Konfiguration vollständig inaktiv.
- Fehlende Sonos-Quelle führt zu einem protokollierten Fehler statt automatischer Auswahl.
- Beim Ausfall des GANTNER-Dienstes wird kein falsches AUS ausgelöst.
- Bei Hardware-/Verbindungsfehlern bleibt der Übergang unbestätigt und wird später erneut geprüft.
