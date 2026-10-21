# KRISTINE: Büro-Anwesenheit → Homematic IP „Stiegenhaus“

Stand 21.10.2026. Die gesamte Licht-/Little-Greene-/Musik-Szene besteht beim Nutzer bereits. **Nicht einzeln schalten.** KRISTINE sendet nur EIN bzw. AUS an genau eine Homematic-IP-Schaltgruppe „Stiegenhaus“.

## Steuerung
- Alex ODER Bettina ODER Dunja ist anwesend ⇒ Gruppe Stiegenhaus EIN.
- Alle drei abwesend für 120 Sekunden ⇒ Stiegenhaus AUS.
- Unbekannte Anwesenheit, Netzfehler oder HCU-Antwortfehler ⇒ kein neuer Befehl.
- Auswertung alle 8 Sekunden aus dem lokalen, bestehenden GANTNER-Zutrittsdienst, ausschließlich per lesendem Status-Endpunkt.
- Nur bei tatsächlichen Präsenzzustandswechseln ein Schaltbefehl; manuelle Schaltungen werden nicht ständig überschrieben.
- Bestehende Homematic-/Little-Greene-/Musik-Automationen werden NICHT geändert.
- Es werden keinerlei GANTNER-Tür- oder Tor-Befehle ausgelöst.

## Richtige HCU-Schaltgruppe
Bei einer lesenden HCU-Abfrage vom 21.10.2026 wurde festgestellt:
- Die HCU hat mehrere Gruppen mit Namen „Stiegenhaus“ (u.a. META, ACCESS_CONTROL und SWITCHING).
- Die richtige Gruppe muss deshalb über ihre exakte Gruppen-ID und den Gruppentyp EXTENDED_LINKED_SWITCHING verifiziert werden, nicht allein anhand des Namens.
- Sie hat als Ausgang einen HmIP-FSM16-Aktor „licht gang“, Schaltkanal 1. Die Taster gehören zu derselben Gruppe.
- Schaltbefehl: /hmip/group/switching/setState mit groupId und on (boolean).
- Niemals ein direktes sendDoorCommand/startImpulse am Taster oder Türöffner senden.

## Sichere Einrichtung
1. Quellcode lokal nach C:\Kristine\PresenceScenes\office_presence_scene.py kopieren.
2. Vorlage als C:\Kristine\PresenceScenes\config.json anlegen. IDs ausschließlich lokal eintragen, nicht ins öffentliche GitHub-Repository.
3. enabled bleibt zuerst false, bis der Lesetest der Gruppe, die manuelle Aktorprüfung und die Zustandsprüfung erfolgreich sind.
4. Trockenlauf ohne Schalten: python C:\Kristine\PresenceScenes\office_presence_scene.py --dry-run
5. Danach erst enabled true setzen und mit --watch eine beaufsichtigte Probe machen.
6. Nach Verifikation von EIN, AUS, Nachlauf, manueller Steuerung und Türfunktions-Unabhängigkeit darf ein automatischer Windows-Start eingerichtet werden.

Alle Befehle an die HCU werden vor der Übermittlung mit der aktuellen Gruppen- und Aktoridentität gegengeprüft. Ein unbekanntes Gerät führt zum Sicherheitsstopp. Keine HCU-Zugangsdaten, GANTNER-Tokens oder Sonos-Passwörter werden in der Projektquelle gespeichert.
