# coding: utf-8
"""Ergaenzungen zum Finance-Abgleich.

- Remote-sicherer statischer Zuordnungs-Endpunkt (Tailscale-Allowlist).
- Generischer Revolut-Transaktionsfeed nutzt dieselbe Rest-0,00-Logik wie CAMT.
- Die Abgleichseite wird auf den statischen Endpoint umgebogen.
"""
from __future__ import annotations

import hashlib
import json
import base64
from datetime import datetime

from brain_finance_source import FinanceStore, norm_method, norm_status


def _txt(value):
    return " ".join(str(value or "").split())


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    capture_connection = ns.get("_capture_connection")
    capture_db = ns.get("CAPTURE_DB")
    kristine_api = ns.get("kristine_api_request")
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

    def exact_revolut_match(tx, expected_method="revolut", items=()):
        amount = round(float(tx.get("amount") or 0), 2)
        currency = str(tx.get("currency") or "EUR").upper()
        merchant = _txt(tx.get("merchant") or tx.get("counterpartyName") or tx.get("description")).lower()
        matches = []
        for item in items:
            if norm_method(item.get("paymentMethod")) != expected_method or norm_status(item.get("paymentStatus")) == "paid":
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
                channel_raw = _txt(body.get("channel") or body.get("accountType") or body.get("source") or "REVOLUT").lower()
                is_business = "business" in channel_raw or channel_raw in {"revolut_business", "business_api"}
                statement_source = "REVOLUT_BUSINESS" if is_business else "REVOLUT"
                expected_method = "revolut_business" if is_business else "revolut"
                payment_context = "Revolut Business" if is_business else "Revolut"
                account = _txt(body.get("account") or statement_source)
                currency = str(body.get("currency") or "EUR").upper()
                digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
                # Read possible invoices before opening the bank write transaction.
                # FinanceStore opens the same SQLite database, so reading it from
                # inside that transaction can wait on its own write lock.
                try:
                    candidate_items = store.items(True)
                except Exception:
                    candidate_items = []
                c = con()
                try:
                    existing = c.execute(
                        "SELECT id FROM brain_statement_imports WHERE source=? AND file_sha256=?",
                        (statement_source, digest),
                    ).fetchone()
                    if existing:
                        return jsonify(ok=True, duplicate=True, statementId=int(existing["id"]), added=0)
                    now = datetime.now().isoformat(timespec="seconds")
                    cur = c.execute("""
                        INSERT INTO brain_statement_imports
                        (source,external_id,account_iban,period_start,period_end,currency,opening_balance,closing_balance,file_sha256,imported_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?)
                    """, (
                        statement_source, external_statement, account,
                        str(body.get("periodStart") or "")[:10], str(body.get("periodEnd") or "")[:10],
                        currency, body.get("openingBalance"), body.get("closingBalance"), digest, now,
                    ))
                    statement_id = int(cur.lastrowid)
                    added = 0
                    suggested = 0
                    attachments_queued = 0
                    attachment_errors = []
                    for index, tx in enumerate(transactions, 1):
                        if not isinstance(tx, dict):
                            continue
                        signed_amount = round(float(tx.get("amount") or 0), 2)
                        amount = round(abs(signed_amount), 2)
                        if amount <= 0:
                            continue
                        tx_currency = str(tx.get("currency") or currency).upper()
                        direction_raw = str(tx.get("direction") or tx.get("type") or "").lower()
                        direction = "in" if direction_raw in {"in", "credit", "crdt", "income"} or (not direction_raw and signed_amount > 0) else "out"
                        merchant = _txt(tx.get("merchant") or tx.get("counterpartyName") or tx.get("description"))
                        booking = str(tx.get("bookingDate") or tx.get("date") or "")[:10]
                        reference = _txt(tx.get("reference") or tx.get("id") or tx.get("transactionId"))
                        external_id = str(tx.get("id") or tx.get("transactionId") or "").strip()
                        if not external_id:
                            external_id = "revolut:" + hashlib.sha256(
                                f"{external_statement}|{index}|{booking}|{direction}|{amount}|{tx_currency}|{merchant}|{reference}".encode("utf-8", "ignore")
                            ).hexdigest()[:32]
                        match = exact_revolut_match({**tx, "amount": amount, "currency": tx_currency, "merchant": merchant}, expected_method, candidate_items) if direction == "out" else None
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
                            statement_id, statement_source, external_id, booking, str(tx.get("valueDate") or booking)[:10],
                            direction, amount, tx_currency, merchant, _txt(tx.get("counterpartyIban")),
                            _txt(tx.get("endToEndId")), reference, _txt(tx.get("description") or merchant),
                            suggested_category, target_source, target_id, reason, now,
                        ))
                        if cur.rowcount:
                            added += 1
                            if match:
                                suggested += 1

                        # Anhänge aus der Revolut-API landen im selben Eingangskorb
                        # wie Scan und Drag & Drop. Das bestehende Intake dedupliziert
                        # nach Dateiinhalt; die Zahlung wird erst manuell zugeordnet.
                        attachments = tx.get("attachments") or []
                        if isinstance(attachments, dict):
                            attachments = [attachments]
                        for attachment in attachments if isinstance(attachments, list) else []:
                            if not isinstance(attachment, dict):
                                continue
                            try:
                                raw_data = attachment.get("data") or attachment.get("contentBytes") or attachment.get("base64") or ""
                                if isinstance(raw_data, bytes):
                                    encoded = base64.b64encode(raw_data).decode("ascii")
                                else:
                                    encoded = str(raw_data or "")
                                    if "," in encoded and encoded.lower().startswith("data:"):
                                        encoded = encoded.split(",", 1)[1]
                                if not encoded:
                                    raise ValueError("Anhang enthält keine Datei.")
                                if not callable(kristine_api):
                                    raise RuntimeError("Rechnungseingang ist nicht erreichbar.")
                                result = kristine_api("/kristine/api/invoice-intake/import", method="POST", payload={
                                    "name": _txt(attachment.get("name") or attachment.get("filename") or f"Revolut-{external_id}.pdf")[:180],
                                    "type": _txt(attachment.get("type") or attachment.get("contentType") or "application/pdf")[:160],
                                    "data": encoded,
                                    "source": payment_context + " API",
                                    "submittedById": "revolut-business-api" if is_business else "revolut-api",
                                    "submittedByName": payment_context + " API",
                                    "capturedAt": str(tx.get("completedAt") or tx.get("createdAt") or booking)[:60],
                                    "paymentContext": payment_context,
                                    "note": (reference or external_id)[:500],
                                }) or {}
                                if result.get("ok") is False:
                                    raise ValueError(str(result.get("error") or "Anhang konnte nicht übernommen werden."))
                                attachments_queued += 1
                            except Exception as exc:
                                attachment_errors.append({"transactionId": external_id, "error": str(exc)})
                    c.commit()
                    return jsonify(ok=True, duplicate=False, statementId=statement_id, added=added, suggested=suggested,
                                   autoPaid=0, attachmentsQueued=attachments_queued, attachmentErrors=attachment_errors)
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
