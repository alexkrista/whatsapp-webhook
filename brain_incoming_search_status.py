# coding: utf-8
"""Canonical payment status for the supplier invoice search."""
from __future__ import annotations

from brain_finance_source import norm_status
from brain_finance_source_v2 import FinanceStore
from brain_invoice_book import _effective_ww_status


STATUS_LABELS = {
    "open": "Offen",
    "sepa_submitted": "An SEPA übergeben",
    "paid": "Bezahlt",
}


def reconcile_incoming_payment_status(rows, ns, store=None):
    """Apply Brain overrides and booked bank assignments to search results."""
    rows = list(rows or [])
    if not rows:
        return rows
    store = store or FinanceStore(ns)
    meta = store.meta()
    overrides = store.status_overrides()
    legacy = store.legacy()
    keyed = {}
    overlay_rows = []

    for item in rows:
        invoice_id = str(item.get("invoiceId") or "")
        if invoice_id.startswith("ww:"):
            source = "WinWorker"
            source_id = invoice_id
            key = (source, source_id)
            source_status = norm_status(item.get("paymentState") or item.get("paymentStatus"))
            ex = meta.get(key, {})
            status = _effective_ww_status(
                source_status,
                norm_status(ex.get("paymentStatus")) if key in meta else "open",
                overrides.get(key, ""),
                legacy.get(source_id, {}).get("status") == "paid",
            )
        elif invoice_id.startswith("kristine:"):
            source = "KRISTINE"
            source_id = invoice_id
            key = (source, source_id)
            source_status = norm_status(item.get("paymentState") or item.get("paymentStatus"))
            ex = meta.get(key, {})
            status = "paid" if source_status == "paid" else norm_status(ex.get("paymentStatus"))
        else:
            continue

        item["sourcePaymentStatus"] = source_status
        item["canonicalPaymentStatus"] = status
        item["statusOverride"] = bool(key in overrides and status != source_status)
        keyed[key] = item
        overlay_rows.append({
            "source": source,
            "id": source_id,
            "amount": float(item.get("amount") or 0),
            "paymentStatus": status,
            "paymentState": status,
        })

    overlay = ns.get("bank_supplier_overlay")
    if callable(overlay) and overlay_rows:
        resolved = overlay(overlay_rows, True)
    else:
        resolved = overlay_rows

    for result in resolved:
        key = (str(result.get("source") or ""), str(result.get("id") or ""))
        item = keyed.get(key)
        if not item:
            continue
        status = norm_status(result.get("paymentStatus"))
        item["canonicalPaymentStatus"] = status
        item["paymentState"] = status
        item["paymentStatus"] = STATUS_LABELS[status]
        item["paymentStatusSource"] = "KRISTINE + Bankabgleich"
        if "bankPaid" in result:
            item["bankPaid"] = result.get("bankPaid")
            item["openAmount"] = float(result.get("amount") or 0)
    return rows

