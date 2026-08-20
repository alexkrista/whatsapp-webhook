# coding: utf-8
"""KRISTINE · Little-Greene-Rechnungssync.

Liest die lokale Eingangsrechnungserfassung von Dunja und übergibt jede
GEPRÜFTE Little-Greene-Rechnung genau einmal an das Farben-/Lagermodul.
Dort werden erkannte Lagerpositionen addiert, EK aktualisiert und der
Nettobetrag dem LG-Geschäftsjahr 01.11.–31.10. zugerechnet.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_DB = Path(os.environ.get(
    "KRISTINE_INCOMING_DB",
    r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_incoming_capture.db",
))
DEFAULT_BASE = os.environ.get("KRISTINE_API_BASE", "https://protokoll.krista.at").rstrip("/")


def _is_little_greene(row: sqlite3.Row) -> bool:
    text = " ".join(str(row[k] or "") for k in (
        "supplier_name", "supplier_number", "our_customer_number", "customer_number_external"
    )).lower()
    return "little greene" in text or "far207" in text


def _post(base: str, token: str, payload: dict) -> dict:
    url = f"{base}/admin/api/paint/lg-incoming-sync?token={urllib.parse.quote(token)}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw or "{}")
        except Exception:
            detail = {"error": raw or str(exc)}
        raise RuntimeError(f"HTTP {exc.code}: {detail.get('error') or raw}") from exc


def run_once(db_path: Path, base: str, token: str) -> tuple[int, int]:
    if not db_path.exists():
        raise FileNotFoundError(f"Eingangsrechnungs-DB fehlt: {db_path}")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute("""
            SELECT id, supplier_name, supplier_number, our_customer_number,
                   customer_number_external, supplier_invoice_number,
                   invoice_date, net_amount, pdf_text, workflow_status
            FROM incoming_invoices
            WHERE workflow_status='geprueft'
            ORDER BY id
        """).fetchall()
    finally:
        con.close()

    checked = synced = 0
    for row in rows:
        if not _is_little_greene(row):
            continue
        checked += 1
        payload = {
            "invoiceRef": str(row["supplier_invoice_number"] or f"KRISTINE-{row['id']}").strip(),
            "invoiceDate": str(row["invoice_date"] or "")[:10],
            "netAmount": float(row["net_amount"] or 0),
            "text": str(row["pdf_text"] or ""),
            "sourceInvoiceId": int(row["id"]),
        }
        try:
            result = _post(base, token, payload)
            if result.get("ok"):
                synced += 1
                state = "bereits synchron" if result.get("duplicate") else f"{result.get('paintLines', 0)} Lagerpositionen"
                print(f"LG {payload['invoiceRef']}: {state} · netto {payload['netAmount']:.2f} EUR")
        except Exception as exc:
            print(f"LG {payload['invoiceRef']}: NOCH OFFEN · {exc}")
    return checked, synced


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=int, default=10)
    args = parser.parse_args()

    token = os.environ.get("KRISTINE_ADMIN_TOKEN", "").strip()
    if not token:
        raise SystemExit("KRISTINE_ADMIN_TOKEN fehlt in der Umgebung.")

    db_path = Path(args.db)
    while True:
        try:
            run_once(db_path, args.base.rstrip("/"), token)
        except Exception as exc:
            print("LG-Sync Fehler:", exc)
        if args.once:
            break
        time.sleep(max(5, int(args.interval)))


if __name__ == "__main__":
    main()
