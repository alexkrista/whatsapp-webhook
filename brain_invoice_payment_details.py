# coding: utf-8
"""Signed supplier credits and read-only payment evidence / Alex clearing views."""
from __future__ import annotations
import json
from decimal import Decimal, ROUND_HALF_UP

def signed_amount(value, document_type):
    amount=float(value or 0)
    return -abs(amount) if str(document_type or "").strip().casefold().startswith("gutschrift") else amount

def payment_events(ns, source, source_id):
    rows=[]
    factory=ns.get("_capture_connection")
    if callable(factory):
        c=factory(ns["CAPTURE_DB"])
        try:
            tables={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {"brain_statement_allocations","brain_statement_movements"}<=tables:
                for r in c.execute("""
                    SELECT a.id,a.amount,m.booking_date,m.value_date,m.source,m.currency,m.reference,m.status
                    FROM brain_statement_allocations a JOIN brain_statement_movements m ON m.id=a.movement_id
                    WHERE a.target_source=? AND a.target_id=?
                      AND a.category IN ('supplier_payment','direct_debit') AND m.status IN ('reconciled','partial')
                    ORDER BY m.booking_date,a.id""",(source,source_id)):
                    rows.append(dict(kind="payment",old_status="open",new_status="paid",changed_at=r["booking_date"],
                        reason="Bankzahlung / Einzug: "+str(r["amount"])+" "+str(r["currency"] or "EUR"),
                        changed_by=str(r["source"]),payment_date=r["booking_date"],value_date=r["value_date"] or "",
                        reference=r["reference"] or "",evidence_id="statement:"+str(r["id"])))
        finally:c.close()
    service=ns.get("bank_assignments")
    if service:
        with service.db() as c:
            for r in c.execute("""SELECT l.id,l.paid,a.payload,a.created FROM bank_assignment_lines l
                JOIN bank_assignments a ON a.rid=l.rid WHERE l.source=? AND l.target=?
                ORDER BY a.created,l.id""",(source,source_id)):
                tx=json.loads(r["payload"])
                day=str(tx.get("bookingDate") or tx.get("booking_date") or "")[:10]
                if not day:continue
                rows.append(dict(kind="payment",old_status="open",new_status="paid",changed_at=day,payment_date=day,
                    value_date=str(tx.get("valueDate") or "")[:10],
                    reason="Bankzahlung / Einzug: "+format(Decimal(r["paid"])/100,".2f")+" "+str(tx.get("currency") or "EUR"),
                    changed_by="Bankabgleich",reference=str(tx.get("reference") or tx.get("endToEndId") or ""),
                    evidence_id="bank:"+str(r["id"])))
    return rows

def private_invoice_entries(ns):
    factory=ns.get("_capture_connection")
    if not callable(factory):return []
    c=factory(ns["CAPTURE_DB"])
    try:
        result=[]
        for r in c.execute("""SELECT i.*,pm.payment_method AS meta_method,pm.payment_status AS meta_status
             FROM incoming_invoices i LEFT JOIN brain_payment_meta pm
             ON pm.source='KRISTINE' AND pm.source_id='kristine:'||i.id
             WHERE COALESCE(pm.payment_method,i.payment_method)='alex_private'"""):
            cents=int((Decimal(str(signed_amount(r["gross_amount"],r["document_type"])))*100).quantize(Decimal("1"),rounding=ROUND_HALF_UP))
            result.append(dict(id="private-invoice-"+str(r["id"]),account="alex",kind="private_expense",
                balanceType="private",date=str(r["invoice_date"] or "")[:10],amount=format(Decimal(cents)/100,".2f"),
                currency=str(r["currency"] or "EUR"),counterparty=r["supplier_name"] or "",
                purpose="Firma privat bezahlt; Belegdatum (Zahlungsdatum nicht erfasst)",
                reference=str(r["supplier_invoice_number"] or r["doc_id"] or ""),external_ref="incoming:kristine:"+str(r["id"]),
                createdAt=r["updated_at"] or "",locked=True,origin="KRISTINE privat",reversed_by=None,source="KRISTINE",invoiceId=int(r["id"])))
        return result
    finally:c.close()
