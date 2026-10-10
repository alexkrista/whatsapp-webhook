# Zweiter Fachblock: Migration 003

32 zusätzliche Tabellen; zusammen mit Migration 002 nun 64 normalisierte Fachtabellen. Drei Views liefern Zahlungsstände und Lagerbestände. Der SQL-Entwurf ist nicht live angewendet und noch nicht mit den Laufzeitdiensten verbunden.

| Bereich | Neue Tabellen |
|---|---|
| Material / Preise | units, products, supplier_products, price_history |
| Angebote | offers, offer_lines |
| Aufträge | orders, order_lines, order_schedules |
| Ausgangsrechnungen | outgoing_invoices, outgoing_invoice_lines, invoice_order_links |
| Eingangsrechnungen | incoming_invoices, incoming_invoice_lines |
| Belege | invoice_documents |
| Konten / Buchungen | financial_accounts, bank_transactions, bank_transaction_classifications |
| Zahlungen | payment_batches, payments, payment_allocations, payment_allocation_events |
| Regie | regie_reports, regie_people, regie_material_lines, regie_invoice_links |
| Einkauf | purchase_orders, purchase_order_lines |
| Lager | warehouses, goods_receipts, goods_receipt_lines, stock_movements |

## Belege und Geldbeträge

Unternehmensgebundene Fremdschlüssel verbinden Kunden, Lieferanten, Baustellen und Belege. Fachkennungen bleiben Text; Angebotsversionen und Positionen sind eigene Datensätze. Netto/Brutto-Preismodus, Gruppenrabatte, Alternativen und eingefrorene Zahlungsbedingungen sind vorbereitet. Die Anwendung berechnet weiterhin mit den bisherigen Rundungs- und Skontoregeln; keine neuen Preisformeln wurden eingebaut.

Geldbeträge sind NUMERIC(20,4), Mengen und Stückpreise NUMERIC(20,6). Belegköpfe prüfen Netto + Steuer = Brutto. Sie erzwingen keine neue Rundung pro Position; die bestehenden Kopf-/Positionssummen müssen beim Import gesondert abgeglichen werden. Rechnungen/Gutschriften speichern positive Gesamtbeträge und ihren Belegtyp separat. Historische Vorzeichenkonventionen vor dem Import prüfen und Originalwerte im Staging erhalten.

Die Herkunftszuordnung erweitert die bisherigen typisierten Fremdschlüssel um Angebot, Auftrag, Eingangs-/Ausgangsrechnung, Produkt, Regie und Bestellung. Genau ein Ziel pro Quellreferenz bleibt vorgeschrieben. Die vollständigen WinWorker-/Obelisk-Feldabbildungen fehlen weiterhin.

## Zahlungsstand

Es gibt keinen frei überschreibbaren Bezahlt-Schalter im Rechnungskopf. `incoming_invoice_settlement` leitet den Stand aus Zuordnungen ab: offen, SEPA übergeben oder bezahlt. Teilzahlungen senken den offenen Betrag, ohne vollständige Zahlung vorzutäuschen. Ausgangsrechnungen erhalten ebenfalls einen abgeleiteten offenen Betrag.

Ein geplanter oder übergebener Zahlungsvorgang ist noch keine bestätigte Zahlung. Für `settled` muss eine tatsächliche Kontobuchung mit passendem Unternehmen, Konto, Betrag, Währung und Richtung verknüpft sein. Eine Buchung ist höchstens einem Zahlungsvorgang zugeordnet; dieser kann mehrere Rechnungen abdecken. Fremdwährungsbuchungen behalten Konto- und Originalbetrag getrennt. Kassa/Revolut sind eigene Kontoarten; Herkunft und Berechtigung für ihre tatsächlichen Buchungsnachweise werden vom noch zu implementierenden Import-/Abgleichdienst geprüft.

Zuordnungen prüfen Währung, Richtung und Grenzen von Zahlungs- und Rechnungsbeträgen. Skonto wird als eigener Betrag gespeichert. Seine fachliche Zulässigkeit/Fristenprüfung bleibt Aufgabe des bestehenden Zahlungsdiensts. Gutschriften erwarten die umgekehrte Zahlungsrichtung. Änderungen der Zuordnungen werden protokolliert. Eine bestätigte Zahlung und ihre ursprüngliche Kontobuchung bleiben unveränderlich. Die Belegzuordnung kann weiterhin mit Historie korrigiert werden.

Normal/Echtzeit sind die beiden Geschwindigkeiten für Zahlungsläufe. EndToEndIds bleiben erhalten. Unternehmereinlagen sind ausdrücklich eine eigene Klassifikation neben Umsatz, Kosten und internen Umbuchungen. Die Views senden keine Zahlungen und erzeugen keine SEPA-Dateien.

## Lager und Wareneingang

Das Erfassen einer Eingangsrechnung erhöht keinen Bestand. Wareneingänge beginnen unbestätigt. Nur der ausdrückliche Statuswechsel zur Bestätigung erzeugt die Lagerbewegungen atomar; jede Eingangsposition und jede Bewegung besitzt eine eindeutige Identität gegen Doppelbuchungen.

Eine unveränderte Wiederholung der Bestätigung bucht nicht erneut. Der künftige Bestätigungsdienst muss bei bereits bestätigtem Eingang den bestehenden Erfolg zurückgeben; er darf dabei keine neuen Bestätigungsdaten schreiben. Bestätigte Eingänge/Positionen und gebuchte Lagerbewegungen werden nicht überschrieben; Korrekturen erfolgen über getrennte Bewegungen mit eigener Referenz.

Bei zugeordneter Bestellung müssen die vollständigen Produktmengen übereinstimmen, wie im bisherigen Wareneingangsablauf. Einkaufs- und Lagereinheit sind ausdrücklich getrennt; der gespeicherte Umrechnungsfaktor wird verwendet. Die Bestellung wird erst nach erfolgreicher Bestätigung als erhalten markiert. Teilwareneingänge wären ein gesonderter fachlicher Ausbau, nicht automatisch durch diese Migration aktiviert.

Bestand ist die Summe des unveränderlichen Bewegungsjournals, nicht ein separat zu überschreibender Gesamtwert. Verbrauch ist negativ, Eingang positiv. Negative Bestände sind nicht pauschal gesperrt; die bestehende Fachlogik entscheidet über Warnungen. Einstandspreise haben eine eigene unveränderliche Historie; automatische EK-Fortschreibung ist noch nicht angebunden.

## Prüfung und offene Arbeit

17 neue Szenarien gegen PGlite 0.5.8 prüfen Tabellenanlage, Beträge, SEPA/Zahlung, Teilzahlungen, Skonto, Fremdwährung, Quellzuordnung, Warenbestätigung, Wiederholung, Mengendifferenzen, Verbrauch, Regie, Angebote/Aufträge und Preishistorie. Zusammen mit elf Kern-Szenarien meldet Node 30 grüne Tests einschließlich zweier übergeordneter Tests.

    PGLITE_MODULE_PATH=/path/to/node_modules/@electric-sql/pglite node --test TEST/*.pg.cjs

PGlite führt PostgreSQL-Code aus, bietet in diesem Testaufbau jedoch keine echten konkurrierenden Verbindungen. Mehrverbindungs-, Render-, Rollen- und Lasttests stehen weiterhin aus. Bei Transaktionen über mehrere Rechnungen/Zahlungen/Bestellungen muss der Dienst eine feste Sperrreihenfolge und begrenzte Wiederholung von Deadlocks verwenden. SQL-Trigger ersetzen keine Benutzerautorisierung; produktive Dienste dürfen nicht als Schemaeigentümer arbeiten.

Offen bleiben insbesondere vollständiges Quellenmapping, Importabgleich, historische OP-Eröffnungs-/Zahlungsnachweise ohne neue Bankbewegungen, Gutschriftverrechnung, Anzahlungs-/Schlussrechnungsabzüge, Positions-/Kopfsummenabgleich, Kontaktpersonen, Aufgaben/Kommunikation und die gesamte Laufzeitanbindung. Historisch bereits bezahlte Belege dürfen durch unvollständige Übernahme nicht als neue offene Forderungen/Verbindlichkeiten erscheinen. Die jetzigen Views sind für die vorbereiteten normalen Zahlungszuordnungen gedacht, noch keine fertige produktive OP-Auswertung über alle Altbestandsfälle.

Keine realen Daten importiert, kein Zahlungsversand, keine Lageränderung und kein Deployment erfolgt.
