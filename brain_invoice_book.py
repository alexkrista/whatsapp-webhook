# coding: utf-8
"""Historisches Eingangsrechnungsbuch mit nachvollziehbarer Statuskorrektur."""
from __future__ import annotations

import secrets
import threading
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from brain_finance_source import norm_method, norm_status, winworker_method
from brain_finance_source_v2 import FinanceStore

BOOK_LOCK = threading.RLock()
LEGACY_PAID_CUTOFF = "2025-11-26"


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _effective_ww_status(source_status, meta_status, explicit_status="", legacy_paid=False):
    """Use exactly the same status precedence as the operative creditor list."""
    source_status = norm_status(source_status)
    meta_status = norm_status(meta_status)
    explicit_status = norm_status(explicit_status) if explicit_status else ""
    if meta_status == "sepa_submitted":
        return "sepa_submitted"
    if explicit_status:
        return explicit_status
    if source_status != "open":
        return source_status
    if legacy_paid:
        return "paid"
    return meta_status


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
        con.execute("""
            CREATE TABLE IF NOT EXISTS brain_invoice_book_numbers(
                book_number INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                source_id TEXT NOT NULL,
                booked_at TEXT NOT NULL,
                UNIQUE(source,source_id)
            )
        """)
        con.execute("CREATE TABLE IF NOT EXISTS brain_invoice_book_migrations(name TEXT PRIMARY KEY,details TEXT NOT NULL,created_at TEXT NOT NULL)")
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

    def _ww(self, query="", year=0, one_id=None, limit=5000, with_pdfs=True):
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
            safe_limit = max(1, min(20000, int(limit or 5000)))
            rows = con.cursor().execute(f"""
                SELECT TOP {safe_limit} e.cID,e.sBelegnummer,e.dzBelegdatum,e.dblBruttoBetrag,
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
            meta_status = norm_status(ex.get("paymentStatus")) if key in meta else "open"
            status = _effective_ww_status(
                source_status,
                meta_status,
                overrides.get(key, ""),
                legacy.get(sid, {}).get("status") == "paid",
            )
            company = str(raw.sFirma or "").strip()
            person = " ".join(x for x in (str(raw.sVorname or "").strip(), str(raw.sName or "").strip()) if x)
            date = iso(raw.dzBelegdatum) if callable(iso) else str(raw.dzBelegdatum or "")[:10]
            method = winworker_method(ex.get("paymentMethod"), raw.sZahlungsStatus)
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
        return self._pdfs(out) if with_pdfs else out

    def _local(self, query="", year=0, one_id=None, limit=5000):
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
            safe_limit = max(1, min(20000, int(limit or 5000)))
            rows = con.execute("""
                SELECT id,doc_id,supplier_name,supplier_invoice_number,invoice_date,
                       gross_amount,currency,iban,swift,account_holder,payment_state,
                       payment_status,payment_method,pdf_path
                FROM incoming_invoices
            """ + clause + " ORDER BY invoice_date DESC,id DESC LIMIT ?", args + [safe_limit]).fetchall()
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

    def _with_bank_status(self, rows):
        """Overlay booked bank payments without changing the historic invoice amount."""
        overlay = self.ns.get("bank_supplier_overlay")
        if not callable(overlay) or not rows:
            return rows
        originals = {
            (str(row.get("source") or ""), str(row.get("id") or "")): float(row.get("amount") or 0)
            for row in rows
        }
        resolved = overlay([dict(row) for row in rows], True)
        resolved_by_key = {
            (str(row.get("source") or ""), str(row.get("id") or "")): row
            for row in resolved
        }
        for row in rows:
            key = (str(row.get("source") or ""), str(row.get("id") or ""))
            hit = resolved_by_key.get(key)
            if not hit:
                continue
            row["paymentStatus"] = norm_status(hit.get("paymentStatus"))
            row["paymentState"] = norm_status(hit.get("paymentState") or hit.get("paymentStatus"))
            if "bankPaid" in hit:
                row["bankPaid"] = hit.get("bankPaid")
                row["openAmount"] = float(hit.get("amount") or 0)
            row["amount"] = originals[key]
        return rows

    def ensure_numbers(self):
        with BOOK_LOCK:
            con = self.db()
            try:
                seeded = con.execute("SELECT 1 FROM brain_invoice_book_migrations WHERE name='book-numbers-v1'").fetchone()
            finally:
                con.close()
            if seeded:
                return
            rows = self._ww("", 0, limit=20000, with_pdfs=False) + self._local("", 0, limit=20000)
            local_docs = {x["docId"] for x in rows if x["source"] == "KRISTINE" and x.get("docId")}
            rows = [x for x in rows if x["source"] == "KRISTINE" or not x.get("docId") or x["docId"] not in local_docs]
            rows.sort(key=lambda x: (str(x.get("invoiceDate") or "9999-12-31"), str(x.get("source") or ""), str(x.get("id") or "")))
            con = self.db()
            try:
                for row in rows:
                    con.execute("INSERT OR IGNORE INTO brain_invoice_book_numbers(source,source_id,booked_at) VALUES(?,?,?)", (row["source"], row["id"], str(row.get("invoiceDate") or "")))
                con.execute("INSERT OR REPLACE INTO brain_invoice_book_migrations(name,details,created_at) VALUES('book-numbers-v1',?,?)", (f"{len(rows)} Rechnungen chronologisch nummeriert", _now()))
                con.commit()
            finally:
                con.close()

    def add_numbers(self, rows):
        self.ensure_numbers()
        con = self.db()
        try:
            for row in sorted(rows, key=lambda x: (str(x.get("invoiceDate") or "9999-12-31"), str(x.get("source") or ""), str(x.get("id") or ""))):
                con.execute("INSERT OR IGNORE INTO brain_invoice_book_numbers(source,source_id,booked_at) VALUES(?,?,?)", (row["source"], row["id"], str(row.get("invoiceDate") or "")))
            con.commit()
            numbers = {(str(x["source"]), str(x["source_id"])): int(x["book_number"]) for x in con.execute("SELECT source,source_id,book_number FROM brain_invoice_book_numbers").fetchall()}
        finally:
            con.close()
        for row in rows:
            number = numbers.get((row["source"], row["id"]))
            row["bookNumber"] = f"B{number:06d}" if number else ""
        return rows

    def items(self, query="", year=0):
        rows = self._ww(query, year) + self._local(query, year)
        local_docs = {x["docId"] for x in rows if x["source"] == "KRISTINE" and x.get("docId")}
        rows = [x for x in rows if x["source"] == "KRISTINE" or not x.get("docId") or x["docId"] not in local_docs]
        rows = self._with_bank_status(rows)
        rows.sort(key=lambda x: (str(x.get("invoiceDate") or ""), str(x.get("supplier") or "").lower()), reverse=True)
        return self.add_numbers(rows[:10000])

    def monthly_totals(self, rows):
        months = {}
        for row in rows:
            month = str(row.get("invoiceDate") or "")[:7] or "Ohne Datum"
            bucket = months.setdefault(month, {"month": month, "count": 0, "total": 0.0, "paid": 0.0, "open": 0.0})
            value = round(float(row.get("amount") or 0), 2)
            bucket["count"] += 1
            bucket["total"] += value
            bucket["paid" if norm_status(row.get("paymentStatus")) == "paid" else "open"] += value
        return [{**x, "total": round(x["total"], 2), "paid": round(x["paid"], 2), "open": round(x["open"], 2)} for _, x in sorted(months.items(), reverse=True)]

    def apply_legacy_paid_cutoff(self):
        migration = "unknown-paid-through-2025-11-26"
        with BOOK_LOCK:
            con = self.db()
            try:
                row = con.execute("SELECT details,created_at FROM brain_invoice_book_migrations WHERE name=?", (migration,)).fetchone()
                if row:
                    return {"applied": False, "details": str(row["details"]), "createdAt": str(row["created_at"])}
            finally:
                con.close()
            candidates = [
                item for item in self.store.items(False)
                if norm_method(item.get("paymentMethod")) == "unknown"
                and str(item.get("invoiceDate") or "")[:10] <= LEGACY_PAID_CUTOFF
            ]
            reason = "Altbestand Zahlungsart ungeklärt bis einschließlich 26.11.2025 automatisch als bezahlt gebucht"
            con = self.db()
            try:
                now = _now()
                con.execute("BEGIN IMMEDIATE")
                for item in candidates:
                    source = str(item.get("source") or "")
                    source_id = str(item.get("id") or "")
                    method = norm_method(item.get("paymentMethod"))
                    if source == "KRISTINE":
                        invoice_id = int(source_id.split(":", 1)[1])
                        con.execute(
                            "UPDATE incoming_invoices SET payment_state='paid',payment_status='Bezahlt',updated_at=? WHERE id=?",
                            (now, invoice_id),
                        )
                    con.execute(
                        "INSERT INTO brain_payment_meta(source,source_id,payment_method,payment_status,payment_id,note,updated_at) "
                        "VALUES(?,?,?,'paid','',?,?) ON CONFLICT(source,source_id) DO UPDATE SET "
                        "payment_status='paid',note=excluded.note,updated_at=excluded.updated_at",
                        (source, source_id, method, reason, now),
                    )
                    con.execute(
                        "INSERT INTO brain_invoice_status_history(source,source_id,old_status,new_status,old_method,new_method,source_status,reason,changed_by,changed_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (
                            source, source_id, norm_status(item.get("paymentStatus")), "paid",
                            method, method, str(item.get("sourcePaymentStatus") or ""),
                            reason, "KRISTINE Automatik", now,
                        ),
                    )
                details = f"{len(candidates)} ungeklärte Rechnungen bis einschließlich {LEGACY_PAID_CUTOFF} als bezahlt gebucht"
                con.execute("INSERT INTO brain_invoice_book_migrations(name,details,created_at) VALUES(?,?,?)", (migration, details, _now()))
                con.commit()
            finally:
                con.close()
            return {"applied": True, "details": details, "createdAt": _now()}

    def one(self, source, source_id):
        if source == "WinWorker" and str(source_id).startswith("ww:"):
            rows = self._ww(one_id=int(str(source_id).split(":", 1)[1]))
        elif source == "KRISTINE" and str(source_id).startswith("kristine:"):
            rows = self._local(one_id=int(str(source_id).split(":", 1)[1]))
        else:
            raise ValueError("Ungültige Rechnung.")
        if not rows:
            raise ValueError("Rechnung wurde nicht gefunden.")
        return self._with_bank_status(rows)[0]

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
        elif action == "open":
            new_status, new_method = "open", old_method
        elif action == "paid":
            new_status, new_method = "paid", old_method
        else:
            raise ValueError("Unbekannte Statusänderung.")
        if source == "WinWorker":
            if action in {"repay", "open"}:
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
            cutoff = book.apply_legacy_paid_cutoff()
            rows = book.items(query, year)
            return jsonify(ok=True, count=len(rows), items=rows, months=book.monthly_totals(rows), cutoff=cutoff)
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
            action = str(body.get("action") or "")
            message = "Rechnung ist wieder im Zahlungslauf." if action == "repay" else "Rechnung wurde wieder geöffnet." if action == "open" else "Rechnung wurde als bezahlt markiert."
            return jsonify(ok=True, invoice=row, message=message)
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    print("✅ Rechnungsbuch aktiv: Buchungsnummer · Monatssalden · Statuskorrektur · Altbestand-Stichtag")
