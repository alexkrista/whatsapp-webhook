"""Shared invoice-book filters and currency-separated monthly totals."""
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from brain_finance_source import norm_method


def payment_channel(value):
    method = norm_method(value)
    return "bank" if method in {"transfer", "direct_debit"} else method


def filter_rows(rows, args):
    month = str(args.get("month") or "")
    start = str(args.get("from") or "")
    end = str(args.get("to") or "")
    if month:
        date.fromisoformat(month + "-01")
    for day in (start, end):
        if day:
            date.fromisoformat(day)
    if start and end and start > end:
        raise ValueError("Datum von muss vor Datum bis liegen.")
    channel = str(args.get("paymentChannel") or "all")
    if channel not in {"all", "bank", "revolut", "revolut_business", "cash", "unknown"}:
        raise ValueError("Ungültige Zahlungsart.")
    return [x for x in rows if
            (not month or str(x.get("invoiceDate") or "").startswith(month)) and
            (not start or str(x.get("invoiceDate") or "")[:10] >= start) and
            (not end or (str(x.get("invoiceDate") or "") and str(x["invoiceDate"])[:10] <= end)) and
            (channel == "all" or payment_channel(x.get("paymentMethod")) == channel)]


def monthly_totals(rows):
    buckets = {}
    for row in rows:
        if row.get("status") == "draft":
            continue
        key = (str(row.get("invoiceDate") or "")[:7] or "Ohne Datum", row.get("currency") or "EUR")
        bucket = buckets.setdefault(key, {"month":key[0], "currency":key[1], "count":0,
                                         **{k:Decimal(0) for k in ("net", "vat", "gross", "paid", "open")}})
        bucket["count"] += 1
        for k in ("net", "vat", "gross", "paid", "open"):
            bucket[k] += Decimal(str(row.get(k) or 0))
    return [{k:float(v.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)) if isinstance(v, Decimal) else v
             for k,v in b.items()} for _, b in sorted(buckets.items(), reverse=True)]
