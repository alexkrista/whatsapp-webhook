# coding: utf-8
"""Dublettenprüfung erst nach vollständigen Kerndaten anzeigen.

Die Lern-UI darf während OCR/Tippen schon Prüfungen anstoßen; sichtbar werden
Treffer aber erst, wenn Lieferant, Rechnungsnummer, Rechnungsdatum und Brutto
vorliegen. Weiche Treffer brauchen zusätzlich den Datumsbezug.
"""


def install(ns):
    app = ns.get("app")
    if app is None:
        return
    original = app.view_functions.get("brain_capture_duplicate_check")
    if not original or getattr(original, "_krista_complete_guard", False):
        return

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
            response.set_data(__import__("json").dumps(data, ensure_ascii=False))
            response.mimetype = "application/json"
        return response

    guarded_duplicate_check.__name__ = "brain_capture_duplicate_check_complete_guard"
    guarded_duplicate_check._krista_complete_guard = True
    app.view_functions["brain_capture_duplicate_check"] = guarded_duplicate_check
    print("✅ Dubletten-Guard: Fragen erst nach vollständigen Rechnungs-Kerndaten")
