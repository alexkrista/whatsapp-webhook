# coding: utf-8
"""KRISTINE Finance: lueckenloser Bank-/Revolut-Abgleich.

Grundregel: Jeder importierte CAMT- bzw. Revolut-Umsatz muss vollstaendig
zugeordnet werden. Ein Auszug gilt erst als fertig, wenn jede einzelne Bewegung
Rest 0,00 hat. Teilzuordnungen/Splits sind erlaubt.

Enthaelt bewusst eigene Buchungsarten fuer:
- Einlage Alex
- Privatentnahme Alex
- Bank <-> Revolut / interne Umbuchung
- Gebuehren/Zinsen/Sonstiges

Starke SEPA-Treffer werden ueber EndToEndId + Betrag automatisch abgeschlossen.
Alle anderen Faelle bleiben offen bzw. werden nur vorgeschlagen.
"""
from __future__ import annotations

import hashlib
import json
import re
import xml.etree.ElementTree as ET
from datetime import date, datetime

from brain_finance_source import FinanceStore, norm_method, norm_status

CATEGORIES = {
    "supplier_payment": "Lieferantenrechnung",
    "customer_receipt": "Kundenzahlung",
    "direct_debit": "Einzug / Lastschrift",
    "revolut_internal": "Umbuchung Bank ↔ Revolut",
    "internal_transfer": "Interne Umbuchung",
    "bank_fee": "Bankspesen / Gebuehr",
    "interest": "Zinsen",
    "tax": "Steuer / Abgabe",
    "wage": "Lohn / Gehalt",
    "cash": "Kassa",
    "alex_contribution": "Einlage Alex",
    "alex_withdrawal": "Privatentnahme Alex",
    "other_income": "Sonstige Einnahme",
    "other_expense": "Sonstige Ausgabe",
}


def _local(tag):
    return str(tag or "").split("}", 1)[-1]


def _children(node, name):
    return [x for x in (list(node) if node is not None else []) if _local(x.tag) == name]


def _child(node, name):
    for x in (list(node) if node is not None else []):
        if _local(x.tag) == name:
            return x
    return None


def _desc(node, names):
    current = node
    for name in names:
        current = _child(current, name)
        if current is None:
            return None
    return current


def _text(node, names=()):
    if names:
        node = _desc(node, names)
    return str(getattr(node, "text", "") or "").strip() if node is not None else ""


def _all_text(node, wanted):
    out = []
    if node is None:
        return out
    for x in node.iter():
        if _local(x.tag) in wanted:
            value = str(x.text or "").strip()
            if value and value not in out:
                out.append(value)
    return out


def _date_text(node, name):
    base = _child(node, name)
    if base is None:
        return ""
    return (_text(base, ("Dt",)) or _text(base, ("DtTm",)))[:10]


def _amount(node):
    if node is None:
        return None, ""
    try:
        return round(abs(float(str(node.text or "0").replace(",", "."))), 2), str(node.attrib.get("Ccy") or "EUR").upper()
    except Exception:
        return None, str(node.attrib.get("Ccy") or "EUR").upper()


def _normal(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _movement_external_id(source, values):
    raw = "|".join(str(v or "") for v in values)
    return source.lower() + ":" + hashlib.sha256(raw.encode("utf-8", "ignore")).hexdigest()[:32]


def _parse_balance(stmt, code):
    for bal in _children(stmt, "Bal"):
        tp = _text(bal, ("Tp", "CdOrPrtry", "Cd")) or _text(bal, ("Tp", "CdOrPrtry", "Prtry"))
        if str(tp).upper() != code:
            continue
        amount, currency = _amount(_child(bal, "Amt"))
        ind = _text(bal, ("CdtDbtInd",)).upper()
        signed = -(amount or 0.0) if ind == "DBIT" else (amount or 0.0)
        return round(signed, 2), currency
    return None, ""


def _tx_party(tx, direction):
    parties = _desc(tx, ("RltdPties",))
    accounts = _desc(tx, ("RltdAgts",))
    if direction == "out":
        name = _text(parties, ("Cdtr", "Nm")) or _text(parties, ("UltmtCdtr", "Nm"))
        iban = _text(parties, ("CdtrAcct", "Id", "IBAN"))
    else:
        name = _text(parties, ("Dbtr", "Nm")) or _text(parties, ("UltmtDbtr", "Nm"))
        iban = _text(parties, ("DbtrAcct", "Id", "IBAN"))
    if not iban and accounts is not None:
        iban = ""
    return _normal(name), re.sub(r"\s+", "", iban).upper()


def _tx_amount(tx, fallback_amount, fallback_currency):
    candidates = [
        ("AmtDtls", "TxAmt", "Amt"),
        ("AmtDtls", "InstdAmt", "Amt"),
        ("Amt",),
    ]
    for path in candidates:
        node = _desc(tx, path)
        amount, currency = _amount(node)
        if amount is not None:
            return amount, currency or fallback_currency
    return fallback_amount, fallback_currency


def parse_camt(data):
    root = ET.fromstring(data)
    statements = [x for x in root.iter() if _local(x.tag) == "Stmt"]
    if not statements:
        raise ValueError("Keine CAMT-Statement-Daten gefunden.")
    result = []
    for stmt in statements:
        statement_ref = _text(stmt, ("Id",))
        account_iban = _text(stmt, ("Acct", "Id", "IBAN"))
        period = _desc(stmt, ("FrToDt",))
        start = (_text(period, ("FrDtTm",)) or _text(period, ("FrDt",)))[:10]
        end = (_text(period, ("ToDtTm",)) or _text(period, ("ToDt",)))[:10]
        opening, opening_ccy = _parse_balance(stmt, "OPBD")
        closing, closing_ccy = _parse_balance(stmt, "CLBD")
        movements = []
        for entry_no, ntry in enumerate(_children(stmt, "Ntry"), 1):
            entry_amount, entry_ccy = _amount(_child(ntry, "Amt"))
            if entry_amount is None:
                continue
            indicator = _text(ntry, ("CdtDbtInd",)).upper()
            direction = "out" if indicator == "DBIT" else "in"
            booking_date = _date_text(ntry, "BookgDt")
            value_date = _date_text(ntry, "ValDt")
            entry_ref = _text(ntry, ("NtryRef",)) or _text(ntry, ("AcctSvcrRef",))
            details = []
            for node in ntry.iter():
                if _local(node.tag) == "TxDtls":
                    details.append(node)
            # Bei Sammelbuchungen ohne Teilbetraege nicht versehentlich den ganzen
            # Ntry-Betrag mehrfach erzeugen: dann bleibt eine Sammelbewegung offen.
            usable = []
            if details:
                for tx in details:
                    amount, currency = _tx_amount(tx, None, entry_ccy)
                    if amount is not None:
                        usable.append((tx, amount, currency))
                if not usable and len(details) == 1:
                    usable = [(details[0], entry_amount, entry_ccy)]
            if not usable:
                raw = " ".join(_all_text(ntry, {"AddtlNtryInf", "Ustrd"}))
                external = _movement_external_id("CAMT", [statement_ref, entry_ref, booking_date, indicator, entry_amount, raw, entry_no])
                movements.append(dict(
                    externalId=external, bookingDate=booking_date, valueDate=value_date,
                    direction=direction, amount=entry_amount, currency=entry_ccy,
                    counterpartyName="", counterpartyIban="", endToEndId="",
                    reference=entry_ref, rawText=_normal(raw),
                ))
                continue
            for tx_no, (tx, amount, currency) in enumerate(usable, 1):
                e2e = _text(tx, ("Refs", "EndToEndId"))
                tx_ref = _text(tx, ("Refs", "AcctSvcrRef")) or _text(tx, ("Refs", "TxId")) or entry_ref
                name, iban = _tx_party(tx, direction)
                remittance = " ".join(_all_text(_desc(tx, ("RmtInf",)), {"Ustrd", "Ref"}))
                raw = _normal(" ".join([name, remittance, _text(ntry, ("AddtlNtryInf",))]))
                external = _movement_external_id("CAMT", [statement_ref, tx_ref, e2e, booking_date, indicator, amount, currency, raw, entry_no, tx_no])
                movements.append(dict(
                    externalId=external, bookingDate=booking_date, valueDate=value_date,
                    direction=direction, amount=amount, currency=currency or entry_ccy,
                    counterpartyName=name, counterpartyIban=iban, endToEndId=e2e,
                    reference=tx_ref, rawText=raw,
                ))
        result.append(dict(
            externalId=statement_ref or _movement_external_id("CAMT-STMT", [account_iban, start, end, opening, closing]),
            accountIban=re.sub(r"\s+", "", account_iban).upper(),
            periodStart=start, periodEnd=end, openingBalance=opening, closingBalance=closing,
            currency=closing_ccy or opening_ccy or "EUR", movements=movements,
        ))
    return result


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    capture_connection = ns.get("_capture_connection")
    capture_db = ns.get("CAPTURE_DB")
    if app is None or not page or not callable(capture_connection):
        return
    store = FinanceStore(ns)

    def con():
        c = capture_connection(capture_db)
        c.executescript("""
            CREATE TABLE IF NOT EXISTS brain_statement_imports(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                external_id TEXT NOT NULL,
                account_iban TEXT,
                period_start TEXT,
                period_end TEXT,
                currency TEXT NOT NULL DEFAULT 'EUR',
                opening_balance REAL,
                closing_balance REAL,
                file_sha256 TEXT,
                imported_at TEXT NOT NULL,
                UNIQUE(source, external_id),
                UNIQUE(source, file_sha256)
            );
            CREATE TABLE IF NOT EXISTS brain_statement_movements(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                statement_id INTEGER NOT NULL,
                source TEXT NOT NULL,
                external_id TEXT NOT NULL,
                booking_date TEXT,
                value_date TEXT,
                direction TEXT NOT NULL,
                amount REAL NOT NULL,
                currency TEXT NOT NULL DEFAULT 'EUR',
                counterparty_name TEXT,
                counterparty_iban TEXT,
                end_to_end_id TEXT,
                reference TEXT,
                raw_text TEXT,
                suggested_category TEXT,
                suggested_target_source TEXT,
                suggested_target_id TEXT,
                suggested_reason TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                created_at TEXT NOT NULL,
                UNIQUE(source, external_id),
                FOREIGN KEY(statement_id) REFERENCES brain_statement_imports(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS brain_statement_allocations(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                movement_id INTEGER NOT NULL,
                line_no INTEGER NOT NULL,
                category TEXT NOT NULL,
                amount REAL NOT NULL,
                target_source TEXT,
                target_id TEXT,
                note TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(movement_id) REFERENCES brain_statement_movements(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_brain_statement_movements_status
                ON brain_statement_movements(status, booking_date, id);
            CREATE INDEX IF NOT EXISTS idx_brain_statement_allocations_movement
                ON brain_statement_allocations(movement_id, line_no);
        """)
        c.commit()
        return c

    def payment_candidates():
        by_e2e = {}
        debit = []
        revolut = []
        debtors = []
        try:
            items = store.items(True)
        except Exception:
            items = []
        for item in items:
            pid = str(item.get("paymentId") or "").strip()
            if pid:
                by_e2e[pid] = item
            method = norm_method(item.get("paymentMethod"))
            if method == "direct_debit" and norm_status(item.get("paymentStatus")) != "paid":
                debit.append(item)
            if method == "revolut" and norm_status(item.get("paymentStatus")) != "paid":
                revolut.append(item)
        outgoing = app.extensions.get("kristine_outgoing_store")
        if outgoing is not None:
            try:
                debtors = outgoing.debtor_open_items()
            except Exception as exc:
                print("⚠ Debitoren-OP für CAMT nicht verfügbar:", exc)
        return by_e2e, debit, revolut, debtors

    def suggest(movement, by_e2e, debit, revolut, debtors):
        e2e = str(movement.get("endToEndId") or "").strip()
        amount = round(float(movement.get("amount") or 0), 2)
        currency = str(movement.get("currency") or "EUR")
        direction = movement.get("direction")
        text = _normal(" ".join([
            movement.get("counterpartyName") or "",
            movement.get("reference") or "",
            movement.get("rawText") or "",
        ])).lower()
        compact_text = re.sub(r"[^a-z0-9]", "", text)
        if direction == "in":
            numbered = []
            for item in debtors:
                if str(item.get("currency") or "EUR").upper() != currency.upper():
                    continue
                number = re.sub(r"[^a-z0-9]", "", str(item.get("invoiceNumber") or "").lower())
                if len(number) < 4 or number not in compact_text:
                    continue
                if amount - round(float(item.get("openGross") or 0), 2) > 0.02:
                    continue
                numbered.append(item)
            if len(numbered) == 1:
                item = numbered[0]
                exact_amount = abs(round(float(item.get("openGross") or 0), 2) - amount) <= 0.02
                reason = "Rechnungsnummer + Betrag eindeutig" if exact_amount else "Rechnungsnummer eindeutig · Teilzahlung"
                return "customer_receipt", "OUTGOING", str(item.get("invoiceId") or ""), reason, True

            amount_matches = []
            for item in debtors:
                if str(item.get("currency") or "EUR").upper() != currency.upper():
                    continue
                if abs(round(float(item.get("openGross") or 0), 2) - amount) > 0.02:
                    continue
                customer = _normal(" ".join([
                    item.get("customer") or "", item.get("customerName") or "",
                    item.get("customerCompany") or "",
                ])).lower()
                tokens = [token for token in re.findall(r"[a-z0-9äöüß]+", customer) if len(token) >= 5]
                if tokens and any(token in text for token in tokens):
                    amount_matches.append(item)
            if len(amount_matches) == 1:
                item = amount_matches[0]
                return "customer_receipt", "OUTGOING", str(item.get("invoiceId") or ""), "Kunde + Betrag eindeutig", False

        if direction == "out" and e2e and e2e in by_e2e:
            item = by_e2e[e2e]
            expected = round(float(item.get("paymentAmount") if item.get("paymentAmount") is not None else item.get("amount") or 0), 2)
            if str(item.get("currency") or "EUR") == currency and abs(expected - amount) <= 0.02:
                return "supplier_payment", str(item.get("source") or ""), str(item.get("id") or ""), "EndToEndId + Betrag eindeutig", True
            return "supplier_payment", str(item.get("source") or ""), str(item.get("id") or ""), "EndToEndId gefunden, Betrag pruefen", False
        if "revolut" in text:
            return "revolut_internal", "", "", "Revolut im Buchungstext", False
        if any(word in text for word in ("spesen", "gebuehr", "gebühr", "entgelt", "provision")):
            return "bank_fee", "", "", "Gebuehr im Buchungstext", False
        if "zinsen" in text or "zins" in text:
            return "interest", "", "", "Zinsen im Buchungstext", False
        # Einlage/Entnahme Alex nur vorschlagen, nie automatisch buchen.
        if "alexander krista" in text or re.search(r"\balex\s+krista\b", text):
            category = "alex_contribution" if direction == "in" else "alex_withdrawal"
            return category, "", "", "Alex im Gegenkonto/Buchungstext", False

        pool = debit if direction == "out" else []
        exact = []
        for item in pool:
            if str(item.get("currency") or "EUR") != currency:
                continue
            if abs(round(float(item.get("amount") or 0), 2) - amount) > 0.02:
                continue
            supplier = str(item.get("supplier") or "").lower().strip()
            if supplier and supplier[:8] in text:
                exact.append(item)
        if len(exact) == 1:
            item = exact[0]
            return "direct_debit", str(item.get("source") or ""), str(item.get("id") or ""), "Einzug: Lieferant + Betrag", False
        return "", "", "", "", False

    def allocation_total(c, movement_id):
        row = c.execute("SELECT COALESCE(SUM(amount),0) total FROM brain_statement_allocations WHERE movement_id=?", (int(movement_id),)).fetchone()
        return round(float(row["total"] or 0), 2)

    def refresh_status(c, movement_id):
        row = c.execute("SELECT amount FROM brain_statement_movements WHERE id=?", (int(movement_id),)).fetchone()
        if not row:
            return None
        amount = round(float(row["amount"] or 0), 2)
        allocated = allocation_total(c, movement_id)
        rest = round(amount - allocated, 2)
        status = "reconciled" if abs(rest) <= 0.005 else ("partial" if allocated > 0 else "open")
        c.execute("UPDATE brain_statement_movements SET status=? WHERE id=?", (status, int(movement_id)))
        return dict(amount=amount, allocated=allocated, remaining=rest, status=status)

    def finish_target(category, target_source, target_id, movement=None, allocation=None):
        if not target_source or not target_id:
            return
        if category in {"supplier_payment", "direct_debit"}:
            try:
                store.set_meta(target_source, target_id, status="paid")
            except Exception as exc:
                print("⚠ CAMT Zielstatus konnte nicht gesetzt werden:", target_source, target_id, exc)
            return
        if category != "customer_receipt" or target_source != "OUTGOING":
            return
        outgoing = app.extensions.get("kristine_outgoing_store")
        if outgoing is None:
            raise RuntimeError("Debitoren-OP ist nicht verfügbar.")
        invoice_id = int(target_id)
        open_item = next(
            (item for item in outgoing.debtor_open_items() if int(item.get("invoiceId") or 0) == invoice_id),
            None,
        )
        if not open_item:
            raise ValueError("Der Debitorenposten ist nicht mehr offen.")
        amount = round(float((allocation or {}).get("amount") or 0), 2)
        if amount - round(float(open_item.get("openGross") or 0), 2) > 0.02:
            raise ValueError("Die CAMT-Zahlung ist höher als der offene Rechnungsbetrag.")
        reference = _normal(" ".join([
            "CAMT", (movement or {}).get("reference") or "",
            (movement or {}).get("raw_text") or "",
        ]))[:500]
        source_id = ":".join([
            str((movement or {}).get("source") or "CAMT"),
            str((movement or {}).get("external_id") or ""),
            str((allocation or {}).get("lineNo") or 1), str(invoice_id),
        ])
        try:
            outgoing.add_payment(open_item["runId"], {
                "invoiceId": invoice_id,
                "paymentDate": str((movement or {}).get("booking_date") or date.today().isoformat())[:10],
                "gross": amount,
                "reference": reference,
                "source": "CAMT",
                "sourceId": source_id,
            })
        except Exception as exc:
            if "UNIQUE" not in str(exc).upper():
                raise

    def allocate(c, movement_id, allocations):
        movement = c.execute("SELECT * FROM brain_statement_movements WHERE id=?", (int(movement_id),)).fetchone()
        if not movement:
            raise ValueError("Bankbewegung nicht gefunden.")
        clean = []
        total = 0.0
        for index, item in enumerate(allocations or [], 1):
            category = str((item or {}).get("category") or "").strip()
            if category not in CATEGORIES:
                raise ValueError("Ungueltige Buchungsart.")
            try:
                amount = round(float((item or {}).get("amount") or 0), 2)
            except Exception:
                raise ValueError("Ungueltiger Teilbetrag.")
            if amount <= 0:
                raise ValueError("Teilbetrag muss groesser 0 sein.")
            total += amount
            clean.append(dict(
                lineNo=index, category=category, amount=amount,
                targetSource=str((item or {}).get("targetSource") or "").strip(),
                targetId=str((item or {}).get("targetId") or "").strip(),
                note=_normal((item or {}).get("note"))[:500],
            ))
        if round(total - float(movement["amount"] or 0), 2) > 0.005:
            raise ValueError("Zuordnung ist groesser als der Umsatz.")
        c.execute("DELETE FROM brain_statement_allocations WHERE movement_id=?", (int(movement_id),))
        now = datetime.now().isoformat(timespec="seconds")
        for item in clean:
            c.execute("""
                INSERT INTO brain_statement_allocations
                (movement_id,line_no,category,amount,target_source,target_id,note,created_at)
                VALUES(?,?,?,?,?,?,?,?)
            """, (int(movement_id), item["lineNo"], item["category"], item["amount"], item["targetSource"], item["targetId"], item["note"], now))
        state = refresh_status(c, movement_id)
        if state and state["status"] == "reconciled":
            for item in clean:
                finish_target(
                    item["category"], item["targetSource"], item["targetId"],
                    dict(movement), item,
                )
        c.commit()
        return state

    def import_statements(data, source="CAMT"):
        source = str(source or "CAMT").upper()
        statements = parse_camt(data) if source == "CAMT" else []
        digest = hashlib.sha256(data).hexdigest()
        by_e2e, debit, revolut, debtors = payment_candidates()
        imported = []
        c = con()
        try:
            for idx, statement in enumerate(statements, 1):
                file_hash = digest if len(statements) == 1 else hashlib.sha256((digest + ":" + str(idx)).encode()).hexdigest()
                now = datetime.now().isoformat(timespec="seconds")
                row = c.execute("SELECT id FROM brain_statement_imports WHERE source=? AND file_sha256=?", (source, file_hash)).fetchone()
                if row:
                    statement_id = int(row["id"])
                    duplicate = True
                else:
                    duplicate = False
                    cur = c.execute("""
                        INSERT INTO brain_statement_imports
                        (source,external_id,account_iban,period_start,period_end,currency,opening_balance,closing_balance,file_sha256,imported_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?)
                    """, (
                        source, statement["externalId"], statement["accountIban"], statement["periodStart"], statement["periodEnd"],
                        statement["currency"], statement["openingBalance"], statement["closingBalance"], file_hash, now,
                    ))
                    statement_id = int(cur.lastrowid)
                added = 0
                if not duplicate:
                    for movement in statement["movements"]:
                        category, target_source, target_id, reason, auto = suggest(
                            movement, by_e2e, debit, revolut, debtors
                        )
                        try:
                            cur = c.execute("""
                                INSERT INTO brain_statement_movements
                                (statement_id,source,external_id,booking_date,value_date,direction,amount,currency,
                                 counterparty_name,counterparty_iban,end_to_end_id,reference,raw_text,
                                 suggested_category,suggested_target_source,suggested_target_id,suggested_reason,status,created_at)
                                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)
                            """, (
                                statement_id, source, movement["externalId"], movement["bookingDate"], movement["valueDate"],
                                movement["direction"], movement["amount"], movement["currency"], movement["counterpartyName"],
                                movement["counterpartyIban"], movement["endToEndId"], movement["reference"], movement["rawText"],
                                category, target_source, target_id, reason, now,
                            ))
                            movement_id = int(cur.lastrowid)
                            added += 1
                            if auto and category:
                                allocate(c, movement_id, [dict(category=category, amount=movement["amount"], targetSource=target_source, targetId=target_id, note=reason)])
                        except Exception as exc:
                            # Doppelte Bewegung innerhalb bereits bekannter Daten nicht erneut anlegen.
                            if "UNIQUE" not in str(exc).upper():
                                raise
                c.commit()
                imported.append(dict(statementId=statement_id, duplicate=duplicate, added=added))
        finally:
            c.close()
        return imported

    def movement_public(c, row):
        d = dict(row)
        allocations = [dict(x) for x in c.execute("SELECT line_no AS lineNo,category,amount,target_source AS targetSource,target_id AS targetId,note FROM brain_statement_allocations WHERE movement_id=? ORDER BY line_no", (int(d["id"]),)).fetchall()]
        allocated = round(sum(float(x.get("amount") or 0) for x in allocations), 2)
        amount = round(float(d.get("amount") or 0), 2)
        return {
            "id": int(d["id"]), "statementId": int(d["statement_id"]), "source": d["source"],
            "bookingDate": d.get("booking_date") or "", "valueDate": d.get("value_date") or "",
            "direction": d.get("direction") or "", "amount": amount, "currency": d.get("currency") or "EUR",
            "counterpartyName": d.get("counterparty_name") or "", "counterpartyIban": d.get("counterparty_iban") or "",
            "endToEndId": d.get("end_to_end_id") or "", "reference": d.get("reference") or "", "rawText": d.get("raw_text") or "",
            "suggestedCategory": d.get("suggested_category") or "", "suggestedTargetSource": d.get("suggested_target_source") or "",
            "suggestedTargetId": d.get("suggested_target_id") or "", "suggestedReason": d.get("suggested_reason") or "",
            "status": d.get("status") or "open", "allocated": allocated, "remaining": round(amount - allocated, 2), "allocations": allocations,
        }

    def statement_summary(c, statement_id):
        stmt = c.execute("SELECT * FROM brain_statement_imports WHERE id=?", (int(statement_id),)).fetchone()
        if not stmt:
            raise ValueError("Auszug nicht gefunden.")
        movements = [movement_public(c, x) for x in c.execute("SELECT * FROM brain_statement_movements WHERE statement_id=? ORDER BY booking_date,id", (int(statement_id),)).fetchall()]
        remaining = round(sum(abs(float(x["remaining"] or 0)) for x in movements), 2)
        open_count = sum(1 for x in movements if x["status"] != "reconciled")
        return {
            "id": int(stmt["id"]), "source": stmt["source"], "externalId": stmt["external_id"], "accountIban": stmt["account_iban"] or "",
            "periodStart": stmt["period_start"] or "", "periodEnd": stmt["period_end"] or "", "currency": stmt["currency"] or "EUR",
            "openingBalance": stmt["opening_balance"], "closingBalance": stmt["closing_balance"], "importedAt": stmt["imported_at"],
            "movementCount": len(movements), "openCount": open_count, "remaining": remaining,
            "status": "complete" if open_count == 0 and remaining <= 0.005 else "open", "movements": movements,
        }

    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    for path in ("/incoming/reconciliation", "/incoming/reconciliation/import-camt", "/incoming/reconciliation/statements", "/incoming/reconciliation/movements"):
        if isinstance(allowed, set):
            allowed.add(path)

    if "brain_reconciliation_statements" not in app.view_functions:
        from flask import request, jsonify, Response

        @app.post("/incoming/reconciliation/import-camt")
        def brain_reconciliation_import_camt():
            try:
                upload = request.files.get("file")
                if not upload:
                    raise ValueError("Bitte CAMT-Datei auswaehlen.")
                data = upload.read()
                if not data:
                    raise ValueError("CAMT-Datei ist leer.")
                imported = import_statements(data, "CAMT")
                return jsonify(ok=True, imported=imported)
            except ValueError as exc:
                return jsonify(ok=False, error=str(exc)), 400
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

        @app.get("/incoming/reconciliation/statements")
        def brain_reconciliation_statements():
            c = con()
            try:
                ids = [int(x["id"]) for x in c.execute("SELECT id FROM brain_statement_imports ORDER BY COALESCE(period_end,imported_at) DESC,id DESC").fetchall()]
                rows = [statement_summary(c, sid) for sid in ids]
                return jsonify(ok=True, statements=rows, openStatements=sum(1 for x in rows if x["status"] != "complete"), remaining=round(sum(float(x["remaining"] or 0) for x in rows), 2))
            finally:
                c.close()

        @app.post("/incoming/reconciliation/movements/<int:movement_id>/allocate")
        def brain_reconciliation_allocate(movement_id):
            try:
                payload = request.get_json(silent=True) or {}
                allocations = payload.get("allocations") or []
                c = con()
                try:
                    state = allocate(c, movement_id, allocations)
                    row = c.execute("SELECT * FROM brain_statement_movements WHERE id=?", (movement_id,)).fetchone()
                    return jsonify(ok=True, state=state, movement=movement_public(c, row))
                finally:
                    c.close()
            except ValueError as exc:
                return jsonify(ok=False, error=str(exc)), 400
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

        @app.get("/incoming/reconciliation")
        def brain_reconciliation_page():
            categories = json.dumps(CATEGORIES, ensure_ascii=False)
            html = r'''<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KRISTINE · Bankabgleich</title><style>
body{margin:0;background:#101316;color:#eef2f4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}.shell{max-width:1500px;margin:auto;padding:18px}.head,.tools,.move-top,.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.head{justify-content:space-between}.card,.statement,.move{border:1px solid #343c46;background:#171b20;border-radius:13px;padding:12px;margin:12px 0}.statement.complete{border-color:#3f7653}.statement.open{border-color:#7a5b2d}.move{background:#11151a}.move.reconciled{opacity:.68}.sub{color:#9da8b3;font-size:12px}.amount{font-size:18px;font-weight:900}.out .amount{color:#f0a0a0}.in .amount{color:#92d6a8}button,select,input{background:#252c34;color:#fff;border:1px solid #485461;border-radius:9px;padding:8px 10px}.primary{background:#3d7f55;font-weight:850}.warn{color:#e8bd68}.ok{color:#8ed2a2}.rest{font-weight:850}.quick{font-size:11px;padding:6px 8px}.split{display:grid;grid-template-columns:minmax(170px,1fr) 120px minmax(170px,1fr);gap:7px;margin-top:8px}.back{color:#fff;font-weight:850}@media(max-width:720px){.split{grid-template-columns:1fr}.head{align-items:flex-start}}
</style></head><body><main class="shell"><div class="head"><div><h1>Bank / CAMT-Abgleich</h1><div class="sub">Ein Auszug ist erst fertig, wenn jede Bewegung Rest 0,00 hat.</div></div><a class="back" href="/incoming/payments">← OP</a></div><section class="card"><form id="upload"><div class="tools"><input id="file" name="file" type="file" accept=".xml,.camt,.053,text/xml,application/xml"><button class="primary">CAMT importieren</button><span id="msg" class="sub"></span></div></form></section><div id="summary" class="card">Wird geladen …</div><div id="rows"></div></main><script>
(()=>{const CATS=__CATS__,rows=document.getElementById('rows'),summary=document.getElementById('summary'),msg=document.getElementById('msg');const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=(n,c='EUR')=>new Intl.NumberFormat('de-AT',{style:'currency',currency:c||'EUR'}).format(Number(n||0)),date=s=>{const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'.'+m[2]+'.'+m[1]:(s||'–')};function opts(selected=''){return Object.entries(CATS).map(([k,v])=>`<option value="${esc(k)}" ${k===selected?'selected':''}>${esc(v)}</option>`).join('')}function moveHtml(x){const sug=x.suggestedCategory?`<div class="sub">Vorschlag: <strong>${esc(CATS[x.suggestedCategory]||x.suggestedCategory)}</strong>${x.suggestedReason?' · '+esc(x.suggestedReason):''}</div>`:'';return `<div class="move ${esc(x.status)} ${esc(x.direction)}" data-id="${x.id}" data-suggested-source="${esc(x.suggestedTargetSource||'')}" data-suggested-id="${esc(x.suggestedTargetId||'')}" data-suggested-reason="${esc(x.suggestedReason||'')}"><div class="move-top"><div><strong>${esc(date(x.bookingDate))} · ${esc(x.counterpartyName||'Ohne Gegenpartei')}</strong><div class="sub">${esc(x.reference||x.endToEndId||'')}</div>${sug}</div><div style="margin-left:auto;text-align:right"><div class="amount">${x.direction==='out'?'−':'+'}${esc(money(x.amount,x.currency))}</div><div class="rest ${x.remaining<=.005?'ok':'warn'}">Rest ${esc(money(x.remaining,x.currency))}</div></div></div><div class="actions"><button class="quick" data-quick="alex_contribution">Einlage Alex</button><button class="quick" data-quick="alex_withdrawal">Privatentnahme Alex</button><button class="quick" data-quick="revolut_internal">Bank ↔ Revolut</button><button class="quick" data-quick="bank_fee">Gebühr</button>${x.suggestedCategory?'<button class="quick primary" data-suggestion>Vorschlag übernehmen</button>':''}</div><div class="split"><select data-cat>${opts(x.suggestedCategory||'other_expense')}</select><input data-amount type="number" step="0.01" min="0" value="${Number(x.remaining||x.amount).toFixed(2)}"><button data-book class="primary">Zuordnen / Rest buchen</button></div></div>`}function render(d){summary.innerHTML=`<strong>${d.openStatements||0} Auszug/Auszüge noch offen</strong> · Rest gesamt <strong>${esc(money(d.remaining||0))}</strong>`;rows.innerHTML=(d.statements||[]).map(s=>`<section class="statement ${esc(s.status)}"><div class="head"><div><strong>${esc(s.source)} · ${esc(s.accountIban||'')}</strong><div class="sub">${esc(date(s.periodStart))} – ${esc(date(s.periodEnd))} · ${s.movementCount} Bewegungen</div></div><div><strong class="${s.status==='complete'?'ok':'warn'}">${s.status==='complete'?'✓ komplett verbucht':'Rest '+esc(money(s.remaining,s.currency))}</strong></div></div>${(s.movements||[]).map(moveHtml).join('')}</section>`).join('')||'<div class="card sub">Noch kein CAMT importiert.</div>';wire()}async function load(){const r=await fetch('/incoming/reconciliation/statements',{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Fehler');render(d)}async function book(id,category,amount,targetSource='',targetId='',note=''){const r=await fetch('/incoming/reconciliation/movements/'+id+'/allocate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allocations:[{category,amount:Number(amount),targetSource,targetId,note}]})}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Buchen fehlgeschlagen');await load()}function wire(){rows.querySelectorAll('.move').forEach(el=>{const id=el.dataset.id,amount=el.querySelector('[data-amount]'),cat=el.querySelector('[data-cat]');el.querySelector('[data-book]').onclick=()=>book(id,cat.value,amount.value).catch(e=>alert(e.message));el.querySelectorAll('[data-quick]').forEach(b=>b.onclick=()=>book(id,b.dataset.quick,amount.value).catch(e=>alert(e.message)));el.querySelector('[data-suggestion]')?.addEventListener('click',()=>{const option=cat.value;book(id,option,amount.value,el.dataset.suggestedSource||'',el.dataset.suggestedId||'',el.dataset.suggestedReason||'').catch(e=>alert(e.message))})})}document.getElementById('upload').onsubmit=async e=>{e.preventDefault();const f=document.getElementById('file').files?.[0];if(!f)return;msg.textContent='Import läuft …';const fd=new FormData();fd.append('file',f);try{const r=await fetch('/incoming/reconciliation/import-camt',{method:'POST',body:fd}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Import fehlgeschlagen');msg.textContent='✓ importiert';await load()}catch(err){msg.textContent=err.message}};load().catch(e=>summary.textContent=e.message)})();
</script></body></html>'''.replace("__CATS__", categories)
            return Response(html, mimetype="text/html")

    # OP-Seite bekommt einen klaren Einstieg in den Bankabgleich.
    payment_page = app.view_functions.get("brain_incoming_payments_page")
    if payment_page and not getattr(payment_page, "_krista_reconciliation", False):
        from flask import Response

        def payment_page_with_reconciliation():
            response = app.make_response(payment_page())
            try:
                html = response.get_data(as_text=True)
                marker = '<a class="back" href="/">← The Brain</a>'
                if marker in html and "/incoming/reconciliation" not in html:
                    html = html.replace(marker, '<div class="actions"><a class="back" href="/incoming/reconciliation">🏦 Bank / CAMT</a>'+marker+'</div>', 1)
                return Response(html, mimetype="text/html")
            except Exception:
                return response

        payment_page_with_reconciliation.__name__ = "brain_incoming_payments_page_reconciliation"
        payment_page_with_reconciliation._krista_reconciliation = True
        app.view_functions["brain_incoming_payments_page"] = payment_page_with_reconciliation

    print("✅ Finance-Abgleich aktiv: CAMT/Revolut muessen je Bewegung auf Rest 0,00")
