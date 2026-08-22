# coding: utf-8
"""KRISTINE Finance source V2: OP-Zeilen mit Skonto-Metadaten.

Die bestehende FinanceStore-Logik bleibt unangetastet. Fuer KRISTINE-Rechnungen
werden zusaetzlich Skonto-Prozent und Skonto-Faelligkeit an die OP-Ansicht geliefert.
"""
from __future__ import annotations

from brain_finance_source import (
    METHODS,
    STATUSES,
    FinanceStore as _BaseFinanceStore,
    norm_method,
    norm_status,
    payment_id,
)


class FinanceStore(_BaseFinanceStore):
    def ww(self, include_resolved=False):
        rows = super().ww(include_resolved)
        for row in rows:
            row.setdefault("skontoEnabled", False)
            row.setdefault("skontoPercent", None)
            row.setdefault("skontoDueDate", "")
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
            out.append(dict(
                id=sid,
                docId=str(r["doc_id"] or ""),
                supplier=str(r["supplier_name"] or ""),
                invoiceNumber=str(r["supplier_invoice_number"] or ""),
                invoiceDate=str(r["invoice_date"] or ""),
                dueDate=str(r["due_date_effective"] or ""),
                amount=float(r["gross_amount"] or 0),
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
                skontoPercent=(float(r["skonto_percent"]) if r["skonto_percent"] is not None else None),
                skontoDueDate=str(r["skonto_due_date"] or ""),
            ))
        return out
