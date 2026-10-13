# coding: utf-8
"""Synchronize open Little-Greene invoice choices from THE BRAIN to KRISTINE.

Read-only on the Brain invoice database. Never posts a warehouse receipt or
changes payment/approval. The HTTPS endpoint only mirrors invoice metadata.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
INCOMING_DB = Path(os.environ.get(
    "KRISTINE_INCOMING_DB",
    r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_incoming_capture.db",
))
SECRET_FILE = Path(os.environ.get(
    "KRISTINE_LG_CANDIDATES_SECRET_FILE",
    str(Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) /
        "Kristine" / "Secrets" / "lg-invoice-candidates.dpapi"),
))
TARGET = os.environ.get("KRISTINE_API_BASE", "https://protokoll.krista.at").rstrip(
    "/"
) + "/admin/api/paint/lg-invoice-candidates/sync"
SKU = re.compile(r"0\d{5}[A-Z0-9]{4,9}", re.I)
DECIMAL = re.compile(r"\d+(?:\.\d{1,3})?")
VALID_REF = re.compile(r"[A-Z0-9][A-Z0-9._/-]{2,99}")


def money(value: float) -> float:
    return round(float(value), 2)


def pdf_lines(pdf_text: str) -> list[dict]:
    """Parse official LG PDF extraction: qty/price/net preceding each unique SKU.

    If layout changes or a row isn't recognized, the exact amount sum check in
    the cloud marks the invoice unbookable instead of silently omitting goods.
    """
    values = [line.strip() for line in str(pdf_text or "").splitlines() if line.strip()]
    out = []
    for index, sku in enumerate(values):
        if index < 3 or not SKU.fullmatch(sku):
            continue
        triplet = values[index - 3:index]
        if not all(DECIMAL.fullmatch(v) for v in triplet):
            continue
        qty, unit_price, net = map(float, triplet)
        if not 0 < qty <= 10000 or unit_price < 0 or abs(qty * unit_price - net) > 0.02:
            continue
        out.append({
            "sku": sku.upper(),
            "quantity": round(qty, 3),
            "unitPrice": money(unit_price),
            "net": money(net),
        })
    return out


def load_invoices(now=None) -> list[dict]:
    if now is None:
        try:
            now = datetime.now(ZoneInfo("Europe/Vienna"))
        except ZoneInfoNotFoundError:
            # Windows may lack the separate IANA tzdata package. PC-ALEX02 runs in Austria.
            now = datetime.now().astimezone()
    cutoff = (now.date() - timedelta(days=21)).isoformat()
    if not INCOMING_DB.is_file():
        raise RuntimeError("Brain-Eingangsrechnungsdatenbank nicht verfügbar.")
    db = sqlite3.connect("file:" + str(INCOMING_DB) + "?mode=ro", uri=True, timeout=15)
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute("""
            SELECT id, supplier_name, supplier_number,
                   supplier_invoice_number, invoice_date, net_amount,
                   pdf_text, payment_status, workflow_status, document_type
            FROM incoming_invoices
            WHERE invoice_date >= ? AND net_amount > 0
              AND lower(workflow_status) != 'storniert'
            ORDER BY invoice_date DESC, id DESC
        """, (cutoff,)).fetchall()
    finally:
        db.close()
    output = []
    seen = set()
    for row in rows:
        supplier = str(row["supplier_name"] or "").lower()
        supplier_id = str(row["supplier_number"] or "").lower()
        if "little greene" not in supplier and "far207" not in supplier_id:
            continue
        doctype = str(row["document_type"] or "").lower()
        if doctype and ("gutschrift" in doctype or "credit" in doctype):
            continue
        invoice_ref = str(row["supplier_invoice_number"] or "").strip().upper()
        if not VALID_REF.fullmatch(invoice_ref) or invoice_ref in seen:
            continue
        seen.add(invoice_ref)
        output.append({
            "invoiceRef": invoice_ref,
            "invoiceDate": str(row["invoice_date"] or "")[:10],
            "netAmount": money(row["net_amount"]),
            "sourceInvoiceId": int(row["id"]),
            "paymentStatus": str(row["payment_status"] or "")[:50],
            "lines": pdf_lines(row["pdf_text"]),
        })
    if len(output) > 400:
        raise RuntimeError("Zu viele LG-Rechnungen; Synchronisierung nicht durchgeführt.")
    return output


def load_token() -> str:
    if not SECRET_FILE.is_file():
        raise RuntimeError("LG-Rechnungsauswahl ist noch nicht sicher verbunden.")
    from brain_konfipay import protect
    return protect(SECRET_FILE.read_bytes(), decrypt=True).decode("utf-8").strip()


def sync() -> dict:
    token = load_token()
    if not token:
        raise RuntimeError("LG-Synchronisierungsschlüssel fehlt.")
    payload = {"invoices": load_invoices()}
    request = urllib.request.Request(
        TARGET, method="POST",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Krista-Lg-Candidates-Token": token,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            "LG-Rechnungssync HTTP " + str(error.code) + ": " +
            error.read(300).decode("utf-8", errors="replace")
        ) from error
    if data.get("ok") is not True or data.get("count") != len(payload["invoices"]):
        raise RuntimeError("Cloud hat die LG-Rechnungsliste nicht bestätigt.")
    return {"count": len(payload["invoices"]), "syncedAt": data.get("syncedAt"),
            "openRefs": [row["invoiceRef"] for row in payload["invoices"]],
            "orderMatches": data.get("orderMatches", [])}


if __name__ == "__main__":
    try:
        print(json.dumps(sync(), ensure_ascii=False))
    except Exception as error:
        print("LG Rechnungs-Auswahl Sync: " + str(error), file=sys.stderr)
        raise SystemExit(1)
