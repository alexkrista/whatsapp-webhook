# coding: utf-8
"""Revolut: bei gleichzeitigen Aufgaben-Updates nie HTML-500 an den Browser liefern.

Im TEST holt die Revolut-Bruecke zusaetzlich den aktuellen Freigabe-/Aufgabenstand
von KRISTINE. Wenn genau waehrend eines Aufgaben-Saves dieser Bootstrap kurz nicht
lesbar ist, darf die eigentliche Revolut-Liste trotzdem funktionieren. Sonst
antwortet Flask mit einer HTML-Fehlerseite; der Browser erwartet JSON und zeigt
"Unexpected token '<'".
"""
from __future__ import annotations

from brain_finance_source import norm_status


def install(ns):
    app = ns.get("app")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    if app is None or not callable(area_connection) or not callable(capture_area):
        return

    original = app.view_functions.get("brain_incoming_revolut_items")
    if not original or getattr(original, "_krista_task_guard", False):
        return

    from flask import request, jsonify

    def test_fallback(error):
        con = area_connection("test")
        try:
            rows = con.execute("""
                SELECT id,doc_id,supplier_name,supplier_invoice_number,invoice_date,
                       gross_amount,currency,payment_state,pdf_path,payment_method,
                       fx_estimated_eur
                FROM incoming_invoices
                WHERE LOWER(COALESCE(payment_method,'unknown'))='revolut'
                ORDER BY invoice_date DESC,id DESC
            """).fetchall()
            items = []
            for row in rows:
                status = norm_status(row["payment_state"])
                items.append({
                    "id": f"kristine:{int(row['id'])}",
                    "docId": str(row["doc_id"] or ""),
                    "supplier": str(row["supplier_name"] or ""),
                    "invoiceNumber": str(row["supplier_invoice_number"] or ""),
                    "invoiceDate": str(row["invoice_date"] or ""),
                    "amount": float(row["gross_amount"] or 0),
                    "currency": str(row["currency"] or "EUR"),
                    "paymentStatus": status,
                    "paymentMethod": "revolut",
                    # Aufgabenstand war kurz nicht lesbar. Nichts automatisch freigeben.
                    "approvalStatus": "pending",
                    "path": str(row["pdf_path"] or ""),
                    "source": "KRISTINE_TEST",
                    "estimatedEur": float(row["fx_estimated_eur"]) if row["fx_estimated_eur"] is not None else None,
                })
            opened = [x for x in items if x["paymentStatus"] != "paid"]
            total = 0.0
            for item in opened:
                if item.get("estimatedEur") is not None:
                    total += float(item["estimatedEur"])
                elif item.get("currency") == "EUR":
                    total += float(item.get("amount") or 0)
            return jsonify(
                ok=True,
                area="test",
                trainingMode=True,
                degraded=True,
                taskSyncWarning="Aufgabenstand wird gerade aktualisiert; Revolut-Daten selbst sind verfuegbar.",
                taskSyncDetail=str(error)[:500],
                count=len(items),
                openCount=len(opened),
                openTotal=round(total, 2),
                approvalPendingCount=len(opened),
                items=items,
            )
        finally:
            con.close()

    def guarded_revolut_items():
        area = capture_area(request.args.get("area") or "live")
        try:
            response = app.make_response(original())
            # Auch falls ein tieferer Wrapper versehentlich HTML liefert, niemals den
            # rohen HTML-Body an einen JSON-Client durchreichen.
            if response.is_json:
                return response
            text = response.get_data(as_text=True) or ""
            if area == "test":
                return test_fallback(f"HTTP {response.status_code}: {text[:180]}")
            return jsonify(
                ok=False,
                error="Revolut-Daten konnten kurz nicht als JSON geladen werden. Bitte nochmals laden.",
                detail=text[:300],
            ), (response.status_code if response.status_code >= 400 else 502)
        except Exception as exc:
            if area == "test":
                try:
                    return test_fallback(exc)
                except Exception as fallback_exc:
                    return jsonify(ok=False, error=f"Revolut konnte nicht geladen werden: {fallback_exc}"), 500
            return jsonify(ok=False, error=f"Revolut konnte nicht geladen werden: {exc}"), 500

    guarded_revolut_items.__name__ = "brain_incoming_revolut_items_task_guard"
    guarded_revolut_items._krista_task_guard = True
    app.view_functions["brain_incoming_revolut_items"] = guarded_revolut_items
    print("✅ Revolut Task-Guard: Aufgaben-Save kann JSON-Liste nicht mehr zerlegen")
