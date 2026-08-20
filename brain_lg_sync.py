# coding: utf-8
"""Little Greene · Brücke zwischen Dunjas Eingangsrechnung und KRISTINE Farben/Lager.

- Historische LG-Umsätze kommen aus der Eingangsrechnungserfassung / WinWorker.
- Nur wenn Dunja eine neue LG-Rechnung auf „geprüft“ setzt, werden erkannte
  Farb-Lagerpositionen zum aktuellen Lager addiert.
- The Brain bekommt denselben Farben-Einstieg wie die übrigen KRISTA-Arbeitswelten.
"""
from __future__ import annotations

import threading
import time

_INSTALLED = False


def _is_lg(row):
    if not row:
        return False
    text = " ".join(str(row.get(k) or "") for k in (
        "supplierName", "supplierNumber", "ourCustomerNumber", "customerNumberExternal", "name"
    )).lower()
    return "little greene" in text or "far207" in text


def _purchase_payload(row):
    ref = str(row.get("invoiceNumber") or row.get("supplierInvoiceNumber") or "").strip()
    date = str(row.get("invoiceDate") or "")[:10]
    amount = row.get("netAmount")
    if not ref or not date or amount is None:
        return None
    try:
        amount = float(amount)
    except Exception:
        return None
    return {"invoiceRef": ref, "invoiceDate": date, "netAmount": amount}


def _sync_turnover(ns, row):
    payload = _purchase_payload(row)
    if not payload:
        return None
    request = ns.get("kristine_api_request")
    if not callable(request):
        return None
    return request("/admin/api/paint/lg-purchase", method="POST", payload=payload)


def _sync_stock_and_turnover(ns, row):
    request = ns.get("kristine_api_request")
    if not callable(request):
        raise RuntimeError("KRISTINE API nicht verfügbar")
    payload = _purchase_payload(row)
    if not payload:
        raise RuntimeError("LG-Rechnungsnummer, Datum oder Netto fehlt")
    payload["text"] = str(row.get("pdfText") or "")
    payload["sourceInvoiceId"] = row.get("id")
    return request("/admin/api/paint/lg-incoming-sync", method="POST", payload=payload)


def _install_farben_navigation(ns):
    """The Brain hat einen eigenen lokalen Kopf – Farben dort ebenfalls einbauen."""
    app = ns.get("app")
    if app is None:
        return

    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.add("/brain-farben")

    if "brain_farben" not in app.view_functions:
        from flask import redirect
        from urllib.parse import quote

        @app.get("/brain-farben")
        def brain_farben():
            base = str(ns.get("KRISTINE_API_BASE") or "https://protokoll.krista.at").rstrip("/")
            token = str(ns.get("KRISTINE_ADMIN_TOKEN") or "").strip()
            location = base + "/admin/paint"
            if token:
                location += "?token=" + quote(token, safe="")
            return redirect(location, code=302)

    page = str(ns.get("MOBILE_PAGE") or "")
    if not page:
        return

    # Der lokale Brain-Kopf ist bewusst separat vom Render-Topbar gebaut.
    # Deshalb muss FARBEN hier ebenfalls ausdrücklich ergänzt werden.
    if "/brain-farben\">🎨 FARBEN" not in page:
        page = page.replace(
            '<a href="/" class="active" aria-current="page">🧠 THE BRAIN</a><a href="/brain-go/kristine">',
            '<a href="/" class="active" aria-current="page">🧠 THE BRAIN</a><a href="/brain-farben">🎨 FARBEN</a><a href="/brain-go/kristine">',
            1,
        )

    # Zusätzlich als Direkteinstieg neben Projekte / Rechnungen / Material.
    if 'id="modePaint"' not in page:
        page = page.replace(
            '<button id="modeMaterial" class="mode" type="button">🔎 Material</button>',
            '<button id="modeMaterial" class="mode" type="button">🔎 Material</button>\n      <button id="modePaint" class="mode" type="button" onclick="window.location.href=\'/brain-farben\'">🎨 Farben & Lager</button>',
            1,
        )

    ns["MOBILE_PAGE"] = page


def _historical_backfill(ns):
    """Nur Umsatz backfillen – niemals alte Rechnungen auf den aktuellen Lagerstand addieren."""
    time.sleep(2)
    seen = set()
    synced = 0

    # WinWorker-Historie
    address_search = ns.get("ww_address_search")
    ww_incoming = ns.get("ww_incoming_for_address")
    if callable(address_search) and callable(ww_incoming):
        try:
            candidates = address_search("Little Greene", 20) or []
            for address in candidates:
                name = str(address.get("name") or address.get("company") or "")
                if "little greene" not in name.lower():
                    continue
                address_id = address.get("addressId")
                if not address_id:
                    continue
                for row in ww_incoming(address_id) or []:
                    key = str(row.get("wwIncomingId") or row.get("invoiceNumber") or "")
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    result = _sync_turnover(ns, row)
                    if result:
                        synced += 1
        except Exception as exc:
            print("LG GJ WinWorker-Sync:", exc)

    # Bereits erfasste KRISTINE-Rechnungen – ebenfalls nur Umsatz.
    connection_factory = ns.get("_capture_connection")
    public_row = ns.get("_capture_row_public")
    if callable(connection_factory) and callable(public_row):
        try:
            con = connection_factory()
            try:
                rows = con.execute("""
                    SELECT * FROM incoming_invoices
                    WHERE workflow_status='geprueft'
                    ORDER BY invoice_date, id
                """).fetchall()
                for raw in rows:
                    row = public_row(raw, [], include_text=False)
                    if not _is_lg(row):
                        continue
                    result = _sync_turnover(ns, row)
                    if result:
                        synced += 1
            finally:
                con.close()
        except Exception as exc:
            print("LG GJ KRISTINE-Sync:", exc)

    print(f"✅ LG Geschäftsjahre aus Eingangsrechnungen synchronisiert: {synced}")


def install(ns):
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True
    app = ns.get("app")
    if app is None:
        return

    _install_farben_navigation(ns)

    original = app.view_functions.get("incoming_capture_status")
    if original and not getattr(original, "_krista_lg_sync", False):
        def wrapped_status(*args, **kwargs):
            from flask import request
            response = app.make_response(original(*args, **kwargs))
            try:
                body = request.get_json(silent=True) or {}
                if str(body.get("workflowStatus") or "").strip() != "geprueft":
                    return response
                area = str(body.get("area") or request.args.get("area") or "live").strip().lower()
                if area not in {"", "live"}:
                    return response
                if not response.is_json:
                    return response
                payload = response.get_json(silent=True) or {}
                row = payload.get("invoice") or {}
                if not _is_lg(row):
                    return response

                # Für die Lagerpositionen brauchen wir den vollständigen PDF-Text.
                connection_factory = ns.get("_capture_connection")
                public_row = ns.get("_capture_row_public")
                invoice_id = row.get("id")
                if callable(connection_factory) and callable(public_row) and invoice_id:
                    con = connection_factory()
                    try:
                        raw = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (int(invoice_id),)).fetchone()
                        if raw:
                            row = public_row(raw, [], include_text=True)
                    finally:
                        con.close()
                try:
                    payload["lgStockSync"] = _sync_stock_and_turnover(ns, row) or {"ok": False}
                except Exception as exc:
                    payload["lgStockSync"] = {"ok": False, "error": str(exc)}
                    print("LG Lagerzugang wartet auf Klärung:", exc)
                response.set_data(app.json.dumps(payload))
                response.content_type = "application/json"
            except Exception as exc:
                print("LG Rechnungs-Sync:", exc)
            return response

        wrapped_status._krista_lg_sync = True
        app.view_functions["incoming_capture_status"] = wrapped_status

    threading.Thread(target=_historical_backfill, args=(ns,), daemon=True, name="lg-gj-sync").start()
