# KRISTINE 2.0 – getrennte PostgreSQL-Testanbindung

Stand: 08.10.2026. Dies ist **kein** SQL-Go-live und kein Zugriff auf Produktionsdaten.

## Bereits vorhandene Render-Ressourcen

- Webdienst: `kristine-2-0-preview` / `srv-db3u5r8473hc73bvmf00` (Frankfurt, frei, GitHub-Zweig `feat/kristine-2-0`)
- PostgreSQL: `kristine-2-0-test-db` / `dpg-db3u5cui0phs73eaa700-a` (PostgreSQL 16, Frankfurt, frei bis 07.11.2026)
- Produktionsdienst `baustellenprotokoll` und Produktionsdatenbank `kristine-postgres` **nicht ändern**.

## Noch erforderliche Verbindung

Der Render-Connector liefert aus Sicherheitsgründen keine Verbindungskennwörter. Für die interne Verbindung muss im **Test-Webdienst** in **Environment** ausschließlich der Schlüssel `KRISTINE_V2_TEST_DATABASE_URL` mit der **Internal Database URL** der oben genannten Testdatenbank belegt werden. **Das Passwort nicht in GitHub, Tickets oder in den Chat kopieren.**

Die Anwendung verweigert jede Datenbank mit anderem Datenbanknamen, Benutzer oder Host. Die Standardvariable `DATABASE_URL` und jede Produktionsanwendungskonfiguration bleiben ausdrücklich gesperrt.

Optionaler expliziter Test-Schema-Bootstrap: `KRISTINE_V2_INIT_SCHEMA=1`. Erst nach existierender Testverbindung werden die 26 versionierten Migrationen (001–026) initial eingespielt; bei bereits vollständiger Struktur unverändert wiederverwendet, bei Teilzustand sicher abgebrochen. Das ist die einzige auf den Test-Schema-Neuaufbau begrenzte automatische Datenbankschreibaktion.

## Bereits implementiert

- Server gibt keine Produktions-API frei; GET/HEAD und geschützter Preview-Zugang bleiben bestehen.
- SQL-Lesemodell fragt in einer `READ ONLY REPEATABLE READ`-Transaktion ausschließlich die explizite Testdatenbank ab.
- Gezeigt werden Firmenname, Baustellen mit Nummer und Status, Mitarbeiter mit Personalnummer, Einteilungen, Zeiterfassung seit 01.10.2026, Dokumentmetadaten und validierte Importläufe.
- Wenn Schema oder Daten fehlen, wird das **korrekt** so angezeigt. Keine erfundenen Baustellen oder Echtzustände.
- OBELISK-Personalzeiten dürfen weder importiert noch mit KRISZEIT-Ereignissen vermischt werden.
- Ein einfacher Passwortschutz reicht für diese geschützte Testvorschau, ist aber kein Ersatz für die später erforderliche Mitarbeiter-Rollen- und Rechteprüfung bei echten Geschäfts- und Personaldaten.

## Noch offener Datenimport

Die Test-DB enthält vor einem geprüften Import keine echten Geschäftsdaten. Produktion enthält bereits versionierte SQL-Momentaufnahmen, aber die Test-Datenbank hat keinen automatischen Zugriff darauf.

**Vor Import echter personenbezogener oder finanzieller Daten:**
1. Prüfen, dass die isolierte Testumgebung mit geeigneten Benutzerrollen, getrennten Credentials und deaktivierten Außenwirkungen abgesichert ist.
2. Einen geprüften Snapshot der aktiven Kristine-Geschäftsdateien und Verknüpfungen über einen autorisierten, vertraulichen Transport bereitstellen, niemals über das GitHub-Repository.
3. Import mit Hashes/Original-IDs/Unternehmenszuordnung, Quellmanifest, Deltaabgleich und Wiederholbarkeit ohne Dubletten.
4. Mit realen Werten gegen die bisherige Kristine **nur lesend** vergleichen. Dokumentdateien getrennt absichern.
5. Erst danach SQL-Lese-/Schreibfunktionen in den einzelnen Fachbereichen testen. KGO-Oberfläche unverändert.

Die kostenlose PostgreSQL-Testdatenbank läuft am 07.11.2026 ab; rechtzeitig eine dauerhafte Testumgebung oder gesicherte Migration planen.
