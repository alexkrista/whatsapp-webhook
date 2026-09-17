# coding: utf-8
"""Historisches Eingangsrechnungsbuch mit nachvollziehbarer Statuskorrektur."""
from __future__ import annotations

import secrets
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from brain_finance_source import norm_method, norm_status
from brain_finance_source_v2 import FinanceStore


def _now():
    return datetime.now().isoformat(timespec="seconds")


class InvoiceBook:
    def __init__(self, ns):
        self.ns = ns
        self.store = FinanceStore(ns)

    def db(self):
        con = self.store.con()
        con.execute("""
            CREATE TABLE IF NOT EXISTS brain_invoice_status_history(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                source_id TEXT NOT NULL,
                old_status TEXT NOT NULL,
                new_status TEXT NOT NULL,
                old_method TEXT NOT NULL,
                new_method TEXT NOT NULL,
                source_status TEXT NOT NULL,
                reason TEXT NOT NULL,
                changed_by TEXT NOT NULL,
                changed_at TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_brain_invoice_status_history_invoice ON brain_invoice_status_history(source,source_id,changed_at DESC)")
        con.commit()
        return con

    def _pdfs(self, rows):
        lookup = self.ns.get("_pdf_paths_by_docids")
        docs = [str(row.get("docId") or "").strip() for row in rows if str(row.get("docId") or "").strip()]
        found = {}
        if callable(lookup) and docs:
            try:
                found = lookup(docs, include_text=False)
            except Exception:
                found = {}
        for row in rows:
            hit = found.get(str(row.get("docId") or "").strip(), {})
            row["path"] = str(hit.get("pdfPath") or hit.get("originalPath") or row.get("path") or "")
        return rows

    def _ww(self, query="", year=0, one_id=None):
        sql_connection = self.ns.get("sql_connection")
        payment_state = self.ns.get("_payment_state")
        iso = self.ns.get("_iso_date")
        if not callable(sql_connection):
            return []
        query = str(query or "").strip()
        pattern = "%" + query + "%"
        where = []
        args = []
        if one_id is not None:
            where.append("e.cID=?")
            args.append(int(one_id))
        else:
            if query:
                where.append("(k.sFirma LIKE ? OR k.sName LIKE ? OR k.sVorname LIKE ? OR e.sBelegnummer LIKE ? OR dm.sDocID LIKE ?)")
                args.extend([pattern] * 5)
            if int(year or 0):
                where.append("YEAR(e.dzBelegdatum)=?")
                args.append(int(year))
        clause = " WHERE " + " AND ".join(where) if where else ""
        con = sql_connection("WinWorker_Projekte_Standard")
        try:
            rows = con.cursor().execute("""
                SELECT TOP 500 e.cID,e.sBelegnummer,e.dzBelegdatum,e.dblBruttoBetrag,
                       e.sZahlungsStatus,e.sIban,e.sSwift,e.sBankkontoInhaber,
                       dm.sDocID,k.sFirma,k.sName,k.sVorname
                FROM dbo.Eingangsbelege e
                LEFT JOIN dbo.DokumentenManagement dm ON dm.gID=e.gDMID
                LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden k ON k.StammIndex=e.lVonAdrIndex
            """ + clause + " ORDER BY e.dzBelegdatum DESC,e.cID DESC", *args).fetchall()
        finally:
            con.close()
        meta = self.store.meta()
        overrides = self.store.status_overrides()
        legacy = self.store.legacy()
        out = []
        for raw in rows:
            sid = "ww:" + str(int(raw.cID))
            key = ("WinWorker", sid)
            ex = meta.get(key, {})
            source_status = norm_status(payment_state(raw.sZahlungsStatus) if callable(payment_state) else raw.sZahlungsStatus)
            if key in overrides:
                status = norm_status(overrides[key])
            elif source_status != "open":
                status = source_status
            elif legacy.get(sid, {}).get("status") == "paid":
                status = "paid"
            else:
                status = norm_status(ex.get("paymentStatus")) if key in meta else source_status
            company = str(raw.sFirma or "").strip()
            person = " ".join(x for x in (str(raw.sVorname or "").strip(), str(raw.sName or "").strip()) if x)
            date = iso(raw.dzBelegdatum) if callable(iso) else str(raw.dzBelegdatum or "")[:10]
            method = norm_method(ex.get("paymentMethod"))
            out.append({
                "source": "WinWorker", "id": sid, "docId": str(raw.sDocID or "").strip(),
                "supplier": company or person or "WinWorker-Lieferant",
                "invoiceNumber": str(raw.sBelegnummer or "").strip(), "invoiceDate": date or "",
                "amount": float(raw.dblBruttoBetrag or 0), "currency": "EUR",
                "paymentStatus": status, "paymentMethod": method,
                "sourcePaymentStatus": source_status, "sourcePaymentLabel": str(raw.sZahlungsStatus or "").strip(),
                "statusOverride": bool(key in overrides and status != source_status),
                "iban": str(raw.sIban or "").strip(), "bic": str(raw.sSwift or "").strip(),
                "accountHolder": str(raw.sBankkontoInhaber or "").strip(), "path": "",
            })
        return self._pdfs(out)

    def _local(self, query="", year=0, one_id=None):
        connect = self.ns.get("_capture_connection")
        db_path = self.ns.get("CAPTURE_DB")
        if not callable(connect):
            return []
        where = []
        args = []
        if one_id is not None:
            where.append("id=?")
            args.append(int(one_id))
        else:
            query = str(query or "").strip()
            if query:
                pattern = "%" + query + "%"
                where.append("(supplier_name LIKE ? OR supplier_invoice_number LIKE ? OR doc_id LIKE ?)")
                args.extend([pattern] * 3)
            if int(year or 0):
                where.append("substr(invoice_date,1,4)=?")
                args.append(str(int(year)))
        clause = " WHERE " + " AND ".join(where) if where else ""
        con = connect(db_path)
        try:
            rows = con.execute("""
                SELECT id,doc_id,supplier_name,supplier_invoice_number,invoice_date,
                       gross_amount,currency,iban,swift,account_holder,payment_state,
                       payment_status,payment_method,pdf_path
                FROM incoming_invoices
            """ + clause + " ORDER BY invoice_date DESC,id DESC LIMIT 500", args).fetchall()
        finally:
            con.close()
        meta = self.store.meta()
        out = []
        for raw in rows:
            sid = "kristine:" + str(int(raw["id"]))
            key = ("KRISTINE", sid)
            ex = meta.get(key, {})
            source_status = norm_status(raw["payment_state"] or raw["payment_status"])
            status = norm_status(ex.get("paymentStatus")) if key in meta else source_status
            method = norm_method(ex.get("paymentMethod") or raw["payment_method"])
            out.append({
                "source": "KRISTINE", "id": sid, "docId": str(raw["doc_id"] or ""),
                "supplier": str(raw["supplier_name"] or ""), "invoiceNumber": str(raw["supplier_invoice_number"] or ""),
                "invoiceDate": str(raw["invoice_date"] or ""), "amount": float(raw["gross_amount"] or 0),
                "currency": str(raw["currency"] or "EUR"), "paymentStatus": status,
                "paymentMethod": method, "sourcePaymentStatus": source_status,
                "sourcePaymentLabel": str(raw["payment_status"] or raw["payment_state"] or ""),
                "statusOverride": bool(key in meta and status != source_status),
                "iban": str(raw["iban"] or ""), "bic": str(raw["swift"] or ""),
                "accountHolder": str(raw["account_holder"] or ""), "path": str(raw["pdf_path"] or ""),
            })
        return out

    def items(self, query="", year=0):
        rows = self._ww(query, year) + self._local(query, year)
        local_docs = {x["docId"] for x in rows if x["source"] == "KRISTINE" and x.get("docId")}
        rows = [x for x in rows if x["source"] == "KRISTINE" or not x.get("docId") or x["docId"] not in local_docs]
        rows.sort(key=lambda x: (str(x.get("invoiceDate") or ""), str(x.get("supplier") or "").lower()), reverse=True)
        return rows[:500]

    def one(self, source, source_id):
        if source == "WinWorker" and str(source_id).startswith("ww:"):
            rows = self._ww(one_id=int(str(source_id).split(":", 1)[1]))
        elif source == "KRISTINE" and str(source_id).startswith("kristine:"):
            rows = self._local(one_id=int(str(source_id).split(":", 1)[1]))
        else:
            raise ValueError("Ungültige Rechnung.")
        if not rows:
            raise ValueError("Rechnung wurde nicht gefunden.")
        return rows[0]

    def history(self, source, source_id):
        con = self.db()
        try:
            return [dict(row) for row in con.execute("SELECT * FROM brain_invoice_status_history WHERE source=? AND source_id=? ORDER BY changed_at DESC,id DESC LIMIT 100", (source, source_id)).fetchall()]
        finally:
            con.close()

    def change(self, source, source_id, action, reason, changed_by="Alex"):
        reason = " ".join(str(reason or "").split())[:500]
        if len(reason) < 3:
            raise ValueError("Bitte den Grund für die Statusänderung angeben.")
        before = self.one(source, source_id)
        old_status = norm_status(before.get("paymentStatus"))
        old_method = norm_method(before.get("paymentMethod"))
        if action == "repay":
            new_status, new_method = "open", "transfer"
        elif action == "paid":
            new_status, new_method = "paid", old_method
        else:
            raise ValueError("Unbekannte Statusänderung.")
        if source == "WinWorker":
            if action == "repay":
                self.store.set_legacy(source_id, False)
                self.store.set_status_override(source, source_id, "open")
            else:
                self.store.set_status_override(source, source_id, None)
            self.store.set_meta(source, source_id, method=new_method, status=new_status, note=reason)
        else:
            connect = self.ns.get("_capture_connection")
            con = connect(self.ns.get("CAPTURE_DB"))
            try:
                invoice_id = int(str(source_id).split(":", 1)[1])
                con.execute("UPDATE incoming_invoices SET payment_state=?,payment_status=?,payment_method=?,updated_at=? WHERE id=?", (new_status, "Bezahlt" if new_status == "paid" else "Offen", new_method, _now(), invoice_id))
                con.commit()
            finally:
                con.close()
            self.store.set_meta(source, source_id, method=new_method, status=new_status, note=reason)
        con = self.db()
        try:
            con.execute("INSERT INTO brain_invoice_status_history(source,source_id,old_status,new_status,old_method,new_method,source_status,reason,changed_by,changed_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (source, source_id, old_status, new_status, old_method, new_method, str(before.get("sourcePaymentStatus") or ""), reason, str(changed_by or "Alex")[:100], _now()))
            con.commit()
        finally:
            con.close()
        return self.one(source, source_id)


def install(ns):
    if ns.get("invoice_book"):
        return
    app = ns["app"]
    book = InvoiceBook(ns)
    ns["invoice_book"] = book
    token = secrets.token_urlsafe(32)
    paths = {"/incoming/invoice-book", "/incoming/invoice-book/items", "/incoming/invoice-book/status", "/incoming/invoice-book/history"}
    ns["MOBILE_ALLOWED_PATHS"].update(paths)

    from flask import Response, jsonify, request

    @app.before_request
    def invoice_book_guard():
        if request.path == "/incoming/invoice-book/status":
            if urlsplit(request.headers.get("Origin", "")).netloc != request.host or not secrets.compare_digest(request.headers.get("X-Invoice-Book", ""), token):
                return jsonify(ok=False, error="Bitte Rechnungsbuch neu laden."), 403
            if not request.content_length or request.content_length > 8000:
                return jsonify(ok=False, error="Eingabe fehlt oder ist zu groß."), 400

    @app.after_request
    def invoice_book_headers(response):
        if request.path in paths:
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
        return response

    @app.get("/incoming/invoice-book")
    def invoice_book_page():
        html = (Path(__file__).resolve().parent / "public" / "invoice-book.html").read_text(encoding="utf-8")
        return Response(html.replace("__TOKEN__", token), mimetype="text/html")

    @app.get("/incoming/invoice-book/items")
    def invoice_book_items():
        try:
            query = str(request.args.get("q") or "").strip()[:100]
            year = int(request.args.get("year") or 0)
            rows = book.items(query, year)
            return jsonify(ok=True, count=len(rows), items=rows)
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    @app.get("/incoming/invoice-book/history")
    def invoice_book_history():
        try:
            return jsonify(ok=True, items=book.history(str(request.args.get("source") or ""), str(request.args.get("id") or "")))
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    @app.post("/incoming/invoice-book/status")
    def invoice_book_status():
        try:
            body = request.get_json(silent=True) or {}
            row = book.change(str(body.get("source") or ""), str(body.get("id") or ""), str(body.get("action") or ""), body.get("reason"), body.get("changedBy") or "Alex")
            return jsonify(ok=True, invoice=row, message="Rechnung ist wieder im Zahlungslauf." if body.get("action") == "repay" else "Rechnung wurde als bezahlt markiert.")
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    print("✅ Rechnungsbuch aktiv: Historie · bezahlt · erneut in den Zahlungslauf")
