# KRISTINE – SEPA & CAMT

Eigene Entwicklungslinie für Zahlungsverkehr und Bankabgleich.

## Ziel

KRISTINE führt alle Zahlungsquellen in einem neutralen Bankmodell zusammen:

- Hausbank über CAMT.053
- Revolut zunächst über CSV, später API
- SEPA-Zahlungsaufträge aus dem Bezahl-OP über pain.001

Die Kernverknüpfung lautet:

`Beleg/Rechnung -> Zahlungsauftrag -> SEPA/Bank -> CAMT/Revolut -> Beleg/Rechnung`

## Grundregeln

1. Eingangsrechnungen werden im Bezahl-OP freigegeben.
2. KRISTINE erzeugt pro Zahlung eine dauerhafte interne Zahlungs-ID und verwendet diese als `EndToEndId`, sofern das Zielformat dies zulässt.
3. Die Bankrückmeldung wird idempotent importiert; dieselbe Bankbewegung darf nie doppelt angelegt werden.
4. CAMT-Einträge werden nicht mit der Annahme `1 Ntry = 1 Rechnung` verarbeitet. Ein `Ntry` kann mehrere `TxDtls` enthalten (Sammelbuchung).
5. Belegverknüpfungen sind n:m-fähig:
   - eine Zahlung kann mehrere Belege ausgleichen
   - ein Beleg kann durch mehrere Zahlungen ausgeglichen werden
6. Skonto, Teilzahlung, Gutschrift, Erstattung, Storno und Umbuchung sind eigene Sachverhalte und keine Sondertexte.
7. Interne Umbuchungen (z. B. Hausbank -> Revolut) sind kein Aufwand/Ertrag.
8. Unsichere Zuordnungen werden vorgeschlagen, nicht automatisch festgeschrieben.
9. Originaldateien mit echten Bankdaten werden nicht in Git committed. Tests verwenden anonymisierte Fixtures.

## Datenmodell

### BankAccount

- id
- owner_id/company_id
- provider (`hypo`, `revolut`, ...)
- iban
- bic
- currency
- display_name
- active

### BankImportBatch

- id
- source (`camt053`, `revolut_csv`, `revolut_api`)
- source_filename / external_batch_id
- imported_at
- statement_from
- statement_to
- checksum
- status

### BankTransaction

Normalisierte einzelne wirtschaftliche Transaktion, unabhängig von der Quelle.

- id
- bank_account_id
- import_batch_id
- source
- source_entry_id
- source_transaction_id
- account_service_reference
- end_to_end_id
- booking_date
- value_date
- amount
- currency
- direction (`credit`, `debit`)
- status (`booked`, `pending`, `reversed`, ...)
- counterparty_name
- counterparty_iban
- counterparty_bic
- remittance_text
- structured_reference
- raw_type_code
- parent_batch_transaction_id (bei Sammelbuchungen optional)
- created_at

Eindeutigkeit nach Möglichkeit über Provider + Konto + externe Transaktions-ID; ansonsten robuste Fallback-Schlüssel aus Referenzen/Fingerprint.

### PaymentInstruction

Von KRISTINE erzeugte Zahlung aus dem Bezahl-OP.

- id
- kristine_payment_id (menschenlesbar, dauerhaft)
- debtor_bank_account_id
- creditor_name
- creditor_iban
- creditor_bic
- amount
- currency
- requested_execution_date
- remittance_text
- end_to_end_id
- status (`draft`, `exported`, `submitted`, `booked`, `failed`, `cancelled`)
- exported_batch_id
- created_at

### DocumentPaymentLink

n:m-Zuordnung zwischen Beleg/Rechnung und Zahlung/Banktransaktion.

- id
- document_id
- payment_instruction_id (optional)
- bank_transaction_id (optional)
- allocated_amount
- link_type (`payment`, `partial_payment`, `discount`, `refund`, `credit_note`, `internal_transfer`)
- confidence
- match_reason
- confirmed_by
- confirmed_at

## CAMT.053 Import

Der Parser muss insbesondere auslesen:

- Statement-ID und Zeitraum
- Konto / IBAN / Währung
- Salden
- `Ntry`
- Buchungsdatum / Valutadatum
- Betrag + Soll/Haben
- `AcctSvcrRef`
- `EndToEndId`
- `TxId`
- Debitor/Kreditor + IBAN/BIC
- strukturierte und unstrukturierte Verwendungszwecke
- mehrere `TxDtls` innerhalb eines `Ntry`

Ein Sammel-`Ntry` wird als Bank-Sammelbuchung erkannt; die wirtschaftlichen Einzeltransaktionen aus `TxDtls` werden separat normalisiert und mit dem Parent verknüpft.

## SEPA pain.001 Export

Erste Kompatibilitätsreferenz ist die aktuell verwendete Hypo-Datei im Format `pain.001.001.03`. Der Generator muss aber versionsfähig gebaut werden, damit eine spätere Bankanforderung nicht das Datenmodell ändert.

Pro Exportbatch:

- Message-ID
- Erstellzeitpunkt
- Anzahl Transaktionen
- Kontrollsumme
- Auftraggeber
- Ausführungstag
- Schuldnerkonto
- einzelne Überweisungen

Pro Zahlung:

- `EndToEndId` = dauerhafte KRISTINE-Zahlungs-ID
- Betrag/Währung
- Empfängername
- Empfänger-IBAN/BIC soweit erforderlich
- Verwendungszweck / Rechnungsnummer

## Matching

Priorität für automatisch erzeugte eigene SEPA-Zahlungen:

1. exakte `EndToEndId`
2. externe/Bank-Transaktionsreferenz
3. Betrag + IBAN + enger Datumsbereich
4. Rechnungs-/Zahlungsreferenz

Priorität für nicht von KRISTINE erzeugte Zahlungen / Revolut-Kartenumsätze:

1. Betrag + Währung
2. Lieferant/Kunde bzw. bekannte Händler-Aliase
3. IBAN / Gegenpartei
4. Zahlungs-/Buchungsdatum
5. Rechnungsnummer / Referenz im Text

Mehrdeutige Treffer werden niemals automatisch bestätigt.

## Sonderfälle

- Sammelzahlung: eine Bankbuchung, mehrere Einzeltransaktionen/Belege
- Teilzahlung: mehrere Zahlungen auf einen Beleg
- Sammelausgleich: eine Zahlung auf mehrere Belege
- Skonto: Beleg wird mit Zahlung + Skontoanteil vollständig ausgeglichen
- Gutschrift/Erstattung: Gegenbuchung mit explizitem Beziehungstyp
- Storno/Reversal: ursprüngliche Verknüpfung nicht löschen, sondern Status/Historie erhalten
- interne Umbuchung Hausbank <-> Revolut: beide Seiten miteinander verknüpfen, keine Aufwands-/Ertragsbuchung

## UI später

- Bankbewegungen: `zugeordnet`, `Vorschlag`, `offen`, `Umbuchung`, `storniert`
- Bezahl-OP: SEPA erstellen / Exportstatus / Bankbestätigung
- Detailansicht: sichtbare Kette vom Beleg bis zur Bankbewegung
- Prüfliste für unsichere Treffer

## Umsetzungsschritte

1. neutrales Bankmodell + IDs
2. CAMT.053 Parser und anonymisierte Fixtures
3. pain.001 Generator und Validierung gegen anonymisierte Referenzfixture
4. Matching-Engine
5. Revolut-CSV Adapter auf dasselbe Bankmodell
6. Persistenz + API
7. UI
8. später Revolut-API
