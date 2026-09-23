# coding: utf-8
"""Read-only Revolut personal overview from the Enable Banking cache on Render."""
import os
import urllib.request
import json
from datetime import date


def install(ns):
    app = ns.get("app")
    if app is None or "brain_revolut_personal_page" in app.view_functions:
        return
    from flask import jsonify, render_template_string
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
            if data.get("syncError"):
                raise ValueError(data["syncError"])
            transactions = data.get("transactions") or []
            if transactions:
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
        return render_template_string('''<!doctype html><html lang="de"><meta charset="utf-8"><title>Revolut Privat · KRISTINE</title>
<style>body{font:16px system-ui;background:#f6f8f7;color:#173c31;max-width:850px;margin:40px auto;padding:20px}section{background:white;border-radius:14px;padding:25px}li{padding:12px;border-bottom:1px solid #ddd}b{float:right}a{color:#185943}</style>
<a href="/">← KRISTINE</a><h1>Revolut Privat</h1><p>Kontostand und gebuchte Bewegungen · automatische Aktualisierung höchstens einmal täglich</p><section><p id="state">Abruf läuft …</p><h2 id="balance"></h2><small id="at"></small><ul id="rows"></ul><a href="https://protokoll.krista.at/banking/enablebanking">Bankfreigabe verwalten</a></section>
<script>async function run(){try{const r=await fetch('/incoming/revolut-personal/status'),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Abruf fehlgeschlagen');document.getElementById('state').textContent=d.connected?'Konto verbunden · '+(d.iban||''):'Noch keine Bankfreigabe';document.getElementById('balance').textContent=(d.balances||[]).map(x=>x.type+': '+x.amount+' '+x.currency).join(' · ');document.getElementById('at').textContent=d.updatedAt?'Stand: '+new Date(d.updatedAt).toLocaleString('de-AT'):'';let ul=document.getElementById('rows');ul.replaceChildren();for(let tx of d.transactions||[]){let li=document.createElement('li'),name=document.createElement('span'),amount=document.createElement('b');name.textContent=tx.bookingDate+' · '+tx.merchant;amount.textContent=tx.amount+' '+tx.currency;li.append(name,amount);ul.append(li)}}catch(e){document.getElementById('state').textContent=e.message}}run()</script></html>''')
