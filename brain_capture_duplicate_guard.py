# coding: utf-8
"""Dublettenprüfung im Rechnungseingang.

1) Die UI zeigt Treffer erst, wenn die Rechnungs-Kerndaten vollständig sind.
2) Zusätzlich blockiert der Server den echten Speichervorgang hart, wenn
   Lieferant + Rechnungsnummer oder die identische PDF bereits vorhanden sind.

Damit ist die UI nur Komfort; die Datenbank bekommt keine neue Dublette mehr,
auch wenn Browser-/OCR-Logik eine Prüfung einmal überspringt.
"""
from __future__ import annotations

import hashlib
import json
import re


def _invoice_norm(value):
    return re.sub(r"[^A-Za-z0-9]+", "", str(value or "")).upper().strip()


def install(ns):
    app = ns.get("app")
    if app is None:
        return

    # ------------------------------------------------------------------
    # UI-Dublettencheck: erst nach vollständigen Kerndaten anzeigen.
    # ------------------------------------------------------------------
    original = app.view_functions.get("brain_capture_duplicate_check")
    if original and not getattr(original, "_krista_complete_guard", False):
        from flask import request, jsonify

        def guarded_duplicate_check():
            body = request.get_json(silent=True) or {}
            supplier = body.get("supplier") or {}
            required = (
                str(supplier.get("addressId") or body.get("addressId") or "").strip(),
                str(body.get("invoiceNumber") or "").strip(),
                str(body.get("invoiceDate") or "").strip(),
                str(body.get("grossAmount") or "").strip(),
            )
            if not all(required):
                return jsonify(ok=True, waiting=True, count=0, hard=False, items=[])

            response = app.make_response(original())
            if not response.is_json:
                return response
            data = response.get_json(silent=True) or {}
            if data.get("ok") and isinstance(data.get("items"), list):
                cleaned = []
                for item in data["items"]:
                    if item.get("hard"):
                        cleaned.append(item)
                        continue
                    reasons = " ".join(str(x or "") for x in (item.get("reasons") or []))
                    # Weicher Treffer nur mit Betrag + tatsächlich vergleichbarem Datum.
                    if "gleicher Betrag" in reasons and "Datum ±" in reasons:
                        cleaned.append(item)
                data["items"] = cleaned
                data["count"] = len(cleaned)
                data["hard"] = any(bool(x.get("hard")) for x in cleaned)
                response.set_data(json.dumps(data, ensure_ascii=False))
                response.mimetype = "application/json"
            return response

        guarded_duplicate_check.__name__ = "brain_capture_duplicate_check_complete_guard"
        guarded_duplicate_check._krista_complete_guard = True
        app.view_functions["brain_capture_duplicate_check"] = guarded_duplicate_check
        print("✅ Dubletten-Guard: Fragen erst nach vollständigen Rechnungs-Kerndaten")

    # ------------------------------------------------------------------
    # Harte Speichersperre. Wichtig für ältere DBs: CREATE TABLE IF NOT
    # EXISTS konnte bestehende Tabellen nicht nachträglich mit UNIQUE
    # (Lieferant, Rechnungsnummer) versehen. Deshalb hier serverseitig.
    # ------------------------------------------------------------------
    original_save = app.view_functions.get("incoming_capture_save")
    if not original_save or getattr(original_save, "_krista_duplicate_save_guard", False):
        return

    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    if not callable(area_connection) or not callable(capture_area):
        return

    from flask import request, jsonify

    def guarded_capture_save():
        try:
            payload_raw = request.form.get("payload") or "{}"
            payload = json.loads(payload_raw) if isinstance(payload_raw, str) else (payload_raw or {})
            supplier = payload.get("supplier") or {}
            address_id = str(supplier.get("addressId") or "").strip()
            invoice_number = str(payload.get("supplierInvoiceNumber") or payload.get("invoiceNumber") or "").strip()
            invoice_norm = _invoice_norm(invoice_number)
            area = capture_area(payload.get("area") or "live")

            upload = request.files.get("file")
            file_sha = ""
            if upload:
                raw = upload.read()
                if raw:
                    file_sha = hashlib.sha256(raw).hexdigest()
                try:
                    upload.stream.seek(0)
                except Exception:
                    pass

            con = area_connection(area)
            try:
                duplicates = []
                if address_id and invoice_norm:
                    rows = con.execute(
                        """SELECT id,doc_id,supplier_name,supplier_invoice_number,invoice_date,gross_amount,pdf_path
                           FROM incoming_invoices
                           WHERE supplier_address_id=? ORDER BY id DESC""",
                        (address_id,),
                    ).fetchall()
                    for row in rows:
                        if _invoice_norm(row["supplier_invoice_number"]) == invoice_norm:
                            duplicates.append(dict(row))

                if file_sha:
                    try:
                        rows = con.execute(
                            """SELECT id,doc_id,supplier_name,supplier_invoice_number,invoice_date,gross_amount,pdf_path
                               FROM incoming_invoices WHERE file_sha256=? ORDER BY id DESC""",
                            (file_sha,),
                        ).fetchall()
                        known = {int(x["id"]) for x in duplicates}
                        duplicates.extend(dict(row) for row in rows if int(row["id"]) not in known)
                    except Exception:
                        pass
            finally:
                con.close()

            if duplicates:
                first = duplicates[0]
                reason = "Rechnungsnummer bereits vorhanden" if address_id and invoice_norm else "identische PDF bereits vorhanden"
                return jsonify(
                    ok=False,
                    duplicate=True,
                    error=f"DUBLETTE BLOCKIERT: {first.get('supplier_name') or 'Lieferant'} · Rechnung {first.get('supplier_invoice_number') or invoice_number} ist bereits als {first.get('doc_id') or first.get('id')} gespeichert.",
                    reason=reason,
                    existing={
                        "id": first.get("id"),
                        "docId": first.get("doc_id"),
                        "supplier": first.get("supplier_name"),
                        "invoiceNumber": first.get("supplier_invoice_number"),
                        "invoiceDate": first.get("invoice_date"),
                        "amount": first.get("gross_amount"),
                        "path": first.get("pdf_path"),
                    },
                ), 409
        except Exception as exc:
            # Fail-open nur für den Guard selbst: der bestehende Save-Weg bleibt
            # funktionsfähig; seine eigene Validierung greift weiterhin.
            print("⚠ Dubletten-Save-Guard konnte nicht prüfen:", exc)

        return original_save()

    guarded_capture_save.__name__ = "incoming_capture_save_duplicate_guard"
    guarded_capture_save._krista_duplicate_save_guard = True
    app.view_functions["incoming_capture_save"] = guarded_capture_save
    print("✅ Dubletten-Guard: Speichern blockiert identische Rechnungsnummer/PDF hart")
