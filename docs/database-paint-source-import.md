# Farbkatalog und Farbgeschäftsdaten

Migration 015 strukturiert die vorhandenen Katalogsammlungen einschließlich `previousCatalog` in versionierten Zeilen. Farb-, Produkt-, Rezept-, Basis-, Gebinde- und Farbstoffkennungen bleiben im ursprünglichen Textformat. Doppelte Kennungen bleiben nach Sammlungsposition getrennt. Rezeptbestandteile, Barcode- und Maschineninformationen bleiben vollständig im Originalobjekt; Verknüpfungen werden nicht aus Namen geraten.

Mischhistorie, Rückläufer, Rücklaufmaterial, Druckwarteschlange, Lieferantenkäufe und gesendete Bestellungen werden ebenfalls übernommen. Stornierungen und Druckstatus lösen keine neue Verarbeitung aus. Mengen und Geld werden direkt durch PostgreSQL aus dem vollständigen originalen JSON gelesen: große Dezimalzahlen verlieren keine Stellen durch JavaScript. Alte Dateiversionen bleiben erhalten; identische Wiederholungen erzeugen keine neuen Zeilen.

Der Import erstellt keine Lagerbewegung, Zahlung, Bestellung oder Druckausgabe. Er ersetzt noch nicht die aktiven produktiven Lese- und Schreibpfade. Fehlende oder unlesbare Zahlen bleiben NULL; die unbearbeitete Quelle bleibt für den folgenden Abgleich verfügbar.

## Live-Import

Live am 2026-10-07: 149.714 Einträge erstellt und geprüft, einschließlich 8.788 aktueller Farben, 33.575 aktueller Rezepte und 33.578 Farb-Produkt-Zuordnungen plus früherem Katalog. 379 LG-Artikel, 73 Käufe, 2 gesendete Bestellungen, 243 Mischungen, 3 Rücklaufmaterialien, 62 Druckaufträge und 62 Rückläufer enthalten. 8 Quelldateien bytegenau geprüft und nach Import unverändert. Originalbackup `/var/data/_sql-import-originals/paint-1791380542663`. Der ursprüngliche große Import wurde durch einen Datenbank-Neustart abgebrochen; nach automatischer Wiederherstellung waren 0 Farb-Fachzeilen vorhanden. Der erfolgreiche Import verwendete Pakete mit maximal 200 Originalobjekten und exakten JSON-Quelltextausschnitten.
