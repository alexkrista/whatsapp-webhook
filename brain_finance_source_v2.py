# coding: utf-8
"""KRISTINE Finance source V2: OP-Zeilen mit Skonto-Metadaten.

KRISTINE-Rechnungen liefern Skonto direkt aus der lokalen Erfassung. Bei
WinWorker werden vorhandene Skonto-Spalten dynamisch erkannt, damit wir nicht an
eine bestimmte WW-Version gebunden sind. Es werden nur die aktuell benoetigten
OP-IDs nachgeladen.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from brain_finance_source import (
    METHODS,
    STATUSES,
    FinanceStore as _BaseFinanceStore,
    norm_method,
    norm_status,
    payment_id,
)


def _norm(value):
    return (str(value or "").strip().lower()
            .replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss"))


def _ident(name):
    return "[" + str(name or "").replace("]", "]]" ) + "]"


def _float(value):
    try:
        return float(value)
    except Exception:
        try:
            return float(str(value or "").replace("%", "").replace(" ", "").replace(",", "."))
        except Exception:
            return None


def _iso(value):
    if value is None:
        return ""
    if hasattr(value, "strftime"):
        try:
            return value.strftime("%Y-%m-%d")
        except Exception:
            pass
    raw = str(value or "").strip()
    if len(raw) >= 10 and raw[4:5] == "-" and raw[7:8] == "-":
        return raw[:10]
    for fmt in ("%d.%m.%Y", "%d/%m/%Y", "%Y%m%d"):
        try:
            return datetime.strptime(raw[:10], fmt).strftime("%Y-%m-%d")
        except Exception:
            pass
    return ""


def _pick_skonto_columns(cursor):
    try:
        rows = cursor.execute("""
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='Eingangsbelege'
        """).fetchall()
    except Exception:
        return {}
    names = [str(getattr(r, "COLUMN_NAME", r[0]) or "") for r in rows]

    def best(kind):
        scored = []
        for name in names:
            n = _norm(name)
            if "skonto" not in n:
                continue
            score = 0
            if kind == "percent":
                if any(x in n for x in ("prozent", "proz", "percent", "pct")): score = 120
                elif "satz" in n: score = 100
            elif kind == "days":
                if any(x in n for x in ("tage", "tag", "days")): score = 120
                if any(x in n for x in ("datum", "date", "betrag", "prozent", "proz")): score = 0
            elif kind == "due":
                if any(x in n for x in ("faellig", "fallig", "datum", "date", "bis")): score = 120
            elif kind == "amount":
                if any(x in n for x in ("betrag", "amount")): score = 120
            if score:
                if n.startswith(("d", "dz")) and kind == "due": score += 5
                scored.append((score, name))
        return sorted(scored, reverse=True)[0][1] if scored else ""

    return {
        "percent": best("percent"),
        "days": best("days"),
        "due": best("due"),
        "amount": best("amount"),
    }


class FinanceStore(_BaseFinanceStore):
    def ww(self, include_resolved=False):
        rows = super().ww(include_resolved)
        for row in rows:
            row.setdefault("skontoEnabled", False)
            row.setdefault("skontoPercent", None)
            row.setdefault("skontoDueDate", "")
            row.setdefault("skontoAmount", None)

        ids = []
        for row in rows:
            sid = str(row.get("id") or "")
            if sid.startswith("ww:"):
                try:
                    ids.append(int(sid.split(":", 1)[1]))
                except Exception:
                    pass
        if not ids:
            return rows

        sql = self.ns.get("sql_connection")
        if not callable(sql):
            return rows

        con = sql("WinWorker_Projekte_Standard")
        try:
            cur = con.cursor()
            cols = _pick_skonto_columns(cur)
            selected = ["e.cID"]
            aliases = {}
            for key in ("percent", "days", "due", "amount"):
                name = cols.get(key) or ""
                if name:
                    alias = "sk_" + key
                    selected.append(f"e.{_ident(name)} AS {alias}")
                    aliases[key] = alias
            if not aliases:
                return rows
            placeholders = ",".join("?" for _ in ids)
            data = cur.execute(
                f"SELECT {','.join(selected)} FROM dbo.Eingangsbelege e WHERE e.cID IN ({placeholders})",
                *ids,
            ).fetchall()
        finally:
            con.close()

        by_id = {}
        for r in data:
            by_id[int(r.cID)] = r

        for row in rows:
            sid = str(row.get("id") or "")
            if not sid.startswith("ww:"):
                continue
            try:
                rid = int(sid.split(":", 1)[1])
            except Exception:
                continue
            raw = by_id.get(rid)
            if raw is None:
                continue

            percent = _float(getattr(raw, aliases.get("percent", ""), None)) if "percent" in aliases else None
            if percent is not None and 0 < percent <= 1:
                percent *= 100.0
            if percent is not None and not (0 < percent < 100):
                percent = None

            days = _float(getattr(raw, aliases.get("days", ""), None)) if "days" in aliases else None
            due = _iso(getattr(raw, aliases.get("due", ""), None)) if "due" in aliases else ""
            amount = _float(getattr(raw, aliases.get("amount", ""), None)) if "amount" in aliases else None

            if not due and days is not None and 0 < days < 3650:
                try:
                    inv = datetime.strptime(str(row.get("invoiceDate") or "")[:10], "%Y-%m-%d")
                    due = (inv + timedelta(days=int(round(days)))).strftime("%Y-%m-%d")
                except Exception:
                    pass
            if amount is None and percent is not None:
                amount = round(float(row.get("amount") or 0) * percent / 100.0, 2)

            enabled = bool((percent is not None and percent > 0) or due or (amount is not None and amount > 0))
            row.update(
                skontoEnabled=enabled,
                skontoPercent=(round(percent, 4) if percent is not None else None),
                skontoDueDate=due,
                skontoAmount=(round(amount, 2) if amount is not None else None),
            )
        return rows

    def kristine(self, include_resolved=False):
        f = self.ns.get("_capture_connection")
        db = self.ns.get("CAPTURE_DB")
        if not callable(f):
            return []
        meta = self.meta()
        c = f(db)
        try:
            where = "" if include_resolved else "WHERE LOWER(COALESCE(payment_state,'open')) NOT IN ('paid','bezahlt','closed','geschlossen')"
            rows = c.execute(f"""
                SELECT
                    id, doc_id, supplier_name, supplier_invoice_number, invoice_date,
                    COALESCE(NULLIF(net_due_date,''),NULLIF(due_date,''),invoice_date) AS due_date_effective,
                    gross_amount, currency, payment_state, workflow_status, pdf_path,
                    COALESCE(skonto_enabled,0) AS skonto_enabled,
                    skonto_percent,
                    COALESCE(skonto_due_date,'') AS skonto_due_date
                FROM incoming_invoices
                {where}
                ORDER BY due_date_effective, supplier_name COLLATE NOCASE, gross_amount
            """).fetchall()
        finally:
            c.close()

        out = []
        for r in rows:
            sid = f"kristine:{int(r['id'])}"
            ex = meta.get(("KRISTINE", sid), {})
            m = norm_method(ex.get("paymentMethod"))
            src = norm_status(r["payment_state"])
            st = "paid" if src == "paid" else norm_status(ex.get("paymentStatus"))
            if st == "paid" and not include_resolved:
                continue
            percent = float(r["skonto_percent"]) if r["skonto_percent"] is not None else None
            gross = float(r["gross_amount"] or 0)
            out.append(dict(
                id=sid,
                docId=str(r["doc_id"] or ""),
                supplier=str(r["supplier_name"] or ""),
                invoiceNumber=str(r["supplier_invoice_number"] or ""),
                invoiceDate=str(r["invoice_date"] or ""),
                dueDate=str(r["due_date_effective"] or ""),
                amount=gross,
                currency=str(r["currency"] or "EUR"),
                paymentState=st,
                paymentStatus=st,
                paymentMethod=m,
                paymentId=str(ex.get("paymentId") or (payment_id("KRISTINE", sid) if m == "transfer" else "")),
                workflowStatus=str(r["workflow_status"] or ""),
                path=str(r["pdf_path"] or ""),
                source="KRISTINE",
                brainOverride="",
                skontoEnabled=bool(r["skonto_enabled"] or 0),
                skontoPercent=percent,
                skontoDueDate=str(r["skonto_due_date"] or ""),
                skontoAmount=(round(gross * percent / 100.0, 2) if percent is not None and percent > 0 else None),
            ))
        return out
