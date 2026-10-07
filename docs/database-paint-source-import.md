# Farbkatalog und Farbgeschäftsdaten

Migration 015 strukturiert die vorhandenen Katalogsammlungen einschließlich `previousCatalog` in versionierten Zeilen. Farb-, Produkt-, Rezept-, Basis-, Gebinde- und Farbstoffkennungen bleiben im ursprünglichen Textformat. Doppelte Kennungen bleiben nach Sammlungsposition getrennt. Rezeptbestandteile, Barcode- und Maschineninformationen bleiben vollständig im Originalobjekt; Verknüpfungen werden nicht aus Namen geraten.

Mischhistorie, Rückläufer, Rücklaufmaterial, Druckwarteschlange, Lieferantenkäufe und gesendete Bestellungen werden ebenfalls übernommen. Stornierungen und Druckstatus lösen keine neue Verarbeitung aus. Mengen und Geld werden direkt durch PostgreSQL aus dem vollständigen originalen JSON gelesen: große Dezimalzahlen verlieren keine Stellen durch JavaScript. Alte Dateiversionen bleiben erhalten; identische Wiederholungen erzeugen keine neuen Zeilen.

Der Import erstellt keine Lagerbewegung, Zahlung, Bestellung oder Druckausgabe. Er ersetzt noch nicht die aktiven produktiven Lese- und Schreibpfade. Fehlende oder unlesbare Zahlen bleiben NULL; die unbearbeitete Quelle bleibt für den folgenden Abgleich verfügbar.
