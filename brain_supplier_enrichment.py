# coding: utf-8
"""The Brain · persistente Lieferantenzuordnung historischer Eingangsrechnungen.

WinWorker ist die fachliche Wahrheit:
Eingangsbelege.gDMID -> DokumentenManagement.sDocID -> lVonAdrIndex -> Kunden.StammIndex.
Die aufgelöste Zuordnung wird lokal gespeichert und für Materialsuche/Materialhistorie
vor OCR-Lieferantenerkennung verwendet.
"""
from __future__ import annotations

import json
import re
import threading
from datetime import datetime
from pathlib import Path

_LOCK = threading.Lock()
_CACHE = None


def _map_file(ns):
    db = Path(ns.get("DB"))
    return db.parent / "brain_supplier_document_map.json"


def _empty():
    return {"version": 1, "generatedAt": "", "count": 0, "documents": {}}


def _load(ns):
    global _CACHE
    with _LOCK:
        if _CACHE is not None:
            return _CACHE
        path = _map_file(ns)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("documents"), dict):
                data = _empty()
        except Exception:
            data = _empty()
        _CACHE = data
        return _CACHE


def _save(ns, data):
    global _CACHE
    path = _map_file(ns)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    with _LOCK:
        _CACHE = data


def _doc_id(value):
    raw = Path(str(value or "").strip()).name
    raw = re.sub(r"_Original\.pdf$", "", raw, flags=re.I)
    raw = re.sub(r"\.pdf$", "", raw, flags=re.I)
    return raw.strip()


def rebuild(ns):
    """Liest alle eindeutig verknüpften historischen Eingangsbelege einmal aus WW."""
    sql_connection = ns.get("sql_connection")
    if not sql_connection:
        raise RuntimeError("WinWorker-SQL-Verbindung nicht verfügbar.")

    con = sql_connection("WinWorker_Projekte_Standard")
    try:
        cur = con.cursor()
        rows = cur.execute(r"""
            SELECT
                dm.sDocID,
                e.cID AS IncomingId,
                e.lVonAdrIndex AS AddressId,
                e.sBelegnummer AS InvoiceNumber,
                e.dzBelegdatum AS InvoiceDate,
                k.sFirma,
                k.sName,
                k.sVorname,
                k.sStrasse,
                k.sPLZ,
                k.sOrt,
                k.lLieferantenNr,
                k.lKundenNr,
                k.sL_KdnNr
            FROM dbo.Eingangsbelege AS e
            INNER JOIN dbo.DokumentenManagement AS dm
                ON dm.gID = e.gDMID
            LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden AS k
                ON k.StammIndex = e.lVonAdrIndex
            WHERE dm.sDocID IS NOT NULL
              AND LTRIM(RTRIM(dm.sDocID)) <> ''
              AND e.lVonAdrIndex IS NOT NULL
        """).fetchall()
    finally:
        con.close()

    documents = {}
    conflicts = 0
    for row in rows:
        doc_id = _doc_id(getattr(row, "sDocID", ""))
        if not doc_id:
            continue
        address_id = str(getattr(row, "AddressId", "") or "").strip()
        if not address_id:
            continue
        company = str(getattr(row, "sFirma", "") or "").strip()
        person = " ".join(x for x in [
            str(getattr(row, "sVorname", "") or "").strip(),
            str(getattr(row, "sName", "") or "").strip(),
        ] if x).strip()
        name = company or person or f"Adresse {address_id}"
        street = str(getattr(row, "sStrasse", "") or "").strip()
        postal = str(getattr(row, "sPLZ", "") or "").strip()
        city = str(getattr(row, "sOrt", "") or "").strip()
        address = ", ".join(x for x in [street, " ".join(x for x in [postal, city] if x)] if x)
        invoice_date = getattr(row, "InvoiceDate", None)
        try:
            invoice_date = invoice_date.date().isoformat()
        except Exception:
            invoice_date = str(invoice_date or "")[:10]
        entry = {
            "docId": doc_id,
            "addressId": address_id,
            "supplierName": name,
            "supplierAddress": address,
            "supplierNumber": str(getattr(row, "lLieferantenNr", "") or "").strip(),
            "customerNumber": str(getattr(row, "lKundenNr", "") or "").strip(),
            "ourCustomerNumber": str(getattr(row, "sL_KdnNr", "") or "").strip(),
            "invoiceNumber": str(getattr(row, "InvoiceNumber", "") or "").strip(),
            "invoiceDate": invoice_date,
            "wwIncomingId": int(getattr(row, "IncomingId", 0) or 0),
            "source": "WinWorker Dokument-ID",
            "confidence": 100,
        }
        old = documents.get(doc_id)
        if old and str(old.get("addressId")) != address_id:
            conflicts += 1
            # Bei Konflikt keine vermeintlich sichere Zuordnung behalten.
            documents.pop(doc_id, None)
            continue
        documents[doc_id] = entry

    data = {
        "version": 1,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "count": len(documents),
        "conflictsSkipped": conflicts,
        "documents": documents,
    }
    _save(ns, data)
    return data


def lookup(ns, value):
    doc_id = _doc_id(value)
    if not doc_id:
        return None
    data = _load(ns)
    return dict((data.get("documents") or {}).get(doc_id) or {}) or None


def _ensure(ns):
    data = _load(ns)
    if data.get("documents"):
        return data
    try:
        return rebuild(ns)
    except Exception as exc:
        print("⚠ Brain Lieferanten-Enrichment noch nicht aufgebaut:", exc)
        return data


def _enrich_material_result(ns, item):
    if not isinstance(item, dict):
        return item
    key = item.get("filename") or item.get("path") or item.get("logical_id") or ""
    linked = lookup(ns, key)
    if not linked:
        return item
    item["supplierName"] = linked.get("supplierName") or item.get("supplierName")
    item["supplierAddress"] = linked.get("supplierAddress") or item.get("supplierAddress")
    item["supplierNumber"] = linked.get("supplierNumber") or item.get("supplierNumber")
    item["supplierAddressId"] = linked.get("addressId") or ""
    item["supplierSource"] = "WinWorker Dokument-ID"
    item["supplierConfidence"] = 100
    return item


def install(ns):
    app = ns.get("app")
    if app is None:
        return

    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.update({"/supplier-enrichment/status", "/supplier-enrichment/rebuild"})

    # Einmalig/lazy laden. Der eigentliche SQL-Lauf passiert erst, wenn noch keine Map existiert.
    _ensure(ns)

    original_search = ns.get("global_material_search")
    if callable(original_search) and not getattr(original_search, "_supplier_enriched", False):
        def enriched_global_material_search(query, limit=80):
            result = original_search(query, limit)
            for item in result.get("results") or []:
                _enrich_material_result(ns, item)
            result["supplierMapCount"] = int((_load(ns).get("count") or 0))
            return result
        enriched_global_material_search._supplier_enriched = True
        ns["global_material_search"] = enriched_global_material_search
        # Flask-Route material_search_api löst global_material_search zur Laufzeit aus dem Modulglobal auf.

    if "brain_supplier_enrichment_status" not in app.view_functions:
        from flask import jsonify

        @app.get("/supplier-enrichment/status")
        def brain_supplier_enrichment_status():
            data = _load(ns)
            return jsonify({
                "ok": True,
                "count": int(data.get("count") or 0),
                "generatedAt": data.get("generatedAt") or "",
                "conflictsSkipped": int(data.get("conflictsSkipped") or 0),
                "file": str(_map_file(ns)),
            })

        @app.post("/supplier-enrichment/rebuild")
        def brain_supplier_enrichment_rebuild():
            try:
                data = rebuild(ns)
                return jsonify({
                    "ok": True,
                    "count": int(data.get("count") or 0),
                    "generatedAt": data.get("generatedAt") or "",
                    "conflictsSkipped": int(data.get("conflictsSkipped") or 0),
                })
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

    print(f"✅ Brain Lieferanten-Enrichment aktiv: {int((_load(ns).get('count') or 0))} feste Dokument-Zuordnungen")
