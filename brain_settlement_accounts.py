# coding: utf-8
"""Alex Privat and DLZ settlement ledgers for THE BRAIN.

A settled customer payment is booked to outgoing_payments and the DLZ
clearing ledger in ONE SQLite transaction. Neither ledger is a second
income/expense book. Existing bank allocations are never automatically
reposted. Entries are immutable; mistakes require a dated reversal.
"""
from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import secrets
import sqlite3
import threading
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from urllib.parse import urlsplit

_LOCK = threading.RLock()
_ACCOUNTS = {"alex", "dlz"}
_KINDS = {
    "alex": {
        "contribution": ("Verrechnungs-Gutschrift", +1, "private"),
        "private_expense": ("Firma privat bezahlt", +1, "private"),
        "withdrawal": ("Entnahme / Auszahlung", -1, "private"),
        "wage_due": ("Noch auszuzahlender Lohn", +1, "wage"),
        "wage_paid": ("Lohn ausgezahlt", -1, "wage"),
    },
    "dlz": {
        "customer_receipt": ("Kundenzahlung über DLZ", +1, "clearing"),
        "liability_settlement": ("ÖGK / Abgaben / Verrechnung", -1, "clearing"),
    },
}
_MAX_DOC = 8_000_000


def _money(value):
    try:
        result = Decimal(str(value).replace(",", "."))
        if not result.is_finite() or result != result.quantize(Decimal("0.01")) or result <= 0 or result > Decimal("10000000"):
            raise ValueError()
        return int(result * 100)
    except (ValueError, TypeError, InvalidOperation):
        raise ValueError("Betrag muss positiv sein, höchstens zwei Nachkommastellen haben und darf 10 Mio. EUR nicht überschreiten.") from None


def _formatted(value):
    return format(Decimal(int(value)) / 100, ".2f")


def _day(value):
    try:
        day = date.fromisoformat(str(value))
        if day.isoformat() != str(value) or day > date.today():
            raise ValueError()
        return day.isoformat()
    except (ValueError, TypeError):
        raise ValueError("Ungültiges oder zukünftiges Buchungsdatum.") from None


def _text(value, max_len, name, required=False):
    result = str(value or "").strip()
    if (required and not result) or len(result) > max_len:
        raise ValueError(name + " fehlt oder ist zu lang.")
    return result


def _today():
    return datetime.now().isoformat(timespec="seconds")


class SettlementLedger:
    def __init__(self, outgoing, ns=None):
        self.outgoing = outgoing
        self.ns = ns or {}

    def connect(self):
        # All ledger rows and outgoing customer payments live in the SAME database.
        # One BEGIN IMMEDIATE protects both sides of each DLZ customer receipt.
        con = self.outgoing.connect()
        con.execute("""
        CREATE TABLE IF NOT EXISTS brain_settlement_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account TEXT NOT NULL CHECK(account IN ('alex','dlz')),
          kind TEXT NOT NULL,
          ledger TEXT NOT NULL,
          booking_date TEXT NOT NULL,
          signed_cents INTEGER NOT NULL,
          counterparty TEXT NOT NULL,
          purpose TEXT NOT NULL,
          reference TEXT NOT NULL DEFAULT '',
          external_ref TEXT,
          client_request TEXT NOT NULL UNIQUE,
          invoice_id INTEGER,
          outgoing_payment_id INTEGER UNIQUE,
          reversal_of INTEGER UNIQUE REFERENCES brain_settlement_entries(id),
          reversed_by INTEGER,
          created_at TEXT NOT NULL
        )""")
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS brain_settlement_external_ref ON brain_settlement_entries(account,external_ref) WHERE external_ref IS NOT NULL")
        con.execute("CREATE INDEX IF NOT EXISTS brain_settlement_by_account ON brain_settlement_entries(account,booking_date,id)")
        con.execute("""
        CREATE TABLE IF NOT EXISTS brain_settlement_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id INTEGER NOT NULL REFERENCES brain_settlement_entries(id),
          filename TEXT NOT NULL,
          mime TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          content BLOB NOT NULL,
          uploaded_at TEXT NOT NULL,
          UNIQUE(entry_id,sha256)
        )""")
        con.commit()
        return con

    @staticmethod
    def _public(row):
        x = dict(row)
        x["amount"] = _formatted(x.pop("signed_cents"))
        x["balanceType"] = x.pop("ledger")
        x["createdAt"] = x.pop("created_at")
        x["date"] = x.pop("booking_date")
        x["id"] = int(x["id"])
        return x

    def bank_alex(self, con):
        """View existing classified KONFIPAY postings, WITHOUT creating another entry."""
        exists = con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bank_assignment_lines'").fetchone()
        if not exists:
            return []
        rows = []
        for item in con.execute("""
            SELECT l.id,l.rid,l.paid,l.reason,t.payload
            FROM bank_assignment_lines l
            JOIN bank_assignment_transactions t ON t.rid=l.rid
            WHERE l.category='alex_private'
            ORDER BY l.id
        """):
            try:
                tx = json.loads(item["payload"])
                dr = str(tx.get("creditDebitIndicator") or "").upper()
                sign = +1 if dr in {"CRDT","CR","CREDIT"} else -1 if dr in {"DBIT","DR","DEBIT"} else 0
                if not sign:
                    continue
                rows.append({
                    "id": "bank-"+str(item["id"]), "account": "alex",
                    "kind": "contribution" if sign > 0 else "withdrawal",
                    "balanceType": "private",
                    "date": str(tx.get("bookingDate") or "")[:10],
                    "amount": _formatted(sign * int(item["paid"])),
                    "counterparty": str(tx.get("counterpartName") or tx.get("counterpartyName") or "Bankbuchung")[:150],
                    "purpose": str(tx.get("purpose") or "Bereits zugeordnete Bankbuchung")[:300],
                    "reference": str(item["rid"]), "external_ref": str(item["rid"]),
                    "origin": "KONFIPAY", "locked": True,
                    "createdAt": "", "reversed_by": None,
                })
            except (ValueError, TypeError, KeyError):
                continue
        return rows

    def revolut_alex(self):
        """Read current private allocations; never duplicate or persist another posting."""
        factory=self.ns.get('_capture_connection')
        if not callable(factory):return []
        c=factory(self.ns['CAPTURE_DB'])
        try:
            tables={x[0] for x in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'brain_statement_movements','brain_statement_allocations'}<=tables:return []
            rows=[]
            for item in c.execute("""
                SELECT a.id,a.category,a.amount,a.note,a.created_at,
                       m.source,m.external_id,m.booking_date,m.currency,m.counterparty_name,m.reference,m.raw_text,m.id AS movement_id
                FROM brain_statement_allocations a
                JOIN brain_statement_movements m ON m.id=a.movement_id
                WHERE m.source IN ('REVOLUT','REVOLUT_BUSINESS')
                  AND a.category IN ('alex_withdrawal','alex_contribution')
                ORDER BY m.booking_date,a.id
            """):
                x=dict(item);sign=1 if x['category']=='alex_contribution' else -1
                cents=int((Decimal(str(x['amount']))*100).quantize(Decimal('1'),rounding=ROUND_HALF_UP))
                rows.append({'id':'revolut-'+str(x['id']),'account':'alex',
                    'kind':'contribution' if sign>0 else 'withdrawal','balanceType':'private',
                    'date':str(x['booking_date'] or '')[:10],'amount':_formatted(sign*abs(cents)),
                    'currency':str(x['currency'] or 'EUR').upper(),
                    'counterparty':str(x['counterparty_name'] or 'Revolut')[:160],
                    'purpose':str(x['note'] or x['raw_text'] or 'Privat zugeordnet')[:500],
                    'reference':str(x['reference'] or x['external_id'] or ''),
                    'origin':'Revolut Business' if x['source']=='REVOLUT_BUSINESS' else 'Revolut',
                    'locked':True,'createdAt':str(x['created_at'] or ''),'reversed_by':None})
            return rows
        finally:c.close()

    def list(self, account):
        if account not in _ACCOUNTS:
            raise ValueError("Unbekanntes Verrechnungskonto.")
        with _LOCK:
            c = self.connect()
            try:
                rows = [self._public(row) for row in c.execute(
                    "SELECT * FROM brain_settlement_entries WHERE account=? ORDER BY booking_date,id", (account,),
                )]
                if account == "alex":
                    rows.extend(self.bank_alex(c))
                    rows.extend(self.revolut_alex())
                rows.sort(key=lambda row: (row["date"], str(row["id"])))
                balances = {"private": 0, "wage": 0, "clearing": 0}
                foreign = {}
                for row in rows:
                    kind = row["balanceType"]
                    currency=row.get('currency','EUR')
                    bucket=balances if currency=='EUR' else foreign.setdefault(currency,{'private':0,'wage':0,'clearing':0})
                    bucket[kind] += int(Decimal(row["amount"]) * 100)
                    row["runningBalance"] = _formatted(bucket[kind])
                    row["documents"] = 0 if isinstance(row["id"], str) else c.execute(
                        "SELECT COUNT(*) FROM brain_settlement_files WHERE entry_id=?", (row["id"],),
                    ).fetchone()[0]
                rows.reverse()
                return {
                    "account": account,
                    "balances": {name: _formatted(value) for name, value in balances.items()},
                    "foreignBalances": {currency:{key:_formatted(value) for key,value in bucket.items()} for currency,bucket in foreign.items()},
                    "rows": rows,
                    "count": len(rows),
                    "note": ("Privat zugeordnete Bank- und Revolut-Buchungen werden automatisch angezeigt. Korrekturen dieser Buchungen erfolgen im jeweiligen Bankabgleich."
                             if account == "alex" else
                             "DLZ ist ein Verrechnungskonto: diese Buchungen erzeugen keinen zweiten Umsatz oder Aufwand."),
                }
            finally:
                c.close()

    def _invoice_open_locked(self, c, invoice_id):
        """Same allocation precedence as OutgoingStore.debtor_open_items, scoped to invoice."""
        invoice = c.execute("SELECT * FROM outgoing_invoices WHERE id=? AND status='issued'", (invoice_id,)).fetchone()
        if invoice is None or invoice["kind"] not in {"TR", "SR", "RE"}:
            raise ValueError("Rechnung ist nicht ausgestellt bzw. kein bezahlbarer Debitoren-OP.")
        run_id = int(invoice["run_id"])
        invoices = list(c.execute(
            "SELECT * FROM outgoing_invoices WHERE run_id=? AND status='issued' ORDER BY due_date,issue_date,id",
            (run_id,),
        ))
        corrections, credit = {}, Decimal(0)
        for item in invoices:
            if item["kind"] not in {"ST", "GS"} or Decimal(str(item["increment_gross"])) >= 0:
                continue
            discount = -Decimal(str(item["increment_gross"]))
            if item["corrects_invoice_id"]:
                key = int(item["corrects_invoice_id"])
                corrections[key] = corrections.get(key, Decimal(0)) + discount
            else:
                credit += discount
        payments = list(c.execute(
            "SELECT * FROM outgoing_payments WHERE run_id=? AND reversed_at IS NULL ORDER BY payment_date,id",
            (run_id,),
        ))
        explicit = {}
        for row in payments:
            money = Decimal(str(row["gross"]))
            if row["invoice_id"]:
                index = int(row["invoice_id"])
                explicit[index] = explicit.get(index, Decimal(0)) + money
            else:
                credit += money
        for item in invoices:
            if item["kind"] not in {"TR", "SR", "RE"} or Decimal(str(item["increment_gross"])) <= 0:
                continue
            inv_id = int(item["id"])
            charge = Decimal(str(item["increment_gross"])) - corrections.get(inv_id, Decimal(0))
            if charge < 0:
                credit -= charge
                charge = Decimal(0)
            paid = explicit.get(inv_id, Decimal(0))
            if paid > charge:
                credit += paid - charge
                paid = charge
            remain = max(Decimal(0), charge - paid)
            allocated = min(remain, credit)
            credit -= allocated
            open_value = max(Decimal(0), remain - allocated)
            if inv_id == invoice_id:
                return invoice, int(open_value.quantize(Decimal("0.01")) * 100)
        raise ValueError("Die Rechnung hat keinen offenen positiven Betrag.")

    def _assert_bank_not_double(self, c, external_ref):
        if not external_ref:
            return
        # A reference already assigned in KONFIPAY or CAMT must NOT be
        # re-entered manually as a fresh movement/payment.
        has_bank = c.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bank_assignment_transactions'",
        ).fetchone()
        if has_bank and c.execute(
            "SELECT 1 FROM bank_assignment_transactions WHERE rid=?", (external_ref,),
        ).fetchone():
            raise ValueError("Bankbewegung bereits in KONFIPAY vorhanden – bitte dort zuordnen, nicht erneut buchen.")
        if c.execute(
            "SELECT 1 FROM outgoing_payments WHERE source_id=? AND reversed_at IS NULL", (external_ref,),
        ).fetchone():
            raise ValueError("Zahlung mit dieser Referenz ist bereits einem Debitoren-OP zugeordnet.")

    def add(self, account, data):
        if account not in _ACCOUNTS:
            raise ValueError("Unbekanntes Verrechnungskonto.")
        kind = str(data.get("kind") or "").strip()
        spec = _KINDS[account].get(kind)
        if not spec:
            raise ValueError("Buchungsart gehört nicht zu diesem Konto.")
        title, sign, ledger = spec
        amount_cents = _money(data.get("amount"))
        day = _day(data.get("date"))
        counterparty = _text(data.get("counterparty"), 160, "Empfänger / Gegenpartei", True)
        purpose = _text(data.get("purpose"), 500, "Buchungszweck", True)
        ref = _text(data.get("reference"), 180, "Belegreferenz")
        external = _text(data.get("externalRef"), 150, "Quellreferenz") or None
        request_id = _text(data.get("requestId"), 100, "Vorgangs-ID", True)
        if not 8 <= len(request_id) <= 100:
            raise ValueError("Ungültige Vorgangs-ID. Buchung nicht gespeichert.")
        invoice_id = None
        if kind == "customer_receipt":
            try:
                invoice_id = int(data.get("invoiceId") or 0)
            except (ValueError, TypeError):
                invoice_id = 0
            if invoice_id <= 0 or not external:
                raise ValueError("DLZ-Kundeneingang erfordert Rechnungs-OP und eindeutige Zahlungsreferenz.")
        if kind == "liability_settlement" and not ref:
            raise ValueError("Bitte ÖGK-/Abgabenreferenz oder Verrechnungsbeleg angeben.")
        with _LOCK:
            c = self.connect()
            try:
                c.execute("BEGIN IMMEDIATE")
                existing = c.execute("SELECT * FROM brain_settlement_entries WHERE client_request=?", (request_id,)).fetchone()
                if existing:
                    # A repeated click is idempotent, but only if all booking data match.
                    expected = (account, kind, day, sign * amount_cents, counterparty, purpose, ref, external, invoice_id)
                    observed = tuple(existing[key] for key in (
                        "account", "kind", "booking_date", "signed_cents", "counterparty", "purpose",
                        "reference", "external_ref", "invoice_id",
                    ))
                    if expected != observed:
                        raise ValueError("Vorgangs-ID bereits für andere Buchungsdaten verwendet.")
                    return self._public(existing)
                if external and c.execute(
                    "SELECT 1 FROM brain_settlement_entries WHERE account=? AND external_ref=?",
                    (account, external),
                ).fetchone():
                    raise ValueError("Quellreferenz in diesem Verrechnungskonto bereits gebucht.")
                self._assert_bank_not_double(c, external)
                payment_id = None
                if kind == "wage_paid":
                    balance = c.execute(
                        "SELECT COALESCE(SUM(signed_cents),0) FROM brain_settlement_entries WHERE account='alex' AND ledger='wage' AND booking_date<=?",
                        (day,),
                    ).fetchone()[0]
                    if balance < amount_cents:
                        raise ValueError("Lohnauszahlung übersteigt den noch offenen Lohn.")
                if kind == "liability_settlement":
                    balance = c.execute(
                        "SELECT COALESCE(SUM(signed_cents),0) FROM brain_settlement_entries WHERE account='dlz' AND ledger='clearing' AND booking_date<=?",
                        (day,),
                    ).fetchone()[0]
                    if balance < amount_cents:
                        raise ValueError("DLZ-Verrechnung übersteigt das verbuchte DLZ-Guthaben.")
                if invoice_id is not None:
                    invoice, open_cents = self._invoice_open_locked(c, invoice_id)
                    if str(invoice["currency"] or "EUR").upper() != "EUR":
                        raise ValueError("DLZ unterstützt derzeit ausschließlich EUR-Rechnungen.")
                    if amount_cents > open_cents:
                        raise ValueError("DLZ-Kundenzahlung übersteigt den offenen Debitoren-OP.")
                    gross = Decimal(amount_cents) / 100
                    rate = Decimal(str(invoice["vat_rate"]))
                    net = (gross / (1 + rate / 100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if rate else gross
                    vat = gross - net
                    result = c.execute("""
                        INSERT INTO outgoing_payments(run_id,invoice_id,payment_date,net,vat,gross,reference,source,source_id,created_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?)
                    """, (
                        int(invoice["run_id"]), invoice_id, day, str(net), str(vat), str(gross),
                        "DLZ: " + (ref or external), "DLZ", "DLZ:" + external, _today(),
                    ))
                    payment_id = result.lastrowid
                    self.outgoing._audit(c,"payment",payment_id,"create",
                        {"runId":int(invoice["run_id"]),"invoiceId":invoice_id,
                         "gross":str(gross),"source":"DLZ","externalRef":external})
                row = c.execute("""
                    INSERT INTO brain_settlement_entries
                    (account,kind,ledger,booking_date,signed_cents,counterparty,purpose,reference,external_ref,
                     client_request,invoice_id,outgoing_payment_id,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (account,kind,ledger,day,sign*amount_cents,counterparty,purpose,ref,external,
                      request_id,invoice_id,payment_id,_today()))
                c.commit()
                saved = c.execute("SELECT * FROM brain_settlement_entries WHERE id=?", (row.lastrowid,)).fetchone()
                return self._public(saved)
            except sqlite3.IntegrityError as error:
                c.rollback()
                raise ValueError("Doppelte Referenz oder Buchung erkannt – keine zweite Buchung erzeugt.") from error
            except Exception:
                c.rollback()
                raise
            finally:
                c.close()

    def reverse(self, account, entry_id, reason, request_id):
        if account not in _ACCOUNTS:
            raise ValueError("Unbekanntes Verrechnungskonto.")
        reason = _text(reason, 500, "Grund der Stornierung", True)
        request_id = _text(request_id, 100, "Vorgangs-ID", True)
        with _LOCK:
            c = self.connect()
            try:
                c.execute("BEGIN IMMEDIATE")
                current = c.execute(
                    "SELECT * FROM brain_settlement_entries WHERE id=? AND account=?", (int(entry_id),account),
                ).fetchone()
                if not current or current["reversal_of"]:
                    raise ValueError("Nur eine originale Buchung dieses Kontos kann storniert werden.")
                if current["reversed_by"] is not None:
                    row = c.execute("SELECT * FROM brain_settlement_entries WHERE id=?",(current["reversed_by"],)).fetchone()
                    if row["client_request"] != request_id:
                        raise ValueError("Diese Buchung wurde bereits storniert.")
                    return self._public(row)
                if current["signed_cents"] > 0 and current["ledger"] in {"wage", "clearing"}:
                    current_balance = c.execute(
                        "SELECT COALESCE(SUM(signed_cents),0) FROM brain_settlement_entries WHERE account=? AND ledger=?",
                        (account, current["ledger"]),
                    ).fetchone()[0]
                    if current_balance < current["signed_cents"]:
                        raise ValueError("Die Gutschrift ist bereits teilweise verwendet. Zuerst spätere Auszahlungen/Verrechnungen stornieren.")
                new = c.execute("""
                    INSERT INTO brain_settlement_entries
                    (account,kind,ledger,booking_date,signed_cents,counterparty,purpose,reference,client_request,
                     invoice_id,reversal_of,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    account, "reversal", current["ledger"], date.today().isoformat(),
                    -int(current["signed_cents"]), current["counterparty"],
                    reason, "Storno "+str(current["id"]), request_id, current["invoice_id"],current["id"],_today(),
                ))
                if current["outgoing_payment_id"]:
                    c.execute(
                        "UPDATE outgoing_payments SET reversed_at=? WHERE id=? AND reversed_at IS NULL",
                        (_today(), current["outgoing_payment_id"]),
                    )
                    if c.execute("SELECT changes()").fetchone()[0] != 1:
                        raise ValueError("Die verknüpfte Debitorenzahlung wurde bereits anders storniert.")
                    self.outgoing._audit(c,"payment",current["outgoing_payment_id"],"reverse",
                                         {"source":"DLZ","ledgerEntry":current["id"],"reason":reason})
                c.execute("UPDATE brain_settlement_entries SET reversed_by=? WHERE id=?", (new.lastrowid, current["id"]))
                c.commit()
                return self._public(c.execute("SELECT * FROM brain_settlement_entries WHERE id=?", (new.lastrowid,)).fetchone())
            except Exception:
                c.rollback()
                raise
            finally:
                c.close()

    def attach(self, account, entry_id, filename, body):
        if account not in _ACCOUNTS:
            raise ValueError("Unbekanntes Verrechnungskonto.")
        filename = Path(str(filename or "")).name.strip()
        if not filename or len(filename) > 180:
            raise ValueError("Dateiname fehlt oder ist zu lang.")
        suffix = Path(filename).suffix.lower()
        mime = {".pdf":"application/pdf",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png"}.get(suffix)
        if not mime or not body or len(body) > _MAX_DOC:
            raise ValueError("Bitte PDF/JPG/PNG mit maximal 8 MB hochladen.")
        if suffix == ".pdf" and not body.startswith(b"%PDF-"):
            raise ValueError("Keine gültige PDF-Datei.")
        if suffix in {".jpg",".jpeg"} and not body.startswith(b"\xff\xd8"):
            raise ValueError("Keine gültige JPEG-Datei.")
        if suffix == ".png" and not body.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Keine gültige PNG-Datei.")
        digest = hashlib.sha256(body).hexdigest()
        with _LOCK:
            c = self.connect()
            try:
                c.execute("BEGIN IMMEDIATE")
                target = c.execute("SELECT id FROM brain_settlement_entries WHERE id=? AND account=?", (int(entry_id),account)).fetchone()
                if target is None:
                    raise ValueError("Buchung nicht gefunden.")
                c.execute("""
                    INSERT OR IGNORE INTO brain_settlement_files
                    (entry_id,filename,mime,sha256,content,uploaded_at) VALUES(?,?,?,?,?,?)
                """,(int(entry_id),filename,mime,digest,body,_today()))
                found = c.execute("SELECT id,filename,mime,sha256,uploaded_at FROM brain_settlement_files WHERE entry_id=? AND sha256=?",
                                  (int(entry_id),digest)).fetchone()
                c.commit()
                return dict(found)
            finally:
                c.close()

    def files(self, account, entry_id):
        with _LOCK:
            c=self.connect()
            try:
                row=c.execute("SELECT 1 FROM brain_settlement_entries WHERE id=? AND account=?",(int(entry_id),account)).fetchone()
                if not row:
                    raise ValueError("Buchung nicht gefunden.")
                return [dict(x) for x in c.execute(
                    "SELECT id,filename,mime,sha256,uploaded_at FROM brain_settlement_files WHERE entry_id=? ORDER BY id",
                    (int(entry_id),),
                )]
            finally:c.close()

    def file(self, account, file_id):
        with _LOCK:
            c=self.connect()
            try:
                row=c.execute("""
                  SELECT f.filename,f.mime,f.content FROM brain_settlement_files f
                  JOIN brain_settlement_entries e ON e.id=f.entry_id WHERE f.id=? AND e.account=?
                """,(int(file_id),account)).fetchone()
                if row is None:
                    raise ValueError("Beleg nicht gefunden.")
                return row["filename"],row["mime"],row["content"]
            finally:c.close()

    def debtor_candidates(self):
        return [{
            "invoiceId": int(x["invoiceId"]), "runId": int(x["runId"]),
            "customer": str(x["customer"]), "invoiceNumber": str(x["invoiceNumber"]),
            "open": _formatted(int(Decimal(str(x["openGross"]))*100)),
            "date": x["issueDate"],
        } for x in self.outgoing.debtor_open_items() if str(x.get("currency") or "EUR").upper()=="EUR"]


def install(ns):
    """Register Brain endpoints without changing existing bank and GANTNER code."""
    if ns.get("_settlement_accounts_installed"):
        return
    from flask import request, jsonify, Response, send_file
    app = ns["app"]
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    csrf = secrets.token_urlsafe(32)
    pages = {"/incoming/alex-privat":"alex","/incoming/dlz":"dlz"}
    paths = set(pages) | {"/incoming/settlements/api","/incoming/settlements/file"}
    if isinstance(allowed,set):
        allowed.update(paths)

    def service():
        outgoing=app.extensions.get("kristine_outgoing_store")
        if outgoing is None:
            raise RuntimeError("Debitorenbuch ist nicht verfügbar. Keine Buchung vorgenommen.")
        return SettlementLedger(outgoing,ns)

    def check_request():
        origin=urlsplit(request.headers.get("Origin",""))
        if (origin.netloc != request.host or
                not secrets.compare_digest(request.headers.get("X-Settlement-Token",""),csrf)):
            raise PermissionError("Sicherheitsbestätigung abgelaufen. Seite neu laden.")
        if request.content_length is None or request.content_length > 9_000_000:
            raise ValueError("Ungültige oder zu große Buchungsanfrage.")

    @app.before_request
    def settlement_guard():
        if request.path in paths and request.method == "POST":
            try:
                check_request()
            except PermissionError as exc:
                return jsonify(ok=False,error=str(exc)),403
            except ValueError as exc:
                return jsonify(ok=False,error=str(exc)),400

    @app.after_request
    def settlement_no_cache(response):
        if request.path in paths:
            response.headers["Cache-Control"] = "no-store, private, max-age=0"
            response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/incoming/alex-privat")
    @app.get("/incoming/dlz")
    def settlement_page():
        account=pages[request.path]
        page=(Path(__file__).parent/"public"/"settlement-accounts.html").read_text(encoding="utf-8")
        page=page.replace("__SETTLEMENT_ACCOUNT__",account).replace("__SETTLEMENT_CSRF__",csrf)
        return Response(page, content_type="text/html; charset=utf-8")

    @app.route("/incoming/settlements/api",methods=["GET","POST"])
    def settlement_api():
        try:
            account=str(request.args.get("account") or "")
            action=str(request.args.get("action") or "list")
            model=service()
            if request.method=="GET":
                if action=="list":
                    return jsonify(ok=True,**model.list(account))
                if action=="debtors":
                    return jsonify(ok=True,items=model.debtor_candidates())
                if action=="files":
                    return jsonify(ok=True,items=model.files(account,int(request.args.get("entryId") or 0)))
                raise ValueError("Unbekannte Kontenabfrage.")
            if action=="attach":
                file=request.files.get("file")
                if file is None:
                    raise ValueError("Bitte einen Beleg auswählen.")
                result=model.attach(account,int(request.form.get("entryId") or 0),file.filename,file.stream.read(_MAX_DOC+1))
                return jsonify(ok=True,item=result)
            body=request.get_json(silent=True) or {}
            if action=="add":
                return jsonify(ok=True,item=model.add(account,body))
            if action=="reverse":
                return jsonify(ok=True,item=model.reverse(account,body.get("entryId"),body.get("reason"),body.get("requestId")))
            raise ValueError("Unbekannte Buchungsaktion.")
        except (ValueError,TypeError,KeyError) as exc:
            return jsonify(ok=False,error=str(exc)),400
        except sqlite3.Error:
            app.logger.exception("Settlement ledger SQLite error")
            return jsonify(ok=False,error="Buchung fehlgeschlagen. Datenbestand unverändert, bitte prüfen."),500
        except Exception:
            app.logger.exception("Settlement ledger error")
            return jsonify(ok=False,error="Verrechnung fehlgeschlagen. Bitte Buchungsstatus prüfen."),500

    @app.get("/incoming/settlements/file")
    def settlement_document():
        try:
            filename,mime,body=service().file(str(request.args.get("account") or ""),int(request.args.get("id") or 0))
            return send_file(io.BytesIO(body),mimetype=mime,as_attachment=True,download_name=filename,max_age=0)
        except (ValueError,TypeError):
            return "Beleg nicht gefunden.",404
    ns["_settlement_accounts_installed"]=True
    ns["settlement_ledger_class"]=SettlementLedger
