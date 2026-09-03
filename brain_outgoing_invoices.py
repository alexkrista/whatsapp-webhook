# coding: utf-8
"""KRISTINE quick outgoing invoices: routes, UI, PDF and payments."""

from __future__ import annotations

import os
import threading
import hmac
import html
import json
import smtplib
from datetime import date, datetime, timedelta
from email import policy
from email.message import EmailMessage
from pathlib import Path

from brain_outgoing_pdf import render_dunning_pdf, render_invoice_pdf
from brain_outgoing_store import OutgoingStore, TAX_MODES


_INSTALLED = False
_SYNC_THREAD_STARTED = False


def _json_error(jsonify, exc, status=400):
    return jsonify({"ok": False, "error": str(exc)}), status


def install(ns):
    global _INSTALLED, _SYNC_THREAD_STARTED
    app = ns.get("app")
    if app is None or _INSTALLED or getattr(app, "_krista_outgoing", False):
        return

    from flask import jsonify, make_response, request, send_file

    base_db = Path(ns.get("DB") or r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db")
    db_path = Path(os.environ.get("KRISTINE_OUTGOING_DB", str(base_db.parent / "kristine_outgoing_invoices.db")))
    output_root = Path(os.environ.get(
        "KRISTINE_OUTGOING_DIR", r"N:\OneDrive\Dokumente\Kristine\Ausgangsrechnungen"
    ))
    store = OutgoingStore(db_path, output_root)
    app.extensions["kristine_outgoing_store"] = store

    search_projects = ns.get("search_projects")
    search_pdf = ns.get("search_pdf")
    terms_fn = ns.get("_terms")
    sql_connection = ns.get("sql_connection")
    ww_hours_source = ns.get("ww_hours_fusion_source")
    kristine_api_request = ns.get("kristine_api_request")

    def _mail_recipients_for_project(project_number):
        if not callable(kristine_api_request):
            raise RuntimeError("KRISTINE-Stammdaten sind nicht verfügbar.")
        project_number = str(project_number or "").strip()
        if not project_number or not project_number.isdigit() or len(project_number) > 12:
            raise ValueError("Ungültige Baustellennummer.")
        payload = kristine_api_request(f"/admin/api/job/{project_number}/meta") or {}
        meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else payload
        contacts = meta.get("projectContacts") if isinstance(meta, dict) else {}
        contacts = contacts if isinstance(contacts, dict) else {}
        owner = contacts.get("owner") if isinstance(contacts.get("owner"), dict) else {}
        site_manager = contacts.get("siteManager") if isinstance(contacts.get("siteManager"), dict) else {}
        architect = contacts.get("architect") if isinstance(contacts.get("architect"), dict) else {}
        delivery = contacts.get("deliveryRecipients") if isinstance(contacts.get("deliveryRecipients"), dict) else {}
        selected = delivery.get("invoice") if isinstance(delivery.get("invoice"), dict) else {"owner": True}

        def emails(*values):
            result = []
            for value in values:
                address = str(value or "").strip()
                if address and "@" in address and address.lower() not in {x.lower() for x in result}:
                    result.append(address)
            return result

        owner_emails = emails(owner.get("womanEmail"), owner.get("manEmail"), owner.get("email"))
        if not owner_emails and isinstance(meta, dict):
            owner_emails = emails(meta.get("contactEmail"))
        primary = owner_emails if selected.get("owner", True) else []
        copies = []
        if selected.get("siteManager"):
            copies.extend(emails(site_manager.get("email")))
        if selected.get("architect"):
            copies.extend(emails(architect.get("email")))
        copies = emails(*copies)
        if not primary and copies:
            primary, copies = copies[:1], copies[1:]
        return {"to": primary, "cc": copies}

    def ww_open_items():
        if not callable(sql_connection):
            raise RuntimeError("WinWorker-Verbindung ist nicht verfügbar.")
        con = sql_connection()
        try:
            cur = con.cursor()
            cur.execute("""
                SELECT
                    CONVERT(varchar(36), b.gID) AS sourceId,
                    b.sBuchNummer AS invoiceNumber,
                    b.ProjektIndex AS projectIndex,
                    COALESCE(p.sProjektNummer,b.sProjektNummer,'') AS projectNumber,
                    b.KundenIndex AS customerIndex,
                    COALESCE(k.sFirma,'') AS customerCompany,
                    LTRIM(RTRIM(COALESCE(k.sVorname,'') + ' ' + COALESCE(k.sName,''))) AS customerName,
                    COALESCE(b.sKunde,'') AS customerRaw,
                    COALESCE(k.sStrasse,'') AS street,
                    COALESCE(k.sPLZ,'') AS postalCode,
                    COALESCE(k.sOrt,'') AS city,
                    COALESCE(p.sProjekt,b.sProjekt,'') AS projectTitle,
                    r.dzRechnungsdatum AS issueDate,
                    r.ZahlungsZiel AS dueDate,
                    r.dzCalcLeistungserbringungVon AS serviceFrom,
                    r.dzCalcLeistungserbringungBis AS serviceTo,
                    r.bIstAbschlag AS isPartial,
                    r.bIstSchlussrechnung AS isFinal,
                    r.cUmsatzNetto AS originalNet,
                    COALESCE(r.cForderungBrutto,r.cOffenerPostenBrutto) AS originalGross,
                    r.cOffenerPostenBrutto AS openGross,
                    COALESCE(r.Mahnstufe,0) AS dunningLevel,
                    r.LetzteMahnung AS lastDunning,
                    r.dzMahnsperre AS dunningBlockedUntil,
                    COALESCE(calc.fCalcMwStSatz,0) AS vatRate,
                    COALESCE(b.sAutor,'') AS worker
                FROM dbo.[Bücher] b
                INNER JOIN dbo.Rechnung r ON r.gBuchID=b.gID
                LEFT JOIN dbo.Projekte p ON p.ProjektIndex=b.ProjektIndex
                LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden k ON k.StammIndex=b.KundenIndex
                OUTER APPLY (
                    SELECT TOP 1 bk.fCalcMwStSatz
                    FROM dbo.[Bücher Kalkulation] bk
                    WHERE bk.gBuchID=b.gID
                    ORDER BY bk.Backup_BuchIndex DESC
                ) calc
                WHERE b.Buchart=7
                  AND b.ErsterAusdruck>CONVERT(datetime,'18000101',112)
                  AND b.Storno=0
                  AND r.IstRechnungBeglichen=0
                  AND r.cOffenerPostenBrutto>0.005
                ORDER BY r.dzRechnungsdatum,b.sBuchNummer
            """)
            columns = [x[0] for x in cur.description]
            result = []
            for row in cur.fetchall():
                item = dict(zip(columns, row))
                for key in ("issueDate", "dueDate", "serviceFrom", "serviceTo", "lastDunning", "dunningBlockedUntil"):
                    value = item.get(key)
                    item[key] = value.date().isoformat() if hasattr(value, "date") else str(value or "")[:10]
                for key in ("originalNet", "originalGross", "openGross", "vatRate"):
                    item[key] = str(item.get(key) or 0)
                result.append(item)
            return result
        finally:
            con.close()

    def ww_project_history(project_index):
        if not callable(sql_connection):
            raise RuntimeError("WinWorker-Verbindung ist nicht verfügbar.")
        con = sql_connection()
        try:
            cur = con.cursor()
            cur.execute("""
                WITH invoice_history AS (
                    SELECT
                        CONVERT(varchar(36), b.gID) AS sourceId,
                        b.sBuchNummer AS invoiceNumber,
                        b.ProjektIndex AS projectIndex,
                        COALESCE(p.sProjektNummer,b.sProjektNummer,'') AS projectNumber,
                        b.KundenIndex AS customerIndex,
                        COALESCE(k.sFirma,'') AS customerCompany,
                        LTRIM(RTRIM(COALESCE(k.sVorname,'') + ' ' + COALESCE(k.sName,''))) AS customerName,
                        COALESCE(b.sKunde,'') AS customerRaw,
                        COALESCE(k.sStrasse,'') AS street,
                        COALESCE(k.sPLZ,'') AS postalCode,
                        COALESCE(k.sOrt,'') AS city,
                        COALESCE(p.sProjekt,b.sProjekt,'') AS projectTitle,
                        r.dzRechnungsdatum AS issueDate,
                        r.ZahlungsZiel AS dueDate,
                        r.dzCalcLeistungserbringungVon AS serviceFrom,
                        r.dzCalcLeistungserbringungBis AS serviceTo,
                        r.bIstAbschlag AS isPartial,
                        r.bIstSchlussrechnung AS isFinal,
                        r.cUmsatzNetto AS originalNet,
                        COALESCE(r.cForderungBrutto,r.cOffenerPostenBrutto,0) AS originalGross,
                        COALESCE(r.cOffenerPostenBrutto,0) AS openGross,
                        r.cSummeZahlungen AS paidGross,
                        CASE WHEN r.cSummeZahlungen IS NULL THEN 0 ELSE 1 END AS paidGrossAvailable,
                        COALESCE(
                          NULLIF(r.dzBeglichen,CONVERT(datetime,'18000101',112)),
                          NULLIF(r.dzValutaLetzteZahlung,CONVERT(datetime,'18000101',112)),
                          NULLIF(r.dzValutaErsteZahlung,CONVERT(datetime,'18000101',112))
                        ) AS paymentDate,
                        COALESCE(r.Mahnstufe,0) AS dunningLevel,
                        r.LetzteMahnung AS lastDunning,
                        r.dzMahnsperre AS dunningBlockedUntil,
                        COALESCE(calc.fCalcMwStSatz,0) AS vatRate,
                        COALESCE(b.sAutor,'') AS worker,
                        ROW_NUMBER() OVER (
                          PARTITION BY b.sBuchNummer
                          ORDER BY COALESCE(b.Geändert,b.dzInhaltGeaendert,b.dzDocDatum,b.Aufgenommen) DESC,b.gID DESC
                        ) AS rowNo
                    FROM dbo.[Bücher] b
                    INNER JOIN dbo.Rechnung r ON r.gBuchID=b.gID
                    LEFT JOIN dbo.Projekte p ON p.ProjektIndex=b.ProjektIndex
                    LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden k ON k.StammIndex=b.KundenIndex
                    OUTER APPLY (
                        SELECT TOP 1 bk.fCalcMwStSatz
                        FROM dbo.[Bücher Kalkulation] bk
                        WHERE bk.gBuchID=b.gID
                        ORDER BY bk.Backup_BuchIndex DESC
                    ) calc
                    WHERE b.Buchart=7
                      AND b.ProjektIndex=?
                      AND b.ErsterAusdruck>CONVERT(datetime,'18000101',112)
                      AND b.Storno=0
                      AND r.cUmsatzNetto IS NOT NULL
                )
                SELECT * FROM invoice_history WHERE rowNo=1
                ORDER BY issueDate,invoiceNumber
            """, int(project_index))
            columns = [x[0] for x in cur.description]
            result = []
            for row in cur.fetchall():
                item = dict(zip(columns, row))
                item.pop("rowNo", None)
                for key in (
                    "issueDate", "dueDate", "serviceFrom", "serviceTo", "paymentDate",
                    "lastDunning", "dunningBlockedUntil",
                ):
                    value = item.get(key)
                    item[key] = value.date().isoformat() if hasattr(value, "date") else str(value or "")[:10]
                for key in ("originalNet", "originalGross", "openGross", "paidGross", "vatRate"):
                    item[key] = str(item.get(key) or 0)
                result.append(item)
            return result
        finally:
            con.close()

    def ww_invoice_numbers(issue_date):
        """Read the shared monthly number range directly from WinWorker."""
        if not callable(sql_connection):
            if app.testing:
                return []
            raise RuntimeError("WinWorker-Verbindung ist für den Rechnungsnummern-Abgleich nicht verfügbar.")
        prefix = date.fromisoformat(str(issue_date)[:10]).strftime("%Y%m")
        con = sql_connection()
        try:
            cur = con.cursor()
            cur.execute("""
                SELECT DISTINCT LTRIM(RTRIM(COALESCE(b.sBuchNummer,'')))
                FROM dbo.[Bücher] b
                WHERE b.Buchart=7
                  AND b.Storno=0
                  AND b.ErsterAusdruck>CONVERT(datetime,'18000101',112)
                  AND b.sBuchNummer LIKE ?
            """, prefix + "%")
            return [str(row[0] or "").strip() for row in cur.fetchall() if str(row[0] or "").strip()]
        finally:
            con.close()

    def sync_from_ww():
        return store.sync_ww_open_items(ww_open_items())

    def sync_is_due(minutes=5):
        last = store.last_ww_sync().get("at")
        if not last:
            return True
        try:
            return datetime.now() - datetime.fromisoformat(last) >= timedelta(minutes=minutes)
        except ValueError:
            return True

    @app.get("/outgoing/invoices")
    def outgoing_page():
        return OUTGOING_PAGE

    @app.get("/outgoing/open-items")
    def outgoing_open_items_page():
        return DEBTOR_OP_PAGE

    @app.get("/api/outgoing/open-items")
    def outgoing_open_items_get():
        try:
            synced = None
            if request.args.get("sync") == "1" and callable(sql_connection) and sync_is_due():
                synced = sync_from_ww()
            items = store.debtor_open_items(request.args.get("asOf"))
            total = round(sum(float(x["openGross"]) for x in items), 2)
            overdue = round(sum(float(x["openGross"]) for x in items if x["isOverdue"]), 2)
            return jsonify({
                "ok": True, "items": items, "totalOpen": total, "totalOverdue": overdue,
                "customerCount": len({x["customerKey"] for x in items}), "lastWwSync": store.last_ww_sync(),
                "sync": synced,
            })
        except Exception as exc:
            return _json_error(jsonify, exc, 500)

    @app.get("/api/outgoing/project-search")
    def outgoing_project_search():
        try:
            query = str(request.args.get("q") or "").strip()
            if len(query) < 2:
                return jsonify({"ok": True, "projects": []})
            if not callable(search_projects):
                raise RuntimeError("WinWorker-Projektsuche ist nicht verfügbar.")
            terms = terms_fn(query) if callable(terms_fn) else [x for x in query.split() if x]
            return jsonify({"ok": True, "projects": search_projects(terms, include_metrics=False, limit=40)})
        except Exception as exc:
            return _json_error(jsonify, exc, 500)

    @app.get("/api/outgoing/settings")
    def outgoing_settings_get():
        tax_modes = {
            key: {**value, "rate": float(value["rate"])}
            for key, value in TAX_MODES.items()
        }
        return jsonify({"ok": True, "settings": store.settings(), "taxModes": tax_modes})

    @app.put("/api/outgoing/settings")
    def outgoing_settings_put():
        try:
            return jsonify({"ok": True, "settings": store.update_settings(request.get_json(silent=True) or {})})
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.post("/api/outgoing/sync-ww")
    def outgoing_sync_ww():
        try:
            result = sync_from_ww()
            return jsonify({"ok": True, **result})
        except Exception as exc:
            return _json_error(jsonify, exc, 500)

    @app.post("/api/outgoing/projects/<int:project_index>/sync-history")
    def outgoing_project_history_sync(project_index):
        try:
            result = store.sync_ww_project_history(ww_project_history(project_index))
            return jsonify({"ok": True, **result})
        except Exception as exc:
            return _json_error(jsonify, exc, 500)

    def project_billing_summary(project):
        project_index = int(project.get("projectIndex") or 0)
        run_details = [store.run(row["id"]) for row in store.runs(project_index)]
        invoices = []
        payments = []
        run_summaries = []
        for run in run_details:
            run_payments = []
            for payment in run.get("payments") or []:
                row = {
                    "id": int(payment.get("id") or 0),
                    "invoiceId": int(payment["invoiceId"]) if payment.get("invoiceId") is not None else None,
                    "paymentDate": str(payment.get("paymentDate") or "")[:10],
                    "net": round(float(payment.get("net") or 0), 2),
                    "vat": round(float(payment.get("vat") or 0), 2),
                    "gross": round(float(payment.get("gross") or 0), 2),
                    "source": "WW" if str(payment.get("source") or "").upper() == "WW" else "KRISTINE",
                }
                run_payments.append(row)
                payments.append(row)
            paid_by_invoice = {}
            for payment in run_payments:
                invoice_id = payment.get("invoiceId")
                if invoice_id is not None:
                    paid_by_invoice[invoice_id] = round(
                        paid_by_invoice.get(invoice_id, 0) + payment["gross"], 2
                    )
            run_invoices = []
            for invoice in run.get("invoices") or []:
                if str(invoice.get("status") or "") != "issued":
                    continue
                invoice_id = int(invoice.get("id") or 0)
                gross = round(float(invoice.get("increment_gross") or 0), 2)
                paid_gross = round(paid_by_invoice.get(invoice_id, 0), 2)
                kind = str(invoice.get("kind") or "RE").upper()
                if kind not in {"TR", "SR", "RE", "GS", "ST"}:
                    kind = "RE"
                row = {
                    "id": invoice_id,
                    "runId": int(run.get("id") or 0),
                    "invoiceNumber": str(invoice.get("invoice_number") or ""),
                    "kind": kind,
                    "issueDate": str(invoice.get("issue_date") or "")[:10],
                    "dueDate": str(invoice.get("due_date") or "")[:10],
                    "net": round(float(invoice.get("increment_net") or 0), 2),
                    "vat": round(float(invoice.get("increment_vat") or 0), 2),
                    "gross": gross,
                    "paidGross": paid_gross,
                    "openGross": round(max(0, gross - paid_gross), 2),
                    "source": "WW" if str(invoice.get("source") or "").upper() == "WW" else "KRISTINE",
                }
                run_invoices.append(row)
                invoices.append(row)
            run_summaries.append({
                "id": int(run.get("id") or 0),
                "label": str(run.get("label") or "Rechnungslauf"),
                "status": "closed" if str(run.get("status") or "") == "closed" else "open",
                "billedNet": round(sum(row["net"] for row in run_invoices), 2),
                "billedGross": round(sum(row["gross"] for row in run_invoices), 2),
                "paidGross": round(sum(row["gross"] for row in run_payments), 2),
                "openGross": round(max(0, float(run.get("currentOpen") or 0)), 2),
            })
        invoices.sort(key=lambda row: (row["issueDate"], row["id"]))
        payments.sort(key=lambda row: (row["paymentDate"], row["id"]))
        return {
            "found": True,
            "projectNumber": str(project.get("projectNumber") or ""),
            "projectIndex": project_index,
            "summary": {
                "invoiceCount": len(invoices),
                "billedNet": round(sum(row["net"] for row in invoices), 2),
                "billedGross": round(sum(row["gross"] for row in invoices), 2),
                "paidGross": round(sum(row["gross"] for row in payments), 2),
                "openGross": round(sum(row["openGross"] for row in run_summaries), 2),
            },
            "invoices": invoices,
            "payments": payments,
            "runs": run_summaries,
        }

    def billing_response(payload, status=200):
        response = make_response(jsonify(payload), status)
        origin = str(request.headers.get("Origin") or "")
        if origin == "https://protokoll.krista.at":
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "X-Krista-Token, Content-Type"
            response.headers["Access-Control-Allow-Private-Network"] = "true"
            response.headers["Access-Control-Max-Age"] = "600"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/api/outgoing/project-billing", methods=["POST", "OPTIONS"])
    def outgoing_project_billing():
        if request.method == "OPTIONS":
            return billing_response({}, 204)
        try:
            origin = str(request.headers.get("Origin") or "")
            if origin:
                if origin != "https://protokoll.krista.at":
                    return billing_response({"ok": False, "error": "Herkunft nicht freigegeben."}, 403)
                expected = str(os.environ.get("KRISTINE_ADMIN_TOKEN") or "")
                supplied = str(request.headers.get("X-Krista-Token") or "")
                if not expected:
                    return billing_response({"ok": False, "error": "Brain-Verbindung ist nicht freigegeben."}, 503)
                if not hmac.compare_digest(supplied, expected):
                    return billing_response({"ok": False, "error": "Brain-Verbindung nicht autorisiert."}, 403)
            data = request.get_json(silent=True) or {}
            project_number = str(data.get("projectNumber") or "").strip()
            if not project_number or not project_number.isdigit() or len(project_number) > 12:
                return billing_response({"ok": False, "error": "Ungültige Baustellennummer."}, 400)
            if not callable(search_projects):
                raise RuntimeError("WinWorker-Projektsuche ist nicht verfügbar.")
            terms = terms_fn(project_number) if callable(terms_fn) else [project_number]
            matches = [
                row for row in search_projects(terms, include_metrics=False, limit=20)
                if str(row.get("projectNumber") or "").strip() == project_number
            ]
            if not matches:
                return billing_response({"ok": True, "billing": {
                    "found": False, "projectNumber": project_number, "projectIndex": 0,
                    "summary": {"invoiceCount": 0, "billedNet": 0, "billedGross": 0, "paidGross": 0, "openGross": 0},
                    "invoices": [], "payments": [], "runs": [],
                }})
            if len(matches) > 1:
                return billing_response({"ok": False, "error": "Baustellennummer ist in WinWorker nicht eindeutig."}, 409)
            project = matches[0]
            if callable(sql_connection):
                store.sync_ww_project_history(ww_project_history(int(project.get("projectIndex") or 0)))
            return billing_response({"ok": True, "billing": project_billing_summary(project)})
        except Exception as exc:
            return billing_response({"ok": False, "error": str(exc)}, 500)

    @app.route("/api/outgoing/project-hours", methods=["POST", "OPTIONS"])
    def outgoing_project_hours():
        if request.method == "OPTIONS":
            return billing_response({}, 204)
        try:
            origin = str(request.headers.get("Origin") or "")
            if origin:
                if origin != "https://protokoll.krista.at":
                    return billing_response({"ok": False, "error": "Herkunft nicht freigegeben."}, 403)
                expected = str(os.environ.get("KRISTINE_ADMIN_TOKEN") or "")
                supplied = str(request.headers.get("X-Krista-Token") or "")
                if not expected:
                    return billing_response({"ok": False, "error": "Brain-Verbindung ist nicht freigegeben."}, 503)
                if not hmac.compare_digest(supplied, expected):
                    return billing_response({"ok": False, "error": "Brain-Verbindung nicht autorisiert."}, 403)
            data = request.get_json(silent=True) or {}
            project_number = str(data.get("projectNumber") or "").strip()
            if not project_number or not project_number.isdigit() or len(project_number) > 12:
                return billing_response({"ok": False, "error": "Ungültige Baustellennummer."}, 400)
            if not callable(search_projects) or not callable(ww_hours_source):
                raise RuntimeError("WinWorker-Stundenquelle ist nicht verfügbar.")
            terms = terms_fn(project_number) if callable(terms_fn) else [project_number]
            matches = [
                row for row in search_projects(terms, include_metrics=False, limit=20)
                if str(row.get("projectNumber") or "").strip() == project_number
            ]
            if not matches:
                return billing_response({"ok": True, "hours": {
                    "found": False, "projectNumber": project_number, "projectIndex": 0,
                    "totalHours": 0, "days": [], "rows": [],
                }})
            if len(matches) > 1:
                return billing_response({"ok": False, "error": "Baustellennummer ist in WinWorker nicht eindeutig."}, 409)
            project = matches[0]
            project_index = int(project.get("projectIndex") or 0)
            by_day = {}
            detail_rows = []
            for row in ww_hours_source([project_index]):
                day = str(row.get("date") or "")[:10]
                if day:
                    net_hours = float(row.get("netHours") or 0)
                    by_day[day] = by_day.get(day, 0) + net_hours
                    detail_rows.append({
                        "date": day,
                        "maIndex": int(row.get("maIndex")) if row.get("maIndex") is not None else None,
                        "finkNumber": str(row.get("finkNumber") or "").strip()[:40],
                        "employeeName": str(row.get("employeeName") or "").strip()[:160],
                        "hours": round(net_hours, 4),
                    })
            days = [{"date": day, "hours": round(hours, 4)} for day, hours in sorted(by_day.items())]
            detail_rows.sort(key=lambda row: (row["date"], row["employeeName"], row["maIndex"] or 0))
            return billing_response({"ok": True, "hours": {
                "found": True,
                "projectNumber": project_number,
                "projectIndex": project_index,
                "totalHours": round(sum(row["hours"] for row in days), 4),
                "days": days,
                "rows": detail_rows,
            }})
        except Exception as exc:
            return billing_response({"ok": False, "error": str(exc)}, 500)

    @app.get("/api/outgoing/runs")
    def outgoing_runs_get():
        try:
            return jsonify({"ok": True, "runs": store.runs(request.args.get("projectIndex"))})
        except Exception as exc:
            return _json_error(jsonify, exc, 500)

    @app.post("/api/outgoing/runs")
    def outgoing_runs_post():
        try:
            return jsonify({"ok": True, "run": store.create_run(request.get_json(silent=True) or {})})
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.get("/api/outgoing/runs/<int:run_id>")
    def outgoing_run_get(run_id):
        try:
            return jsonify({"ok": True, "run": store.run(run_id)})
        except Exception as exc:
            return _json_error(jsonify, exc, 404)

    @app.get("/api/outgoing/project-mail-recipients")
    def outgoing_project_mail_recipients():
        try:
            recipients = _mail_recipients_for_project(request.args.get("projectNumber"))
            return jsonify({"ok": True, **recipients})
        except Exception as exc:
            return _json_error(jsonify, exc, 404)

    @app.post("/api/outgoing/invoices")
    def outgoing_invoice_post():
        try:
            return jsonify({"ok": True, "invoice": store.save_draft(request.get_json(silent=True) or {})})
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.put("/api/outgoing/invoices/<int:invoice_id>")
    def outgoing_invoice_put(invoice_id):
        try:
            return jsonify({"ok": True, "invoice": store.save_draft(request.get_json(silent=True) or {}, invoice_id)})
        except Exception as exc:
            return _json_error(jsonify, exc)

    def pdf_path_for(invoice):
        issue = date.fromisoformat(str(invoice.get("issue_date"))[:10])
        folder = output_root / issue.strftime("%Y") / issue.strftime("%m")
        revision = int(invoice.get("revisionNo") or 0)
        suffix = f"_V{revision + 1}" if revision else ""
        name = f"{invoice.get('invoice_number')}_{invoice.get('kind')}{suffix}.pdf"
        return folder / name

    def enrich_correction(invoice):
        original_id = invoice.get("corrects_invoice_id")
        if not original_id:
            return invoice
        original = store.invoice(original_id)
        invoice["correctedInvoice"] = {
            "invoiceNumber": original.get("invoice_number"), "issueDate": original.get("issue_date")
        }
        return invoice

    @app.post("/api/outgoing/invoices/<int:invoice_id>/issue")
    def outgoing_invoice_issue(invoice_id):
        try:
            draft = store.invoice(invoice_id, live=True)
            existing_ww_numbers = ww_invoice_numbers(draft.get("issue_date"))
            invoice = enrich_correction(store.prepare_issue(invoice_id, existing_ww_numbers))
            destination = pdf_path_for(invoice)
            if not destination.exists() or not invoice.get("pdf_sha256"):
                render_invoice_pdf(invoice, store.settings(), destination)
                invoice = store.attach_pdf(invoice_id, destination)
            return jsonify({"ok": True, "invoice": invoice, "pdfUrl": f"/api/outgoing/invoices/{invoice_id}/pdf"})
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.get("/api/outgoing/invoices/<int:invoice_id>/number-preview")
    def outgoing_invoice_number_preview(invoice_id):
        try:
            draft = store.invoice(invoice_id, live=True)
            existing_ww_numbers = ww_invoice_numbers(draft.get("issue_date"))
            return jsonify({
                "ok": True,
                "invoiceNumber": store.next_number_preview(draft.get("issue_date"), existing_ww_numbers),
            })
        except Exception as exc:
            return _json_error(jsonify, exc, 500)

    @app.post("/api/outgoing/invoices/<int:invoice_id>/revision")
    def outgoing_invoice_revision(invoice_id):
        try:
            return jsonify({"ok": True, "invoice": store.begin_revision(invoice_id)})
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.get("/api/outgoing/invoices/<int:invoice_id>/preview.pdf")
    def outgoing_invoice_preview(invoice_id):
        try:
            invoice = enrich_correction(store.invoice(invoice_id, live=True))
            preview_root = output_root / "_Entwuerfe"
            destination = preview_root / f"Entwurf_{invoice_id}.pdf"
            render_invoice_pdf(invoice, store.settings(), destination)
            return send_file(destination, mimetype="application/pdf", as_attachment=False, download_name=destination.name)
        except Exception as exc:
            return _json_error(jsonify, exc)

    def source_pdf_path(invoice):
        own_path = Path(str(invoice.get("pdf_path") or ""))
        if own_path.is_file() and own_path.suffix.lower() == ".pdf":
            return own_path
        if str(invoice.get("source") or "").upper() != "WW" or not callable(search_pdf):
            raise ValueError("Rechnungs-PDF fehlt.")
        invoice_number = str(invoice.get("invoice_number") or "").strip()
        if not invoice_number:
            raise ValueError("Rechnungsnummer fehlt.")
        for candidate in search_pdf([invoice_number]):
            path = Path(str(candidate.get("path") or ""))
            if path.is_file() and path.suffix.lower() == ".pdf":
                return path
        raise ValueError("Original-PDF der WinWorker-Rechnung wurde nicht gefunden.")

    @app.get("/api/outgoing/invoices/<int:invoice_id>/preview.png")
    def outgoing_invoice_preview_image(invoice_id):
        try:
            import pymupdf

            invoice = enrich_correction(store.invoice(invoice_id, live=True))
            if str(invoice.get("status") or "") == "draft":
                preview_root = output_root / "_Entwuerfe"
                pdf_path = preview_root / f"Entwurf_{invoice_id}.pdf"
                render_invoice_pdf(invoice, store.settings(), pdf_path)
            else:
                pdf_path = source_pdf_path(invoice)
            with pymupdf.open(pdf_path) as document:
                if document.page_count < 1:
                    raise ValueError("Die Rechnungs-PDF enthält keine Seite.")
                pixmap = document[0].get_pixmap(matrix=pymupdf.Matrix(1.8, 1.8), alpha=False)
                payload = pixmap.tobytes("png")
            response = make_response(payload)
            response.headers["Content-Type"] = "image/png"
            response.headers["Content-Disposition"] = f"inline; filename=Vorschau_{invoice_id}.png"
            return response
        except Exception as exc:
            return _json_error(jsonify, exc, 404)

    @app.get("/api/outgoing/invoices/<int:invoice_id>/pdf")
    def outgoing_invoice_pdf(invoice_id):
        try:
            invoice = store.invoice(invoice_id)
            path = Path(str(invoice.get("pdf_path") or ""))
            if not path.is_file():
                raise ValueError("Rechnungs-PDF fehlt.")
            return send_file(path, mimetype="application/pdf", as_attachment=False, download_name=path.name)
        except Exception as exc:
            return _json_error(jsonify, exc, 404)

    @app.get("/api/outgoing/invoices/<int:invoice_id>/source-pdf")
    def outgoing_invoice_source_pdf(invoice_id):
        try:
            invoice = store.invoice(invoice_id)
            path = source_pdf_path(invoice)
            return send_file(path, mimetype="application/pdf", as_attachment=False, download_name=path.name)
        except Exception as exc:
            return _json_error(jsonify, exc, 404)

    @app.post("/api/outgoing/invoices/<int:invoice_id>/send-email")
    def outgoing_invoice_send_email(invoice_id):
        try:
            invoice = store.invoice(invoice_id)
            if str(invoice.get("status") or "") != "issued":
                raise ValueError("Nur ausgestellte Rechnungen können versendet werden.")
            data = request.get_json(silent=True) or {}
            recipients = [x.strip() for x in str(data.get("to") or "").replace(";", ",").split(",") if x.strip()]
            cc = [x.strip() for x in str(data.get("cc") or "").replace(";", ",").split(",") if x.strip()]
            if not recipients or any("@" not in x for x in recipients + cc):
                raise ValueError("Bitte gültige E-Mail-Adressen eingeben.")
            host, user, password = (str(os.environ.get(k) or "").strip() for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS"))
            port = int(os.environ.get("SMTP_PORT") or 587)
            sender = str(os.environ.get("MAIL_FROM") or user).strip()
            if not host or not user or not password or not sender:
                raise ValueError("Der E-Mail-Versand ist noch nicht vollständig eingerichtet.")
            pdf_path = source_pdf_path(invoice)
            number = str(invoice.get("invoice_number") or invoice_id)
            subject = str(data.get("subject") or f"Rechnung {number}").strip()
            body = str(data.get("message") or "Anbei erhalten Sie unsere Rechnung.\n\nVielen Dank für die gute Zusammenarbeit.").strip()
            signature = """<p>Mit farbenfrohen Grüßen aus Frastanz</p><p><strong style=\"font-size:18px\">MMSt. Ing. Alexander Krista</strong><br>Maler- &amp; Baumeister<br>Geschäftsleitung<br>M +43 664 3203577</p><p><strong>Farben Krista GmbH &amp; Co KG</strong><br>Feldkircherstr. 45, 6820 Frastanz<br>T +43 (0)5522 53940, <a href=\"https://www.krista.at\">www.krista.at</a></p><p><img src=\"cid:krista-logo\" width=\"260\" alt=\"Farben Krista\"></p>"""
            mail = EmailMessage()
            mail["From"], mail["To"], mail["Subject"] = sender, ", ".join(recipients), subject
            if cc:
                mail["Cc"] = ", ".join(cc)
            mail.set_content(body + "\n\nMit farbenfrohen Grüßen aus Frastanz\n\nMMSt. Ing. Alexander Krista\nMaler- & Baumeister | Geschäftsleitung\nM +43 664 3203577\n\nFarben Krista GmbH & Co KG\nFeldkircherstr. 45, 6820 Frastanz\nT +43 (0)5522 53940 | www.krista.at")
            mail.add_alternative("<div style=\"font:15px/1.5 Arial,sans-serif;color:#222\">" + body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>") + "<br><br>" + signature + "</div>", subtype="html")
            logo_path = Path(__file__).resolve().parent / "assets" / "krista_invoice_logo.png"
            if logo_path.is_file():
                mail.get_payload()[-1].add_related(logo_path.read_bytes(), maintype="image", subtype="png", cid="<krista-logo>", filename="krista-logo.png")
            mail.add_attachment(pdf_path.read_bytes(), maintype="application", subtype="pdf", filename=pdf_path.name)
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                smtp.starttls()
                smtp.login(user, password)
                smtp.send_message(mail)
            log_dir = output_root / "_Versand"
            log_dir.mkdir(parents=True, exist_ok=True)
            with (log_dir / "rechnungsversand.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps({"sentAt": datetime.now().isoformat(timespec="seconds"), "invoiceId": invoice_id, "invoiceNumber": number, "to": recipients, "cc": cc, "subject": subject}, ensure_ascii=False) + "\n")
            return jsonify({"ok": True, "sent": True, "invoiceNumber": number, "to": recipients, "cc": cc})
        except Exception as exc:
            return _json_error(jsonify, exc, 500)

    @app.post("/api/outgoing/invoices/<int:invoice_id>/open-outlook")
    def outgoing_invoice_open_outlook(invoice_id):
        try:
            invoice = store.invoice(invoice_id)
            if str(invoice.get("status") or "") != "issued":
                raise ValueError("Nur ausgestellte Rechnungen können in Outlook geöffnet werden.")
            data = request.get_json(silent=True) or {}
            recipients = [x.strip() for x in str(data.get("to") or "").replace(";", ",").split(",") if x.strip()]
            cc = [x.strip() for x in str(data.get("cc") or "").replace(";", ",").split(",") if x.strip()]
            if not recipients or any("@" not in x for x in recipients + cc):
                raise ValueError("Bitte gültige E-Mail-Adressen eingeben.")
            pdf_path = source_pdf_path(invoice)
            number = str(invoice.get("invoice_number") or invoice_id)
            subject = str(data.get("subject") or f"Rechnung {number}").strip()
            message = str(data.get("message") or "Guten Tag,\n\nim Anhang erhalten Sie unsere Rechnung.").strip()
            signature_text = "Mit farbenfrohen Grüßen aus Frastanz\n\nMMSt. Ing. Alexander Krista\nMaler- & Baumeister | Geschäftsleitung\nM +43 664 3203577\n\nFarben Krista GmbH & Co KG\nFeldkircherstr. 45, 6820 Frastanz\nT +43 (0)5522 53940 | www.krista.at"
            signature_html = "<p>Mit farbenfrohen Grüßen aus Frastanz</p><p><strong style='font-size:18px'>MMSt. Ing. Alexander Krista</strong><br>Maler- &amp; Baumeister<br>Geschäftsleitung<br>M +43 664 3203577</p><p><strong>Farben Krista GmbH &amp; Co KG</strong><br>Feldkircherstr. 45, 6820 Frastanz<br>T +43 (0)5522 53940 · <a href='https://www.krista.at'>www.krista.at</a></p><p><img src='cid:krista-logo' width='260' alt='Farben Krista'></p>"
            draft = EmailMessage(policy=policy.SMTP)
            draft["X-Unsent"] = "1"
            draft["To"] = ", ".join(recipients)
            if cc:
                draft["Cc"] = ", ".join(cc)
            draft["Subject"] = subject
            draft.set_content(message + "\n\n" + signature_text, charset="utf-8")
            draft.add_alternative("<div style='font:15px/1.5 Calibri,Arial,sans-serif;color:#222'>" + html.escape(message).replace("\n", "<br>") + "<br><br>" + signature_html + "</div>", subtype="html", charset="utf-8")
            logo_path = Path(__file__).resolve().parent / "assets" / "krista_invoice_logo.png"
            if logo_path.is_file():
                draft.get_payload()[-1].add_related(logo_path.read_bytes(), maintype="image", subtype="png", cid="<krista-logo>", filename="krista-logo.png")
            draft.add_attachment(pdf_path.read_bytes(), maintype="application", subtype="pdf", filename=pdf_path.name)
            draft_dir = output_root / "_Outlook-Entwuerfe"
            draft_dir.mkdir(parents=True, exist_ok=True)
            draft_path = draft_dir / f"Rechnung_{number}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.eml"
            draft_path.write_bytes(draft.as_bytes(policy=policy.SMTP))
            return jsonify({
                "ok": True,
                "opened": False,
                "invoiceNumber": number,
                "downloadUrl": f"/api/outgoing/outlook-drafts/{draft_path.name}",
            })
        except Exception as exc:
            return _json_error(jsonify, exc, 500)

    @app.get("/api/outgoing/outlook-drafts/<path:name>")
    def outgoing_outlook_draft_download(name):
        try:
            safe_name = Path(str(name or "")).name
            if safe_name != name or not safe_name.lower().endswith(".eml"):
                raise ValueError("Ungültiger Outlook-Entwurf.")
            path = output_root / "_Outlook-Entwuerfe" / safe_name
            if not path.is_file():
                raise ValueError("Outlook-Entwurf wurde nicht gefunden.")
            return send_file(path, mimetype="message/rfc822", as_attachment=True, download_name=safe_name)
        except Exception as exc:
            return _json_error(jsonify, exc, 404)

    @app.put("/api/outgoing/invoices/<int:invoice_id>/debtor-meta")
    def outgoing_debtor_meta_put(invoice_id):
        try:
            item = store.update_debtor_meta(invoice_id, request.get_json(silent=True) or {})
            return jsonify({"ok": True, "item": item})
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.post("/api/outgoing/invoices/<int:invoice_id>/dunnings")
    def outgoing_dunning_post(invoice_id):
        try:
            payload = request.get_json(silent=True) or {}
            dunning = store.prepare_dunning(invoice_id, payload.get("dunningDate"))
            snapshot = dunning.get("snapshot") or {}
            item = snapshot.get("openItem") or {}
            stamp = date.fromisoformat(str(dunning.get("dunning_date"))[:10])
            folder = output_root / "Mahnungen" / stamp.strftime("%Y") / stamp.strftime("%m")
            number = str(item.get("invoiceNumber") or invoice_id).replace("/", "-").replace("\\", "-")
            destination = folder / f"{number}_Mahnung_{int(dunning['level'])}.pdf"
            if dunning.get("status") != "issued" or not destination.is_file():
                render_dunning_pdf(dunning, store.settings(), destination)
                dunning = store.attach_dunning_pdf(dunning["id"], destination)
            return jsonify({
                "ok": True, "dunning": dunning,
                "pdfUrl": f"/api/outgoing/dunnings/{int(dunning['id'])}/pdf",
            })
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.get("/api/outgoing/dunnings/<int:dunning_id>/pdf")
    def outgoing_dunning_pdf(dunning_id):
        try:
            dunning = store.dunning(dunning_id)
            path = Path(str(dunning.get("pdf_path") or ""))
            if not path.is_file():
                raise ValueError("Mahnungs-PDF fehlt.")
            return send_file(path, mimetype="application/pdf", as_attachment=False, download_name=path.name)
        except Exception as exc:
            return _json_error(jsonify, exc, 404)

    @app.post("/api/outgoing/runs/<int:run_id>/payments")
    def outgoing_payment_post(run_id):
        try:
            return jsonify({"ok": True, "payment": store.add_payment(run_id, request.get_json(silent=True) or {}), "run": store.run(run_id)})
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.post("/api/outgoing/payments/<int:payment_id>/reverse")
    def outgoing_payment_reverse(payment_id):
        try:
            return jsonify({"ok": True, "payment": store.reverse_payment(payment_id)})
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.post("/api/outgoing/invoices/<int:invoice_id>/corrections")
    def outgoing_correction_post(invoice_id):
        try:
            return jsonify({"ok": True, "invoice": store.create_correction_draft(invoice_id, request.get_json(silent=True) or {})})
        except Exception as exc:
            return _json_error(jsonify, exc)

    @app.get("/api/outgoing/periods")
    def outgoing_periods_get():
        return jsonify({"ok": True, "periods": store.periods()})

    @app.post("/api/outgoing/periods/close")
    def outgoing_period_close():
        try:
            data = request.get_json(silent=True) or {}
            return jsonify({"ok": True, **store.close_period(data.get("period"), data.get("closedBy"))})
        except Exception as exc:
            return _json_error(jsonify, exc)

    if callable(sql_connection) and not _SYNC_THREAD_STARTED:
        _SYNC_THREAD_STARTED = True

        def nightly_ww_sync():
            while True:
                now = datetime.now()
                target = now.replace(hour=2, minute=15, second=0, microsecond=0)
                if target <= now:
                    target += timedelta(days=1)
                threading.Event().wait(max(60, (target - now).total_seconds()))
                try:
                    result = sync_from_ww()
                    print(f"KRISTINE WW debtor sync: {result['imported']} new | {result['skipped']} existing")
                except Exception as exc:
                    print(f"KRISTINE WW debtor sync failed: {exc}")

        threading.Thread(target=nightly_ww_sync, name="kristine-ww-debtor-sync", daemon=True).start()

    app._krista_outgoing = True
    _INSTALLED = True
    print("KRISTINE outgoing invoices + debtor open items: WW sync 02:15 | TR/SR | payments | corrections")


OUTGOING_PAGE = r'''<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KRISTINE · Ausgangsrechnungen</title>
<style>
:root{--bg:#0b0e12;--card:#12171d;--card2:#171e26;--line:#2a3440;--text:#eef3f7;--muted:#9aabb9;--blue:#70a8ff;--green:#7bd99b;--red:#ff8c8c;--amber:#f5ca68}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}.top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 18px;background:#0d1217ee;border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}.top h1{font-size:18px;margin:0}.top a{color:var(--text);text-decoration:none}.layout{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:14px;padding:14px;max-width:1600px;margin:auto}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}.side{position:sticky;top:70px;align-self:start;max-height:calc(100vh - 84px);overflow:auto}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1}.grid{display:grid;grid-template-columns:repeat(2,minmax(180px,1fr));gap:10px}.grid3{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:10px}label{display:grid;gap:4px;color:var(--muted);font-size:12px}input,select,textarea{width:100%;border:1px solid var(--line);border-radius:9px;background:#0e1318;color:var(--text);padding:9px 10px;min-height:40px}textarea{min-height:70px;resize:vertical}button{border:1px solid var(--line);border-radius:9px;background:#202a34;color:var(--text);padding:9px 12px;min-height:40px;font-weight:700}button.primary{background:#276bd2;border-color:#397ee9}button.good{background:#17643d;border-color:#248656}button.danger{background:#63252a;border-color:#8b383e}button.ghost{background:transparent}.muted{color:var(--muted)}.small{font-size:12px}.money{font-variant-numeric:tabular-nums;text-align:right}.run,.project,.invoice,.payment{border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:8px;background:var(--card2)}.run.active,.project.active{border-color:var(--blue)}.head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.pill{display:inline-block;padding:2px 7px;border-radius:999px;background:#26323e;color:#cbd8e3;font-size:11px}.pill.open{background:#173c29;color:#8de6ac}.pill.closed{background:#3e2d18;color:#f5ce87}.summary{display:grid;grid-template-columns:repeat(4,minmax(110px,1fr));gap:8px;margin:10px 0}.summary>div{padding:10px;background:#0e1318;border:1px solid var(--line);border-radius:9px}.summary strong{display:block;font-size:17px}.section{margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}.section h2,.section h3{margin:0 0 10px}.lines{width:100%;border-collapse:collapse}.lines th,.lines td{padding:5px;vertical-align:top}.lines th{font-size:11px;color:var(--muted);text-align:left}.lines input{min-width:70px}.lines .desc{min-width:250px}.date-control{display:grid;grid-template-columns:40px 1fr 40px;gap:4px}.date-control button{padding:0}.quick-view{margin-top:14px}.quick-lines{width:100%;border-collapse:collapse}.quick-lines th,.quick-lines td{padding:8px;border-bottom:1px solid var(--line);text-align:left}.quick-lines th{font-size:11px;color:var(--muted)}.quick-lines td:last-child,.quick-lines th:last-child{text-align:right}.invoice-preview{display:block;width:100%;height:720px;margin-top:12px;border:1px solid var(--line);border-radius:10px;background:#fff}.message{position:fixed;right:14px;bottom:14px;max-width:420px;padding:12px 14px;border-radius:10px;background:#15202a;border:1px solid var(--line);box-shadow:0 8px 30px #0008;z-index:20}.message.error{background:#441f24;border-color:#8b383e}.hide{display:none!important}.modal{position:fixed;inset:0;background:#000b;z-index:10;display:grid;place-items:center;padding:20px}.modal>.card{width:min(700px,100%);max-height:90vh;overflow:auto}@media(max-width:900px){.layout{grid-template-columns:1fr}.side{position:static;max-height:none}.grid,.grid3,.summary{grid-template-columns:1fr 1fr}.invoice-preview{height:580px}}@media(max-width:560px){.grid,.grid3,.summary{grid-template-columns:1fr}.top{align-items:flex-start}.lines{display:block;overflow:auto}.invoice-preview{height:460px}}
.recent-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px}.recent-card{min-height:92px;text-align:left;background:var(--card2);padding:11px}.recent-card strong,.recent-card span{display:block}.recent-card .amount{margin-top:7px;color:var(--green);font-size:13px}
</style></head><body>
<header class="top"><div><a href="/">← KRISTINE</a><h1>Ausgangsrechnungen</h1></div><div class="row"><a href="/outgoing/open-items"><button class="ghost">Debitoren-OP</button></a><button id="syncWw" class="ghost">WW abgleichen</button><button id="periodButton" class="ghost">Monatsabschluss</button><button id="settingsButton" class="ghost">Firmendaten</button></div></header>
<main class="layout"><aside class="card side"><label>Projekt, Kunde oder Nummer suchen<div class="row"><input id="search" class="grow" placeholder="z. B. 26025 oder Kundenname"><button id="searchButton">Suchen</button></div></label><div id="projects"></div><div class="section"><h3>Rechnungsläufe</h3><div id="runs" class="muted">Projekt auswählen.</div></div></aside><section><div id="empty" class="card">Projekt auswählen und einen Rechnungslauf anlegen.</div><div id="workspace" class="hide"></div><div id="recent" class="card section"><h3>Zuletzt bearbeitet</h3><div id="recentGrid" class="recent-grid"><span class="muted">Wird geladen …</span></div></div></section></main>
<div id="message" class="message hide"></div>
<div id="runModal" class="modal hide"><div class="card"><div class="head"><h2>Neuer Rechnungslauf</h2><button data-close="runModal">×</button></div><div class="grid"><label>Bezeichnung<input id="runLabel" placeholder="z. B. Fassade / Zusatzauftrag"></label><label>Kunden-UID<input id="runUid"></label><label>Firma<input id="runCompany"></label><label>Name<input id="runName"></label><label>Straße<input id="runStreet"></label><label>PLZ<input id="runPostal"></label><label>Ort<input id="runCity"></label><label>Land<input id="runCountry" value="Österreich"></label></div><div class="row section"><button id="runSave" class="primary">Rechnungslauf anlegen</button><button data-close="runModal">Abbrechen</button></div></div></div>
<div id="paymentModal" class="modal hide"><div class="card"><div class="head"><h2>Zahlung buchen</h2><button data-close="paymentModal">×</button></div><div class="grid"><label style="grid-column:1/-1">Zu Rechnung<select id="payInvoice"></select></label><label>Datum<input id="payDate" type="date"></label><label>Brutto<input id="payGross" inputmode="decimal"></label><label>Netto (optional)<input id="payNet" inputmode="decimal"></label><label>USt (optional)<input id="payVat" inputmode="decimal"></label><label style="grid-column:1/-1">Text / Referenz<input id="payRef"></label></div><div class="row section"><button id="paySave" class="good">Zahlung buchen</button><button data-close="paymentModal">Abbrechen</button></div></div></div>
<div id="correctionModal" class="modal hide"><div class="card"><div class="head"><h2>Korrekturbeleg</h2><button data-close="correctionModal">×</button></div><div class="grid"><label>Art<select id="correctionKind"><option value="GS">Gutschrift</option><option value="ST">Stornorechnung (nur offener Monat)</option></select></label><label>Datum<input id="correctionDate" type="date"></label><label id="creditGrossLabel">Gutschrift Brutto<input id="creditGross" inputmode="decimal"></label><label style="grid-column:1/-1">Begründung<input id="correctionReason"></label></div><div class="row section"><button id="correctionSave" class="danger">Korrekturentwurf anlegen</button><button data-close="correctionModal">Abbrechen</button></div></div></div>
<div id="mailModal" class="modal hide"><div class="card"><div class="head"><h2>Rechnung per E-Mail senden</h2><button data-close="mailModal">×</button></div><div class="grid"><label style="grid-column:1/-1">Empfänger<input id="mailTo" type="email" placeholder="wird aus den Stammdaten übernommen"></label><label style="grid-column:1/-1">CC – Bauleitung / Architekt<input id="mailCc" placeholder="wird aus den Stammdaten übernommen"></label><label style="grid-column:1/-1">Betreff<input id="mailSubject"></label><label style="grid-column:1/-1">Nachricht<textarea id="mailText"></textarea></label></div><p class="small muted">„In Outlook öffnen“ erstellt die Original-Mail mit PDF-Anhang und deiner normalen Outlook-Signatur. Vor dem Senden kannst du alles prüfen und ändern.</p><div class="row section"><button id="mailOutlook" class="good">In Outlook öffnen</button><button id="mailSend">Direkt senden</button><button data-close="mailModal">Abbrechen</button></div></div></div>
<div id="periodModal" class="modal hide"><div class="card"><div class="head"><h2>Monatsabschluss</h2><button data-close="periodModal">×</button></div><p class="muted">Nach dem Abschluss sind Rechnungen dieses Monats gesperrt. Korrekturen erfolgen nur noch über Gutschriften.</p><label>Monat<input id="periodValue" type="month"></label><div class="row section"><button id="periodClose" class="danger">Monat endgültig abschließen</button><button data-close="periodModal">Abbrechen</button></div><div id="closedPeriods" class="section small muted"></div></div></div>
<script>
(()=>{const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=n=>new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(n||0)),today=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);let selectedProject=null,selectedRun=null,editing=null,correctionTarget=null,settings={};
function msg(t,error=false){const e=$('message');e.textContent=t;e.className='message'+(error?' error':'');setTimeout(()=>e.classList.add('hide'),4500)}async function api(url,opt={}){if(url==='/api/outgoing/runs'&&opt.method==='POST'&&opt.body&&selectedProject){const body=JSON.parse(opt.body),designation=projectDesignation(selectedProject);body.projectTitle=designation;body.label=designation;opt={...opt,body:JSON.stringify(body)}}const r=await fetch(url,{cache:'no-store',headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Fehler');return d}function open(id){$(id).classList.remove('hide')}function close(id){$(id).classList.add('hide')}document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>close(b.dataset.close));
async function init(){const d=await api('/api/outgoing/settings');settings=d.settings;$('payDate').value=today();$('correctionDate').value=today();$('periodValue').value=today().slice(0,7);await loadRecent();const project=new URLSearchParams(location.search).get('project');if(project){$('search').value=project;await search(true)}}
async function loadRecent(){const d=await api('/api/outgoing/runs'),rows=[...d.runs].sort((a,b)=>Number(b.id)-Number(a.id)).slice(0,6);$('recentGrid').innerHTML=rows.map(x=>`<button class="recent-card" data-recent="${x.id}"><strong>${esc(x.project_number||'Projekt')} · ${esc(x.customer_company||x.customer_name)}</strong><span class="small muted">${esc(x.project_title||x.label)}</span><span class="amount">${x.invoiceCount} Beleg(e) · offen ${money(x.currentOpen)}</span></button>`).join('')||'<span class="muted">Noch keine Rechnungsläufe vorhanden.</span>';$('recentGrid').querySelectorAll('[data-recent]').forEach(button=>button.onclick=async()=>{const x=rows.find(row=>row.id===Number(button.dataset.recent));if(!x)return;selectedProject={projectIndex:x.project_index,projectNumber:x.project_number,title:x.project_title||x.label,company:x.customer_company,customer:x.customer_name,address:[x.customer_street,[x.customer_postal_code,x.customer_city].filter(Boolean).join(' ')].filter(Boolean).join(', ')};await loadRun(x.id)})}
async function search(autoSelect=false){const q=$('search').value.trim();if(q.length<2)return;const d=await api('/api/outgoing/project-search?q='+encodeURIComponent(q));$('projects').innerHTML=d.projects.map((p,i)=>`<div class="project" data-p="${i}"><strong>${esc(p.projectNumber)} · ${esc(p.company||p.customer)}</strong><div class="small muted">${esc(p.title||p.site)}<br>${esc(p.address)}</div></div>`).join('')||'<div class="muted">Kein Projekt gefunden.</div>';const elements=[...$('projects').children];elements.forEach((e,i)=>e.onclick=()=>selectProject(d.projects[i],e));if(autoSelect&&d.projects.length){const i=Math.max(0,d.projects.findIndex(p=>String(p.projectNumber)===q));await selectProject(d.projects[i],elements[i])}}
async function selectProject(p,e){selectedProject=p;selectedRun=null;document.querySelectorAll('.project').forEach(x=>x.classList.remove('active'));e?.classList.add('active');let synced=null;try{synced=await api('/api/outgoing/projects/'+encodeURIComponent(p.projectIndex)+'/sync-history',{method:'POST',body:'{}'})}catch(err){msg('WW-Rechnungshistorie konnte nicht geladen werden: '+err.message,true)}$('empty').classList.remove('hide');$('workspace').classList.add('hide');$('empty').innerHTML=`<div class="head"><div><h2>${esc(p.projectNumber)} · ${esc(p.title)}</h2><div class="muted">${esc(p.company||p.customer)} · ${esc(p.address)}</div></div><button id="newRun" class="primary">Neuer Rechnungslauf</button></div>`;$('newRun').onclick=showRun;await loadRuns();if(synced?.runId){await loadRun(synced.runId);if(synced.imported)msg(`${synced.imported} WW-Vorgängerrechnung(en) übernommen. Die nächste Teilrechnung wird korrekt fortgeführt.`)}}
async function loadRuns(){if(!selectedProject)return;const d=await api('/api/outgoing/runs?projectIndex='+encodeURIComponent(selectedProject.projectIndex));$('runs').innerHTML=d.runs.map(x=>`<div class="run ${selectedRun?.id===x.id?'active':''}" data-id="${x.id}"><div class="head"><strong>${esc(x.label)}</strong><span class="pill ${x.status}">${x.status==='open'?'offen':'abgeschlossen'}</span></div><div class="small muted">${x.invoiceCount} Beleg(e) · offen ${money(x.currentOpen)}</div></div>`).join('')||'<div class="muted">Noch kein Lauf.</div>';document.querySelectorAll('.run').forEach(e=>e.onclick=()=>loadRun(Number(e.dataset.id)))}
function projectDesignation(p){return [p.title||'Auftrag',p.address||[p.street,[p.postalCode,p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
function showRun(){const p=selectedProject;$('runLabel').value=projectDesignation(p);$('runUid').value='';$('runCompany').value=p.company||'';$('runName').value=p.customer||[p.firstName,p.lastName].filter(Boolean).join(' ');$('runStreet').value=p.street||'';$('runPostal').value=p.postalCode||'';$('runCity').value=p.city||'';$('runCountry').value='Österreich';open('runModal')}
async function saveRun(){const p=selectedProject,d=await api('/api/outgoing/runs',{method:'POST',body:JSON.stringify({projectIndex:p.projectIndex,projectNumber:p.projectNumber,customerIndex:p.customerIndex,projectTitle:p.title,label:$('runLabel').value,customerUid:$('runUid').value,company:$('runCompany').value,customerName:$('runName').value,street:$('runStreet').value,postalCode:$('runPostal').value,city:$('runCity').value,country:$('runCountry').value})});close('runModal');await loadRuns();await loadRun(d.run.id)}
async function loadRun(id){const d=await api('/api/outgoing/runs/'+id);selectedRun=d.run;editing=editing?(selectedRun.invoices||[]).find(x=>x.id===editing.id)||null:null;$('empty').classList.add('hide');$('workspace').classList.remove('hide');renderRun();await loadRuns()}
function renderRun(){const r=selectedRun,draft=(r.invoices||[]).find(x=>x.status==='draft'),nextTr=(r.invoices||[]).filter(x=>x.kind==='TR'&&x.status==='issued').length+1;$('workspace').innerHTML=`<div class="card"><div class="head"><div><h2>${esc(r.label)}</h2><div class="muted">Projekt ${esc(r.project_number)} · ${esc(r.customer_company||r.customer_name)} · ${esc(r.customer_street)}, ${esc(r.customer_postal_code)} ${esc(r.customer_city)}</div></div><span class="pill ${r.status}">${r.status==='open'?'offen':'abgeschlossen'}</span></div><div class="summary"><div>Rechnungsstand<strong>${money(r.currentGross)}</strong></div><div>Zahlungen<strong>${money(r.paidGross)}</strong></div><div>Offen<strong>${money(r.currentOpen)}</strong></div><div>Belege<strong>${r.invoiceCount}</strong></div></div><div class="row">${r.status==='open'&&!r.label.startsWith('WW-Altbestand')?`<button id="newInvoice" class="primary">${draft?'Entwurf bearbeiten':nextTr+'. TR / Rechnung erstellen'}</button>`:''}<button id="newPayment" class="good">Zahlung buchen</button></div></div><div class="card section"><h3>Rechnungen</h3><div id="invoiceList">${invoiceList(r.invoices)}</div><div id="quickView"></div></div><div class="card section"><h3>Zahlungen</h3>${paymentList(r.payments)}</div><div id="editor"></div>`;$('newInvoice')?.addEventListener('click',()=>editInvoice(draft||null));$('newPayment').onclick=showPayment;wireInvoices()}
function linkedRegiePreset(){const q=new URLSearchParams(location.search),hours=Number(q.get('regieHours')||0),labor=Number(q.get('laborTotal')||0),material=Number(q.get('materialTotal')||0);return {hours,labor,material,available:hours>0||labor>0||material>0}}
async function createLinkedRegieDraft(){const p=linkedRegiePreset(),due=new Date(today()+'T12:00:00');due.setDate(due.getDate()+Number(settings.default_due_days||14));const lines=[];if(p.labor>0)lines.push({description:'Regiearbeit lt. Berichten',quantity:p.hours||1,unit:p.hours?'Std.':'PA',unitPrice:p.hours?p.labor/p.hours:p.labor,discountPercent:0});if(p.material>0)lines.push({description:'Material lt. Berichten',quantity:1,unit:'PA',unitPrice:p.material,discountPercent:20});const d=await api('/api/outgoing/invoices',{method:'POST',body:JSON.stringify({runId:selectedRun.id,kind:'TR',issueDate:today(),dueDate:due.toISOString().slice(0,10),serviceFrom:today(),serviceTo:today(),taxMode:'AT20',retentionPercent:0,discountPercent:0,cashDiscountPercent:0,subject:selectedRun.label,notes:'Aus den Regieberichten der Baustelle übernommen; alle Werte sind bearbeitbar.',lines})});await loadRun(selectedRun.id);editInvoice(d.invoice)}
function startInvoiceKind(kind){editInvoice(null);const select=$('invKind');if(select){select.value=kind;select.onchange?.()}if(kind==='RE'){$('subject').value='Extra-Rechnung · Handwerker / Material';$('notes').value='Zusätzliche, der Baustelle zugeordnete Leistung.'}}
function addInvoiceKindButtons(){const original=$('newInvoice'),draft=(selectedRun?.invoices||[]).find(x=>x.status==='draft'),row=original?.parentElement;if(!original||draft||!row)return;const tr=original.cloneNode(true),next=(selectedRun.invoices||[]).filter(x=>x.kind==='TR'&&x.status==='issued').length+1;tr.textContent=`${next}. TR erstellen`;original.replaceWith(tr);tr.onclick=()=>startInvoiceKind('TR');const sr=document.createElement('button');sr.textContent='Schlussrechnung';sr.onclick=()=>startInvoiceKind('SR');const extra=document.createElement('button');extra.className='ghost';extra.textContent='Extra-Rechnung';extra.title='Handwerker, Material oder weitere projektbezogene Kosten';extra.onclick=()=>startInvoiceKind('RE');tr.after(sr,extra)}
const renderRunBase=renderRun;renderRun=function(){renderRunBase();addInvoiceKindButtons();const preset=linkedRegiePreset(),draft=(selectedRun?.invoices||[]).find(x=>x.status==='draft'),row=document.querySelector('#workspace>.card .row');if(!preset.available||draft||!row||selectedRun.status!=='open')return;const button=document.createElement('button');button.id='useRegieData';button.className='good';button.textContent='Regiedaten übernehmen';button.onclick=()=>createLinkedRegieDraft().catch(e=>msg(e.message,true));row.prepend(button)};
function invoiceList(xs){let tr=0;return (xs||[]).map(x=>{const label=x.kind==='TR'?`${++tr}. Teilrechnung`:({SR:'Schlussrechnung',RE:'Rechnung',ST:'Stornorechnung',GS:'Gutschrift'})[x.kind],ww=x.source==='WW';return `<div class="invoice"><div class="head"><div><strong>${esc(x.invoice_number||'Entwurf')} · ${esc(label)}</strong><div class="small muted">${esc(x.issue_date)} · ${money(x.increment_gross)}${x.revisionNo?' · Version '+(x.revisionNo+1):''}${ww?' · aus WinWorker':''}</div></div><span class="pill ${x.status==='draft'?'open':'closed'}">${x.status==='draft'?'Entwurf':'ausgestellt'}</span></div><div class="row"><button data-quick="${x.id}">Schnellansicht</button><button data-preview="${x.id}">Vorschau</button>${ww?'<span class="small muted">Originalbeleg aus WW</span>':`${['TR','SR','RE'].includes(x.kind)?`<button data-edit="${x.id}" data-issued="${x.status==='issued'?'1':'0'}">${x.status==='issued'?'Ändern':'Bearbeiten'}</button>`:''}${x.status==='draft'?`<button class="good" data-issue="${x.id}">Abschließen</button>`:`<button class="danger" data-correct="${x.id}">Storno / Gutschrift</button>`}`}</div></div>`}).join('')||'<div class="muted">Noch keine Rechnung.</div>'}
function paymentList(xs){return (xs||[]).map((x,i)=>`<div class="payment head"><div><strong>${i+1}. Zahlung · ${esc(x.paymentDate)}</strong><div class="small muted">${esc(x.reference)}</div></div><strong>${money(x.gross)}</strong></div>`).join('')||'<div class="muted">Noch keine Zahlung gebucht.</div>'}
function quickInvoice(id,showPdf=false){const x=(selectedRun.invoices||[]).find(row=>row.id===Number(id));if(!x)return;const payments=(selectedRun.payments||[]).filter(p=>Number(p.invoiceId)===Number(x.id)),paid=payments.reduce((s,p)=>s+Number(p.gross||0),0),openGross=Math.max(0,Number(x.increment_gross||0)-paid),trNo=x.kind==='TR'?(selectedRun.invoices||[]).filter(row=>row.kind==='TR'&&row.status!=='cancelled').findIndex(row=>row.id===x.id)+1:0,label=x.kind==='TR'?`${trNo}. Teilrechnung`:({SR:'Schlussrechnung',RE:'Rechnung',ST:'Stornorechnung',GS:'Gutschrift'})[x.kind]||x.kind,pdfUrl=`/api/outgoing/invoices/${x.id}/${x.status==='draft'?'preview.pdf':'source-pdf'}`,lines=(x.lines||[]).map((line,i)=>`<tr><td>${i+1}</td><td>${esc(line.description)}</td><td>${esc(line.quantity)} ${esc(line.unit)}</td><td>${money(line.net)}</td></tr>`).join(''),paymentRows=payments.map(p=>`${esc(p.paymentDate)} · ${money(p.gross)} · ${esc(p.reference||p.source)}`).join('<br>');$('quickView').innerHTML=`<div class="quick-view card"><div class="head"><div><h3>${esc(x.invoice_number||'Entwurf')} · ${esc(label)}</h3><div class="small muted">${esc(x.issue_date)} · Leistung ${esc(x.service_from)} bis ${esc(x.service_to)} · ${esc(x.source==='WW'?'WinWorker':'KRISTINE')}</div></div><button id="quickClose">×</button></div><div class="summary"><div>Netto<strong>${money(x.increment_net)}</strong></div><div>USt<strong>${money(x.increment_vat)}</strong></div><div>Brutto<strong>${money(x.increment_gross)}</strong></div><div>Bezahlt / offen<strong>${money(paid)} / ${money(openGross)}</strong></div></div><table class="quick-lines"><thead><tr><th>Pos.</th><th>Leistung</th><th>Menge</th><th>Betrag netto</th></tr></thead><tbody>${lines||'<tr><td colspan="4" class="muted">Keine Positionen gespeichert.</td></tr>'}</tbody></table>${paymentRows?`<div class="section"><strong>Zahlungen</strong><div class="small muted">${paymentRows}</div></div>`:''}<div class="row section"><button id="quickPreview">Vorschau einblenden</button><a href="${pdfUrl}" target="_blank"><button>PDF separat öffnen</button></a></div>${showPdf?`<iframe class="invoice-preview" title="Vorschau ${esc(x.invoice_number||'Rechnung')}" src="${pdfUrl}"></iframe>`:''}</div>`;$('quickClose').onclick=()=>{$('quickView').innerHTML=''};$('quickPreview').onclick=()=>quickInvoice(id,true);$('quickView').scrollIntoView({behavior:'smooth',block:'nearest'})}
async function loadEmbeddedPreview(){const frame=document.querySelector('.invoice-preview');if(!frame)return;const match=frame.src.match(/\/api\/outgoing\/invoices\/(\d+)\//);if(!match)return;const image=document.createElement('img');image.className='invoice-preview';image.alt='Rechnungsvorschau';image.style.height='auto';image.style.objectFit='contain';image.src='/api/outgoing/invoices/'+match[1]+'/preview.png?t='+Date.now();image.onerror=()=>image.replaceWith(Object.assign(document.createElement('div'),{className:'card muted',textContent:'Rechnungsvorschau konnte nicht geladen werden.'}));frame.replaceWith(image)}
function decorateLineDiscounts(id){const invoice=(selectedRun?.invoices||[]).find(row=>row.id===Number(id)),rows=document.querySelectorAll('.quick-lines tbody tr');(invoice?.lines||[]).forEach((line,index)=>{const discount=Number(line.discount_percent||0),cell=rows[index]?.lastElementChild;if(!cell||discount<=0)return;const before=Number(line.quantity||0)*Number(line.unit_price||0),percent=new Intl.NumberFormat('de-AT',{maximumFractionDigits:2}).format(discount);cell.innerHTML=`<span class="small muted">${money(before)} · − ${percent} %</span><br><strong>${money(line.net)}</strong>`})}
const quickInvoiceWithDirectPdf=quickInvoice;quickInvoice=function(id,showPdf=false){quickInvoiceWithDirectPdf(id,showPdf);decorateLineDiscounts(id);if(showPdf)loadEmbeddedPreview()};
function wireInvoices(){document.querySelectorAll('[data-quick]').forEach(b=>b.onclick=()=>quickInvoice(Number(b.dataset.quick),false));document.querySelectorAll('[data-preview]').forEach(b=>b.onclick=()=>quickInvoice(Number(b.dataset.preview),true));document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=async()=>{try{let x=selectedRun.invoices.find(x=>x.id===Number(b.dataset.edit));if(b.dataset.issued==='1'){if(!confirm('Ausgestellte Rechnung als neue Version öffnen? Die bisherige Version bleibt archiviert.'))return;const d=await api('/api/outgoing/invoices/'+x.id+'/revision',{method:'POST',body:'{}'});x=d.invoice;await loadRun(selectedRun.id)}editInvoice(x)}catch(e){msg(e.message,true)}});document.querySelectorAll('[data-issue]').forEach(b=>b.onclick=()=>issueInvoice(Number(b.dataset.issue)));document.querySelectorAll('[data-correct]').forEach(b=>b.onclick=()=>{correctionTarget=Number(b.dataset.correct);$('correctionKind').value='GS';$('creditGrossLabel').classList.remove('hide');open('correctionModal')})}
let mailInvoiceId=null;async function showInvoiceMail(id){const x=(selectedRun?.invoices||[]).find(row=>row.id===Number(id));if(!x)return;mailInvoiceId=x.id;const projectLabel=String(x.subject||selectedRun.project_title||selectedRun.label||'').replace(/\s*·\s*aus WinWorker fortgeführt\s*$/i,'').trim();$('mailTo').value='';$('mailCc').value='';$('mailSubject').value=`${x.kind==='TR'?'Teilrechnung':'Rechnung'} ${x.invoice_number||''} · ${projectLabel}`;$('mailText').value=x.kind==='TR'?`Guten Tag,\n\nim Anhang erhalten Sie unsere Teilrechnung ${x.invoice_number||''} für die bisher erbrachten Leistungen beim Projekt ${projectLabel}.\n\nSollte etwas unklar oder noch offen sein, melden Sie sich bitte jederzeit bei uns. Wir kümmern uns gerne darum.`:`Guten Tag,\n\nvielen Dank, dass wir für Sie arbeiten durften.\n\nIm Anhang erhalten Sie unsere Rechnung ${x.invoice_number||''} zum Projekt ${projectLabel}. Sollte etwas unklar oder noch offen sein, melden Sie sich bitte jederzeit bei uns. Wir kümmern uns gerne darum.`;open('mailModal');try{const d=await api('/api/outgoing/project-mail-recipients?projectNumber='+encodeURIComponent(selectedRun.project_number));$('mailTo').value=(d.to||[]).join(', ');$('mailCc').value=(d.cc||[]).join(', ');if(!(d.to||[]).length)msg('Für die angekreuzten Empfänger ist keine E-Mail-Adresse gespeichert.',true)}catch(e){msg('E-Mail-Adressen aus den Stammdaten konnten nicht geladen werden: '+e.message,true)}}
async function sendInvoiceMail(){const button=$('mailSend');button.disabled=true;try{const d=await api('/api/outgoing/invoices/'+mailInvoiceId+'/send-email',{method:'POST',body:JSON.stringify({to:$('mailTo').value,cc:$('mailCc').value,subject:$('mailSubject').value,message:$('mailText').value})});close('mailModal');msg(`Rechnung ${d.invoiceNumber} wurde versendet.`)}catch(e){msg(e.message,true)}finally{button.disabled=false}}
async function openInvoiceInOutlook(){const button=$('mailOutlook');button.disabled=true;try{const d=await api('/api/outgoing/invoices/'+mailInvoiceId+'/open-outlook',{method:'POST',body:JSON.stringify({to:$('mailTo').value,cc:$('mailCc').value,subject:$('mailSubject').value,message:$('mailText').value})});const link=document.createElement('a');link.href=d.downloadUrl;link.download='';document.body.appendChild(link);link.click();link.remove();close('mailModal');msg(`Outlook-Entwurf für Rechnung ${d.invoiceNumber} wurde heruntergeladen. Bitte den Download öffnen.`)}catch(e){msg(e.message,true)}finally{button.disabled=false}}
const wireInvoicesBase=wireInvoices;wireInvoices=function(){wireInvoicesBase();document.querySelectorAll('.invoice').forEach((card,index)=>{const invoice=(selectedRun?.invoices||[])[index],row=card.querySelector('.row');if(!invoice||invoice.status!=='issued'||!row)return;const button=document.createElement('button');button.className='good';button.textContent='Per E-Mail senden';button.onclick=()=>showInvoiceMail(invoice.id);row.append(button)})};
function dateControl(id,label,value){return `<label>${label}<div class="date-control"><button type="button" data-date-minus="${id}">−</button><input id="${id}" type="date" value="${esc(value||today())}"><button type="button" data-date-plus="${id}">+</button></div></label>`}
function editInvoice(x=null){editing=x;const history=(selectedRun.invoices||[]).filter(i=>['TR','SR','RE'].includes(i.kind)&&i.status==='issued'&&i.id!==x?.id),nextTr=history.filter(i=>i.kind==='TR').length+1,titleFor=k=>k==='TR'?`${nextTr}. Teilrechnung`:k==='SR'?'Schlussrechnung':'Rechnung',priorNet=history.reduce((s,i)=>s+Number(i.increment_net||0),0),priorVat=history.reduce((s,i)=>s+Number(i.increment_vat||0),0),priorGross=history.reduce((s,i)=>s+Number(i.increment_gross||0),0),paidGross=Number(selectedRun.paidGross||0),due=new Date((x?.issue_date||today())+'T12:00:00');due.setDate(due.getDate()+Number(settings.default_due_days||14));const lines=x?.lines?.length?x.lines:[{description:'Kumulativer Leistungsstand lt. Auftrag',quantity:1,unit:'PA',unit_price:priorNet,discount_percent:0}],historyRows=history.map((i,n)=>`${esc(i.invoice_number||'')}${i.kind==='TR'?' · '+(n+1)+'. Teilrechnung':' · '+esc(i.kind)} · netto ${money(i.increment_net)} · brutto ${money(i.increment_gross)}`).join('<br>');$('editor').innerHTML=`<div class="card section"><div class="head"><h2 id="editorTitle">${x?'Entwurf bearbeiten':'Neue '+titleFor('TR')}</h2><button id="editorClose">×</button></div><div class="grid3"><label>Art<select id="invKind"><option value="TR">Teilrechnung</option><option value="SR">Schlussrechnung</option><option value="RE">Rechnung</option></select></label>${dateControl('invDate','Rechnungsdatum',x?.issue_date||today())}${dateControl('dueDate','Fällig am',x?.due_date||due.toISOString().slice(0,10))}${dateControl('serviceFrom','Leistung von',x?.service_from||today())}${dateControl('serviceTo','Leistung bis',x?.service_to||today())}<label>USt-Art<select id="taxMode"><option value="AT20">20 % Österreich</option><option value="CHLI81">8,1 % Schweiz / Liechtenstein</option><option value="RC19">0 % · § 19 Übergang Steuerschuld</option><option value="EU0">0 % · EU-Auslandslieferung</option></select></label><label id="recipientUidLabel">Kunden-UID<input id="recipientUid" value="${esc(x?.recipient_uid||selectedRun.customer_uid||'')}"></label><label>Deckungsrücklass %<input id="retention" inputmode="decimal" value="${x?.retention_percent||0}"></label><label>Rabatt %<input id="discount" inputmode="decimal" value="${x?.discount_percent||0}"></label><label>Skonto %<input id="cashDiscount" inputmode="decimal" value="${x?.cash_discount_percent||0}"></label>${dateControl('cashUntil','Skonto bis',x?.cash_discount_until||'')}<label>Betreff<input id="subject" value="${esc(x?.subject||selectedRun.label)}"></label></div>${history.length?`<div class="section"><h3>Bisheriger Stand aus WW / KRISTINE</h3><div class="summary"><div>Abgerechnet netto<strong>${money(priorNet)}</strong></div><div>USt<strong>${money(priorVat)}</strong></div><div>Abgerechnet brutto<strong>${money(priorGross)}</strong></div><div>Erhaltene Zahlungen<strong>${money(paidGross)}</strong></div></div><div class="small muted">${historyRows}</div><div class="small" style="margin-top:9px;color:var(--amber)">Unten steht bereits der bisherige Netto-Leistungsstand. Für die ${nextTr}. Teilrechnung bitte auf den neuen kumulierten Gesamtstand erhöhen – nicht nur den Zusatzbetrag eingeben.</div></div>`:''}<div class="section"><h3>Leistungen / kumulierter Stand</h3><table class="lines"><thead><tr><th>Pos</th><th>Leistung</th><th>Menge</th><th>Einheit</th><th>Gesamtstand netto</th><th>Rabatt %</th><th></th></tr></thead><tbody id="lineRows"></tbody></table><button id="addLine">+ Position</button></div><label class="section">Zusatztext<textarea id="notes">${esc(x?.notes||'')}</textarea></label><div class="row section"><button id="saveDraft" class="primary">Entwurf speichern</button><button id="savePreview">Speichern & PDF prüfen</button></div></div>`;$('invKind').value=x?.kind||'TR';$('invKind').onchange=()=>{if(!x)$('editorTitle').textContent='Neue '+titleFor($('invKind').value)};$('taxMode').value=x?.tax_mode||'AT20';let model=lines.map(l=>({description:l.description||'',quantity:l.quantity||1,unit:l.unit||'PA',unitPrice:l.unit_price??l.unitPrice??0,discountPercent:l.discount_percent??l.discountPercent??0}));function renderLines(){$('lineRows').innerHTML=model.map((l,i)=>`<tr><td>${i+1}</td><td><input class="desc" data-f="description" data-i="${i}" value="${esc(l.description)}"></td><td><input data-f="quantity" data-i="${i}" value="${esc(l.quantity)}"></td><td><input data-f="unit" data-i="${i}" value="${esc(l.unit)}"></td><td><input data-f="unitPrice" data-i="${i}" value="${esc(l.unitPrice)}"></td><td><input data-f="discountPercent" data-i="${i}" value="${esc(l.discountPercent)}"></td><td><button data-del="${i}">×</button></td></tr>`).join('');$('lineRows').querySelectorAll('input').forEach(e=>e.oninput=()=>model[Number(e.dataset.i)][e.dataset.f]=e.value);$('lineRows').querySelectorAll('[data-del]').forEach(e=>e.onclick=()=>{model.splice(Number(e.dataset.del),1);renderLines()})}renderLines();$('addLine').onclick=()=>{model.push({description:'',quantity:1,unit:'PA',unitPrice:0,discountPercent:0});renderLines()};$('editorClose').onclick=()=>{$('editor').innerHTML=''};document.querySelectorAll('[data-date-minus]').forEach(b=>b.onclick=()=>shiftDate(b.dataset.dateMinus,-1));document.querySelectorAll('[data-date-plus]').forEach(b=>b.onclick=()=>shiftDate(b.dataset.datePlus,1));$('taxMode').onchange=()=>$('recipientUidLabel').classList.toggle('hide',!['RC19','EU0'].includes($('taxMode').value));$('taxMode').onchange();async function save(preview){const payload={runId:selectedRun.id,kind:$('invKind').value,issueDate:$('invDate').value,dueDate:$('dueDate').value,serviceFrom:$('serviceFrom').value,serviceTo:$('serviceTo').value,taxMode:$('taxMode').value,recipientUid:$('recipientUid').value,retentionPercent:$('retention').value,discountPercent:$('discount').value,cashDiscountPercent:$('cashDiscount').value,cashDiscountUntil:$('cashUntil').value,subject:$('subject').value,notes:$('notes').value,lines:model};const d=await api(editing?'/api/outgoing/invoices/'+editing.id:'/api/outgoing/invoices',{method:editing?'PUT':'POST',body:JSON.stringify(payload)});editing=d.invoice;msg('Entwurf gespeichert.');await loadRun(selectedRun.id);if(preview)window.open('/api/outgoing/invoices/'+editing.id+'/preview.pdf','_blank')} $('saveDraft').onclick=()=>save(false).catch(e=>msg(e.message,true));$('savePreview').onclick=()=>save(true).catch(e=>msg(e.message,true))}
function shiftDate(id,days){const e=$(id),d=new Date((e.value||today())+'T12:00:00');d.setDate(d.getDate()+days);e.value=d.toISOString().slice(0,10)}
async function issueInvoice(id){if(!confirm('Rechnung jetzt nummerieren und abschließen?'))return;try{const d=await api('/api/outgoing/invoices/'+id+'/issue',{method:'POST',body:'{}'});msg('Rechnung '+d.invoice.invoice_number+' erstellt.');await loadRun(selectedRun.id);window.open(d.pdfUrl,'_blank')}catch(e){msg(e.message,true)}}
function showPayment(){$('payInvoice').innerHTML='<option value="">Allgemein zum Rechnungslauf</option>'+selectedRun.invoices.filter(x=>x.status==='issued'&&!['ST','GS'].includes(x.kind)).map(x=>`<option value="${x.id}">${esc(x.invoice_number)} · ${money(x.increment_gross)}</option>`).join('');open('paymentModal')}
async function savePayment(){try{await api('/api/outgoing/runs/'+selectedRun.id+'/payments',{method:'POST',body:JSON.stringify({invoiceId:$('payInvoice').value?Number($('payInvoice').value):null,paymentDate:$('payDate').value,gross:$('payGross').value,net:$('payNet').value||null,vat:$('payVat').value||null,reference:$('payRef').value})});close('paymentModal');msg('Zahlung gebucht.');await loadRun(selectedRun.id)}catch(e){msg(e.message,true)}}
async function saveCorrection(){try{const d=await api('/api/outgoing/invoices/'+correctionTarget+'/corrections',{method:'POST',body:JSON.stringify({kind:$('correctionKind').value,issueDate:$('correctionDate').value,gross:$('creditGross').value,reason:$('correctionReason').value})});close('correctionModal');msg('Korrekturentwurf angelegt.');await loadRun(selectedRun.id)}catch(e){msg(e.message,true)}}
async function showPeriods(){const d=await api('/api/outgoing/periods');$('closedPeriods').innerHTML='<strong>Abgeschlossene Monate</strong><br>'+(d.periods.map(x=>esc(x.period.slice(0,4)+'-'+x.period.slice(4))+' · '+esc(x.closed_at)).join('<br>')||'Noch keiner.');open('periodModal')}async function closePeriod(){const p=$('periodValue').value.replace('-','');if(!confirm('Monat '+$('periodValue').value+' endgültig abschließen?'))return;try{await api('/api/outgoing/periods/close',{method:'POST',body:JSON.stringify({period:p})});msg('Monat abgeschlossen.');showPeriods()}catch(e){msg(e.message,true)}}
$('searchButton').onclick=()=>search().catch(e=>msg(e.message,true));$('search').onkeydown=e=>{if(e.key==='Enter')search().catch(x=>msg(x.message,true))};$('runSave').onclick=()=>saveRun().catch(e=>msg(e.message,true));$('paySave').onclick=savePayment;$('correctionSave').onclick=saveCorrection;$('mailOutlook').onclick=openInvoiceInOutlook;$('mailSend').onclick=sendInvoiceMail;$('correctionKind').onchange=()=>$('creditGrossLabel').classList.toggle('hide',$('correctionKind').value==='ST');$('periodButton').onclick=showPeriods;$('periodClose').onclick=closePeriod;$('syncWw').onclick=async()=>{try{const d=await api('/api/outgoing/sync-ww',{method:'POST',body:'{}'});msg(`${d.imported} neue WW-OP übernommen · ${d.skipped} bereits vorhanden`);if(selectedProject)await loadRuns()}catch(e){msg(e.message,true)}};$('settingsButton').onclick=()=>msg('Firmendaten werden in der nächsten Ansicht bearbeitbar; die WW-Stammdaten sind bereits vorbelegt.');init().catch(e=>msg(e.message,true));})();
</script></body></html>'''


DEBTOR_OP_PAGE = r'''<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KRISTINE · Debitoren-OP</title>
<style>
:root{--bg:#0b0e12;--card:#12171d;--card2:#171e26;--line:#2a3440;--text:#eef3f7;--muted:#9aabb9;--blue:#70a8ff;--green:#7bd99b;--red:#ff8c8c;--amber:#f5ca68}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer;border:1px solid var(--line);border-radius:9px;background:#202a34;color:var(--text);padding:9px 12px;min-height:40px;font-weight:750}button.good{background:#17643d;border-color:#248656}button.warn{background:#624917;border-color:#8c6925}button.ghost{background:transparent}button:disabled{cursor:not-allowed;opacity:.45}.top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 18px;background:#0d1217ee;border-bottom:1px solid var(--line)}.top h1{font-size:18px;margin:0}.top a{color:var(--text);text-decoration:none}.wrap{max-width:1700px;margin:auto;padding:14px}.summary{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:13px}.summary strong{display:block;margin-top:4px;font-size:21px}.muted{color:var(--muted)}.small{font-size:12px}.toolbar{display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin:12px 0}.toolbar label{display:grid;gap:4px;color:var(--muted);font-size:12px}.toolbar input,.toolbar select{min-height:40px;border:1px solid var(--line);border-radius:9px;background:#0e1318;color:var(--text);padding:8px 10px}.toolbar input{min-width:280px}.group{margin:12px 0;border:1px solid var(--line);border-radius:12px;overflow:hidden}.group-head{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;background:#19212a}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1380px}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-size:11px;background:#0f1419}td.money,th.money{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.pill{display:inline-block;padding:2px 7px;border-radius:999px;background:#26323e;font-size:11px}.pill.ww{background:#243b59;color:#a9cbff}.pill.late{background:#54272a;color:#ffb0b0}.pill.due{background:#3e321d;color:#f4d489}.pill.blocked{background:#553d20;color:#ffd994}.actions{display:flex;gap:5px;justify-content:flex-end}.actions button{min-height:32px;padding:5px 8px;font-size:12px}.dunning{min-width:280px}.dunning-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.op-note{width:100%;min-height:45px;margin-top:6px;border:1px solid var(--line);border-radius:7px;background:#0e1318;color:var(--text);padding:6px 7px;resize:vertical}.lock{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)}.lock input{width:auto}.print-only{display:none}.empty{padding:35px;text-align:center;color:var(--muted)}.modal{position:fixed;inset:0;background:#000b;z-index:10;display:grid;place-items:center;padding:20px}.modal.hide,.hide{display:none}.modal>.card{width:min(520px,100%)}.modal label{display:grid;gap:4px;margin:9px 0;color:var(--muted);font-size:12px}.modal input{min-height:40px;border:1px solid var(--line);border-radius:9px;background:#0e1318;color:var(--text);padding:8px 10px}.modal-actions{display:flex;gap:8px;margin-top:14px}.message{position:fixed;right:14px;bottom:14px;padding:11px 14px;background:#173c29;border:1px solid #248656;border-radius:9px}.message.error{background:#54272a;border-color:#8b383e}@media(max-width:720px){.summary{grid-template-columns:1fr 1fr}.top{align-items:flex-start}.toolbar input{min-width:0;width:100%}}@media print{body{background:#fff;color:#111;font-size:10px}.top,.toolbar,.actions,.message,.modal,.screen-only{display:none!important}.print-only{display:block!important}.wrap{max-width:none;padding:0}.card,.group{border-color:#aaa;background:#fff}.summary{grid-template-columns:repeat(4,1fr)}table{min-width:0}th{background:#eee;color:#333}th,td{border-color:#ccc;padding:5px 6px}.group{break-inside:avoid}.pill{border:1px solid #777;background:#fff!important;color:#111!important}.dunning{min-width:0}}
</style></head><body>
<header class="top"><div><a href="/">← KRISTINE</a><h1>Debitoren · Offene Posten</h1><div id="syncInfo" class="small muted">WW-Abgleich wird geprüft …</div></div><div><a href="/outgoing/invoices"><button class="ghost">Ausgangsrechnungen</button></a> <a href="/incoming/reconciliation"><button class="ghost">CAMT-Zahlungen</button></a> <button id="sync" class="ghost">Jetzt mit WW abgleichen</button> <button id="print" class="ghost">Liste drucken</button></div></header>
<main class="wrap"><section class="summary"><div class="card">Gesamt offen<strong id="total">–</strong></div><div class="card">Davon überfällig<strong id="overdue">–</strong></div><div class="card">Kunden<strong id="customers">–</strong></div><div class="card">Rechnungen<strong id="count">–</strong></div></section><section class="toolbar"><label>Suche<input id="search" placeholder="Kunde, Rechnung oder Projekt"></label><label>Sortierung<select id="sort"><option value="due">Fälligkeit</option><option value="amount">Betrag absteigend</option><option value="customer">Kunde A–Z</option></select></label><label>Ansicht<select id="view"><option value="customer">Nach Kunden gruppiert</option><option value="list">Gesamtliste</option></select></label></section><section id="rows"><div class="empty">Offene Posten werden geladen …</div></section></main>
<div id="payment" class="modal hide"><div class="card"><h2>Zahlung zuordnen</h2><div id="payTarget" class="muted"></div><label>Zahlungsdatum<input id="payDate" type="date"></label><label>Betrag brutto<input id="payGross" inputmode="decimal"></label><label>Text / Referenz<input id="payRef" placeholder="z. B. Bankeingang"></label><div class="modal-actions"><button id="paySave" class="good">Zahlung buchen</button><button id="payCancel">Abbrechen</button></div></div></div><div id="message" class="message hide"></div>
<script>
(()=>{const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=n=>new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(n||0)),date=s=>{const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}.${m[2]}.${m[1]}`:(s||'–')},today=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);let items=[],payItem=null;
function msg(t,error=false){const e=$('message');e.textContent=t;e.className='message'+(error?' error':'');setTimeout(()=>e.classList.add('hide'),4500)}async function api(url,opt={}){const r=await fetch(url,{cache:'no-store',headers:{'Content-Type':'application/json'},...opt}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Fehler');return d}
function sorted(xs){const mode=$('sort').value;xs=[...xs];if(mode==='amount')xs.sort((a,b)=>b.openGross-a.openGross||a.dueDate.localeCompare(b.dueDate));else if(mode==='customer')xs.sort((a,b)=>a.customer.localeCompare(b.customer,'de')||a.dueDate.localeCompare(b.dueDate));else xs.sort((a,b)=>a.dueDate.localeCompare(b.dueDate)||a.customer.localeCompare(b.customer,'de'));return xs}
function row(x){const status=x.isOverdue?`<span class="pill late">${x.overdueDays} Tage überfällig</span>`:'<span class="pill due">offen</span>',source=x.source==='WW'?'<span class="pill ww">WW</span>':'<span class="pill">KRISTINE</span>',pdf=x.pdfAvailable?`<a href="/api/outgoing/invoices/${x.invoiceId}/pdf" target="_blank"><button>PDF</button></a>`:'',mahn=x.dunningLevel?`Mahnung ${x.dunningLevel}${x.lastDunningDate?' · '+date(x.lastDunningDate):''}`:'Noch keine Mahnung',mahnPdf=x.lastDunningPdfAvailable?`<a href="/api/outgoing/dunnings/${x.lastDunningId}/pdf" target="_blank"><button>Mahnung PDF</button></a>`:'',next=x.isOverdue&&x.nextDunningLevel&&!x.dunningBlocked?`<button class="warn" data-dun="${x.invoiceId}" data-level="${x.nextDunningLevel}">Mahnung ${x.nextDunningLevel} erstellen</button>`:'',blocked=x.dunningBlocked?`<span class="pill blocked">Mahnsperre${x.wwDunningBlockedUntil?' bis '+date(x.wwDunningBlockedUntil):''}</span>`:'';return `<tr><td>${status}</td><td>${date(x.dueDate)}<div class="small muted">RE ${date(x.issueDate)}</div></td><td><strong>${esc(x.customer)}</strong><div class="small muted">${esc(x.customerName||'')}</div></td><td><strong>${esc(x.invoiceNumber)}</strong><div class="small muted">${esc(x.kind)} · ${source}</div></td><td>${esc(x.projectNumber||'–')}<div class="small muted">${esc(x.projectTitle||x.runLabel||'')}</div></td><td class="money">${money(x.openGross)}<div class="small muted">von ${money(x.invoiceGross)}</div></td><td class="dunning"><div class="dunning-line"><strong>${esc(mahn)}</strong>${blocked}</div><div class="dunning-line screen-only">${next}${mahnPdf}<label class="lock"><input type="checkbox" data-lock="${x.invoiceId}" ${x.dunningBlockedLocal?'checked':''}> Mahnsperre</label></div><textarea class="op-note screen-only" data-note="${x.invoiceId}" placeholder="Notiz zum offenen Posten">${esc(x.opNote||'')}</textarea><div class="print-only small">${x.opNote?'Notiz: '+esc(x.opNote):''}</div></td><td class="actions screen-only">${pdf}<button class="good" data-pay="${x.invoiceId}">Zahlung</button></td></tr>`}
function table(xs){return `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Fällig / Rechnung</th><th>Kunde</th><th>Rechnung</th><th>Projekt</th><th class="money">Offen</th><th>Mahnung / Notiz</th><th class="screen-only"></th></tr></thead><tbody>${xs.map(row).join('')}</tbody></table></div>`}
function render(){const q=$('search').value.trim().toLocaleLowerCase('de'),filtered=sorted(items.filter(x=>!q||[x.customer,x.customerName,x.invoiceNumber,x.projectNumber,x.projectTitle,x.runLabel,x.opNote].join(' ').toLocaleLowerCase('de').includes(q)));if(!filtered.length){$('rows').innerHTML='<div class="card empty">Keine passenden offenen Posten.</div>';return}if($('view').value==='list')$('rows').innerHTML=`<div class="group">${table(filtered)}</div>`;else{const groups=new Map();filtered.forEach(x=>{if(!groups.has(x.customerKey))groups.set(x.customerKey,[]);groups.get(x.customerKey).push(x)});$('rows').innerHTML=[...groups.values()].map(xs=>`<div class="group"><div class="group-head"><strong>${esc(xs[0].customer)}</strong><span>${xs.length} Rechnung(en) · <strong>${money(xs.reduce((s,x)=>s+x.openGross,0))}</strong></span></div>${table(xs)}</div>`).join('')}document.querySelectorAll('[data-pay]').forEach(b=>b.onclick=()=>openPayment(Number(b.dataset.pay)));document.querySelectorAll('[data-lock]').forEach(e=>e.onchange=()=>saveMeta(Number(e.dataset.lock),{dunningBlocked:e.checked},true));document.querySelectorAll('[data-note]').forEach(e=>e.onchange=()=>saveMeta(Number(e.dataset.note),{note:e.value},false));document.querySelectorAll('[data-dun]').forEach(b=>b.onclick=()=>createDunning(Number(b.dataset.dun),Number(b.dataset.level)))}
async function load(sync=false){const d=await api('/api/outgoing/open-items'+(sync?'?sync=1':''));items=d.items;$('total').textContent=money(d.totalOpen);$('overdue').textContent=money(d.totalOverdue);$('customers').textContent=d.customerCount;$('count').textContent=items.length;const s=d.lastWwSync;$('syncInfo').textContent=s.at?'Letzter WW-Abgleich: '+date(s.at)+' '+String(s.at).slice(11,16)+' Uhr':'Noch kein WW-Abgleich';render()}
function openPayment(id){payItem=items.find(x=>x.invoiceId===id);if(!payItem)return;$('payTarget').textContent=`${payItem.customer} · Rechnung ${payItem.invoiceNumber} · offen ${money(payItem.openGross)}`;$('payDate').value=today();$('payGross').value=String(payItem.openGross).replace('.',',');$('payRef').value='';$('payment').classList.remove('hide')}
async function savePayment(){try{await api(`/api/outgoing/runs/${payItem.runId}/payments`,{method:'POST',body:JSON.stringify({invoiceId:payItem.invoiceId,paymentDate:$('payDate').value,gross:$('payGross').value,reference:$('payRef').value})});$('payment').classList.add('hide');msg('Zahlung wurde zugeordnet.');await load(false)}catch(e){msg(e.message,true)}}
async function saveMeta(id,payload,reload){try{await api(`/api/outgoing/invoices/${id}/debtor-meta`,{method:'PUT',body:JSON.stringify(payload)});msg(payload.note!==undefined?'Notiz gespeichert.':'Mahnsperre gespeichert.');if(reload)await load(false)}catch(e){msg(e.message,true);await load(false)}}
async function createDunning(id,level){if(!confirm(`Mahnung ${level} jetzt erstellen?`))return;try{const d=await api(`/api/outgoing/invoices/${id}/dunnings`,{method:'POST',body:JSON.stringify({dunningDate:today()})});msg(`Mahnung ${d.dunning.level} wurde erstellt.`);await load(false);window.open(d.pdfUrl,'_blank')}catch(e){msg(e.message,true)}}
$('search').oninput=render;$('sort').onchange=render;$('view').onchange=render;$('paySave').onclick=savePayment;$('payCancel').onclick=()=>$('payment').classList.add('hide');$('print').onclick=()=>{const old=$('view').value;$('view').value='list';render();setTimeout(()=>{window.print();$('view').value=old;render()},60)};$('sync').onclick=async()=>{try{const d=await api('/api/outgoing/sync-ww',{method:'POST',body:'{}'});msg(`${d.imported} neue WW-Rechnung(en) übernommen.`);await load(false)}catch(e){msg(e.message,true)}};load(true).catch(e=>msg(e.message,true));})();
</script></body></html>'''
