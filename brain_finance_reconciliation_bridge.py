# coding: utf-8
"""Ergaenzungen zum Finance-Abgleich.

- Remote-sicherer statischer Zuordnungs-Endpunkt (Tailscale-Allowlist).
- Generischer Revolut-Transaktionsfeed nutzt dieselbe Rest-0,00-Logik wie CAMT.
- Die Abgleichseite wird auf den statischen Endpoint umgebogen.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime

from brain_finance_source import FinanceStore, norm_method, norm_status


def _txt(value):
    return " ".join(str(value or "").split())


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    capture_connection = ns.get("_capture_connection")
    capture_db = ns.get("CAPTURE_DB")
    if app is None or not page or not callable(capture_connection):
        return

    store = FinanceStore(ns)

    def con():
        return capture_connection(capture_db)

    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.update({
            "/incoming/reconciliation/allocate",
            "/incoming/reconciliation/import-revolut",
        })

    dynamic_allocate = app.view_functions.get("brain_reconciliation_allocate")
    if dynamic_allocate and "brain_reconciliation_allocate_static" not in app.view_functions:
        from flask import request, jsonify

        @app.post("/incoming/reconciliation/allocate")
        def brain_reconciliation_allocate_static():
            body = request.get_json(silent=True) or {}
            try:
                movement_id = int(body.get("movementId") or 0)
            except Exception:
                movement_id = 0
            if not movement_id:
                return jsonify(ok=False, error="movementId fehlt"), 400
            return dynamic_allocate(movement_id)

    def exact_revolut_match(tx):
        amount = round(float(tx.get("amount") or 0), 2)
        currency = str(tx.get("currency") or "EUR").upper()
        merchant = _txt(tx.get("merchant") or tx.get("counterpartyName") or tx.get("description")).lower()
        matches = []
        try:
            items = store.items(True)
        except Exception:
            items = []
        for item in items:
            if norm_method(item.get("paymentMethod")) != "revolut" or norm_status(item.get("paymentStatus")) == "paid":
                continue
            if str(item.get("currency") or "EUR").upper() != currency:
                continue
            if abs(round(float(item.get("amount") or 0), 2) - amount) > 0.02:
                continue
            supplier = _txt(item.get("supplier")).lower()
            # Betrag ist Pflicht; Name dient als zweites Merkmal. Bei leerem Namen
            # niemals automatisch zuordnen.
            if supplier and merchant and (supplier in merchant or merchant in supplier or supplier[:8] in merchant):
                matches.append(item)
        return matches[0] if len(matches) == 1 else None

    if "brain_reconciliation_import_revolut" not in app.view_functions:
        from flask import request, jsonify

        @app.post("/incoming/reconciliation/import-revolut")
        def brain_reconciliation_import_revolut():
            try:
                body = request.get_json(silent=True) or {}
                transactions = body.get("transactions") or []
                if not isinstance(transactions, list) or not transactions:
                    raise ValueError("Keine Revolut-Transaktionen geliefert.")
                external_statement = _txt(body.get("statementId") or body.get("period") or datetime.now().date().isoformat())
                account = _txt(body.get("account") or "REVOLUT")
                currency = str(body.get("currency") or "EUR").upper()
                digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
                c = con()
                try:
                    existing = c.execute(
                        "SELECT id FROM brain_statement_imports WHERE source='REVOLUT' AND file_sha256=?",
                        (digest,),
                    ).fetchone()
                    if existing:
                        return jsonify(ok=True, duplicate=True, statementId=int(existing["id"]), added=0)
                    now = datetime.now().isoformat(timespec="seconds")
                    cur = c.execute("""
                        INSERT INTO brain_statement_imports
                        (source,external_id,account_iban,period_start,period_end,currency,opening_balance,closing_balance,file_sha256,imported_at)
                        VALUES('REVOLUT',?,?,?,?,?,?,?,?,?)
                    """, (
                        external_statement, account,
                        str(body.get("periodStart") or "")[:10], str(body.get("periodEnd") or "")[:10],
                        currency, body.get("openingBalance"), body.get("closingBalance"), digest, now,
                    ))
                    statement_id = int(cur.lastrowid)
                    added = 0
                    auto_paid = 0
                    for index, tx in enumerate(transactions, 1):
                        if not isinstance(tx, dict):
                            continue
                        amount = round(abs(float(tx.get("amount") or 0)), 2)
                        if amount <= 0:
                            continue
                        tx_currency = str(tx.get("currency") or currency).upper()
                        direction_raw = str(tx.get("direction") or tx.get("type") or "").lower()
                        direction = "in" if direction_raw in {"in", "credit", "crdt", "income"} else "out"
                        merchant = _txt(tx.get("merchant") or tx.get("counterpartyName") or tx.get("description"))
                        booking = str(tx.get("bookingDate") or tx.get("date") or "")[:10]
                        reference = _txt(tx.get("reference") or tx.get("id") or tx.get("transactionId"))
                        external_id = str(tx.get("id") or tx.get("transactionId") or "").strip()
                        if not external_id:
                            external_id = "revolut:" + hashlib.sha256(
                                f"{external_statement}|{index}|{booking}|{direction}|{amount}|{tx_currency}|{merchant}|{reference}".encode("utf-8", "ignore")
                            ).hexdigest()[:32]
                        match = exact_revolut_match({**tx, "amount": amount, "currency": tx_currency, "merchant": merchant}) if direction == "out" else None
                        suggested_category = "supplier_payment" if match else ""
                        target_source = str((match or {}).get("source") or "")
                        target_id = str((match or {}).get("id") or "")
                        reason = "Revolut: Betrag + Währung + Lieferant eindeutig" if match else ""
                        cur = c.execute("""
                            INSERT OR IGNORE INTO brain_statement_movements
                            (statement_id,source,external_id,booking_date,value_date,direction,amount,currency,
                             counterparty_name,counterparty_iban,end_to_end_id,reference,raw_text,
                             suggested_category,suggested_target_source,suggested_target_id,suggested_reason,status,created_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)
                        """, (
                            statement_id, "REVOLUT", external_id, booking, str(tx.get("valueDate") or booking)[:10],
                            direction, amount, tx_currency, merchant, _txt(tx.get("counterpartyIban")),
                            _txt(tx.get("endToEndId")), reference, _txt(tx.get("description") or merchant),
                            suggested_category, target_source, target_id, reason, now,
                        ))
                        if cur.rowcount:
                            movement_id = int(cur.lastrowid)
                            added += 1
                            if match:
                                c.execute("""
                                    INSERT INTO brain_statement_allocations
                                    (movement_id,line_no,category,amount,target_source,target_id,note,created_at)
                                    VALUES(?,1,'supplier_payment',?,?,?,?,?)
                                """, (movement_id, amount, target_source, target_id, reason, now))
                                c.execute("UPDATE brain_statement_movements SET status='reconciled' WHERE id=?", (movement_id,))
                                try:
                                    store.set_meta(target_source, target_id, status="paid")
                                    auto_paid += 1
                                except Exception as exc:
                                    print("⚠ Revolut Zielstatus:", exc)
                    c.commit()
                    return jsonify(ok=True, duplicate=False, statementId=statement_id, added=added, autoPaid=auto_paid)
                finally:
                    c.close()
            except ValueError as exc:
                return jsonify(ok=False, error=str(exc)), 400
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

    # Die Originalseite verwendet einen dynamischen URL-Pfad. Lokal funktioniert das,
    # die Remote-Allowlist ist absichtlich strikt. Deshalb nur die Seite umschreiben,
    # nicht den Sicherheitsfilter aufweichen.
    reconciliation_page = app.view_functions.get("brain_reconciliation_page")
    if reconciliation_page and not getattr(reconciliation_page, "_krista_static_allocate", False):
        from flask import Response

        def reconciliation_page_static_allocate():
            response = app.make_response(reconciliation_page())
            try:
                html = response.get_data(as_text=True)
                old = "fetch('/incoming/reconciliation/movements/'+id+'/allocate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allocations:"
                new = "fetch('/incoming/reconciliation/allocate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({movementId:Number(id),allocations:"
                html = html.replace(old, new)
                return Response(html, mimetype="text/html")
            except Exception:
                return response

        reconciliation_page_static_allocate.__name__ = "brain_reconciliation_page_static_allocate"
        reconciliation_page_static_allocate._krista_static_allocate = True
        app.view_functions["brain_reconciliation_page"] = reconciliation_page_static_allocate

    print("✅ Finance-Abgleich Bridge: Remote-Zuordnung + Revolut-Feed auf Rest 0,00")
