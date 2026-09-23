# coding: utf-8
"""Read-only Revolut overview from the Enable Banking cache on Render."""
import os
import urllib.request
import json
from datetime import date


def install(ns):
    app = ns.get("app")
    if app is None or "brain_revolut_personal_page" in app.view_functions:
        return
    from flask import jsonify
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.update({"/incoming/revolut-personal", "/incoming/revolut-personal/status"})

    def cloud_status():
        token = str(ns.get("KRISTINE_ADMIN_TOKEN") or os.environ.get("KRISTINE_ADMIN_TOKEN") or "")
        if not token:
            raise ValueError("KRISTINE_ADMIN_TOKEN fehlt")
        base = str(ns.get("KRISTINE_API_BASE") or "https://protokoll.krista.at").rstrip("/")
        with urllib.request.urlopen(urllib.request.Request(
            base + "/banking/enablebanking/status",
            headers={"X-Admin-Token": token, "Accept": "application/json"}), timeout=30) as response:
            return json.load(response)

    @app.get("/incoming/revolut-personal/status")
    def brain_revolut_personal_status():
        try:
            data = cloud_status()
            transactions = data.get("transactions") or []
            if transactions and not data.get("syncError"):
                importer = app.view_functions.get("brain_reconciliation_import_revolut")
                if importer is None:
                    raise ValueError("Bankabgleich ist nicht geladen")
                dates = [row.get("bookingDate") for row in transactions if row.get("bookingDate")]
                payload = {
                    "channel": "revolut_personal", "account": data.get("iban"),
                    "statementId": "ENABLE-BANKING-" + str(data.get("updatedAt") or date.today().isoformat())[:10],
                    "periodStart": min(dates) if dates else "", "periodEnd": max(dates) if dates else "",
                    "currency": "EUR", "transactions": transactions,
                }
                with app.test_request_context("/incoming/reconciliation/import-revolut", method="POST", json=payload):
                    response = app.make_response(importer())
                    result = response.get_json(silent=True) or {}
                if response.status_code >= 400 or not result.get("ok"):
                    raise ValueError(result.get("error") or "Bankimport fehlgeschlagen")
                data["added"] = result.get("added", 0)
            return jsonify(data)
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 502

    @app.get("/incoming/revolut-personal")
    def brain_revolut_personal_page():
        return ns["revolut_assignment_page"]()
