# coding: utf-8
"""KRISTINE outgoing invoices: durable store and WW-compatible calculations.

The important accounting rule is the same one used by WinWorker partial invoices:
an invoice run is cumulative, the current invoice has an incremental revenue value,
and the payable amount is the cumulative gross total less payments actually received.
Several independent runs may belong to the same WinWorker project.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path


CENT = Decimal("0.01")
THREE = Decimal("0.001")
_LOCK = threading.RLock()


class _ClosingConnection(sqlite3.Connection):
    """sqlite context manager that also releases the Windows file handle."""
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()

TAX_MODES = {
    "AT20": {"rate": Decimal("20"), "label": "20 % Österreich", "requires_uid": False, "note": ""},
    "CHLI81": {"rate": Decimal("8.1"), "label": "8,1 % Schweiz / Liechtenstein", "requires_uid": False, "note": ""},
    "RC19": {
        "rate": Decimal("0"),
        "label": "§ 19 Übergang der Steuerschuld",
        "requires_uid": True,
        "note": "Übergang der Steuerschuld gemäß § 19 Abs. 1a UStG. Die Steuerschuld geht auf den Leistungsempfänger über.",
    },
    "EU0": {
        "rate": Decimal("0"),
        "label": "Steuerfreie EU-Auslandslieferung",
        "requires_uid": True,
        "note": "Steuerfreie innergemeinschaftliche Lieferung. Die Umsatzsteuer wird vom Erwerber im Bestimmungsmitgliedstaat geschuldet.",
    },
}

DEFAULT_SETTINGS = {
    "company_name": "Farben Krista GmbH & Co KG",
    "company_street": "Feldkircherstraße 45",
    "company_postal_city": "A 6820 Frastanz",
    "company_phone": "+43 5522 53940",
    "company_email": "office@krista.at",
    "company_web": "www.krista.at",
    "company_uid": "ATU36511805",
    "company_fn": "FN 15539b",
    "company_legal": "Unbeschränkt haftender Gesellschafter: Farben Krista GmbH, Feldkircherstraße 45, 6820 Frastanz, FN 77707a, Firmenbuchgericht Feldkirch",
    "company_eori": "ATEOS1000017548",
    "company_dg": "401425536",
    "bank_iban": "AT82 5800 0104 9932 3013",
    "bank_bic": "HYPVAT2B",
    "number_template": "{year}{month}{seq:03d}",
    "number_warning": "Automatischer gemeinsamer Nummernkreis JJJJMM00x mit WinWorker-Abgleich.",
    "default_worker": "Ing. Alexander Krista",
    "default_due_days": "14",
}

WW_CONTINUATION_LABEL = "Hauptauftrag · aus WinWorker fortgeführt"


def _d(value, default="0") -> Decimal:
    if value is None or value == "":
        return Decimal(default)
    if isinstance(value, Decimal):
        return value
    text = str(value).strip().replace(" ", "")
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"Ungültiger Betrag: {value}") from exc


def _money(value) -> Decimal:
    return _d(value).quantize(CENT, rounding=ROUND_HALF_UP)


def _rate(value) -> Decimal:
    return _d(value).quantize(THREE, rounding=ROUND_HALF_UP)


def _iso_date(value, *, required=False, label="Datum") -> str:
    text = str(value or "").strip()[:10]
    if not text:
        if required:
            raise ValueError(f"{label} fehlt.")
        return ""
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError as exc:
        raise ValueError(f"{label} ist ungültig.") from exc


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _bounded_percent(value, label) -> Decimal:
    result = _rate(value)
    if result < 0 or result > 100:
        raise ValueError(f"{label} muss zwischen 0 und 100 % liegen.")
    return result


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _row(row):
    return dict(row) if row is not None else None


def _num(value):
    return float(_d(value))


def calculate_totals(lines, *, tax_mode="AT20", retention_percent=0, discount_percent=0,
                     cash_discount_percent=0, prior=None, payments=None):
    """Pure WW-style cumulative calculation, returned as Decimal values."""
    if tax_mode not in TAX_MODES:
        raise ValueError("USt-Art ist ungültig.")
    retention_percent = _bounded_percent(retention_percent, "Deckungsrücklass")
    discount_percent = _bounded_percent(discount_percent, "Rabatt")
    cash_discount_percent = _bounded_percent(cash_discount_percent, "Skonto")

    subtotal = Decimal("0")
    normalized_lines = []
    for index, raw in enumerate(lines or [], 1):
        description = str(raw.get("description") or "").strip()
        if not description:
            raise ValueError(f"Leistungstext in Position {index} fehlt.")
        quantity = _d(raw.get("quantity"), "1")
        unit_price = _d(raw.get("unitPrice") if "unitPrice" in raw else raw.get("unit_price"))
        line_discount = _bounded_percent(
            raw.get("discountPercent") if "discountPercent" in raw else raw.get("discount_percent"),
            f"Positionsrabatt in Position {index}",
        )
        raw_net = quantity * unit_price
        line_net = _money(raw_net - (raw_net * line_discount / Decimal("100")))
        subtotal += line_net
        normalized_lines.append({
            "lineNo": index,
            "description": description,
            "quantity": quantity,
            "unit": str(raw.get("unit") or "PA").strip()[:20],
            "unitPrice": _money(unit_price),
            "discountPercent": line_discount,
            "net": line_net,
        })
    if not normalized_lines:
        raise ValueError("Mindestens eine Rechnungsposition ist erforderlich.")

    subtotal = _money(subtotal)
    retention = _money(subtotal * retention_percent / Decimal("100"))
    after_retention = _money(subtotal - retention)
    discount = _money(after_retention * discount_percent / Decimal("100"))
    cumulative_net = _money(after_retention - discount)
    vat_rate = TAX_MODES[tax_mode]["rate"]
    cumulative_vat = _money(cumulative_net * vat_rate / Decimal("100"))
    cumulative_gross = _money(cumulative_net + cumulative_vat)
    cash_discount = _money(cumulative_gross * cash_discount_percent / Decimal("100"))
    cumulative_discounted = _money(cumulative_gross - cash_discount)

    prior = prior or {}
    prior_net = _money(prior.get("net"))
    prior_vat = _money(prior.get("vat"))
    prior_gross = _money(prior.get("gross"))
    increment_net = _money(cumulative_net - prior_net)
    increment_vat = _money(cumulative_vat - prior_vat)
    increment_gross = _money(cumulative_gross - prior_gross)
    if min(increment_net, increment_vat, increment_gross) < 0:
        raise ValueError("Der kumulative Rechnungsstand liegt unter den bereits gestellten Rechnungen dieses Laufs.")

    payments = payments or {}
    paid_net = _money(payments.get("net"))
    paid_vat = _money(payments.get("vat"))
    paid_gross = _money(payments.get("gross"))
    open_with_discount = _money(cumulative_discounted - paid_gross)
    open_after_discount = _money(cumulative_gross - paid_gross)

    return {
        "lines": normalized_lines,
        "lineSubtotalNet": subtotal,
        "retentionPercent": retention_percent,
        "retentionNet": retention,
        "netAfterRetention": after_retention,
        "discountPercent": discount_percent,
        "discountNet": discount,
        "cumulativeNet": cumulative_net,
        "vatRate": vat_rate,
        "cumulativeVat": cumulative_vat,
        "cumulativeGross": cumulative_gross,
        "cashDiscountPercent": cash_discount_percent,
        "cashDiscountGross": cash_discount,
        "cumulativeGrossDiscounted": cumulative_discounted,
        "priorNet": prior_net,
        "priorVat": prior_vat,
        "priorGross": prior_gross,
        "incrementNet": increment_net,
        "incrementVat": increment_vat,
        "incrementGross": increment_gross,
        "paidNet": paid_net,
        "paidVat": paid_vat,
        "paidGross": paid_gross,
        "openWithDiscount": open_with_discount,
        "openAfterDiscount": open_after_discount,
    }


class OutgoingStore:
    def __init__(self, db_path, output_root):
        self.db_path = Path(db_path)
        self.output_root = Path(output_root)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_root.mkdir(parents=True, exist_ok=True)
        with self.connect() as con:
            self.ensure_schema(con)

    def connect(self):
        con = sqlite3.connect(self.db_path, timeout=30, factory=_ClosingConnection)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        con.execute("PRAGMA journal_mode=DELETE")
        con.execute("PRAGMA synchronous=FULL")
        con.execute("PRAGMA busy_timeout=30000")
        return con

    @staticmethod
    def ensure_schema(con):
        con.executescript("""
        CREATE TABLE IF NOT EXISTS outgoing_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outgoing_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_index INTEGER,
            project_number TEXT NOT NULL DEFAULT '',
            customer_index INTEGER,
            label TEXT NOT NULL,
            customer_name TEXT NOT NULL,
            customer_company TEXT NOT NULL DEFAULT '',
            customer_street TEXT NOT NULL,
            customer_postal_code TEXT NOT NULL,
            customer_city TEXT NOT NULL,
            customer_country TEXT NOT NULL DEFAULT 'Österreich',
            customer_uid TEXT NOT NULL DEFAULT '',
            project_title TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
            created_at TEXT NOT NULL,
            closed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outgoing_runs_project ON outgoing_runs(project_index, status);
        CREATE TABLE IF NOT EXISTS outgoing_invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL REFERENCES outgoing_runs(id),
            source TEXT NOT NULL DEFAULT 'KRISTINE',
            source_id TEXT,
            kind TEXT NOT NULL CHECK(kind IN ('TR','SR','RE','ST','GS')),
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','cancelled')),
            invoice_number TEXT UNIQUE,
            issue_date TEXT NOT NULL,
            due_date TEXT NOT NULL,
            service_from TEXT NOT NULL,
            service_to TEXT NOT NULL,
            subject TEXT NOT NULL DEFAULT '',
            worker TEXT NOT NULL DEFAULT '',
            recipient_uid TEXT NOT NULL DEFAULT '',
            tax_mode TEXT NOT NULL,
            vat_rate TEXT NOT NULL,
            retention_percent TEXT NOT NULL DEFAULT '0',
            discount_percent TEXT NOT NULL DEFAULT '0',
            cash_discount_percent TEXT NOT NULL DEFAULT '0',
            cash_discount_until TEXT NOT NULL DEFAULT '',
            currency TEXT NOT NULL DEFAULT 'EUR',
            line_subtotal_net TEXT NOT NULL DEFAULT '0',
            retention_net TEXT NOT NULL DEFAULT '0',
            net_after_retention TEXT NOT NULL DEFAULT '0',
            discount_net TEXT NOT NULL DEFAULT '0',
            cumulative_net TEXT NOT NULL DEFAULT '0',
            cumulative_vat TEXT NOT NULL DEFAULT '0',
            cumulative_gross TEXT NOT NULL DEFAULT '0',
            cash_discount_gross TEXT NOT NULL DEFAULT '0',
            cumulative_gross_discounted TEXT NOT NULL DEFAULT '0',
            prior_net TEXT NOT NULL DEFAULT '0',
            prior_vat TEXT NOT NULL DEFAULT '0',
            prior_gross TEXT NOT NULL DEFAULT '0',
            increment_net TEXT NOT NULL DEFAULT '0',
            increment_vat TEXT NOT NULL DEFAULT '0',
            increment_gross TEXT NOT NULL DEFAULT '0',
            paid_net_snapshot TEXT NOT NULL DEFAULT '0',
            paid_vat_snapshot TEXT NOT NULL DEFAULT '0',
            paid_gross_snapshot TEXT NOT NULL DEFAULT '0',
            open_with_discount TEXT NOT NULL DEFAULT '0',
            open_after_discount TEXT NOT NULL DEFAULT '0',
            previous_snapshot_json TEXT NOT NULL DEFAULT '[]',
            payments_snapshot_json TEXT NOT NULL DEFAULT '[]',
            tax_note TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            corrects_invoice_id INTEGER REFERENCES outgoing_invoices(id),
            correction_reason TEXT NOT NULL DEFAULT '',
            pdf_path TEXT,
            pdf_sha256 TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            issued_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outgoing_invoices_run ON outgoing_invoices(run_id, status, issue_date, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_outgoing_invoices_source ON outgoing_invoices(source, source_id) WHERE source_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS outgoing_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL REFERENCES outgoing_invoices(id) ON DELETE CASCADE,
            line_no INTEGER NOT NULL,
            description TEXT NOT NULL,
            quantity TEXT NOT NULL,
            unit TEXT NOT NULL,
            unit_price TEXT NOT NULL,
            discount_percent TEXT NOT NULL DEFAULT '0',
            net TEXT NOT NULL,
            UNIQUE(invoice_id, line_no)
        );
        CREATE TABLE IF NOT EXISTS outgoing_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL REFERENCES outgoing_runs(id),
            invoice_id INTEGER REFERENCES outgoing_invoices(id),
            payment_date TEXT NOT NULL,
            net TEXT NOT NULL,
            vat TEXT NOT NULL,
            gross TEXT NOT NULL,
            reference TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'KRISTINE',
            source_id TEXT,
            created_at TEXT NOT NULL,
            reversed_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_outgoing_payment_source ON outgoing_payments(source, source_id) WHERE source_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_outgoing_payments_run ON outgoing_payments(run_id, payment_date, id);
        CREATE TABLE IF NOT EXISTS outgoing_sequences (
            period TEXT PRIMARY KEY,
            next_value INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outgoing_periods (
            period TEXT PRIMARY KEY,
            closed_at TEXT NOT NULL,
            closed_by TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS outgoing_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL REFERENCES outgoing_invoices(id),
            revision_no INTEGER NOT NULL,
            invoice_json TEXT NOT NULL,
            previous_pdf_path TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(invoice_id, revision_no)
        );
        CREATE TABLE IF NOT EXISTS outgoing_debtor_meta (
            invoice_id INTEGER PRIMARY KEY REFERENCES outgoing_invoices(id) ON DELETE CASCADE,
            dunning_blocked INTEGER NOT NULL DEFAULT 0,
            note TEXT NOT NULL DEFAULT '',
            ww_dunning_level INTEGER NOT NULL DEFAULT 0,
            ww_last_dunning TEXT NOT NULL DEFAULT '',
            ww_blocked_until TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outgoing_dunnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL REFERENCES outgoing_invoices(id) ON DELETE CASCADE,
            level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 3),
            dunning_date TEXT NOT NULL,
            open_gross TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued')),
            snapshot_json TEXT NOT NULL DEFAULT '{}',
            pdf_path TEXT,
            pdf_sha256 TEXT,
            created_at TEXT NOT NULL,
            issued_at TEXT,
            UNIQUE(invoice_id, level)
        );
        CREATE INDEX IF NOT EXISTS idx_outgoing_dunnings_invoice
            ON outgoing_dunnings(invoice_id, level);
        CREATE TABLE IF NOT EXISTS outgoing_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity TEXT NOT NULL,
            entity_id INTEGER,
            action TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        """)
        run_columns = {row[1] for row in con.execute("PRAGMA table_info(outgoing_runs)")}
        for column, definition in (
            ("billing_rate", "TEXT NOT NULL DEFAULT '75'"),
            ("material_markup_percent", "TEXT NOT NULL DEFAULT '80'"),
            ("pricing_locked_at", "TEXT"),
        ):
            if column not in run_columns:
                con.execute(f"ALTER TABLE outgoing_runs ADD COLUMN {column} {definition}")
        con.execute("""
            UPDATE outgoing_runs
            SET pricing_locked_at=(
                SELECT MIN(issued_at) FROM outgoing_invoices
                WHERE outgoing_invoices.run_id=outgoing_runs.id
                  AND outgoing_invoices.status='issued'
                  AND outgoing_invoices.source='KRISTINE'
                  AND outgoing_invoices.kind IN ('TR','SR','RE')
            )
            WHERE pricing_locked_at IS NULL AND EXISTS(
                SELECT 1 FROM outgoing_invoices
                WHERE outgoing_invoices.run_id=outgoing_runs.id
                  AND outgoing_invoices.status='issued'
                  AND outgoing_invoices.source='KRISTINE'
                  AND outgoing_invoices.kind IN ('TR','SR','RE')
            )
        """)
        for key, value in DEFAULT_SETTINGS.items():
            con.execute("INSERT OR IGNORE INTO outgoing_settings(key,value) VALUES(?,?)", (key, str(value)))
        con.execute(
            "UPDATE outgoing_settings SET value=? WHERE key='number_template' AND value=?",
            (DEFAULT_SETTINGS["number_template"], "{yy}{month}{seq:03d}"),
        )
        con.execute(
            "UPDATE outgoing_settings SET value=? WHERE key='number_warning' AND value=?",
            (DEFAULT_SETTINGS["number_warning"], "Automatischer gemeinsamer Nummernkreis JJMM00x."),
        )
        con.commit()

    def settings(self, con=None):
        own = con is None
        con = con or self.connect()
        try:
            result = dict(DEFAULT_SETTINGS)
            result.update({r["key"]: r["value"] for r in con.execute("SELECT key,value FROM outgoing_settings")})
            return result
        finally:
            if own:
                con.close()

    def update_settings(self, values):
        allowed = set(DEFAULT_SETTINGS)
        with _LOCK, self.connect() as con:
            for key, value in (values or {}).items():
                if key in allowed:
                    con.execute(
                        "INSERT INTO outgoing_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (key, str(value or "").strip()),
                    )
            self._audit(con, "settings", None, "update", {k: values.get(k) for k in values if k in allowed and "iban" not in k})
            con.commit()
        return self.settings()

    @staticmethod
    def _audit(con, entity, entity_id, action, payload=None):
        con.execute(
            "INSERT INTO outgoing_audit(entity,entity_id,action,payload_json,created_at) VALUES(?,?,?,?,?)",
            (entity, entity_id, action, _json(payload or {}), _now()),
        )

    def create_run(self, data):
        label = str(data.get("label") or "").strip()
        if not label:
            raise ValueError("Bezeichnung des Rechnungslaufs fehlt.")
        customer_name = str(data.get("customerName") or data.get("customer") or "").strip()
        customer_company = str(data.get("company") or "").strip()
        if not customer_name and not customer_company:
            raise ValueError("Rechnungsempfänger fehlt.")
        street = str(data.get("street") or "").strip()
        postal = str(data.get("postalCode") or "").strip()
        city = str(data.get("city") or "").strip()
        if not street or not postal or not city:
            raise ValueError("Vollständige Rechnungsadresse fehlt.")
        with _LOCK, self.connect() as con:
            cur = con.execute("""
                INSERT INTO outgoing_runs(
                    project_index,project_number,customer_index,label,customer_name,customer_company,
                    customer_street,customer_postal_code,customer_city,customer_country,customer_uid,
                    project_title,status,created_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'open',?)
            """, (
                data.get("projectIndex"), str(data.get("projectNumber") or ""), data.get("customerIndex"), label,
                customer_name, customer_company, street, postal, city,
                str(data.get("country") or "Österreich").strip(), str(data.get("customerUid") or "").strip().upper(),
                str(data.get("projectTitle") or data.get("title") or "").strip(), _now(),
            ))
            run_id = cur.lastrowid
            self._audit(con, "run", run_id, "create", {"label": label, "projectNumber": data.get("projectNumber")})
            con.commit()
        return self.run(run_id)

    def update_run_pricing(self, run_id, data):
        run_id = int(run_id)
        try:
            billing_rate = _money(data.get("billingRate"))
            material_markup = Decimal(str(data.get("materialMarkupPercent") or "0").replace(",", "."))
        except Exception as exc:
            raise ValueError("Preisbasis ist ungültig.") from exc
        if billing_rate <= 0 or billing_rate > Decimal("10000"):
            raise ValueError("Der Regiestundensatz muss größer als null sein.")
        if material_markup < 0 or material_markup > Decimal("10000"):
            raise ValueError("Der Materialaufschlag ist ungültig.")
        with _LOCK, self.connect() as con:
            row = con.execute("SELECT * FROM outgoing_runs WHERE id=?", (run_id,)).fetchone()
            if not row:
                raise ValueError("Rechnungslauf nicht gefunden.")
            if row["pricing_locked_at"]:
                raise ValueError("Die Preisbasis ist seit der ersten Rechnung festgeschrieben.")
            con.execute(
                "UPDATE outgoing_runs SET billing_rate=?,material_markup_percent=? WHERE id=?",
                (str(billing_rate), str(material_markup), run_id),
            )
            self._audit(con, "run", run_id, "update_pricing", {
                "billingRate": str(billing_rate), "materialMarkupPercent": str(material_markup),
            })
            con.commit()
        return self.run(run_id)

    @staticmethod
    def period_for(value):
        return date.fromisoformat(_iso_date(value, required=True)).strftime("%Y%m")

    def is_period_closed(self, value, con=None):
        own = con is None
        con = con or self.connect()
        try:
            period = self.period_for(value)
            return con.execute("SELECT 1 FROM outgoing_periods WHERE period=?", (period,)).fetchone() is not None
        finally:
            if own:
                con.close()

    def close_period(self, period, closed_by=""):
        text = str(period or "").replace("-", "").strip()
        if len(text) != 6 or not text.isdigit():
            raise ValueError("Monat muss als JJJJMM angegeben werden.")
        year, month = int(text[:4]), int(text[4:])
        if year < 2000 or month < 1 or month > 12:
            raise ValueError("Monat ist ungültig.")
        with _LOCK, self.connect() as con:
            open_drafts = con.execute(
                "SELECT COUNT(*) FROM outgoing_invoices WHERE status='draft' AND replace(substr(issue_date,1,7),'-','')=?",
                (text,),
            ).fetchone()[0]
            if open_drafts:
                raise ValueError(f"Monatsabschluss nicht möglich: {open_drafts} Rechnungsentwurf/Entwürfe sind noch offen.")
            con.execute(
                "INSERT OR IGNORE INTO outgoing_periods(period,closed_at,closed_by) VALUES(?,?,?)",
                (text, _now(), str(closed_by or "").strip()),
            )
            self._audit(con, "period", None, "close", {"period": text, "closedBy": str(closed_by or "")})
            con.commit()
        return {"period": text, "closed": True}

    def periods(self):
        with self.connect() as con:
            return [dict(row) for row in con.execute("SELECT * FROM outgoing_periods ORDER BY period DESC")]

    def runs(self, project_index=None):
        with self.connect() as con:
            sql = "SELECT * FROM outgoing_runs"
            params = []
            if project_index not in (None, ""):
                sql += " WHERE project_index=?"
                params.append(int(project_index))
            sql += " ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC"
            return [self._run_public(con, row) for row in con.execute(sql, params)]

    def run(self, run_id):
        with self.connect() as con:
            row = con.execute("SELECT * FROM outgoing_runs WHERE id=?", (int(run_id),)).fetchone()
            if not row:
                raise ValueError("Rechnungslauf nicht gefunden.")
            return self._run_public(con, row, detail=True)

    def debtor_open_items(self, as_of=None):
        """Return customer open items; payments are allocated explicitly, then oldest first."""
        today = date.fromisoformat(_iso_date(as_of or date.today().isoformat(), required=True, label="Stichtag"))
        result = []
        with self.connect() as con:
            for run in con.execute("SELECT * FROM outgoing_runs ORDER BY customer_company,customer_name,id"):
                invoices = list(con.execute(
                    "SELECT * FROM outgoing_invoices WHERE run_id=? AND status='issued' ORDER BY due_date,issue_date,id",
                    (run["id"],),
                ))
                charges = [x for x in invoices if x["kind"] in {"TR", "SR", "RE"} and _d(x["increment_gross"]) > 0]
                corrections = {}
                unlinked_credit = Decimal("0")
                for inv in invoices:
                    if inv["kind"] not in {"ST", "GS"} or _d(inv["increment_gross"]) >= 0:
                        continue
                    credit = -_money(inv["increment_gross"])
                    target = inv["corrects_invoice_id"]
                    if target:
                        corrections[int(target)] = _money(corrections.get(int(target), Decimal("0")) + credit)
                    else:
                        unlinked_credit = _money(unlinked_credit + credit)

                explicit = {}
                unassigned = Decimal("0")
                for payment in con.execute(
                    "SELECT * FROM outgoing_payments WHERE run_id=? AND reversed_at IS NULL ORDER BY payment_date,id",
                    (run["id"],),
                ):
                    gross = _money(payment["gross"])
                    if payment["invoice_id"]:
                        key = int(payment["invoice_id"])
                        explicit[key] = _money(explicit.get(key, Decimal("0")) + gross)
                    else:
                        unassigned = _money(unassigned + gross)

                credit_pool = _money(unassigned + unlinked_credit)
                for inv in charges:
                    charge = _money(_d(inv["increment_gross"]) - corrections.get(int(inv["id"]), Decimal("0")))
                    if charge < 0:
                        credit_pool = _money(credit_pool - charge)
                        charge = Decimal("0")
                    assigned = explicit.get(int(inv["id"]), Decimal("0"))
                    if assigned > charge:
                        credit_pool = _money(credit_pool + assigned - charge)
                        assigned = charge
                    remaining = _money(charge - assigned)
                    allocated = min(remaining, credit_pool)
                    credit_pool = _money(credit_pool - allocated)
                    paid = _money(assigned + allocated)
                    open_gross = _money(charge - paid)
                    if open_gross <= 0:
                        continue
                    due = date.fromisoformat(inv["due_date"])
                    overdue_days = max(0, (today - due).days)
                    customer = str(run["customer_company"] or run["customer_name"] or "Ohne Kunde").strip()
                    meta = con.execute(
                        "SELECT * FROM outgoing_debtor_meta WHERE invoice_id=?",
                        (int(inv["id"]),),
                    ).fetchone()
                    local_dunnings = [dict(row) for row in con.execute(
                        "SELECT * FROM outgoing_dunnings WHERE invoice_id=? AND status='issued' ORDER BY level",
                        (int(inv["id"]),),
                    )]
                    ww_level = max(0, min(3, int(meta["ww_dunning_level"] or 0))) if meta else 0
                    local_level = max((int(row["level"]) for row in local_dunnings), default=0)
                    dunning_level = max(ww_level, local_level)
                    last_local = local_dunnings[-1] if local_dunnings else None
                    last_dunning_date = str((last_local or {}).get("dunning_date") or "")
                    if ww_level >= local_level and meta and meta["ww_last_dunning"]:
                        last_dunning_date = str(meta["ww_last_dunning"])
                    blocked_until = str(meta["ww_blocked_until"] or "") if meta else ""
                    locally_blocked = bool(meta and meta["dunning_blocked"])
                    ww_blocked = bool(blocked_until and blocked_until >= today.isoformat())
                    result.append({
                        "runId": int(run["id"]), "invoiceId": int(inv["id"]),
                        "source": inv["source"], "invoiceNumber": inv["invoice_number"], "kind": inv["kind"],
                        "issueDate": inv["issue_date"], "dueDate": inv["due_date"], "currency": inv["currency"],
                        "invoiceGross": _num(charge), "paidGross": _num(paid), "openGross": _num(open_gross),
                        "overdueDays": overdue_days, "isOverdue": overdue_days > 0,
                        "customerKey": str(run["customer_index"] or customer).strip(), "customer": customer,
                        "customerName": run["customer_name"], "customerCompany": run["customer_company"],
                        "projectIndex": run["project_index"], "projectNumber": run["project_number"],
                        "projectTitle": run["project_title"], "runLabel": run["label"],
                        "pdfAvailable": bool(inv["pdf_path"] and Path(inv["pdf_path"]).is_file()),
                        "dunningLevel": dunning_level,
                        "nextDunningLevel": dunning_level + 1 if dunning_level < 3 else None,
                        "lastDunningDate": last_dunning_date,
                        "dunningBlocked": locally_blocked or ww_blocked,
                        "dunningBlockedLocal": locally_blocked,
                        "wwDunningBlockedUntil": blocked_until,
                        "opNote": str(meta["note"] or "") if meta else "",
                        "dunningHistory": [{
                            "id": int(row["id"]), "level": int(row["level"]),
                            "date": row["dunning_date"],
                            "pdfAvailable": bool(row["pdf_path"] and Path(row["pdf_path"]).is_file()),
                        } for row in local_dunnings],
                        "lastDunningId": int(last_local["id"]) if last_local else None,
                        "lastDunningPdfAvailable": bool(
                            last_local and last_local["pdf_path"] and Path(last_local["pdf_path"]).is_file()
                        ),
                    })
        result.sort(key=lambda x: (x["dueDate"], str(x["customer"]).casefold(), x["invoiceNumber"] or ""))
        return result

    def update_debtor_meta(self, invoice_id, data):
        invoice_id = int(invoice_id)
        with _LOCK, self.connect() as con:
            invoice = con.execute("SELECT id FROM outgoing_invoices WHERE id=?", (invoice_id,)).fetchone()
            if not invoice:
                raise ValueError("Ausgangsrechnung nicht gefunden.")
            current = con.execute(
                "SELECT * FROM outgoing_debtor_meta WHERE invoice_id=?", (invoice_id,)
            ).fetchone()
            blocked = int(bool(data.get("dunningBlocked"))) if "dunningBlocked" in data else int(current["dunning_blocked"] if current else 0)
            note = str(data.get("note") or "").strip()[:2000] if "note" in data else str(current["note"] if current else "")
            now = _now()
            con.execute("""
                INSERT INTO outgoing_debtor_meta(invoice_id,dunning_blocked,note,updated_at)
                VALUES(?,?,?,?)
                ON CONFLICT(invoice_id) DO UPDATE SET
                    dunning_blocked=excluded.dunning_blocked,
                    note=excluded.note,
                    updated_at=excluded.updated_at
            """, (invoice_id, blocked, note, now))
            self._audit(con, "invoice", invoice_id, "debtor_meta", {
                "dunningBlocked": bool(blocked), "noteChanged": "note" in data,
            })
            con.commit()
        return next(
            (row for row in self.debtor_open_items() if row["invoiceId"] == invoice_id),
            {"invoiceId": invoice_id, "dunningBlocked": bool(blocked), "opNote": note},
        )

    def dunning(self, dunning_id):
        with self.connect() as con:
            row = con.execute("SELECT * FROM outgoing_dunnings WHERE id=?", (int(dunning_id),)).fetchone()
            if not row:
                raise ValueError("Mahnung nicht gefunden.")
            data = dict(row)
            data["snapshot"] = json.loads(data.pop("snapshot_json") or "{}")
            data["pdfAvailable"] = bool(data.get("pdf_path") and Path(data["pdf_path"]).is_file())
            return data

    def prepare_dunning(self, invoice_id, dunning_date=None):
        invoice_id = int(invoice_id)
        dunning_date = _iso_date(
            dunning_date or date.today().isoformat(), required=True, label="Mahndatum"
        )
        item = next(
            (row for row in self.debtor_open_items(dunning_date) if row["invoiceId"] == invoice_id),
            None,
        )
        if not item:
            raise ValueError("Die Rechnung ist nicht mehr offen.")
        if not item["isOverdue"]:
            raise ValueError("Eine Mahnung ist erst nach Fälligkeit möglich.")
        if item["dunningBlocked"]:
            raise ValueError("Für diese Rechnung ist eine Mahnsperre gesetzt.")
        level = int(item.get("nextDunningLevel") or 0)
        if level not in {1, 2, 3}:
            raise ValueError("Die dritte Mahnung wurde bereits erstellt.")

        with _LOCK, self.connect() as con:
            existing = con.execute(
                "SELECT id FROM outgoing_dunnings WHERE invoice_id=? AND level=?",
                (invoice_id, level),
            ).fetchone()
            if existing:
                return self.dunning(int(existing["id"]))
            invoice = con.execute("SELECT * FROM outgoing_invoices WHERE id=?", (invoice_id,)).fetchone()
            run = con.execute("SELECT * FROM outgoing_runs WHERE id=?", (invoice["run_id"],)).fetchone() if invoice else None
            if not invoice or not run:
                raise ValueError("Rechnung oder Rechnungslauf nicht gefunden.")
            snapshot = {"openItem": item, "invoice": dict(invoice), "run": dict(run)}
            now = _now()
            cur = con.execute("""
                INSERT INTO outgoing_dunnings(
                    invoice_id,level,dunning_date,open_gross,status,snapshot_json,created_at
                ) VALUES(?,?,?,?,'draft',?,?)
            """, (invoice_id, level, dunning_date, str(_money(item["openGross"])), _json(snapshot), now))
            dunning_id = int(cur.lastrowid)
            self._audit(con, "dunning", dunning_id, "prepare", {
                "invoiceId": invoice_id, "level": level, "openGross": item["openGross"],
            })
            con.commit()
        return self.dunning(dunning_id)

    def attach_dunning_pdf(self, dunning_id, pdf_path):
        path = Path(pdf_path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with _LOCK, self.connect() as con:
            row = con.execute("SELECT * FROM outgoing_dunnings WHERE id=?", (int(dunning_id),)).fetchone()
            if not row:
                raise ValueError("Mahnung nicht gefunden.")
            if row["status"] == "issued" and row["pdf_sha256"] and row["pdf_sha256"] != digest:
                raise ValueError("Eine erstellte Mahnung darf nicht überschrieben werden.")
            now = _now()
            con.execute("""
                UPDATE outgoing_dunnings
                SET status='issued',pdf_path=?,pdf_sha256=?,issued_at=?
                WHERE id=?
            """, (str(path), digest, now, int(dunning_id)))
            self._audit(con, "dunning", int(dunning_id), "issue", {
                "invoiceId": int(row["invoice_id"]), "level": int(row["level"]), "sha256": digest,
            })
            con.commit()
        return self.dunning(dunning_id)

    def last_ww_sync(self):
        with self.connect() as con:
            row = con.execute(
                "SELECT created_at,payload_json FROM outgoing_audit WHERE entity='sync' AND action='ww_open_items' ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if not row:
                return {"at": "", "imported": 0, "skipped": 0}
            payload = json.loads(row["payload_json"] or "{}")
            return {"at": row["created_at"], "imported": int(payload.get("imported") or 0), "skipped": int(payload.get("skipped") or 0)}

    def _run_public(self, con, row, detail=False):
        data = _row(row)
        invoices = list(con.execute(
            "SELECT * FROM outgoing_invoices WHERE run_id=? ORDER BY issue_date,id", (row["id"],)
        ))
        payments = list(con.execute(
            "SELECT * FROM outgoing_payments WHERE run_id=? AND reversed_at IS NULL ORDER BY payment_date,id", (row["id"],)
        ))
        paid = self._payment_sum(payments)
        billed_gross = _money(sum(
            (_d(inv["increment_gross"]) for inv in invoices if inv["status"] == "issued"),
            Decimal("0"),
        ))
        data.update({
            "invoiceCount": len([x for x in invoices if x["status"] != "cancelled"]),
            "paidGross": _num(paid["gross"]),
            "currentGross": _num(billed_gross),
            "currentOpen": _num(_money(billed_gross - paid["gross"])),
        })
        if detail:
            data["invoices"] = [self._invoice_public(con, x, live=(x["status"] == "draft")) for x in invoices]
            data["payments"] = [self._payment_public(x) for x in payments]
        return data

    @staticmethod
    def _payment_sum(rows):
        return {
            "net": _money(sum((_d(x["net"]) for x in rows), Decimal("0"))),
            "vat": _money(sum((_d(x["vat"]) for x in rows), Decimal("0"))),
            "gross": _money(sum((_d(x["gross"]) for x in rows), Decimal("0"))),
        }

    def _prior_sum(self, con, run_id, exclude_invoice_id=None):
        sql = "SELECT increment_net,increment_vat,increment_gross FROM outgoing_invoices WHERE run_id=? AND status='issued' AND kind IN ('TR','SR','RE')"
        params = [int(run_id)]
        if exclude_invoice_id is not None:
            sql += " AND id<>?"
            params.append(int(exclude_invoice_id))
        rows = con.execute(sql, params).fetchall()
        return {
            "net": _money(sum((_d(x["increment_net"]) for x in rows), Decimal("0"))),
            "vat": _money(sum((_d(x["increment_vat"]) for x in rows), Decimal("0"))),
            "gross": _money(sum((_d(x["increment_gross"]) for x in rows), Decimal("0"))),
        }

    def _previous_invoices(self, con, run_id, exclude_invoice_id=None):
        sql = "SELECT id,invoice_number,issue_date,increment_net,increment_vat,increment_gross,kind FROM outgoing_invoices WHERE run_id=? AND status='issued' AND kind IN ('TR','SR','RE')"
        params = [int(run_id)]
        if exclude_invoice_id is not None:
            sql += " AND id<>?"
            params.append(int(exclude_invoice_id))
        sql += " ORDER BY issue_date,id"
        return [dict(row) for row in con.execute(sql, params)]

    def _active_payments(self, con, run_id):
        return list(con.execute(
            "SELECT * FROM outgoing_payments WHERE run_id=? AND reversed_at IS NULL ORDER BY payment_date,id", (int(run_id),)
        ))

    def save_draft(self, data, invoice_id=None):
        run_id = int(data.get("runId") or 0)
        kind = str(data.get("kind") or "TR").upper()
        if kind not in {"TR", "SR", "RE"}:
            raise ValueError("Rechnungsart ist ungültig.")
        tax_mode = str(data.get("taxMode") or "AT20").upper()
        if tax_mode not in TAX_MODES:
            raise ValueError("USt-Art ist ungültig.")
        recipient_uid = str(data.get("recipientUid") or "").strip().upper()
        if TAX_MODES[tax_mode]["requires_uid"] and not recipient_uid:
            raise ValueError("Für 0 % ist die UID des Leistungsempfängers Pflicht.")
        issue_date = _iso_date(data.get("issueDate") or date.today().isoformat(), required=True, label="Rechnungsdatum")
        due_date = _iso_date(data.get("dueDate"), required=True, label="Fälligkeitsdatum")
        service_from = _iso_date(data.get("serviceFrom"), required=True, label="Leistungsbeginn")
        service_to = _iso_date(data.get("serviceTo"), required=True, label="Leistungsende")
        if service_to < service_from:
            raise ValueError("Leistungsende liegt vor Leistungsbeginn.")
        cash_until = _iso_date(data.get("cashDiscountUntil"), required=False, label="Skontofrist")
        cash_percent = _bounded_percent(data.get("cashDiscountPercent"), "Skonto")
        if cash_percent and not cash_until:
            raise ValueError("Skontofrist fehlt.")

        with _LOCK, self.connect() as con:
            if self.is_period_closed(issue_date, con):
                raise ValueError("Der Rechnungsmonat ist bereits abgeschlossen. Bitte eine Gutschrift erstellen.")
            run = con.execute("SELECT * FROM outgoing_runs WHERE id=?", (run_id,)).fetchone()
            if not run:
                raise ValueError("Rechnungslauf nicht gefunden.")
            if run["status"] != "open":
                raise ValueError("Dieser Rechnungslauf ist bereits abgeschlossen.")
            existing = None
            if invoice_id is not None:
                existing = con.execute("SELECT * FROM outgoing_invoices WHERE id=? AND run_id=?", (int(invoice_id), run_id)).fetchone()
                if not existing:
                    raise ValueError("Rechnungsentwurf nicht gefunden.")
                if existing["status"] != "draft":
                    raise ValueError("Eine ausgestellte Rechnung ist unveränderlich.")
            if kind == "RE" and self._previous_invoices(con, run_id, invoice_id):
                raise ValueError("Eine normale Rechnung ist nur in einem neuen, leeren Rechnungslauf möglich.")

            prior = self._prior_sum(con, run_id, invoice_id)
            payment_rows = self._active_payments(con, run_id)
            paid = self._payment_sum(payment_rows)
            lines = [dict(row) for row in (data.get("lines") or [])]
            report_start = 0
            for line_index, line in enumerate(lines):
                marker = str(line.get("unit") or "").upper()
                if marker == "TAG":
                    report_start = line_index + 1
                if marker != "SUMME":
                    continue
                material_discount = _bounded_percent(
                    line.get("discountPercent") if "discountPercent" in line else line.get("discount_percent"),
                    "Materialrabatt",
                )
                if not material_discount:
                    continue
                for report_line in lines[report_start:line_index]:
                    unit = str(report_line.get("unit") or "").upper()
                    if unit in {"STD", "STD.", "H", "H.", "TAG", "BAUTEIL", "ARBEIT", "MATERIAL"}:
                        if unit in {"STD", "STD.", "H", "H."}:
                            report_line["discountPercent"] = 0
                        continue
                    report_line["discountPercent"] = str(material_discount)
            totals = calculate_totals(
                lines, tax_mode=tax_mode,
                retention_percent=data.get("retentionPercent"),
                discount_percent=data.get("discountPercent"),
                cash_discount_percent=cash_percent,
                prior=prior, payments=paid,
            )
            if (
                tax_mode == "AT20"
                and str(run["customer_company"] or "").strip()
                and abs(totals["incrementGross"]) > Decimal("10000")
                and not recipient_uid
            ):
                raise ValueError("Bei einer B2B-Rechnung über 10.000 EUR ist die Kunden-UID Pflicht.")
            now = _now()
            fields = (
                kind, issue_date, due_date, service_from, service_to, str(data.get("subject") or "").strip(),
                str(data.get("worker") or self.settings(con).get("default_worker") or "").strip(), recipient_uid,
                tax_mode, str(totals["vatRate"]), str(totals["retentionPercent"]), str(totals["discountPercent"]),
                str(totals["cashDiscountPercent"]), cash_until, str(data.get("currency") or "EUR").upper()[:3],
                str(totals["lineSubtotalNet"]), str(totals["retentionNet"]), str(totals["netAfterRetention"]),
                str(totals["discountNet"]), str(totals["cumulativeNet"]), str(totals["cumulativeVat"]),
                str(totals["cumulativeGross"]), str(totals["cashDiscountGross"]), str(totals["cumulativeGrossDiscounted"]),
                str(totals["priorNet"]), str(totals["priorVat"]), str(totals["priorGross"]),
                str(totals["incrementNet"]), str(totals["incrementVat"]), str(totals["incrementGross"]),
                str(totals["paidNet"]), str(totals["paidVat"]), str(totals["paidGross"]),
                str(totals["openWithDiscount"]), str(totals["openAfterDiscount"]),
                TAX_MODES[tax_mode]["note"], str(data.get("notes") or "").strip(), now,
            )
            if existing:
                con.execute("""
                    UPDATE outgoing_invoices SET
                      kind=?,issue_date=?,due_date=?,service_from=?,service_to=?,subject=?,worker=?,recipient_uid=?,
                      tax_mode=?,vat_rate=?,retention_percent=?,discount_percent=?,cash_discount_percent=?,cash_discount_until=?,currency=?,
                      line_subtotal_net=?,retention_net=?,net_after_retention=?,discount_net=?,cumulative_net=?,cumulative_vat=?,cumulative_gross=?,
                      cash_discount_gross=?,cumulative_gross_discounted=?,prior_net=?,prior_vat=?,prior_gross=?,increment_net=?,increment_vat=?,increment_gross=?,
                      paid_net_snapshot=?,paid_vat_snapshot=?,paid_gross_snapshot=?,open_with_discount=?,open_after_discount=?,tax_note=?,notes=?,updated_at=?
                    WHERE id=?
                """, fields + (int(invoice_id),))
                target_id = int(invoice_id)
                con.execute("DELETE FROM outgoing_lines WHERE invoice_id=?", (target_id,))
            else:
                columns = [
                    "run_id","kind","status","issue_date","due_date","service_from","service_to","subject","worker","recipient_uid",
                    "tax_mode","vat_rate","retention_percent","discount_percent","cash_discount_percent","cash_discount_until","currency",
                    "line_subtotal_net","retention_net","net_after_retention","discount_net","cumulative_net","cumulative_vat","cumulative_gross",
                    "cash_discount_gross","cumulative_gross_discounted","prior_net","prior_vat","prior_gross","increment_net","increment_vat","increment_gross",
                    "paid_net_snapshot","paid_vat_snapshot","paid_gross_snapshot","open_with_discount","open_after_discount","tax_note","notes","created_at","updated_at",
                ]
                values = (run_id, fields[0], "draft") + fields[1:-1] + (now, now)
                cur = con.execute(
                    f"INSERT INTO outgoing_invoices({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
                    values,
                )
                target_id = cur.lastrowid
            for line in totals["lines"]:
                con.execute("""
                    INSERT INTO outgoing_lines(invoice_id,line_no,description,quantity,unit,unit_price,discount_percent,net)
                    VALUES(?,?,?,?,?,?,?,?)
                """, (target_id, line["lineNo"], line["description"], str(line["quantity"]), line["unit"],
                      str(line["unitPrice"]), str(line["discountPercent"]), str(line["net"])))
            self._audit(con, "invoice", target_id, "save_draft", {"kind": kind, "runId": run_id})
            con.commit()
        return self.invoice(target_id, live=True)

    def invoice(self, invoice_id, live=False):
        with self.connect() as con:
            row = con.execute("SELECT * FROM outgoing_invoices WHERE id=?", (int(invoice_id),)).fetchone()
            if not row:
                raise ValueError("Rechnung nicht gefunden.")
            return self._invoice_public(con, row, live=live and row["status"] == "draft")

    def _invoice_public(self, con, row, live=False):
        data = _row(row)
        data["lines"] = [dict(x) for x in con.execute("SELECT * FROM outgoing_lines WHERE invoice_id=? ORDER BY line_no", (row["id"],))]
        run = con.execute("SELECT * FROM outgoing_runs WHERE id=?", (row["run_id"],)).fetchone()
        data["run"] = _row(run)
        data["revisionNo"] = int(con.execute(
            "SELECT COUNT(*) FROM outgoing_revisions WHERE invoice_id=?", (row["id"],)
        ).fetchone()[0])
        if live:
            prior = self._prior_sum(con, row["run_id"], row["id"])
            payment_rows = self._active_payments(con, row["run_id"])
            paid = self._payment_sum(payment_rows)
            calc_lines = [{
                "description": x["description"], "quantity": x["quantity"], "unit": x["unit"],
                "unitPrice": x["unit_price"], "discountPercent": x["discount_percent"],
            } for x in data["lines"]]
            totals = calculate_totals(
                calc_lines, tax_mode=row["tax_mode"], retention_percent=row["retention_percent"],
                discount_percent=row["discount_percent"], cash_discount_percent=row["cash_discount_percent"],
                prior=prior, payments=paid,
            )
            for key, value in totals.items():
                if key != "lines":
                    data[key] = _num(value)
            data["previousInvoices"] = [self._invoice_snapshot(x) for x in self._previous_invoices(con, row["run_id"], row["id"])]
            data["payments"] = [self._payment_public(x) for x in payment_rows]
        else:
            data["previousInvoices"] = json.loads(row["previous_snapshot_json"] or "[]")
            data["payments"] = json.loads(row["payments_snapshot_json"] or "[]")
        for key in (
            "vat_rate","retention_percent","discount_percent","cash_discount_percent","line_subtotal_net","retention_net",
            "net_after_retention","discount_net","cumulative_net","cumulative_vat","cumulative_gross","cash_discount_gross",
            "cumulative_gross_discounted","prior_net","prior_vat","prior_gross","increment_net","increment_vat","increment_gross",
            "paid_net_snapshot","paid_vat_snapshot","paid_gross_snapshot","open_with_discount","open_after_discount",
        ):
            if key in data:
                data[key] = _num(data[key])
        return data

    @staticmethod
    def _invoice_snapshot(row):
        return {
            "id": row["id"], "invoiceNumber": row["invoice_number"], "issueDate": row["issue_date"], "kind": row["kind"],
            "net": _num(row["increment_net"]), "vat": _num(row["increment_vat"]), "gross": _num(row["increment_gross"]),
        }

    @staticmethod
    def _payment_public(row):
        return {
            "id": row["id"], "invoiceId": row["invoice_id"], "paymentDate": row["payment_date"],
            "net": _num(row["net"]), "vat": _num(row["vat"]), "gross": _num(row["gross"]),
            "reference": row["reference"], "source": row["source"],
        }

    def add_payment(self, run_id, data):
        run_id = int(run_id)
        payment_date = _iso_date(data.get("paymentDate"), required=True, label="Zahlungsdatum")
        gross = _money(data.get("gross"))
        if gross <= 0:
            raise ValueError("Zahlungsbetrag muss größer als null sein.")
        with _LOCK, self.connect() as con:
            run = con.execute("SELECT * FROM outgoing_runs WHERE id=?", (run_id,)).fetchone()
            if not run:
                raise ValueError("Rechnungslauf nicht gefunden.")
            net_value = data.get("net")
            vat_value = data.get("vat")
            if net_value in (None, "") or vat_value in (None, ""):
                latest = con.execute(
                    "SELECT vat_rate FROM outgoing_invoices WHERE run_id=? AND status<>'cancelled' ORDER BY issue_date DESC,id DESC LIMIT 1",
                    (run_id,),
                ).fetchone()
                rate = _d(latest["vat_rate"] if latest else "0")
                net = _money(gross / (Decimal("1") + rate / Decimal("100"))) if rate else gross
                vat = _money(gross - net)
            else:
                net = _money(net_value)
                vat = _money(vat_value)
                if _money(net + vat) != gross:
                    raise ValueError("Netto + USt muss dem Bruttobetrag entsprechen.")
            cur = con.execute("""
                INSERT INTO outgoing_payments(run_id,invoice_id,payment_date,net,vat,gross,reference,source,source_id,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)
            """, (run_id, data.get("invoiceId"), payment_date, str(net), str(vat), str(gross),
                  str(data.get("reference") or "").strip(), str(data.get("source") or "KRISTINE"), data.get("sourceId"), _now()))
            payment_id = cur.lastrowid
            self._audit(con, "payment", payment_id, "create", {"runId": run_id, "gross": str(gross)})
            con.commit()
            row = con.execute("SELECT * FROM outgoing_payments WHERE id=?", (payment_id,)).fetchone()
            return self._payment_public(row)

    def sync_ww_project_history(self, rows):
        """Import the complete WW invoice chain for one project and continue it in KRISTINE.

        Unlike the debtor opening-balance import, this keeps the original invoice amount and
        mirrors the already settled portion as one WW payment.  That makes a paid first partial
        invoice visible to the cumulative calculation of the next partial invoice.
        """
        unique = {}
        for raw in rows or []:
            source_id = str(raw.get("sourceId") or "").strip()
            number = str(raw.get("invoiceNumber") or "").strip()
            if source_id and number:
                unique[source_id] = dict(raw)
        items = sorted(
            unique.values(),
            key=lambda x: (str(x.get("issueDate") or ""), str(x.get("invoiceNumber") or "")),
        )
        if not items:
            return {"imported": 0, "updated": 0, "payments": 0, "runId": None}

        imported = updated = payment_count = 0
        project_index = int(items[0].get("projectIndex") or 0)
        if not project_index:
            raise ValueError("WW-Projektindex fehlt.")

        with _LOCK, self.connect() as con:
            source_ids = list(unique)
            placeholders = ",".join("?" for _ in source_ids)
            existing_ww = con.execute(
                f"SELECT * FROM outgoing_invoices WHERE source='WW' AND source_id IN ({placeholders}) "
                "ORDER BY issue_date,id",
                source_ids,
            ).fetchall()
            run = None
            if existing_ww:
                run = con.execute(
                    "SELECT * FROM outgoing_runs WHERE id=?", (int(existing_ww[0]["run_id"]),)
                ).fetchone()
            if not run:
                run = con.execute(
                    "SELECT * FROM outgoing_runs WHERE project_index=? AND label IN (?,?) ORDER BY id LIMIT 1",
                    (project_index, WW_CONTINUATION_LABEL, "WW-Altbestand (automatisch)"),
                ).fetchone()

            first = items[0]
            customer_name = str(first.get("customerName") or "").strip()
            customer_company = str(first.get("customerCompany") or "").strip()
            if not customer_name and not customer_company:
                customer_name = str(first.get("customerRaw") or "WinWorker-Kunde").strip()
            if not run:
                cur = con.execute("""
                    INSERT INTO outgoing_runs(
                      project_index,project_number,customer_index,label,customer_name,customer_company,
                      customer_street,customer_postal_code,customer_city,customer_country,customer_uid,
                      project_title,status,created_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'open',?)
                """, (
                    project_index, str(first.get("projectNumber") or ""), first.get("customerIndex"),
                    WW_CONTINUATION_LABEL, customer_name, customer_company,
                    str(first.get("street") or "Adresse lt. WinWorker"),
                    str(first.get("postalCode") or "-"), str(first.get("city") or "-"),
                    str(first.get("country") or "Österreich"),
                    str(first.get("customerUid") or "").strip().upper(),
                    str(first.get("projectTitle") or "").strip(), _now(),
                ))
                run_id = int(cur.lastrowid)
            else:
                run_id = int(run["id"])
                if str(run["label"]) == "WW-Altbestand (automatisch)":
                    con.execute(
                        "UPDATE outgoing_runs SET label=? WHERE id=?",
                        (WW_CONTINUATION_LABEL, run_id),
                    )

            previous = []
            cumulative_net = cumulative_vat = cumulative_gross = Decimal("0")
            last_kind = ""
            for item in items:
                source_id = str(item.get("sourceId") or "").strip()
                number = str(item.get("invoiceNumber") or "").strip()
                rate = _rate(item.get("vatRate"))
                tax_mode = "AT20" if rate == Decimal("20.000") else "CHLI81" if rate == Decimal("8.100") else "RC19"
                original_net = _money(item.get("originalNet"))
                original_gross = _money(item.get("originalGross"))
                if not original_gross and original_net:
                    original_gross = _money(original_net * (Decimal("1") + rate / Decimal("100")))
                original_vat = _money(original_gross - original_net)
                open_gross = max(Decimal("0"), min(original_gross, _money(item.get("openGross"))))
                calculated_paid_gross = _money(original_gross - open_gross)
                if item.get("paidGrossAvailable"):
                    paid_gross = max(Decimal("0"), min(original_gross, _money(item.get("paidGross"))))
                else:
                    paid_gross = calculated_paid_gross
                paid_net = _money(paid_gross / (Decimal("1") + rate / Decimal("100"))) if rate else paid_gross
                paid_vat = _money(paid_gross - paid_net)
                issue_date = _iso_date(item.get("issueDate"), required=True, label="WW-Rechnungsdatum")
                due_date = _iso_date(item.get("dueDate") or issue_date, required=True, label="WW-Fälligkeit")
                service_from = _iso_date(item.get("serviceFrom") or issue_date, required=True)
                service_to = _iso_date(item.get("serviceTo") or issue_date, required=True)
                payment_date = _iso_date(item.get("paymentDate") or due_date, required=True, label="WW-Zahlungsdatum")
                kind = "SR" if item.get("isFinal") else "TR" if item.get("isPartial") else "RE"
                last_kind = kind
                prior_net, prior_vat, prior_gross = cumulative_net, cumulative_vat, cumulative_gross
                cumulative_net = _money(cumulative_net + original_net)
                cumulative_vat = _money(cumulative_vat + original_vat)
                cumulative_gross = _money(cumulative_gross + original_gross)
                now = _now()
                existing = con.execute(
                    "SELECT * FROM outgoing_invoices WHERE source='WW' AND source_id=?", (source_id,)
                ).fetchone()
                if existing and int(existing["run_id"]) != run_id:
                    con.execute("UPDATE outgoing_invoices SET run_id=? WHERE id=?", (run_id, int(existing["id"])))
                    con.execute("UPDATE outgoing_payments SET run_id=? WHERE invoice_id=?", (run_id, int(existing["id"])))

                fields = (
                    run_id, kind, number, issue_date, due_date, service_from, service_to,
                    str(item.get("projectTitle") or "WinWorker-Ausgangsrechnung"),
                    str(item.get("worker") or ""), str(item.get("customerUid") or ""), tax_mode, str(rate),
                    str(original_net), str(original_net), str(cumulative_net), str(cumulative_vat), str(cumulative_gross),
                    str(cumulative_gross), str(prior_net), str(prior_vat), str(prior_gross),
                    str(original_net), str(original_vat), str(original_gross), str(open_gross), str(open_gross),
                    _json(previous), TAX_MODES[tax_mode]["note"] if not rate else "",
                    "Vollständige Rechnungshistorie aus WinWorker; wird in KRISTINE fortgeführt.", now, now,
                )
                if existing:
                    invoice_id = int(existing["id"])
                    con.execute("""
                        UPDATE outgoing_invoices SET
                          run_id=?,kind=?,status='issued',invoice_number=?,issue_date=?,due_date=?,service_from=?,service_to=?,
                          subject=?,worker=?,recipient_uid=?,tax_mode=?,vat_rate=?,currency='EUR',line_subtotal_net=?,
                          net_after_retention=?,cumulative_net=?,cumulative_vat=?,cumulative_gross=?,
                          cumulative_gross_discounted=?,prior_net=?,prior_vat=?,prior_gross=?,increment_net=?,
                          increment_vat=?,increment_gross=?,open_with_discount=?,open_after_discount=?,
                          previous_snapshot_json=?,tax_note=?,notes=?,updated_at=?,issued_at=COALESCE(issued_at,?)
                        WHERE id=?
                    """, (*fields, invoice_id))
                    updated += 1
                else:
                    conflict = con.execute(
                        "SELECT id FROM outgoing_invoices WHERE invoice_number=?", (number,)
                    ).fetchone()
                    if conflict:
                        raise ValueError(f"Rechnungsnummer {number} ist in KRISTINE bereits anderweitig vorhanden.")
                    columns = [
                        "run_id","kind","invoice_number","issue_date","due_date","service_from","service_to",
                        "subject","worker","recipient_uid","tax_mode","vat_rate","line_subtotal_net","net_after_retention",
                        "cumulative_net","cumulative_vat","cumulative_gross","cumulative_gross_discounted",
                        "prior_net","prior_vat","prior_gross","increment_net","increment_vat","increment_gross",
                        "open_with_discount","open_after_discount","previous_snapshot_json","tax_note","notes","created_at","updated_at",
                    ]
                    values = fields
                    cur = con.execute(
                        f"INSERT INTO outgoing_invoices(source,source_id,status,currency,issued_at,{','.join(columns)}) "
                        f"VALUES('WW',?,'issued','EUR',?,{','.join('?' for _ in columns)})",
                        (source_id, now, *values),
                    )
                    invoice_id = int(cur.lastrowid)
                    imported += 1

                line = con.execute(
                    "SELECT id FROM outgoing_lines WHERE invoice_id=? AND line_no=1", (invoice_id,)
                ).fetchone()
                line_text = f"{len([x for x in previous if x.get('kind') == 'TR']) + 1}. Teilrechnung aus WinWorker · {number}" if kind == "TR" else f"{kind} aus WinWorker · {number}"
                if line:
                    con.execute(
                        "UPDATE outgoing_lines SET description=?,quantity='1',unit='PA',unit_price=?,discount_percent='0',net=? WHERE id=?",
                        (line_text, str(original_net), str(original_net), int(line["id"])),
                    )
                else:
                    con.execute("""
                        INSERT INTO outgoing_lines(invoice_id,line_no,description,quantity,unit,unit_price,discount_percent,net)
                        VALUES(?,1,?,'1','PA',?,'0',?)
                    """, (invoice_id, line_text, str(original_net), str(original_net)))

                payment_source_id = f"HISTORY:{source_id}"
                existing_payment = con.execute(
                    "SELECT id FROM outgoing_payments WHERE source='WW' AND source_id=?", (payment_source_id,)
                ).fetchone()
                if paid_gross > 0:
                    if existing_payment:
                        con.execute("""
                            UPDATE outgoing_payments SET run_id=?,invoice_id=?,payment_date=?,net=?,vat=?,gross=?,
                              reference=?,reversed_at=NULL WHERE id=?
                        """, (run_id, invoice_id, payment_date, str(paid_net), str(paid_vat), str(paid_gross),
                              f"In WinWorker bereits verbucht · Rechnung {number}", int(existing_payment["id"])))
                    else:
                        con.execute("""
                            INSERT INTO outgoing_payments(
                              run_id,invoice_id,payment_date,net,vat,gross,reference,source,source_id,created_at
                            ) VALUES(?,?,?,?,?,?,?,'WW',?,?)
                        """, (run_id, invoice_id, payment_date, str(paid_net), str(paid_vat), str(paid_gross),
                              f"In WinWorker bereits verbucht · Rechnung {number}", payment_source_id, now))
                    payment_count += 1
                elif existing_payment:
                    con.execute("DELETE FROM outgoing_payments WHERE id=?", (int(existing_payment["id"]),))

                try:
                    level = max(0, min(3, int(item.get("dunningLevel") or 0)))
                except (TypeError, ValueError):
                    level = 0
                con.execute("""
                    INSERT INTO outgoing_debtor_meta(
                      invoice_id,ww_dunning_level,ww_last_dunning,ww_blocked_until,updated_at
                    ) VALUES(?,?,?,?,?)
                    ON CONFLICT(invoice_id) DO UPDATE SET
                      ww_dunning_level=excluded.ww_dunning_level,ww_last_dunning=excluded.ww_last_dunning,
                      ww_blocked_until=excluded.ww_blocked_until,updated_at=excluded.updated_at
                """, (invoice_id, level, _iso_date(item.get("lastDunning")),
                      _iso_date(item.get("dunningBlockedUntil")), now))
                self._audit(con, "invoice", invoice_id, "sync_ww_history", {
                    "invoiceNumber": number, "originalGross": str(original_gross),
                    "openGross": str(open_gross), "sourceId": source_id,
                })
                previous.append({
                    "id": invoice_id, "invoiceNumber": number, "issueDate": issue_date, "kind": kind,
                    "net": _num(original_net), "vat": _num(original_vat), "gross": _num(original_gross),
                })

            local_after_ww = con.execute(
                "SELECT 1 FROM outgoing_invoices WHERE run_id=? AND source='KRISTINE' AND status<>'cancelled' LIMIT 1",
                (run_id,),
            ).fetchone()
            run_status = "closed" if last_kind == "SR" and not local_after_ww else "open"
            con.execute("UPDATE outgoing_runs SET status=?,closed_at=? WHERE id=?", (
                run_status, _now() if run_status == "closed" else None, run_id,
            ))
            self._audit(con, "sync", None, "ww_project_history", {
                "projectIndex": project_index, "runId": run_id, "imported": imported,
                "updated": updated, "payments": payment_count,
            })
            con.commit()
        return {"imported": imported, "updated": updated, "payments": payment_count, "runId": run_id}

    def sync_ww_open_items(self, rows):
        """Import new WW open items once as opening balances; never writes to WW."""
        imported = skipped = 0
        touched_runs = set()
        with _LOCK, self.connect() as con:
            def sync_dunning_meta(invoice_id, item):
                try:
                    level = max(0, min(3, int(item.get("dunningLevel") or 0)))
                except (TypeError, ValueError):
                    level = 0
                last = _iso_date(item.get("lastDunning"))
                blocked_until = _iso_date(item.get("dunningBlockedUntil"))
                con.execute("""
                    INSERT INTO outgoing_debtor_meta(
                        invoice_id,ww_dunning_level,ww_last_dunning,ww_blocked_until,updated_at
                    ) VALUES(?,?,?,?,?)
                    ON CONFLICT(invoice_id) DO UPDATE SET
                        ww_dunning_level=excluded.ww_dunning_level,
                        ww_last_dunning=excluded.ww_last_dunning,
                        ww_blocked_until=excluded.ww_blocked_until,
                        updated_at=excluded.updated_at
                """, (int(invoice_id), level, last, blocked_until, _now()))

            for item in rows or []:
                source_id = str(item.get("sourceId") or "").strip()
                number = str(item.get("invoiceNumber") or "").strip()
                if not source_id or not number:
                    continue
                existing = con.execute(
                    "SELECT id,run_id FROM outgoing_invoices WHERE source='WW' AND source_id=?", (source_id,)
                ).fetchone()
                if existing:
                    sync_dunning_meta(int(existing["id"]), item)
                    touched_runs.add(int(existing["run_id"]))
                    skipped += 1
                    continue
                project_index = item.get("projectIndex")
                run = con.execute(
                    "SELECT * FROM outgoing_runs WHERE project_index=? AND label='WW-Altbestand (automatisch)' ORDER BY id LIMIT 1",
                    (project_index,),
                ).fetchone()
                if not run:
                    customer_name = str(item.get("customerName") or "").strip()
                    customer_company = str(item.get("customerCompany") or "").strip()
                    if not customer_name and not customer_company:
                        customer_name = str(item.get("customerRaw") or "WinWorker-Kunde").strip()
                    cur = con.execute("""
                        INSERT INTO outgoing_runs(
                          project_index,project_number,customer_index,label,customer_name,customer_company,
                          customer_street,customer_postal_code,customer_city,customer_country,customer_uid,
                          project_title,status,created_at
                        ) VALUES(?,?,?,'WW-Altbestand (automatisch)',?,?,?,?,?,?,?,?,'open',?)
                    """, (
                        project_index, str(item.get("projectNumber") or ""), item.get("customerIndex"),
                        customer_name, customer_company, str(item.get("street") or "Adresse lt. WinWorker"),
                        str(item.get("postalCode") or "-"), str(item.get("city") or "-"),
                        str(item.get("country") or "").strip(), str(item.get("customerUid") or "").strip().upper(),
                        str(item.get("projectTitle") or "").strip(), _now(),
                    ))
                    run_id = cur.lastrowid
                else:
                    run_id = int(run["id"])
                touched_runs.add(run_id)

                rate = _rate(item.get("vatRate"))
                tax_mode = "AT20" if rate == Decimal("20.000") else "CHLI81" if rate == Decimal("8.100") else "RC19"
                open_gross = _money(item.get("openGross"))
                if open_gross <= 0:
                    skipped += 1
                    continue
                open_net = _money(open_gross / (Decimal("1") + rate / Decimal("100"))) if rate else open_gross
                open_vat = _money(open_gross - open_net)
                original_net = _money(item.get("originalNet"))
                original_gross = _money(item.get("originalGross"))
                original_vat = _money(original_gross - original_net)
                issue_date = _iso_date(item.get("issueDate"), required=True, label="WW-Rechnungsdatum")
                due_date = _iso_date(item.get("dueDate") or issue_date, required=True, label="WW-Fälligkeit")
                service_from = _iso_date(item.get("serviceFrom") or issue_date, required=True)
                service_to = _iso_date(item.get("serviceTo") or issue_date, required=True)
                kind = "SR" if item.get("isFinal") else "TR" if item.get("isPartial") else "RE"
                now = _now()
                columns = [
                    "run_id","source","source_id","kind","status","invoice_number","issue_date","due_date","service_from","service_to",
                    "subject","worker","recipient_uid","tax_mode","vat_rate","currency","line_subtotal_net","net_after_retention",
                    "cumulative_net","cumulative_vat","cumulative_gross","cumulative_gross_discounted","increment_net","increment_vat","increment_gross",
                    "open_with_discount","open_after_discount","tax_note","notes","created_at","updated_at","issued_at",
                ]
                values = (
                    run_id,"WW",source_id,kind,"issued",number,issue_date,due_date,service_from,service_to,
                    str(item.get("projectTitle") or "WinWorker-Ausgangsrechnung"),str(item.get("worker") or ""),str(item.get("customerUid") or ""),
                    tax_mode,str(rate),"EUR",str(original_net),str(original_net),str(original_net),str(original_vat),str(original_gross),str(original_gross),
                    str(open_net),str(open_vat),str(open_gross),str(open_gross),str(open_gross),TAX_MODES[tax_mode]["note"] if not rate else "",
                    f"Aus WinWorker übernommen. Original brutto {original_gross}; offener Übernahmestand {open_gross}.",now,now,now,
                )
                cur = con.execute(
                    f"INSERT INTO outgoing_invoices({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", values
                )
                invoice_id = cur.lastrowid
                con.execute("""
                    INSERT INTO outgoing_lines(invoice_id,line_no,description,quantity,unit,unit_price,discount_percent,net)
                    VALUES(?,1,?,'1','PA',?,'0',?)
                """, (invoice_id, f"Offener Posten aus WinWorker · Rechnung {number}", str(open_net), str(open_net)))
                sync_dunning_meta(invoice_id, item)
                self._audit(con, "invoice", invoice_id, "import_ww_open", {
                    "invoiceNumber": number, "openGross": str(open_gross), "sourceId": source_id,
                })
                imported += 1
            self._audit(con, "sync", None, "ww_open_items", {"imported": imported, "skipped": skipped})
            con.commit()
        return {"imported": imported, "skipped": skipped, "runIds": sorted(touched_runs)}

    def reverse_payment(self, payment_id):
        with _LOCK, self.connect() as con:
            row = con.execute("SELECT * FROM outgoing_payments WHERE id=?", (int(payment_id),)).fetchone()
            if not row:
                raise ValueError("Zahlung nicht gefunden.")
            if row["reversed_at"]:
                return self._payment_public(row)
            stamp = _now()
            con.execute("UPDATE outgoing_payments SET reversed_at=? WHERE id=?", (stamp, int(payment_id)))
            self._audit(con, "payment", int(payment_id), "reverse", {})
            con.commit()
            result = self._payment_public(row)
            result["reversedAt"] = stamp
            return result

    def next_number_preview(self, issue_date, external_numbers=None):
        """Return the next number without consuming it."""
        with _LOCK, self.connect() as con:
            return self._number_for(con, issue_date, external_numbers, consume=False)

    def _number_for(self, con, issue_date, external_numbers=None, *, consume):
        stamp = date.fromisoformat(issue_date)
        period = stamp.strftime("%Y%m")
        row = con.execute("SELECT next_value FROM outgoing_sequences WHERE period=?", (period,)).fetchone()
        seq = int(row["next_value"]) if row else 1
        template = self.settings(con).get("number_template") or DEFAULT_SETTINGS["number_template"]
        occupied = {
            str(x or "").strip()
            for x in (external_numbers or [])
            if str(x or "").strip()
        }
        occupied.update(
            str(x[0] or "").strip()
            for x in con.execute(
                "SELECT invoice_number FROM outgoing_invoices WHERE invoice_number IS NOT NULL"
            ).fetchall()
        )
        external_sequences = [
            int(number[len(period):])
            for number in occupied
            if number.startswith(period) and number[len(period):].isdigit()
        ]
        if external_sequences:
            seq = max(seq, max(external_sequences) + 1)
        try:
            while True:
                number = template.format(year=stamp.strftime("%Y"), yy=stamp.strftime("%y"), month=stamp.strftime("%m"), seq=seq)
                if number not in occupied:
                    break
                seq += 1
        except Exception as exc:
            raise ValueError("Rechnungsnummern-Vorlage ist ungültig.") from exc
        if not number or len(number) > 40:
            raise ValueError("Erzeugte Rechnungsnummer ist ungültig.")
        if consume:
            if row:
                con.execute("UPDATE outgoing_sequences SET next_value=? WHERE period=?", (seq + 1, period))
            else:
                con.execute("INSERT INTO outgoing_sequences(period,next_value) VALUES(?,?)", (period, seq + 1))
        return number

    def _next_number(self, con, issue_date, external_numbers=None):
        return self._number_for(con, issue_date, external_numbers, consume=True)

    def create_correction_draft(self, invoice_id, data):
        """Create a linked full cancellation (ST) or partial credit note (GS)."""
        kind = str(data.get("kind") or "").upper()
        if kind not in {"ST", "GS"}:
            raise ValueError("Korrekturart muss Stornorechnung oder Gutschrift sein.")
        reason = str(data.get("reason") or "").strip()
        if not reason:
            raise ValueError("Begründung der Korrektur fehlt.")
        issue_date = _iso_date(data.get("issueDate") or date.today().isoformat(), required=True, label="Belegdatum")
        with _LOCK, self.connect() as con:
            original = con.execute("SELECT * FROM outgoing_invoices WHERE id=?", (int(invoice_id),)).fetchone()
            if not original or original["status"] != "issued" or original["kind"] in {"ST", "GS"}:
                raise ValueError("Ausgangsrechnung für die Korrektur nicht gefunden.")
            already_storno = con.execute(
                "SELECT 1 FROM outgoing_invoices WHERE corrects_invoice_id=? AND kind='ST' AND status IN ('draft','issued') LIMIT 1",
                (int(invoice_id),),
            ).fetchone()
            if kind == "ST" and already_storno:
                raise ValueError("Zu dieser Rechnung besteht bereits eine Stornorechnung.")
            if kind == "ST" and self.is_period_closed(original["issue_date"], con):
                raise ValueError("Der Ursprungsmonat ist abgeschlossen. Bitte eine Gutschrift über den Gesamtbetrag erstellen.")
            rate = _d(original["vat_rate"])
            if kind == "ST":
                net = -_money(original["increment_net"])
                vat = -_money(original["increment_vat"])
                gross = -_money(original["increment_gross"])
                description = f"Storno zur {original['invoice_number']} vom {original['issue_date']}"
            else:
                gross_abs = _money(data.get("gross"))
                if gross_abs <= 0:
                    raise ValueError("Gutschriftbetrag muss größer als null sein.")
                net_abs = _money(gross_abs / (Decimal("1") + rate / Decimal("100"))) if rate else gross_abs
                vat_abs = _money(gross_abs - net_abs)
                net, vat, gross = -net_abs, -vat_abs, -gross_abs
                description = str(data.get("description") or f"Gutschrift / Abzug zu {original['invoice_number']}").strip()
            now = _now()
            subject = "Stornorechnung" if kind == "ST" else "Gutschrift"
            cur = con.execute("""
                INSERT INTO outgoing_invoices(
                  run_id,kind,status,issue_date,due_date,service_from,service_to,subject,worker,recipient_uid,
                  tax_mode,vat_rate,currency,line_subtotal_net,net_after_retention,cumulative_net,cumulative_vat,cumulative_gross,
                  cumulative_gross_discounted,increment_net,increment_vat,increment_gross,open_with_discount,open_after_discount,
                  tax_note,notes,corrects_invoice_id,correction_reason,created_at,updated_at
                ) VALUES(?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                original["run_id"], kind, issue_date, issue_date, original["service_from"], original["service_to"], subject,
                original["worker"], original["recipient_uid"], original["tax_mode"], str(rate), original["currency"],
                str(net), str(net), str(net), str(vat), str(gross), str(gross), str(net), str(vat), str(gross),
                str(gross), str(gross), original["tax_note"], reason, int(invoice_id), reason, now, now,
            ))
            correction_id = cur.lastrowid
            if kind == "ST":
                original_lines = list(con.execute(
                    "SELECT * FROM outgoing_lines WHERE invoice_id=? ORDER BY line_no", (int(invoice_id),)
                ))
                if original_lines:
                    # Preserve the familiar original positions; the final correction totals remain authoritative.
                    factor = Decimal("-1")
                    for line in original_lines:
                        con.execute("""
                            INSERT INTO outgoing_lines(invoice_id,line_no,description,quantity,unit,unit_price,discount_percent,net)
                            VALUES(?,?,?,?,?,?,?,?)
                        """, (correction_id, line["line_no"], line["description"], line["quantity"], line["unit"],
                              str(_money(_d(line["unit_price"]) * factor)), line["discount_percent"],
                              str(_money(_d(line["net"]) * factor))))
                else:
                    con.execute("""
                        INSERT INTO outgoing_lines(invoice_id,line_no,description,quantity,unit,unit_price,discount_percent,net)
                        VALUES(?,1,?,'1','PA',?,'0',?)
                    """, (correction_id, description, str(net), str(net)))
            else:
                con.execute("""
                    INSERT INTO outgoing_lines(invoice_id,line_no,description,quantity,unit,unit_price,discount_percent,net)
                    VALUES(?,1,?,'1','PA',?,'0',?)
                """, (correction_id, description, str(net), str(net)))
            self._audit(con, "invoice", correction_id, "create_correction_draft", {
                "kind": kind, "correctsInvoiceId": int(invoice_id), "gross": str(gross),
            })
            con.commit()
        return self.invoice(correction_id, live=False)

    def begin_revision(self, invoice_id):
        """Open an issued invoice for a traceable revision before period close."""
        with _LOCK, self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT * FROM outgoing_invoices WHERE id=?", (int(invoice_id),)).fetchone()
            if not row or row["status"] != "issued":
                raise ValueError("Nur eine ausgestellte Rechnung kann überarbeitet werden.")
            if row["kind"] in {"ST", "GS"}:
                raise ValueError("Korrekturbelege werden nicht überschrieben; bitte einen weiteren Beleg erstellen.")
            if self.is_period_closed(row["issue_date"], con):
                raise ValueError("Der Rechnungsmonat ist abgeschlossen. Bitte eine Gutschrift erstellen.")
            snapshot = self._invoice_public(con, row, live=False)
            revision_no = int(con.execute(
                "SELECT COALESCE(MAX(revision_no),0)+1 FROM outgoing_revisions WHERE invoice_id=?", (int(invoice_id),)
            ).fetchone()[0])
            con.execute("""
                INSERT INTO outgoing_revisions(invoice_id,revision_no,invoice_json,previous_pdf_path,created_at)
                VALUES(?,?,?,?,?)
            """, (int(invoice_id), revision_no, _json(snapshot), row["pdf_path"], _now()))
            con.execute(
                "UPDATE outgoing_invoices SET status='draft',pdf_path=NULL,pdf_sha256=NULL,updated_at=? WHERE id=?",
                (_now(), int(invoice_id)),
            )
            if row["kind"] in {"SR", "RE"}:
                con.execute("UPDATE outgoing_runs SET status='open',closed_at=NULL WHERE id=?", (row["run_id"],))
            self._audit(con, "invoice", int(invoice_id), "begin_revision", {"revisionNo": revision_no})
            con.commit()
        return self.invoice(invoice_id, live=True)

    def prepare_issue(self, invoice_id, external_numbers=None):
        """Freeze an invoice and allocate its number. PDF is attached separately."""
        with _LOCK, self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT * FROM outgoing_invoices WHERE id=?", (int(invoice_id),)).fetchone()
            if not row:
                raise ValueError("Rechnung nicht gefunden.")
            if row["status"] == "issued":
                return self._invoice_public(con, row)
            if row["status"] != "draft":
                raise ValueError("Nur ein Entwurf kann abgeschlossen werden.")
            if self.is_period_closed(row["issue_date"], con):
                raise ValueError("Der Rechnungsmonat ist bereits abgeschlossen.")
            run = con.execute("SELECT * FROM outgoing_runs WHERE id=?", (row["run_id"],)).fetchone()
            if not run or (run["status"] != "open" and row["kind"] not in {"ST", "GS"}):
                raise ValueError("Rechnungslauf ist nicht offen.")
            if TAX_MODES[row["tax_mode"]]["requires_uid"] and not row["recipient_uid"]:
                raise ValueError("UID des Leistungsempfängers fehlt.")
            previous = self._previous_invoices(con, row["run_id"], row["id"])
            payments = self._active_payments(con, row["run_id"])
            paid = self._payment_sum(payments)
            lines = list(con.execute("SELECT * FROM outgoing_lines WHERE invoice_id=? ORDER BY line_no", (row["id"],)))
            if row["kind"] in {"ST", "GS"}:
                totals = {
                    "vatRate": _d(row["vat_rate"]), "lineSubtotalNet": _d(row["line_subtotal_net"]),
                    "retentionNet": Decimal("0"), "netAfterRetention": _d(row["net_after_retention"]),
                    "discountNet": Decimal("0"), "cumulativeNet": _d(row["cumulative_net"]),
                    "cumulativeVat": _d(row["cumulative_vat"]), "cumulativeGross": _d(row["cumulative_gross"]),
                    "cashDiscountGross": Decimal("0"), "cumulativeGrossDiscounted": _d(row["cumulative_gross"]),
                    "priorNet": Decimal("0"), "priorVat": Decimal("0"), "priorGross": Decimal("0"),
                    "incrementNet": _d(row["increment_net"]), "incrementVat": _d(row["increment_vat"]),
                    "incrementGross": _d(row["increment_gross"]), "paidNet": paid["net"], "paidVat": paid["vat"],
                    "paidGross": paid["gross"], "openWithDiscount": _d(row["increment_gross"]),
                    "openAfterDiscount": _d(row["increment_gross"]),
                }
            else:
                prior = self._prior_sum(con, row["run_id"], row["id"])
                totals = calculate_totals(
                    [{"description": x["description"], "quantity": x["quantity"], "unit": x["unit"],
                      "unitPrice": x["unit_price"], "discountPercent": x["discount_percent"]} for x in lines],
                    tax_mode=row["tax_mode"], retention_percent=row["retention_percent"], discount_percent=row["discount_percent"],
                    cash_discount_percent=row["cash_discount_percent"], prior=prior, payments=paid,
                )
            if (
                row["tax_mode"] == "AT20"
                and str(run["customer_company"] or "").strip()
                and abs(totals["incrementGross"]) > Decimal("10000")
                and not row["recipient_uid"]
            ):
                raise ValueError("Bei einer B2B-Rechnung über 10.000 EUR ist die Kunden-UID Pflicht.")
            existing_number = str(row["invoice_number"] or "")
            expected_prefix = date.fromisoformat(row["issue_date"]).strftime("%Y%m")
            invoice_number = existing_number if existing_number.startswith(expected_prefix) else self._next_number(
                con, row["issue_date"], external_numbers
            )
            now = _now()
            con.execute("""
                UPDATE outgoing_invoices SET status='issued',invoice_number=?,vat_rate=?,line_subtotal_net=?,retention_net=?,net_after_retention=?,
                  discount_net=?,cumulative_net=?,cumulative_vat=?,cumulative_gross=?,cash_discount_gross=?,cumulative_gross_discounted=?,
                  prior_net=?,prior_vat=?,prior_gross=?,increment_net=?,increment_vat=?,increment_gross=?,paid_net_snapshot=?,paid_vat_snapshot=?,
                  paid_gross_snapshot=?,open_with_discount=?,open_after_discount=?,previous_snapshot_json=?,payments_snapshot_json=?,issued_at=?,updated_at=?
                WHERE id=?
            """, (
                invoice_number, str(totals["vatRate"]), str(totals["lineSubtotalNet"]), str(totals["retentionNet"]),
                str(totals["netAfterRetention"]), str(totals["discountNet"]), str(totals["cumulativeNet"]), str(totals["cumulativeVat"]),
                str(totals["cumulativeGross"]), str(totals["cashDiscountGross"]), str(totals["cumulativeGrossDiscounted"]),
                str(totals["priorNet"]), str(totals["priorVat"]), str(totals["priorGross"]), str(totals["incrementNet"]),
                str(totals["incrementVat"]), str(totals["incrementGross"]), str(totals["paidNet"]), str(totals["paidVat"]),
                str(totals["paidGross"]), str(totals["openWithDiscount"]), str(totals["openAfterDiscount"]),
                _json([self._invoice_snapshot(x) for x in previous]), _json([self._payment_public(x) for x in payments]), now, now, int(invoice_id),
            ))
            if row["kind"] in {"TR", "SR", "RE"}:
                con.execute(
                    "UPDATE outgoing_runs SET pricing_locked_at=COALESCE(pricing_locked_at,?) WHERE id=?",
                    (now, row["run_id"]),
                )
            if row["kind"] in {"SR", "RE"}:
                con.execute("UPDATE outgoing_runs SET status='closed',closed_at=? WHERE id=?", (now, row["run_id"]))
            self._audit(con, "invoice", int(invoice_id), "issue", {"invoiceNumber": invoice_number})
            con.commit()
        return self.invoice(invoice_id)

    def attach_pdf(self, invoice_id, pdf_path):
        path = Path(pdf_path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with _LOCK, self.connect() as con:
            row = con.execute("SELECT status,pdf_path,pdf_sha256 FROM outgoing_invoices WHERE id=?", (int(invoice_id),)).fetchone()
            if not row or row["status"] != "issued":
                raise ValueError("PDF kann nur einer ausgestellten Rechnung zugeordnet werden.")
            if row["pdf_sha256"] and row["pdf_sha256"] != digest:
                raise ValueError("Das Original-PDF einer ausgestellten Rechnung darf nicht überschrieben werden.")
            con.execute("UPDATE outgoing_invoices SET pdf_path=?,pdf_sha256=?,updated_at=? WHERE id=?", (str(path), digest, _now(), int(invoice_id)))
            self._audit(con, "invoice", int(invoice_id), "attach_pdf", {"sha256": digest})
            con.commit()
        return self.invoice(invoice_id)
