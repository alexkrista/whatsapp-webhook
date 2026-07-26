# Build 0023.21 – M3.1.1 „Ein Datum, eine Wahrheit“

## Leitstand
- Pfeile wechseln jetzt nur den im Leitstand angezeigten Tag.
- Datumsauswahl aktualisiert den Leitstand direkt und öffnet nicht mehr ungefragt einen neuen Rapport.
- Neuer eigener Button **Tagesrapport** öffnet den Rapport exakt für den aktuell angezeigten Tag.
- Relative Orientierung: Heute, Gestern oder Morgen plus vollständiges Datum.

## Doppelte Mitarbeiter
- Mitarbeiter mit derselben normalisierten Identität (Telefonnummer, sonst Name) werden im Leitstand zu einer Person zusammengeführt.
- Der Datensatz mit aktiver Planung bzw. den aussagekräftigsten Tagesdaten wird verwendet.
- Verdächtige Dubletten werden mit beiden IDs in der Browser-Konsole protokolliert, damit die Stammdaten später sauber bereinigt werden können.

## Sicherheit
- Keine Daten werden gelöscht oder automatisch zusammengeführt.
- WhatsApp-, Buchungs- und Regielogik bleiben unverändert.
