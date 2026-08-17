from flask import Flask, request, jsonify, send_file, render_template_string
import sqlite3
from pathlib import Path
from io import BytesIO
from datetime import datetime
import os
import re
import json
import hmac
import hashlib
import urllib.request
import urllib.error
import urllib.parse

import pymupdf
import pyodbc
from waitress import serve

app = Flask(__name__)

# ---------------------------------------------------------------------------
# HANDY-ZUGANG / SICHERHEIT
# ---------------------------------------------------------------------------
# Der Dienst lauscht nur auf localhost UND auf der Tailscale-IP dieses PCs.
# Er wird NICHT auf 0.0.0.0 geöffnet.
TAILSCALE_IP = os.environ.get("KRISTINE_TAILSCALE_IP", "100.98.155.39").strip()
ARCHIVE_USER = os.environ.get("KRISTINE_ARCHIVE_USER", "kristine").strip()
ARCHIVE_PASSWORD = os.environ.get("KRISTINE_ARCHIVE_PASSWORD", "").strip()

KRISTINE_API_BASE = os.environ.get(
    "KRISTINE_API_BASE",
    "https://protokoll.krista.at"
).rstrip("/")
KRISTINE_ADMIN_TOKEN = os.environ.get("KRISTINE_ADMIN_TOKEN", "").strip()

# Vom Handy aus werden absichtlich nur diese vier Endpunkte freigegeben.
# Diagnose-, Schema-, Fusion- und /open-Endpunkte bleiben ausschließlich lokal.
MOBILE_ALLOWED_PATHS = {"/", "/mobile", "/mobile/", "/status", "/search", "/thumb", "/pdf", "/kristine-job-next", "/kristine-job-create", "/search-incoming", "/incoming/suppliers", "/incoming/invoices", "/incoming/address-search", "/incoming/address-invoices", "/incoming/address-link", "/incoming/address-reject", "/incoming/unassigned"}


def _request_is_local():
    return (request.remote_addr or "") in {"127.0.0.1", "::1"}


@app.before_request
def protect_remote_archive_access():
    # Bestehende lokale KRISTINE-Aufrufe auf 127.0.0.1 bleiben unverändert.
    if _request_is_local():
        return None

    # Über Tailscale nur die minimale Handy-API freigeben.
    if request.path not in MOBILE_ALLOWED_PATHS:
        return jsonify({"ok": False, "error": "Nicht verfügbar"}), 404

    # Fail closed: Ohne gesetztes Passwort gibt es KEINEN Remote-Zugriff.
    if not ARCHIVE_PASSWORD:
        return jsonify({
            "ok": False,
            "error": "Remote-Zugriff gesperrt: KRISTINE_ARCHIVE_PASSWORD fehlt."
        }), 503

    auth = request.authorization
    username_ok = bool(auth) and hmac.compare_digest(auth.username or "", ARCHIVE_USER)
    password_ok = bool(auth) and hmac.compare_digest(auth.password or "", ARCHIVE_PASSWORD)

    if not (username_ok and password_ok):
        response = jsonify({"ok": False, "error": "Anmeldung erforderlich"})
        response.status_code = 401
        response.headers["WWW-Authenticate"] = 'Basic realm="KRISTINE Archive", charset="UTF-8"'
        return response

    return None


@app.after_request
def archive_security_headers(response):
    # Keine sensiblen Archivantworten im Browser-/Proxy-Cache behalten.
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "img-src 'self' data:; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; "
        "connect-src 'self'; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    )
    return response


def kristine_api_request(path, method="GET", payload=None):
    """Serverseitiger, gleich-origin sicherer Proxy zu KRISTINE/Render."""
    if not KRISTINE_ADMIN_TOKEN:
        raise RuntimeError("KRISTINE_ADMIN_TOKEN fehlt am Brain-Connector")

    sep = "&" if "?" in path else "?"
    url = f"{KRISTINE_API_BASE}{path}{sep}token={urllib.parse.quote(KRISTINE_ADMIN_TOKEN)}"
    body = None
    headers = {"Accept": "application/json"}

    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read().decode("utf-8", errors="replace")
            data = json.loads(raw or "{}")
            if not data.get("ok", True):
                raise RuntimeError(data.get("error") or f"KRISTINE HTTP {response.status}")
            return data
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw or "{}")
            detail = data.get("error") or raw
        except Exception:
            detail = raw
        raise RuntimeError(f"KRISTINE HTTP {e.code}: {detail or e.reason}") from e


DB = Path(r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db")
SQL_SERVER = r"SRV-DB01\WINWORKER"
SQL_DATABASE = "WinWorker_Projekte_Standard"
SQL_USER = "kristine_reader"

SCHEMA_INDEX_FILE = DB.parent / "winworker_sql_structure_index.json"

BRAIN_SUPPLIER_MAP_FILE = DB.parent / "brain_supplier_map.json"


def _load_brain_supplier_map():
    """
    Persistente Brain-Zuordnung.
    - addressLinks: erkannter PDF-Supplier-Key -> WW-StammIndex
    - invoiceLinks: einzelne Rechnung/logical_id/path -> WW-StammIndex
    Originaldaten werden nie verändert.
    """
    if not BRAIN_SUPPLIER_MAP_FILE.exists():
        return {"addressLinks": {}, "invoiceLinks": {}, "fingerprints": {}, "rejections": {}}
    try:
        data = json.loads(BRAIN_SUPPLIER_MAP_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
        return {
            "addressLinks": dict(data.get("addressLinks") or {}),
            "invoiceLinks": dict(data.get("invoiceLinks") or {}),
            "fingerprints": dict(data.get("fingerprints") or {}),
            "rejections": dict(data.get("rejections") or {}),
        }
    except Exception:
        return {"addressLinks": {}, "invoiceLinks": {}, "fingerprints": {}, "rejections": {}}


def _save_brain_supplier_map(data):
    BRAIN_SUPPLIER_MAP_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = BRAIN_SUPPLIER_MAP_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(BRAIN_SUPPLIER_MAP_FILE)


def _invoice_identity(item):
    return str(item.get("logical_id") or item.get("path") or "").strip()


def ww_address_search(query, limit=25):
    """
    Echte WinWorker-Adressen als Master.
    Dieselbe Adresswelt wie bei Projekten; unabhängig davon, ob bereits
    eine Rechnung richtig erkannt wurde.
    """
    q = str(query or "").strip()
    if len(q) < 2:
        return []

    terms = [x for x in re.split(r"\s+", q) if x]
    con = sql_connection("WinWorker_Adressen_Standard")
    cur = con.cursor()

    conditions = []
    params = []
    for term in terms:
        like = f"%{term}%"
        conditions.append("""
            (
                ISNULL(k.sFirma,'') LIKE ?
                OR ISNULL(k.sName,'') LIKE ?
                OR ISNULL(k.sVorname,'') LIKE ?
                OR ISNULL(k.sStrasse,'') LIKE ?
                OR ISNULL(k.sPLZ,'') LIKE ?
                OR ISNULL(k.sOrt,'') LIKE ?
                OR CAST(ISNULL(k.lKundenNr,0) AS varchar(40)) LIKE ?
            )
        """)
        params.extend([like] * 7)

    sql = f"""
        SELECT TOP {max(1, min(int(limit or 25), 100))}
            k.StammIndex,
            k.lKundenNr,
            k.sFirma,
            k.sName,
            k.sVorname,
            k.sStrasse,
            k.sPLZ,
            k.sOrt
        FROM dbo.Kunden AS k
        WHERE {" AND ".join(conditions)}
        ORDER BY
            CASE WHEN ISNULL(k.sFirma,'') LIKE ? THEN 0 ELSE 1 END,
            CASE WHEN k.lKundenNr IS NULL THEN 1 ELSE 0 END,
            k.lKundenNr,
            k.sFirma,
            k.sName,
            k.sOrt
    """
    exact_like = f"%{q}%"
    rows = cur.execute(sql, *(params + [exact_like])).fetchall()
    con.close()

    out = []
    for r in rows:
        name = (r.sFirma or "").strip()
        person = " ".join(x for x in [r.sVorname or "", r.sName or ""] if x).strip()
        if not name:
            name = person or f"Adresse {r.StammIndex}"
        out.append({
            "addressId": str(r.StammIndex),
            "customerNumber": str(r.lKundenNr or ""),
            "name": name,
            "person": person,
            "street": r.sStrasse or "",
            "postalCode": r.sPLZ or "",
            "city": r.sOrt or "",
            "address": ", ".join(
                x for x in [
                    (r.sStrasse or "").strip(),
                    " ".join(x for x in [(r.sPLZ or "").strip(), (r.sOrt or "").strip()] if x)
                ] if x
            ),
        })
    return out


def _address_tokens(address):
    tokens = []
    for value in (
        address.get("name"), address.get("person"), address.get("street"),
        address.get("postalCode"), address.get("city"), address.get("customerNumber")
    ):
        nv = _norm_supplier(value)
        tokens.extend([x for x in nv.split() if len(x) >= 3])
    # noisy generic words should not drive matching
    stop = {"gmbh","ges","mbh","kg","und","co","strasse","straße","austria","osterreich","österreich"}
    return [x for x in dict.fromkeys(tokens) if x not in stop]


def _invoice_linked_address_id(item, supplier_map):
    iid = _invoice_identity(item)
    if iid and iid in supplier_map.get("invoiceLinks", {}):
        return str(supplier_map["invoiceLinks"][iid])

    ident = item.get("_supplier") or {}
    skey = str(ident.get("key") or "")
    if skey and skey in supplier_map.get("addressLinks", {}):
        return str(supplier_map["addressLinks"][skey])
    return ""


def incoming_for_address(address_id, text_query=""):
    address_id = str(address_id or "").strip()
    if not address_id:
        return []

    supplier_map = _load_brain_supplier_map()
    qtokens = [x for x in _norm_supplier(text_query).split() if x]
    result = []

    for item in _incoming_catalog():
        if _invoice_linked_address_id(item, supplier_map) != address_id:
            continue
        raw = str(item.get("_raw_text") or "")
        if qtokens:
            nr = _norm_supplier(raw)
            if not all(t in nr for t in qtokens):
                continue
        result.append(_incoming_public_item(item))

    result.sort(key=lambda x: (x.get("invoiceDateTime") or "", x.get("filename") or ""), reverse=True)
    return result



MONEY_RE = re.compile(r'(?<!\d)(\d{1,3}(?:[.\s]\d{3})*,\d{2}|\d+,\d{2})(?!\d)')
TOTAL_LABELS_HIGH = (
    "endbetrag", "rechnungsbetrag", "gesamtbetrag", "zahlbetrag",
    "zu zahlen", "zahlbarer betrag", "bruttobetrag", "gesamt eur",
)
TOTAL_LABELS_NET = ("nettobetrag", "netto", "ust-basis", "mwst-basis", "ust basis")
TOTAL_LABELS_TAX = ("mwst", "ust", "mehrwertsteuer")


def _parse_euro_number(value):
    s = str(value or "").replace("EUR","").replace("€","").strip().replace(" ","")
    if not s:
        return None
    if "," in s:
        s = s.replace(".","").replace(",",".")
    try:
        return round(float(s), 2)
    except Exception:
        return None


def _line_money_values(line):
    out=[]
    for m in MONEY_RE.finditer(str(line or "")):
        v=_parse_euro_number(m.group(1))
        if v is not None:
            out.append(v)
    return out


def _extract_invoice_amount_smart(raw_text):
    lines=[re.sub(r"\s+"," ",x).strip() for x in str(raw_text or "").splitlines()]
    lines=[x for x in lines if x]
    best=None
    net=None
    tax=None

    for i,line in enumerate(lines):
        low=line.lower()
        vals=_line_money_values(line)
        if not vals:
            continue

        # Prozent-/Rabattzeilen niemals als Gesamtsumme verwenden
        if "%" in line and not any(lbl in low for lbl in TOTAL_LABELS_HIGH):
            continue

        if any(lbl in low for lbl in TOTAL_LABELS_HIGH):
            cand=vals[-1]
            row={"amount":cand,"confidence":100,"reason":"total_label","line":line}
            if best is None or row["confidence"]>best["confidence"]:
                best=row

        if any(lbl in low for lbl in TOTAL_LABELS_NET):
            net=vals[-1]
        if any(lbl in low for lbl in TOTAL_LABELS_TAX) and "%" not in line:
            tax=vals[-1]

    if best is None:
        for i,line in enumerate(lines[:-1]):
            low=line.lower()
            if any(lbl in low for lbl in TOTAL_LABELS_HIGH):
                vals=_line_money_values(lines[i+1])
                if vals and "%" not in lines[i+1]:
                    best={"amount":vals[-1],"confidence":95,"reason":"next_line_total","line":line+" / "+lines[i+1]}
                    break

    if net is not None and tax is not None:
        expected=round(net+tax,2)
        if best is not None and abs(best["amount"]-expected)<=0.02:
            best["confidence"]=100
            best["reason"]="total_label+net_tax_check"
        elif best is None:
            best={"amount":expected,"confidence":80,"reason":"net_plus_tax","line":""}

    return best or {"amount":None,"confidence":0,"reason":"not_found","line":""}


def _extract_supplier_fingerprint(raw_text):
    flat=re.sub(r"\s+"," ",str(raw_text or ""))

    def first(patterns):
        for p in patterns:
            m=re.search(p,flat,re.I)
            if m:
                return (m.group(1) or "").strip()
        return ""

    customer_no=first([
        r'Kunden[-\s]?Nr\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9./\-]{2,})',
        r'Kundennummer\s*[:\-]?\s*([A-Z0-9][A-Z0-9./\-]{2,})',
    ])
    uid=first([
        r'\bUID(?:-Nr\.?)?\s*[:\-]?\s*(ATU\d{8})\b',
        r'\bUSt[-\s]?Id(?:Nr\.?)?\s*[:\-]?\s*(ATU\d{8})\b',
    ])
    iban=first([
        r'\bIBAN\s*[:\-]?\s*((?:AT|DE|CH|LI)\s*\d(?:[\sA-Z0-9]){12,32})',
    ])
    if iban:
        iban=re.sub(r'\s+','',iban).upper()

    invoice_no=first([
        r'\bRechnung(?:s)?(?:nummer|nr\.?|Nr\.?)\s*[:\-]?\s*([A-Z0-9][A-Z0-9./\-]{2,})',
        r'\bNummer\s*[:\-]?\s*([A-Z0-9][A-Z0-9./\-]{2,})',
    ])
    amount=_extract_invoice_amount_smart(flat)

    return {
        "customerNumberExternal":customer_no,
        "uid":uid,
        "iban":iban,
        "invoiceNumber":invoice_no,
        "amountSmart":amount.get("amount"),
        "amountConfidence":amount.get("confidence",0),
        "amountReason":amount.get("reason",""),
    }


def _incoming_public_item(item):
    raw = str(item.get("_raw_text") or "")
    compact = " ".join(raw.split())
    ident = item.get("_supplier") or {}
    fp = _extract_supplier_fingerprint(raw)

    old_amount = item.get("amount")
    smart_amount = fp.get("amountSmart")
    smart_conf = int(fp.get("amountConfidence") or 0)
    final_amount = smart_amount if smart_amount is not None and smart_conf >= 80 else old_amount

    return {
        "filename": item.get("filename"),
        "path": item.get("path"),
        "logical_id": item.get("logical_id"),
        "invoiceId": _invoice_identity(item),
        "dokumenttyp": item.get("dokumenttyp") or "Eingangsrechnung",
        "invoiceDate": item.get("invoiceDate"),
        "invoiceDateTime": item.get("invoiceDateTime"),
        "year": item.get("year"),
        "month": item.get("month"),
        "monthName": item.get("monthName"),
        "day": item.get("day"),
        "amount": final_amount,
        "amountOriginal": old_amount,
        "amountSmart": smart_amount,
        "amountConfidence": smart_conf,
        "amountReason": fp.get("amountReason") or "",
        "snippet": compact[:420],
        "detectedSupplierKey": ident.get("key") or "",
        "detectedSupplierName": ident.get("name") or "",
        "detectedSupplierAddress": ident.get("address") or "",
        "detectedSupplierNumber": ident.get("supplierNumber") or "",
        "fingerprint": {
            "customerNumberExternal": fp.get("customerNumberExternal") or "",
            "uid": fp.get("uid") or "",
            "iban": fp.get("iban") or "",
            "invoiceNumber": fp.get("invoiceNumber") or "",
        },
    }


def unassigned_invoice_candidates(address, limit=80):
    """
    Unknown-only review queue.
    Explicit YES -> linked.
    Explicit NO -> permanently hidden for this address.
    Strong learned fingerprints are auto-linked before this list is returned.
    """
    address_id = str(address.get("addressId") or "")
    auto_link_by_fingerprint(address_id)
    supplier_map = _load_brain_supplier_map()
    rejected = set(supplier_map.get("rejections", {}).get(address_id, []))
    tokens = _address_tokens(address)
    scored = []

    for item in _incoming_catalog():
        iid = _invoice_identity(item)
        if not iid or iid in rejected:
            continue
        if _invoice_linked_address_id(item, supplier_map):
            continue

        ident = item.get("_supplier") or {}
        hay = _norm_supplier(" ".join([
            ident.get("name") or "",
            ident.get("address") or "",
            ident.get("supplierNumber") or "",
            str(item.get("_raw_text") or "")[:3500],
            item.get("filename") or "",
        ]))

        score = 0
        matched = []

        # Stable learned fingerprints: these would normally already be auto-linked.
        for kind, value, pts in _stable_fingerprint_matches(item, address_id, supplier_map):
            score += pts
            matched.append(f"{kind}: {value}")

        # Fuzzy address/name evidence is only for the manual review queue.
        for t in tokens:
            if t and t in hay:
                score += 3 if len(t) >= 6 else 1
                matched.append(t)
        for field in ("postalCode", "city"):
            t = _norm_supplier(address.get(field))
            if t and t in hay:
                score += 4

        # Only genuinely plausible candidates enter manual review.
        if score >= 8:
            scored.append((score, item, matched))

    scored.sort(key=lambda row: (
        -row[0],
        -(float(row[1].get("modified") or 0)),
        str(row[1].get("filename") or "")
    ))

    out=[]
    for score,item,matched in scored[:max(1,min(int(limit or 80),120))]:
        pub=_incoming_public_item(item)
        pub["matchScore"]=score
        pub["matchTerms"]=matched[:8]
        pub["decision"]="unknown"
        out.append(pub)
    return out


def _learn_address_fingerprint(address_id, item):
    data = _load_brain_supplier_map()
    fp = _extract_supplier_fingerprint(str(item.get("_raw_text") or ""))
    bucket = data.setdefault("fingerprints", {}).setdefault(str(address_id), {
        "customerNumbers": [], "uids": [], "ibans": []
    })

    for key, field in (
        ("customerNumberExternal", "customerNumbers"),
        ("uid", "uids"),
        ("iban", "ibans"),
    ):
        value = str(fp.get(key) or "").strip()
        if value and value not in bucket[field]:
            bucket[field].append(value)

    _save_brain_supplier_map(data)
    return fp


def link_invoice_or_supplier_to_address(address_id, invoice_id="", supplier_key=""):
    address_id = str(address_id or "").strip()
    invoice_id = str(invoice_id or "").strip()
    supplier_key = str(supplier_key or "").strip()
    if not address_id:
        raise ValueError("WW-Adresse fehlt.")
    if not invoice_id and not supplier_key:
        raise ValueError("Rechnung fehlt.")

    data = _load_brain_supplier_map()
    if supplier_key:
        data.setdefault("addressLinks", {})[supplier_key] = address_id
    if invoice_id:
        data.setdefault("invoiceLinks", {})[invoice_id] = address_id
        rejected = data.setdefault("rejections", {}).setdefault(address_id, [])
        if invoice_id in rejected:
            rejected.remove(invoice_id)
    _save_brain_supplier_map(data)

    learned={}
    if invoice_id:
        for item in _incoming_catalog():
            if _invoice_identity(item) == invoice_id:
                learned=_learn_address_fingerprint(address_id,item)
                break

    auto_linked = auto_link_by_fingerprint(address_id)
    return _load_brain_supplier_map(), learned, auto_linked


def reject_invoice_for_address(address_id, invoice_id):
    address_id = str(address_id or "").strip()
    invoice_id = str(invoice_id or "").strip()
    if not address_id or not invoice_id:
        raise ValueError("Adresse oder Rechnung fehlt.")
    data = _load_brain_supplier_map()
    bucket = data.setdefault("rejections", {}).setdefault(address_id, [])
    if invoice_id not in bucket:
        bucket.append(invoice_id)
    _save_brain_supplier_map(data)
    return data


def _stable_fingerprint_matches(item, address_id, supplier_map=None):
    supplier_map = supplier_map or _load_brain_supplier_map()
    bucket = supplier_map.get("fingerprints", {}).get(str(address_id), {})
    raw_norm = _norm_supplier(str(item.get("_raw_text") or ""))
    matches = []

    for value in bucket.get("customerNumbers", []):
        nv = _norm_supplier(value)
        if nv and nv in raw_norm:
            matches.append(("customerNumber", value, 100))
    for value in bucket.get("uids", []):
        nv = _norm_supplier(value)
        if nv and nv in raw_norm:
            matches.append(("uid", value, 95))
    for value in bucket.get("ibans", []):
        nv = _norm_supplier(value)
        if nv and nv in raw_norm:
            matches.append(("iban", value, 90))
    return matches


def auto_link_by_fingerprint(address_id):
    """
    Re-scan the COMPLETE invoice catalogue after every positive learning click.
    Strong stable fingerprints are auto-married. Explicit rejections always win.
    """
    address_id = str(address_id or "").strip()
    data = _load_brain_supplier_map()
    rejected = set(data.get("rejections", {}).get(address_id, []))
    linked = 0

    for item in _incoming_catalog():
        iid = _invoice_identity(item)
        if not iid or iid in rejected:
            continue
        current = _invoice_linked_address_id(item, data)
        if current and current != address_id:
            continue
        if current == address_id:
            continue

        matches = _stable_fingerprint_matches(item, address_id, data)
        if matches:
            data.setdefault("invoiceLinks", {})[iid] = address_id
            linked += 1

    if linked:
        _save_brain_supplier_map(data)
    return linked


def get_sql_driver():
    drivers = pyodbc.drivers()
    for name in (
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "SQL Server Native Client 11.0",
        "SQL Server",
    ):
        if name in drivers:
            return name
    raise RuntimeError("Kein geeigneter SQL-Server-ODBC-Treiber gefunden")


def sql_connection(database=SQL_DATABASE):
    password = os.environ.get("KRISTINE_SQL_PASSWORD", "").strip()
    if not password:
        raise RuntimeError("KRISTINE_SQL_PASSWORD fehlt")

    driver = get_sql_driver()
    return pyodbc.connect(
        f"DRIVER={{{driver}}};"
        f"SERVER={SQL_SERVER};"
        f"DATABASE={database};"
        f"UID={SQL_USER};"
        f"PWD={password};"
        "TrustServerCertificate=yes;",
        timeout=5,
    )


def clean_date(value):
    if value is None:
        return None
    if hasattr(value, "date"):
        return value.date().isoformat()
    return str(value)




def _schema_safe_name(value):
    value = str(value or "")
    if not re.fullmatch(r"[A-Za-z0-9_]+", value):
        raise ValueError(f"Unsicherer SQL-Name: {value}")
    return value


def build_winworker_schema_index():
    """
    Baut einen reinen STRUKTURINDEX der WinWorker-SQL-Landschaft.
    Keine Geschäftsdaten werden kopiert.

    Erfasst – soweit der Reader darauf zugreifen darf:
    - Datenbanken WinWorker_*
    - Tabellen und Views
    - Spalten + Datentyp + NULL
    - Primärschlüssel
    - Fremdschlüssel
    - normale/unique Indizes

    Nicht erreichbare Datenbanken werden protokolliert und übersprungen.
    """
    master = sql_connection("master")
    cur = master.cursor()
    db_rows = cur.execute("""
        SELECT name
        FROM sys.databases
        WHERE name LIKE 'WinWorker[_]%'
          AND state_desc = 'ONLINE'
        ORDER BY name
    """).fetchall()
    master.close()

    db_names = [str(row.name) for row in db_rows]
    result = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "server": SQL_SERVER,
        "databaseCount": len(db_names),
        "databases": [],
        "errors": [],
    }

    for db_name in db_names:
        db_name = _schema_safe_name(db_name)
        db_item = {
            "name": db_name,
            "objects": [],
            "foreignKeys": [],
            "indexes": [],
        }
        try:
            con = sql_connection(db_name)
            cur = con.cursor()

            # Tables + views + columns + PK flag.
            rows = cur.execute("""
                SELECT
                    s.name AS schema_name,
                    o.name AS object_name,
                    CASE o.type WHEN 'U' THEN 'TABLE' WHEN 'V' THEN 'VIEW' ELSE o.type_desc END AS object_type,
                    c.column_id,
                    c.name AS column_name,
                    t.name AS data_type,
                    c.max_length,
                    c.precision,
                    c.scale,
                    c.is_nullable,
                    CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS is_primary_key
                FROM sys.objects o
                JOIN sys.schemas s ON s.schema_id = o.schema_id
                JOIN sys.columns c ON c.object_id = o.object_id
                JOIN sys.types t ON t.user_type_id = c.user_type_id
                LEFT JOIN (
                    SELECT ic.object_id, ic.column_id
                    FROM sys.indexes i
                    JOIN sys.index_columns ic
                      ON ic.object_id = i.object_id
                     AND ic.index_id = i.index_id
                    WHERE i.is_primary_key = 1
                ) pk
                  ON pk.object_id = c.object_id
                 AND pk.column_id = c.column_id
                WHERE o.type IN ('U','V')
                  AND o.is_ms_shipped = 0
                ORDER BY s.name, o.name, c.column_id
            """).fetchall()

            object_map = {}
            for row in rows:
                key = (str(row.schema_name), str(row.object_name), str(row.object_type))
                if key not in object_map:
                    object_map[key] = {
                        "schema": key[0],
                        "name": key[1],
                        "type": key[2],
                        "columns": [],
                    }
                object_map[key]["columns"].append({
                    "ordinal": int(row.column_id),
                    "name": str(row.column_name),
                    "dataType": str(row.data_type),
                    "maxLength": int(row.max_length) if row.max_length is not None else None,
                    "precision": int(row.precision) if row.precision is not None else None,
                    "scale": int(row.scale) if row.scale is not None else None,
                    "nullable": bool(row.is_nullable),
                    "primaryKey": bool(row.is_primary_key),
                })
            db_item["objects"] = list(object_map.values())

            # Foreign keys.
            fk_rows = cur.execute("""
                SELECT
                    fk.name AS fk_name,
                    ps.name AS parent_schema,
                    pt.name AS parent_table,
                    pc.name AS parent_column,
                    rs.name AS ref_schema,
                    rt.name AS ref_table,
                    rc.name AS ref_column
                FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
                JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
                JOIN sys.columns pc
                  ON pc.object_id = fkc.parent_object_id
                 AND pc.column_id = fkc.parent_column_id
                JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
                JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
                JOIN sys.columns rc
                  ON rc.object_id = fkc.referenced_object_id
                 AND rc.column_id = fkc.referenced_column_id
                ORDER BY fk.name, fkc.constraint_column_id
            """).fetchall()
            db_item["foreignKeys"] = [{
                "name": str(r.fk_name),
                "from": f"{r.parent_schema}.{r.parent_table}.{r.parent_column}",
                "to": f"{r.ref_schema}.{r.ref_table}.{r.ref_column}",
            } for r in fk_rows]

            # Indexes: useful for identifying stable keys even where no FK exists.
            idx_rows = cur.execute("""
                SELECT
                    s.name AS schema_name,
                    t.name AS table_name,
                    i.name AS index_name,
                    i.is_unique,
                    i.is_primary_key,
                    c.name AS column_name,
                    ic.key_ordinal
                FROM sys.indexes i
                JOIN sys.tables t ON t.object_id = i.object_id
                JOIN sys.schemas s ON s.schema_id = t.schema_id
                JOIN sys.index_columns ic
                  ON ic.object_id = i.object_id
                 AND ic.index_id = i.index_id
                JOIN sys.columns c
                  ON c.object_id = ic.object_id
                 AND c.column_id = ic.column_id
                WHERE i.name IS NOT NULL
                  AND i.is_hypothetical = 0
                ORDER BY s.name, t.name, i.name, ic.key_ordinal, c.column_id
            """).fetchall()
            idx_map = {}
            for r in idx_rows:
                key = (str(r.schema_name), str(r.table_name), str(r.index_name))
                idx_map.setdefault(key, {
                    "schema": key[0],
                    "table": key[1],
                    "name": key[2],
                    "unique": bool(r.is_unique),
                    "primaryKey": bool(r.is_primary_key),
                    "columns": [],
                })
                idx_map[key]["columns"].append(str(r.column_name))
            db_item["indexes"] = list(idx_map.values())

            con.close()
        except Exception as e:
            db_item["error"] = str(e)
            result["errors"].append({"database": db_name, "error": str(e)})

        db_item["objectCount"] = len(db_item["objects"])
        db_item["columnCount"] = sum(len(obj["columns"]) for obj in db_item["objects"])
        result["databases"].append(db_item)

    SCHEMA_INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_INDEX_FILE.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    return result


def load_winworker_schema_index():
    if not SCHEMA_INDEX_FILE.exists():
        return None
    try:
        return json.loads(SCHEMA_INDEX_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def search_winworker_schema_index(query, limit=100):
    index = load_winworker_schema_index()
    if not index:
        return {"ok": False, "error": "SQL-Strukturindex fehlt. Zuerst /schema-index/rebuild aufrufen."}

    terms = [t for t in re.split(r"\\s+", str(query or "").strip().lower()) if t]
    if not terms:
        return {"ok": True, "query": query, "hits": [], "generatedAt": index.get("generatedAt")}

    hits = []
    for db in index.get("databases", []):
        db_name = str(db.get("name") or "")
        for obj in db.get("objects", []):
            schema = str(obj.get("schema") or "")
            name = str(obj.get("name") or "")
            for col in obj.get("columns", []):
                col_name = str(col.get("name") or "")
                hay = f"{db_name} {schema} {name} {col_name} {col.get('dataType','')}".lower()
                if all(term in hay for term in terms):
                    hits.append({
                        "database": db_name,
                        "schema": schema,
                        "object": name,
                        "objectType": obj.get("type"),
                        "column": col_name,
                        "dataType": col.get("dataType"),
                        "nullable": col.get("nullable"),
                        "primaryKey": col.get("primaryKey"),
                    })
                    if len(hits) >= max(1, min(int(limit or 100), 500)):
                        return {"ok": True, "query": query, "hits": hits, "generatedAt": index.get("generatedAt")}

    return {"ok": True, "query": query, "hits": hits, "generatedAt": index.get("generatedAt")}




def ww_hours_fusion_source(project_indices):
    """
    Liefert WinWorker-Stunden als Rohmaterial für die Fusion mit KRISTINE.

    Regel:
    - relevante Mitarbeiter/Tage werden über die angefragten Projekte bestimmt
    - für diese Mitarbeiter/Tage werden ALLE produktiven Projektstunden des Tages
      berücksichtigt, damit die 15 Minuten korrekt proportional verteilt werden
    - pro MA + Tag werden maximal 0,25 h abgezogen
    - die Mitarbeiteridentität kommt über
      Stundenmitschreibung.MAIndex = LohnEmpfaenger.StammIndex
      und LohnEmpfaenger.sMANr = Fink-Personalnummer
    """
    ids = sorted({int(x) for x in project_indices if x is not None})
    if not ids:
        return []

    placeholders = ",".join("?" for _ in ids)
    con = sql_connection("WinWorker_Projekte_Standard")
    cur = con.cursor()

    sql = f"""
        WITH RelevantDays AS (
            SELECT DISTINCT
                sm.MAIndex,
                CAST(sm.Tag AS date) AS Arbeitstag
            FROM WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung AS sm
            WHERE sm.ProjektIndex IN ({placeholders})
              AND sm.MAIndex IS NOT NULL
              AND sm.Tag IS NOT NULL
              AND ISNULL(sm.bNichtAuswerten, 0) = 0
        ),
        DayProject AS (
            SELECT
                sm.MAIndex,
                CAST(sm.Tag AS date) AS Arbeitstag,
                sm.ProjektIndex,
                SUM(CAST(ISNULL(sm.dStundenErfasst, 0) AS decimal(18,6))) AS RawHours
            FROM WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung AS sm
            INNER JOIN RelevantDays AS rd
                ON rd.MAIndex = sm.MAIndex
               AND rd.Arbeitstag = CAST(sm.Tag AS date)
            WHERE sm.ProjektIndex IS NOT NULL
              AND ISNULL(sm.bNichtAuswerten, 0) = 0
              AND ISNULL(sm.bUnproduktiv, 0) = 0
            GROUP BY
                sm.MAIndex,
                CAST(sm.Tag AS date),
                sm.ProjektIndex
        ),
        DayTotals AS (
            SELECT
                MAIndex,
                Arbeitstag,
                SUM(RawHours) AS TotalRawHours
            FROM DayProject
            GROUP BY MAIndex, Arbeitstag
        )
        SELECT
            dp.MAIndex,
            LTRIM(RTRIM(ISNULL(le.sMANr, ''))) AS FinkNumber,
            LTRIM(RTRIM(ISNULL(le.sVorname, ''))) AS FirstName,
            LTRIM(RTRIM(ISNULL(le.sName, ''))) AS LastName,
            dp.Arbeitstag,
            dp.ProjektIndex,
            p.sProjektNummer,
            CAST(dp.RawHours AS decimal(18,6)) AS RawHours,
            CAST(dt.TotalRawHours AS decimal(18,6)) AS TotalDayHours,
            CAST(
                CASE
                    WHEN dt.TotalRawHours <= 0 THEN dp.RawHours
                    ELSE dp.RawHours
                       - (
                           CASE
                               WHEN dt.TotalRawHours < CAST(0.25 AS decimal(18,6))
                                   THEN dt.TotalRawHours
                               ELSE CAST(0.25 AS decimal(18,6))
                           END
                           * (dp.RawHours / dt.TotalRawHours)
                         )
                END
                AS decimal(18,6)
            ) AS NetHours,
            CAST(
                CASE
                    WHEN dt.TotalRawHours <= 0 THEN 0
                    ELSE (
                        CASE
                            WHEN dt.TotalRawHours < CAST(0.25 AS decimal(18,6))
                                THEN dt.TotalRawHours
                            ELSE CAST(0.25 AS decimal(18,6))
                        END
                        * (dp.RawHours / dt.TotalRawHours)
                    )
                END
                AS decimal(18,6)
            ) AS BreakHours
        FROM DayProject AS dp
        INNER JOIN DayTotals AS dt
            ON dt.MAIndex = dp.MAIndex
           AND dt.Arbeitstag = dp.Arbeitstag
        LEFT JOIN WinWorker_Personal_Standard.dbo.LohnEmpfaenger AS le
            ON le.StammIndex = dp.MAIndex
        LEFT JOIN dbo.Projekte AS p
            ON p.ProjektIndex = dp.ProjektIndex
        WHERE dp.ProjektIndex IN ({placeholders})
        ORDER BY
            dp.Arbeitstag,
            dp.MAIndex,
            dp.ProjektIndex
    """

    rows = cur.execute(sql, *(ids + ids)).fetchall()
    con.close()

    result = []
    for row in rows:
        result.append({
            "maIndex": int(row.MAIndex) if row.MAIndex is not None else None,
            "finkNumber": row.FinkNumber or "",
            "employeeName": " ".join(
                x for x in [row.FirstName or "", row.LastName or ""] if x
            ).strip(),
            "date": clean_date(row.Arbeitstag),
            "projectIndex": int(row.ProjektIndex) if row.ProjektIndex is not None else None,
            "projectNumber": row.sProjektNummer or "",
            "rawHours": float(row.RawHours or 0),
            "totalDayHours": float(row.TotalDayHours or 0),
            "netHours": float(row.NetHours or 0),
            "breakHours": float(row.BreakHours or 0),
        })

    return result



def project_metrics(project_indices):
    """
    Projektkennzahlen V0.9.

    IST-STUNDEN
    -----------
    Direkte Verbindung zur Datenbank WinWorker_Mitschreibung_Standard.
    Das vermeidet Cross-DB-Probleme des Reader-Users.
    SUM(dStundenErfasst), bNichtAuswerten = 0.

    NETTO
    -----
    1) Pro Projekt + sBuchNummer nur die neueste Buch-Version.
       Reihenfolge: Geändert / dzInhaltGeaendert / dzDocDatum / Aufgenommen.
    2) dbo.Rechnung zusätzlich je gBuchID deduplizieren.
    3) Erst danach cUmsatzNetto summieren.
    """
    ids = sorted({int(x) for x in project_indices if x is not None})
    if not ids:
        return {}

    placeholders = ",".join("?" for _ in ids)
    result = {pid: {"hoursTotal": None, "netInvoiced": None} for pid in ids}

    # 1) Echte IST-Stunden
    # Wichtig: gleiche Verbindung wie die funktionierende Projektsuche verwenden,
    # aber die Mitschreibungs-Tabelle vollständig qualifizieren.
    try:
        con = sql_connection("WinWorker_Projekte_Standard")
        cur = con.cursor()
        sql = f"""
            SELECT
                sm.ProjektIndex,
                SUM(CAST(ISNULL(sm.dStundenErfasst, 0) AS decimal(18,4))) AS IstStunden
            FROM WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung AS sm
            WHERE sm.ProjektIndex IN ({placeholders})
              AND ISNULL(sm.bNichtAuswerten, 0) = 0
            GROUP BY sm.ProjektIndex
        """
        rows = cur.execute(sql, *ids).fetchall()
        con.close()

        for row in rows:
            pid = int(row.ProjektIndex)
            if pid in result:
                result[pid]["hoursTotal"] = (
                    float(row.IstStunden) if row.IstStunden is not None else None
                )
    except Exception as e:
        print("SQL Stunden-Metrik FEHLER:", repr(e))

    # 2) Aktueller Netto-Abrechnungsstand
    #
    # WinWorker liefert dieselbe Rechnungsnummer mehrfach (z. B. Buchart 6/7
    # oder neu gedruckte/geänderte Versionen). Für die Archivkarte zählt
    # JEDE RECHNUNGSNUMMER NUR EINMAL.
    #
    # Vorgehen:
    # - alle Buch-/Rechnungszeilen des Projekts holen
    # - pro sBuchNummer nur eine aktuelle/eindeutige Netto-Zeile bestimmen
    # - erst danach summieren
    try:
        con = sql_connection("WinWorker_Projekte_Standard")
        cur = con.cursor()
        sql = f"""
            WITH InvoiceRows AS (
                SELECT
                    b.ProjektIndex,
                    LTRIM(RTRIM(b.sBuchNummer)) AS sBuchNummer,
                    r.cUmsatzNetto,
                    COALESCE(
                        b.Geändert,
                        b.dzInhaltGeaendert,
                        b.dzDocDatum,
                        b.Aufgenommen
                    ) AS VersionZeit,
                    b.gID
                FROM dbo.[Bücher] AS b
                INNER JOIN dbo.Rechnung AS r
                    ON r.gBuchID = b.gID
                WHERE b.ProjektIndex IN ({placeholders})
                  AND NULLIF(LTRIM(RTRIM(ISNULL(b.sBuchNummer, ''))), '') IS NOT NULL
                  AND ISNULL(b.Storno, 0) = 0
                  AND r.cUmsatzNetto IS NOT NULL
            ),
            LatestPerInvoiceNumber AS (
                SELECT
                    ProjektIndex,
                    sBuchNummer,
                    cUmsatzNetto,
                    ROW_NUMBER() OVER (
                        PARTITION BY ProjektIndex, sBuchNummer
                        ORDER BY
                            VersionZeit DESC,
                            gID DESC
                    ) AS rn
                FROM InvoiceRows
            )
            SELECT
                ProjektIndex,
                SUM(CAST(cUmsatzNetto AS decimal(18,2))) AS NettoAbgerechnet
            FROM LatestPerInvoiceNumber
            WHERE rn = 1
            GROUP BY ProjektIndex
        """
        rows = cur.execute(sql, *ids).fetchall()
        con.close()

        for row in rows:
            pid = int(row.ProjektIndex)
            if pid in result:
                result[pid]["netInvoiced"] = (
                    float(row.NettoAbgerechnet)
                    if row.NettoAbgerechnet is not None
                    else None
                )
    except Exception as e:
        print("SQL Rechnungs-Metrik FEHLER:", repr(e))

    return result

def search_projects(terms):
    if not terms:
        return []

    con = sql_connection()
    cur = con.cursor()

    conditions = []
    params = []

    # Alle Suchbegriffe müssen irgendwo im Projekt/Kunden-Datensatz vorkommen.
    for term in terms:
        like = f"%{term}%"
        conditions.append(
            """
            (
                ISNULL(p.sProjektNummer, '') LIKE ?
                OR ISNULL(p.sProjekt, '') LIKE ?
                OR ISNULL(p.sBaustelle, '') LIKE ?
                OR ISNULL(p.sBauvorhaben, '') LIKE ?
                OR ISNULL(k.sFirma, '') LIKE ?
                OR ISNULL(k.sName, '') LIKE ?
                OR ISNULL(k.sVorname, '') LIKE ?
                OR ISNULL(k.sStrasse, '') LIKE ?
                OR ISNULL(k.sPLZ, '') LIKE ?
                OR ISNULL(k.sOrt, '') LIKE ?
            )
            """
        )
        params.extend([like] * 10)

    # Numerische Suchbegriffe werden nur zur Sortierung genutzt:
    # exakte Projektnummer zuerst, flexible Suche bleibt vollständig erhalten.
    numeric_terms = [t for t in terms if re.fullmatch(r"\d+", t)]
    order_params = []
    order_parts = []
    if numeric_terms:
        placeholders = ",".join("?" for _ in numeric_terms)
        order_parts.append(
            f"CASE WHEN p.sProjektNummer IN ({placeholders}) THEN 0 ELSE 1 END"
        )
        order_params.extend(numeric_terms)

    order_parts.extend([
        "CASE WHEN k.lKundenNr IS NULL THEN 1 ELSE 0 END",
        "k.lKundenNr ASC",
        "MAX(b.dzDocDatum) DESC",
        "p.ProjektIndex DESC",
    ])
    order_by = ",\n            ".join(order_parts)

    sql = f"""
        SELECT TOP 100
            p.ProjektIndex,
            p.sProjektNummer,
            p.sProjekt,
            p.sBaustelle,
            p.sBauvorhaben,
            p.KundenIndex,
            k.lKundenNr,
            k.sFirma,
            k.sName,
            k.sVorname,
            k.sStrasse,
            k.sPLZ,
            k.sOrt,
            MIN(b.dzDocDatum) AS ErstesDatum,
            MAX(b.dzDocDatum) AS LetztesDatum
        FROM dbo.Projekte AS p
        LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden AS k
            ON p.KundenIndex = k.StammIndex
        LEFT JOIN dbo.Bücher AS b
            ON b.ProjektIndex = p.ProjektIndex
        WHERE {" AND ".join(conditions)}
        GROUP BY
            p.ProjektIndex,
            p.sProjektNummer,
            p.sProjekt,
            p.sBaustelle,
            p.sBauvorhaben,
            p.KundenIndex,
            k.lKundenNr,
            k.sFirma,
            k.sName,
            k.sVorname,
            k.sStrasse,
            k.sPLZ,
            k.sOrt
        ORDER BY
            {order_by}
    """

    cur.execute(sql, params + order_params)
    rows = cur.fetchall()
    con.close()

    result = []
    for row in rows:
        street = row.sStrasse or ""
        postal = row.sPLZ or ""
        city = row.sOrt or ""
        address = " ".join(x for x in [street, postal, city] if x).strip()

        customer = " ".join(
            x for x in [row.sVorname or "", row.sName or ""] if x
        ).strip()

        result.append({
            "projectIndex": row.ProjektIndex,
            "projectNumber": row.sProjektNummer or "",
            "title": row.sProjekt or row.sBaustelle or row.sBauvorhaben or "",
            "site": row.sBaustelle or "",
            "projectDescription": row.sBauvorhaben or "",
            "customerIndex": row.KundenIndex,
            "customerNumber": row.lKundenNr,
            "company": row.sFirma or "",
            "firstName": row.sVorname or "",
            "lastName": row.sName or "",
            "customer": customer,
            "street": street,
            "postalCode": postal,
            "city": city,
            "address": address,
            "firstDate": clean_date(row.ErstesDatum),
            "lastDate": clean_date(row.LetztesDatum),
        })


    metrics = project_metrics([item.get("projectIndex") for item in result])
    for item in result:
        project_index = item.get("projectIndex")
        metric = metrics.get(int(project_index)) if project_index is not None else None
        item["hoursTotal"] = metric.get("hoursTotal") if metric else None
        item["netInvoiced"] = metric.get("netInvoiced") if metric else None

    return result



def discover_metric_columns():
    """
    Findet nur Kandidaten für Stunden-/Rechnungsfelder.
    Es wird noch NICHT automatisch auf unbekannte Tabellen summiert.
    """
    con = sql_connection()
    cur = con.cursor()

    sql = """
        SELECT
            TABLE_SCHEMA,
            TABLE_NAME,
            COLUMN_NAME,
            DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE
            LOWER(COLUMN_NAME) LIKE '%stund%'
            OR LOWER(COLUMN_NAME) LIKE '%hour%'
            OR LOWER(COLUMN_NAME) LIKE '%zeit%'
            OR LOWER(COLUMN_NAME) LIKE '%netto%'
            OR LOWER(COLUMN_NAME) LIKE '%rechnung%'
            OR LOWER(COLUMN_NAME) LIKE '%betrag%'
            OR LOWER(COLUMN_NAME) LIKE '%summe%'
            OR LOWER(COLUMN_NAME) LIKE '%umsatz%'
        ORDER BY TABLE_NAME, ORDINAL_POSITION
    """

    rows = cur.execute(sql).fetchall()
    con.close()

    result = []
    for row in rows:
        result.append({
            "schema": row.TABLE_SCHEMA,
            "table": row.TABLE_NAME,
            "column": row.COLUMN_NAME,
            "dataType": row.DATA_TYPE,
        })
    return result


def parse_print_time(filename, modified):
    # WinWorker benennt Kundenexemplare z.B.
    # 2205110 (2022-05-10 11.36.47).pdf
    match = re.search(
        r"\((\d{4}-\d{2}-\d{2})\s+(\d{2})\.(\d{2})\.(\d{2})\)",
        filename or "",
    )
    if match:
        iso = f"{match.group(1)}T{match.group(2)}:{match.group(3)}:{match.group(4)}"
        try:
            dt = datetime.fromisoformat(iso)
            return dt
        except ValueError:
            pass

    try:
        return datetime.fromtimestamp(float(modified))
    except Exception:
        return None


def search_pdf(terms):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row

    sql = """
        SELECT
            filename,
            path,
            dokumenttyp,
            modified
        FROM pdf_index
        WHERE 1=1
    """
    params = []

    for term in terms:
        sql += """
            AND (
                text LIKE ?
                OR filename LIKE ?
                OR path LIKE ?
            )
        """
        like = f"%{term}%"
        params.extend([like, like, like])

    sql += " ORDER BY modified DESC LIMIT 300"
    rows = con.execute(sql, params).fetchall()
    con.close()

    result = []
    for row in rows:
        item = dict(row)
        dt = parse_print_time(item.get("filename"), item.get("modified"))
        item["printDate"] = dt.date().isoformat() if dt else None
        item["printDateTime"] = dt.isoformat(timespec="seconds") if dt else None
        item["year"] = dt.year if dt else None
        result.append(item)

    # Letzter Druck zuerst. Filename-Zeit ist zuverlässiger als Netzwerk-mtime.
    result.sort(key=lambda x: x.get("printDateTime") or "", reverse=True)
    return result




_INCOMING_CACHE = {"stamp": None, "rows": []}

MONTH_NAMES_DE = {
    1:"Januar", 2:"Februar", 3:"März", 4:"April", 5:"Mai", 6:"Juni",
    7:"Juli", 8:"August", 9:"September", 10:"Oktober", 11:"November", 12:"Dezember"
}


def _norm_supplier(value):
    value = str(value or "").lower()
    value = value.replace("ß", "ss")
    value = re.sub(r"[^a-z0-9äöü]+", " ", value)
    return " ".join(value.split())


def _money_to_float(raw):
    s = str(raw or "").strip().replace("€", "").replace("EUR", "").replace(" ", "")
    if not s:
        return None
    # Österreich/DE: 12.345,67
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    else:
        # Englische/technische Schreibweise nur dann als Dezimalpunkt interpretieren,
        # wenn genau 1 Punkt und max. 2 Nachkommastellen vorhanden sind.
        if s.count(".") > 1:
            s = s.replace(".", "")
    try:
        value = float(s)
        return value if value >= 0 else None
    except Exception:
        return None


def _extract_invoice_amount(text):
    """
    Best-effort Rechnungsbetrag aus dem PDF-Text.
    Bevorzugt eindeutige Endsumme-Bezeichnungen.
    """
    raw = str(text or "")
    patterns = [
        r"(?i)(?:rechnungsbetrag|zahlbetrag|endbetrag|gesamtbetrag|bruttobetrag|zu\s+zahlen)"
        r"[^\d]{0,35}(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})",
        r"(?i)(?:gesamt|summe)\s*(?:brutto)?[^\d]{0,30}"
        r"(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})",
    ]
    for pattern in patterns:
        matches = re.findall(pattern, raw)
        if matches:
            # Bei wiederholten Summen steht die Endsumme meist zuletzt.
            for candidate in reversed(matches):
                value = _money_to_float(candidate)
                if value is not None:
                    return value
    return None


def _extract_invoice_date(text, modified=None, doc_year=None):
    raw = str(text or "")
    patterns = [
        r"(?i)(?:rechnungsdatum|belegdatum|datum)\s*[:\-]?\s*"
        r"(\d{1,2})[./-](\d{1,2})[./-](20\d{2})",
        r"\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b",
    ]
    for pattern in patterns:
        m = re.search(pattern, raw[:7000])
        if m:
            try:
                day, month, year = map(int, m.groups())
                return datetime(year, month, day)
            except Exception:
                pass

    try:
        dt = datetime.fromtimestamp(float(modified))
        # doc_year aus Dokman ist verlässlicher als mtime-Jahr, wenn vorhanden.
        if doc_year and int(doc_year) != dt.year:
            return datetime(int(doc_year), dt.month, min(dt.day, 28))
        return dt
    except Exception:
        if doc_year:
            try:
                return datetime(int(doc_year), 1, 1)
            except Exception:
                pass
    return None


def _extract_supplier_identity(text, query=""):
    """
    Lieferant aus dem RECHNUNGSKOPF erkennen.
    Wichtig: nicht im ganzen Rechnungstext suchen, sonst findet "Sto"
    z.B. auch andere Lieferanten, die irgendwo einen Sto-Artikel erwähnen.
    """
    raw = str(text or "")
    lines = [re.sub(r"\s+", " ", x).strip() for x in raw[:2200].splitlines()]
    lines = [x for x in lines if x]

    # Eigene Firma ist auf Eingangsrechnungen typischerweise Empfänger,
    # niemals Lieferant.
    own_company = re.compile(
        r"(?i)\b(farben\s+krista|malerische\s+wohnideen)\b"
    )

    bad_meta = re.compile(
        r"(?i)\b(iban|bic|uid|ust[- ]?id|firmenbuch|handelsgericht|gericht|"
        r"dvr|konto|bank|telefon|tel\.|fax|e-?mail|www\.|seite\s+\d|"
        r"rechnungsnr|rechnungsnummer|kundennr|kunden-?ust)\b"
    )

    legal = re.compile(
        r"(?i)\b(gmbh|ges\.?\s*m\.?\s*b\.?\s*h\.?|ag|kg|ohg|"
        r"gmbh\s*&\s*co|sarl|sa|limited|ltd)\b"
    )

    # 1) Lieferantenname: möglichst frühe plausible Firmenzeile.
    candidates = []
    for i, line in enumerate(lines[:28]):
        if own_company.search(line):
            continue
        if bad_meta.search(line):
            continue
        if len(line) < 3 or len(line) > 160:
            continue

        score = 0
        if legal.search(line):
            score += 5
        if i < 8:
            score += 3
        elif i < 15:
            score += 1
        if re.search(r"[A-Za-zÄÖÜäöü]{3}", line):
            score += 1
        # reine Adresse / Zahl nicht als Name
        if re.search(r"\b\d{4}\b", line) and not legal.search(line):
            score -= 2

        if score > 0:
            candidates.append((score, -i, i, line))

    if not candidates:
        return None

    candidates.sort(reverse=True)
    name_idx = candidates[0][2]
    name = candidates[0][3][:180]

    # 2) Adresse: nur Zeilen im direkten Umfeld NACH dem Firmennamen.
    #    Finanz-/Firmenbuchdaten ausdrücklich ausschließen.
    address_lines = []
    postal_line = ""
    street_line = ""

    for j in range(name_idx + 1, min(len(lines), name_idx + 9)):
        line = lines[j]
        if own_company.search(line) or bad_meta.search(line):
            continue

        # PLZ + Ort
        if re.search(r"\b(?:A-|AT-|CH-|FL-)?\d{4}\s+[A-Za-zÄÖÜäöü]", line, re.I):
            postal_line = line
            # direkte Zeile davor als Straße, wenn sie plausibel ist
            for k in range(j - 1, name_idx, -1):
                prev = lines[k]
                if own_company.search(prev) or bad_meta.search(prev):
                    continue
                if re.search(r"\d", prev) and len(prev) <= 120:
                    street_line = prev
                    break
            break

    if street_line:
        address_lines.append(street_line)
    if postal_line:
        address_lines.append(postal_line)

    address = ", ".join(address_lines)[:220]

    # 3) Nummer im Kopf - nur echte Nummernfelder, keine IBAN/FN etc.
    supplier_no = ""
    header = "\n".join(lines[:45])
    m = re.search(
        r"(?i)(?:lieferanten?(?:nummer|nr\.?)|kreditor(?:ennummer|nr\.?)|"
        r"kundennummer|kunden-?nr\.?)\s*[:#\-]?\s*([A-Z0-9./\-]{2,30})",
        header
    )
    if m:
        supplier_no = m.group(1).strip()

    # 4) Stabile Identität: Name normalisiert + PLZ/Ort.
    #    Rechtsformen und Schreibweisen wie "Straße/Strasse" sollen nicht
    #    zu künstlichen Dubletten führen.
    name_norm = _norm_supplier(name)
    for token in (
        "gesellschaft mit beschrankter haftung",
        "gesellschaft mbh", "ges mbh", "gmbh", "ag", "kg", "ohg",
        "ges m b h", "co"
    ):
        name_norm = re.sub(rf"\b{re.escape(token)}\b", " ", name_norm)
    name_norm = " ".join(name_norm.split())

    address_norm = _norm_supplier(address)
    postal = ""
    city = ""
    m = re.search(r"\b(?:a|at|ch|fl)?\s*(\d{4})\s+([a-zäöü][a-zäöü \-]+)", address_norm)
    if m:
        postal = m.group(1)
        city = m.group(2).strip()

    key_raw = "|".join([name_norm, postal, city])
    supplier_key = hashlib.sha1(key_raw.encode("utf-8", errors="ignore")).hexdigest()[:18]

    return {
        "key": supplier_key,
        "name": name,
        "address": address,
        "supplierNumber": supplier_no,
        "nameNorm": name_norm,
        "addressNorm": address_norm,
    }


def _incoming_catalog():
    """
    Cache der 6.000+ Eingangsrechnungen, damit Lieferantenauswahl,
    Jahresansicht und Textsuche flott bleiben.
    """
    try:
        stamp = DB.stat().st_mtime_ns
    except Exception:
        stamp = None

    if _INCOMING_CACHE["stamp"] == stamp and _INCOMING_CACHE["rows"]:
        return _INCOMING_CACHE["rows"]

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(pdf_index)").fetchall()}
        has_source = "source" in cols
        has_year = "doc_year" in cols
        has_logical = "logical_id" in cols

        select = ["filename","path","dokumenttyp","modified","text"]
        if has_source:
            select.append("source")
        if has_year:
            select.append("doc_year")
        if has_logical:
            select.append("logical_id")

        sql = "SELECT " + ",".join(select) + " FROM pdf_index WHERE 1=1 "
        if has_source:
            sql += " AND source='EINGANG' "
        else:
            sql += r" AND path LIKE '%\Dokman\%' "
        sql += " ORDER BY modified DESC"

        dbrows = con.execute(sql).fetchall()
    finally:
        con.close()

    result = []
    seen = set()
    for row in dbrows:
        item = dict(row)
        logical = str(item.get("logical_id") or "").strip()
        unique = logical or str(item.get("path") or "")
        if unique in seen:
            continue
        seen.add(unique)

        raw = str(item.get("text") or "")
        doc_year = item.get("doc_year")
        dt = _extract_invoice_date(raw, item.get("modified"), doc_year)
        amount = _extract_invoice_amount(raw)

        item["_raw_text"] = raw
        item["_header_norm"] = _norm_supplier(raw[:2200])
        item["_supplier"] = _extract_supplier_identity(raw)
        item["invoiceDate"] = dt.date().isoformat() if dt else None
        item["invoiceDateTime"] = dt.isoformat(timespec="seconds") if dt else None
        item["year"] = dt.year if dt else (int(doc_year) if doc_year else None)
        item["month"] = dt.month if dt else None
        item["monthName"] = MONTH_NAMES_DE.get(dt.month, "") if dt else ""
        item["day"] = dt.day if dt else None
        item["amount"] = amount
        result.append(item)

    _INCOMING_CACHE["stamp"] = stamp
    _INCOMING_CACHE["rows"] = result
    return result


def incoming_supplier_candidates(query, limit=20):
    """
    Schritt 1: nur Lieferant/Adresse.
    Kein Treffer mehr, nur weil 'Sto' irgendwo im Artikeltext einer Hilti-Rechnung steht.
    """
    q = str(query or "").strip()
    nq = _norm_supplier(q)
    if len(nq) < 2:
        return []

    tokens = [x for x in nq.split() if len(x) >= 2]
    grouped = {}

    for item in _incoming_catalog():
        ident = item.get("_supplier")
        if not ident:
            continue

        searchable = " ".join([
            ident.get("nameNorm") or "",
            ident.get("addressNorm") or "",
            _norm_supplier(ident.get("supplierNumber") or ""),
        ])

        if not all(t in searchable for t in tokens):
            continue

        g = grouped.setdefault(ident["key"], {
            "key": ident["key"],
            "name": ident.get("name") or "",
            "address": ident.get("address") or "",
            "supplierNumber": ident.get("supplierNumber") or "",
            "count": 0,
            "years": set(),
        })
        g["count"] += 1
        if item.get("year"):
            g["years"].add(int(item["year"]))

        # Wenn spätere Rechnung eine bessere Adresse/Nummer liefert, nachziehen.
        if not g["address"] and ident.get("address"):
            g["address"] = ident["address"]
        if not g["supplierNumber"] and ident.get("supplierNumber"):
            g["supplierNumber"] = ident["supplierNumber"]

    rows = []
    for g in grouped.values():
        g["years"] = sorted(g["years"], reverse=True)
        rows.append(g)

    rows.sort(key=lambda x: (-x["count"], x["name"].lower(), x["address"].lower()))
    return rows[:max(1, min(int(limit or 20), 50))]


def incoming_supplier_invoices(supplier_key, text_query=""):
    """
    Schritt 2: direkte Auswahl über den bereits erkannten Supplier-Key.
    Dadurch kein erneutes Parsen aller 6.475 PDFs beim Klick -> deutlich schneller.
    """
    supplier_key = str(supplier_key or "").strip()
    text_query = str(text_query or "").strip()

    if not supplier_key:
        return []

    query_tokens = [x for x in _norm_supplier(text_query).split() if x]
    result = []

    for item in _incoming_catalog():
        ident = item.get("_supplier")
        if not ident or ident.get("key") != supplier_key:
            continue

        raw = str(item.get("_raw_text") or "")
        raw_norm = _norm_supplier(raw)

        if query_tokens and not all(t in raw_norm for t in query_tokens):
            continue

        snippet = " ".join(raw.split())[:420]
        if query_tokens:
            low = raw.lower()
            positions = [low.find(t.lower()) for t in query_tokens if low.find(t.lower()) >= 0]
            if positions:
                pos = min(positions)
                compact = " ".join(raw.split())
                # Für Snippet robust nochmal im kompakten Text suchen.
                low_compact = compact.lower()
                pos2 = min(
                    [low_compact.find(t.lower()) for t in query_tokens if low_compact.find(t.lower()) >= 0]
                    or [0]
                )
                snippet = compact[max(0, pos2-140):min(len(compact), pos2+500)]

        result.append({
            "filename": item.get("filename"),
            "path": item.get("path"),
            "dokumenttyp": item.get("dokumenttyp") or "Eingangsrechnung",
            "modified": item.get("modified"),
            "logical_id": item.get("logical_id"),
            "invoiceDate": item.get("invoiceDate"),
            "printDate": item.get("invoiceDate"),
            "invoiceDateTime": item.get("invoiceDateTime"),
            "year": item.get("year"),
            "month": item.get("month"),
            "monthName": item.get("monthName"),
            "day": item.get("day"),
            "amount": item.get("amount"),
            "snippet": snippet,
        })

    result.sort(
        key=lambda x: (
            x.get("invoiceDateTime") or "",
            x.get("filename") or ""
        ),
        reverse=True
    )
    return result


def incoming_year_summary(documents):
    summary = {}
    for d in documents:
        year = str(d.get("year") or "ohne Jahr")
        row = summary.setdefault(year, {
            "count": 0,
            "amount": 0.0,
            "amountCount": 0,
        })
        row["count"] += 1
        if d.get("amount") is not None:
            row["amount"] += float(d["amount"])
            row["amountCount"] += 1

    for row in summary.values():
        row["amount"] = round(row["amount"], 2)
    return summary


def validate_pdf_path(raw_path):
    path = Path(str(raw_path or "").strip())
    if not str(path):
        raise ValueError("PDF-Pfad fehlt")
    if path.suffix.lower() != ".pdf":
        raise ValueError("Keine PDF-Datei")
    if not path.is_file():
        raise FileNotFoundError("Datei nicht gefunden")
    return path


def validate_indexed_pdf_path(raw_path):
    """
    Remote-Ausgabe nur für PDFs, die tatsächlich im KRISTINE-PDF-Index stehen.
    Dadurch kann ein Client nicht einfach irgendeinen anderen PDF-Pfad des PCs
    erraten und abrufen.
    """
    path = validate_pdf_path(raw_path)

    con = sqlite3.connect(DB)
    try:
        row = con.execute(
            "SELECT 1 FROM pdf_index WHERE path = ? LIMIT 1",
            (str(path),)
        ).fetchone()
    finally:
        con.close()

    if not row:
        raise PermissionError("PDF ist nicht im KRISTINE-Archivindex")
    return path



MOBILE_PAGE = r"""
<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111111">
<title>KRISTINE · The Brain</title>
<style>
:root{
  --bg:#0e0f11;--panel:#17191d;--panel2:#20232a;--text:#f5f7fa;
  --muted:#aab0bb;--line:#2c313a;--accent:#fff;--good:#9fe0b4;
  --warn:#ffd38a;--blue:#7bb7ff
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
body{min-height:100vh}
.wrap{max-width:820px;margin:0 auto;padding:calc(18px + env(safe-area-inset-top)) 16px calc(34px + env(safe-area-inset-bottom))}
.brand{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:18px}
.brand h1{margin:0;font-size:28px;letter-spacing:-.7px}
.brand small{color:var(--muted);font-weight:600}
.hero{background:linear-gradient(180deg,var(--panel),#131519);border:1px solid var(--line);border-radius:22px;padding:16px;box-shadow:0 14px 40px rgba(0,0,0,.22)}
.mode-switch{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.mode{background:#20232a;color:#dfe3e8;border:1px solid var(--line);min-height:40px;padding:8px 13px}
.mode.active{background:#fff;color:#111}
.searchrow{display:flex;gap:10px}
input[type=search],input[type=text],select{width:100%;border:1px solid var(--line);background:#0d0f12;color:var(--text);border-radius:14px;padding:13px 14px;font-size:16px;outline:none}
input:focus,select:focus{border-color:#5f6774}
button{border:0;border-radius:14px;padding:0 18px;background:var(--accent);color:#111;font-size:15px;font-weight:800;cursor:pointer}
button.dark{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
button.plus{background:#fff;color:#111}
.meta{margin-top:10px;color:var(--muted);font-size:13px;min-height:18px}
.loader{display:none;margin-top:12px;color:var(--muted)}
.error{color:#ffb3b3}
.section{margin-top:18px;scroll-margin-top:14px}
.section-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.section h2{font-size:14px;text-transform:uppercase;letter-spacing:.12em;color:#d7dbe1;margin:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:14px;margin-bottom:10px}
.project-card{cursor:pointer}
.project-card.selected{border-color:#8d98a8;box-shadow:0 0 0 2px rgba(255,255,255,.06)}
.project-title{font-size:18px;font-weight:800;line-height:1.2}
.project-no{display:inline-block;margin-top:5px;font-size:12px;font-weight:800;background:var(--panel2);padding:5px 8px;border-radius:999px;color:#dfe3e8}
.sub{color:var(--muted);margin-top:8px;font-size:14px;line-height:1.45}
.metrics,.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.pill,.chip{background:#111318;border:1px solid var(--line);border-radius:999px;padding:7px 10px;font-size:12px;color:#dfe3e8;text-decoration:none}
.chip{cursor:pointer}
.chip.active,.chip:hover{background:#f5f5f5;color:#111}
.addressbar{margin-top:14px}
.addressbar-title{font-size:12px;color:var(--muted);font-weight:750;margin-bottom:8px}
.summary{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}
.summary .chip strong{margin-left:4px}
.source-block{margin-top:14px;border-top:1px solid var(--line);padding-top:14px}
.type-list{display:flex;gap:8px;flex-wrap:wrap}
.doc-list{margin-top:12px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.doc{display:flex;flex-direction:column;gap:12px;align-items:stretch;margin-bottom:0;min-width:0}
.thumb{width:100%;height:auto;aspect-ratio:210/297;border-radius:12px;object-fit:contain;background:#fff;border:1px solid var(--line)}
.docname{font-weight:750;line-height:1.3;word-break:break-word}
.doctype{margin-top:4px;color:#c8cdd5;font-size:13px}
.docmeta{margin-top:6px;color:var(--muted);font-size:12px}
.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
a.action{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;background:#f5f5f5;color:#111;border-radius:12px;padding:9px 12px;font-size:13px;font-weight:800}
.empty{color:var(--muted);background:var(--panel);border:1px dashed var(--line);border-radius:16px;padding:18px}
.footer{margin-top:24px;text-align:center;color:#6f7681;font-size:12px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;align-items:flex-end;justify-content:center;z-index:50;padding:16px}
.modal.open{display:flex}
.modal-card{width:min(720px,100%);max-height:88vh;overflow:auto;background:#17191d;border:1px solid #343a44;border-radius:22px;padding:18px;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.modal-head{display:flex;justify-content:space-between;gap:14px;align-items:center}
.modal-head h3{margin:0;font-size:20px}
.close{background:#2a2e35;color:#fff;width:40px;height:40px;padding:0}
.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.formgrid .full{grid-column:1/-1}
.formlabel{font-size:11px;color:var(--muted);margin:0 0 5px 3px}
.save-row{margin-top:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.save-row button{height:48px}
.notice{font-size:12px;color:var(--warn)}
.success{color:var(--good)}

.supplier-card{margin-bottom:14px}
.supplier-choice{cursor:pointer}
.supplier-choice:hover{border-color:#788292}
.supplier-choice .project-title{font-size:17px}
.ww-address-card{cursor:pointer}
.ww-address-card:hover{border-color:#8994a5}
.ww-address-card.selected{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.10)}
.review-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
.review-card{background:#17191d;border:1px solid var(--line);border-radius:18px;padding:12px}
.review-thumb{width:100%;aspect-ratio:210/297;object-fit:contain;background:#fff;border-radius:11px}
.review-title{font-weight:850;margin-top:9px}
.review-match{color:var(--good);font-size:12px;margin-top:5px}
.review-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
@media(max-width:700px){.review-grid{grid-template-columns:1fr}}
.supplier-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.invoice-text-search{margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.year-block{margin-top:20px}
.year-header{display:flex;justify-content:space-between;align-items:end;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:9px;margin-bottom:12px}
.year-name{font-size:24px;font-weight:900}
.year-total{text-align:right}
.year-total strong{font-size:18px}
.year-total small{display:block;color:var(--muted);margin-top:2px}
.month-block{margin-top:17px}
.month-title{font-size:14px;text-transform:uppercase;letter-spacing:.1em;color:#cbd1d9;margin:0 0 9px}
.day-date{font-weight:850;font-size:14px;margin-bottom:4px}
.invoice-amount{font-size:15px;font-weight:850;margin-top:7px}
.invoice-snippet{font-size:12px;color:var(--muted);line-height:1.35;margin-top:7px;max-height:4.1em;overflow:hidden}

@media (max-width:900px){
  .doc-list{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:520px){
  .brand h1{font-size:25px}
  .mode-switch{display:grid;grid-template-columns:1fr}
  .mode{width:100%}
  .searchrow{display:grid;grid-template-columns:1fr}
  .searchrow button{height:50px}
  .formgrid{grid-template-columns:1fr}
  .formgrid .full{grid-column:auto}
  .doc-list{grid-template-columns:1fr}
  .doc{padding:12px}
  .thumb{width:100%;aspect-ratio:210/297}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <div><small>KRISTINE</small><h1>The Brain</h1></div>
    <small>Firmenwissen</small>
  </div>

  <div class="hero">
    <div class="mode-switch">
      <button id="modeProjects" class="mode active" type="button">🧠 Projekte / Firmenwissen</button>
      <button id="modeIncoming" class="mode" type="button">🧾 Eingangsrechnungen</button>
    </div>
    <div class="searchrow">
      <input id="q" type="search" placeholder="Baustelle, Kunde, Nummer, Adresse …" autocomplete="off">
      <button id="go">Suchen</button>
    </div>
    <div class="meta" id="meta">WinWorker + PDF-Archiv</div>
    <div class="loader" id="loader">Suche läuft …</div>

    <div class="addressbar" id="addressBar" hidden>
      <div class="addressbar-title">Adresse eingrenzen</div>
      <div class="chips" id="addresses"></div>
    </div>

    <div class="summary" id="summary" hidden></div>
  </div>

  <div class="section" id="projectsSection" hidden>
    <div class="section-head">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button id="backToProjects" class="dark" type="button" hidden>← Zurück</button>
        <h2 id="projectsTitle">Projekte / Aufträge</h2>
      </div>
      <button id="newFromSelection" class="plus" type="button">＋ Neue Baustelle</button>
    </div>
    <div id="projects"></div>
  </div>

  <div class="section" id="docsSection" hidden>
    <div class="section-head"><h2>Dokumente & Quellen</h2></div>
    <div id="sourceTypes"></div>
    <div id="docs"></div>
  </div>
  <div class="section" id="incomingSupplierSection" hidden>
    <div class="section-head"><h2>Adresse auswählen</h2></div>
    <div id="incomingSuppliers"></div>
  </div>

  <div class="section" id="incomingSection" hidden>
    <div class="section-head">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button id="backToSuppliers" class="dark" type="button">← Adresse wechseln</button>
        <h2>Eingangsrechnungen</h2>
      </div>
    </div>

    <div class="card supplier-card">
      <div class="project-title" id="incomingTitle">Lieferant</div>
      <div class="sub" id="incomingSupplierAddress"></div>
      <div class="sub" id="incomingSupplierNumber"></div>
      <div class="sub" id="incomingSub"></div>

      <div class="invoice-text-search">
        <div class="formlabel">Was suche ich in den Rechnungen?</div>
        <div class="searchrow">
          <input id="incomingTextQ" type="search"
                 placeholder="Artikel, Artikelnummer, Text …" autocomplete="off">
          <button id="incomingTextGo" type="button">In Rechnungen suchen</button>
        </div>
        <div class="meta" id="incomingTextMeta"></div>
      </div>
    </div>

    <div id="incomingGrouped"></div>

    <div class="section" id="incomingReviewSection" hidden>
      <div class="section-head"><h2>Noch nicht zugeordnet · einmal prüfen</h2></div>
      <div class="meta">Unsichere Rechnung einmal anklicken → danach dauerhaft mit dieser WW-Adresse verheiratet.</div>
      <div id="incomingReview"></div>
    </div>
  </div>

  <div class="footer">Privater Zugriff über Tailscale</div>
</div>

<div id="newJobModal" class="modal">
  <div class="modal-card">
    <div class="modal-head">
      <h3>＋ Neue Baustelle in KRISTINE</h3>
      <button id="closeModal" class="close" type="button">×</button>
    </div>
    <div class="formgrid">
      <div>
        <div class="formlabel">Baustellennummer</div>
        <input id="newJobId" type="text" placeholder="z. B. 26086">
      </div>
      <div>
        <div class="formlabel">Status</div>
        <select id="newJobStatus"><option>Auftrag</option><option>Angebot</option></select>
      </div>
      <div class="full">
        <div class="formlabel">Baustellenname</div>
        <input id="newJobName" type="text">
      </div>
      <div>
        <div class="formlabel">Straße</div>
        <input id="newJobStreet" type="text">
      </div>
      <div>
        <div class="formlabel">Hausnummer</div>
        <input id="newJobHouse" type="text">
      </div>
      <div>
        <div class="formlabel">PLZ</div>
        <input id="newJobPostal" type="text">
      </div>
      <div>
        <div class="formlabel">Ort</div>
        <input id="newJobCity" type="text">
      </div>
    </div>
    <div class="save-row">
      <button id="saveNewJob" type="button">Baustelle anlegen</button>
      <span id="newJobMsg" class="notice"></span>
    </div>
  </div>
</div>

<script>
const q=document.getElementById('q'),go=document.getElementById('go'),meta=document.getElementById('meta');
const loader=document.getElementById('loader'),projects=document.getElementById('projects'),docs=document.getElementById('docs');
const ps=document.getElementById('projectsSection'),ds=document.getElementById('docsSection');
const addressBar=document.getElementById('addressBar'),addresses=document.getElementById('addresses');
const summary=document.getElementById('summary'),sourceTypes=document.getElementById('sourceTypes');
const newFromSelection=document.getElementById('newFromSelection');
const modeProjects=document.getElementById('modeProjects'),modeIncoming=document.getElementById('modeIncoming');
const incomingSupplierSection=document.getElementById('incomingSupplierSection'),incomingSuppliers=document.getElementById('incomingSuppliers');
const incomingSection=document.getElementById('incomingSection'),incomingGrouped=document.getElementById('incomingGrouped');
const incomingTitle=document.getElementById('incomingTitle'),incomingSub=document.getElementById('incomingSub');
const incomingSupplierAddress=document.getElementById('incomingSupplierAddress'),incomingSupplierNumber=document.getElementById('incomingSupplierNumber');
const incomingTextQ=document.getElementById('incomingTextQ'),incomingTextGo=document.getElementById('incomingTextGo'),incomingTextMeta=document.getElementById('incomingTextMeta');
const backToSuppliers=document.getElementById('backToSuppliers');
const incomingReviewSection=document.getElementById('incomingReviewSection'),incomingReview=document.getElementById('incomingReview');
const backToProjects=document.getElementById('backToProjects'),projectsTitle=document.getElementById('projectsTitle');
const modal=document.getElementById('newJobModal'),closeModal=document.getElementById('closeModal');
const saveNewJob=document.getElementById('saveNewJob'),newJobMsg=document.getElementById('newJobMsg');

let baseQuery='',currentProjects=[],currentDocs=[],selectedProject=null,selectedAddress=null,currentDocType='',projectDetailMode=false,previousView=null,searchMode='projects',incomingAll=[],incomingCandidates=[],selectedSupplier=null,selectedWwAddress=null;

function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function money(v){if(v===null||v===undefined||v==='')return null;try{return new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(v))}catch{return v}}
function num(v){if(v===null||v===undefined||v==='')return null;return new Intl.NumberFormat('de-AT',{maximumFractionDigits:2}).format(Number(v))}
function urlFor(path,p){return path+'?path='+encodeURIComponent(p)}
function norm(v){return String(v||'').trim().toLowerCase().replace(/\s+/g,' ')}
function addressLabel(p){return [p.street,[p.postalCode,p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
function addressKey(p){return norm([p.street,p.postalCode,p.city].filter(Boolean).join('|'))}

function docSource(d){
  const s=norm([d.path,d.filename,d.dokumenttyp].filter(Boolean).join(' '));
  if(s.includes('moser'))return 'MOSER';
  if(/eingangs?rechnung|kreditor|kredi/.test(s))return 'Eingangsrechnungen';
  if(/archiv|altarchiv|scanarchiv/.test(s))return 'Archiv';
  return 'Dokumente';
}
function docType(d){return String(d.dokumenttyp||'Sonstige / nicht erkannt').trim()||'Sonstige / nicht erkannt'}

function groupCounts(list,fn){
  const m=new Map(); list.forEach(x=>{const k=fn(x);m.set(k,(m.get(k)||0)+1)}); return [...m.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'de'));
}

function renderAddressChoices(pp){
  const map=new Map();
  pp.forEach(p=>{
    const key=addressKey(p),label=addressLabel(p);
    if(!key||!label)return;
    if(!map.has(key))map.set(key,{key,label,p,count:0});
    map.get(key).count++;
  });
  const rows=[...map.values()].sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,'de'));
  addressBar.hidden=rows.length<2;
  addresses.innerHTML=rows.map(a=>`<button class="chip ${selectedAddress?.key===a.key?'active':''}" type="button" data-address="${esc(a.key)}">${esc(a.label)} <strong>${a.count}</strong></button>`).join('');
  addresses.querySelectorAll('[data-address]').forEach(btn=>btn.onclick=()=>{
    const row=rows.find(x=>x.key===btn.dataset.address);if(!row)return;
    selectedAddress=row;
    const p=row.p;
    const refined=[baseQuery,p.street,p.postalCode,p.city].filter(Boolean).join(' ');
    runSearch(refined,true);
  });
}

function renderSummary(pp,dd){
  const sourceCounts=groupCounts(dd,docSource);
  summary.hidden=false;
  summary.innerHTML=
    `<a class="chip" href="#projectsSection">Projekte <strong>${pp.length}</strong></a>`+
    `<a class="chip" href="#docsSection">Dokumente <strong>${dd.length}</strong></a>`+
    sourceCounts.filter(([s])=>s!=='Dokumente').map(([s,c])=>`<a class="chip" href="#docsSection" data-source="${esc(s)}">${esc(s)} <strong>${c}</strong></a>`).join('');
  summary.querySelectorAll('[data-source]').forEach(a=>a.onclick=e=>{e.preventDefault();renderDocumentTypes(a.dataset.source);ds.scrollIntoView({behavior:'smooth'})});
}

function renderProject(p,index){
  const title=p.title||p.site||p.projectDescription||p.customer||'Projekt';
  const customer=[p.company,p.customer].filter(Boolean).join(' · ');
  const addr=p.address||addressLabel(p);
  const h=num(p.hoursTotal),n=money(p.netInvoiced);
  let metrics='';if(h)metrics+=`<span class="pill">${esc(h)} h IST</span>`;if(n)metrics+=`<span class="pill">${esc(n)} netto</span>`;
  return `<div class="card project-card ${selectedProject===p?'selected':''}" data-project="${index}">
    <div class="project-title">${esc(title)}</div>
    ${p.projectNumber?`<span class="project-no">${esc(p.projectNumber)}</span>`:''}
    ${customer?`<div class="sub">${esc(customer)}</div>`:''}
    ${addr?`<div class="sub">${esc(addr)}</div>`:''}
    ${metrics?`<div class="metrics">${metrics}</div>`:''}
    <div class="actions"><button class="dark create-from-project" type="button" data-project="${index}">＋ Neue Baustelle daraus</button></div>
  </div>`;
}
function renderProjects(){
  projects.innerHTML=currentProjects.length?currentProjects.map(renderProject).join(''):'<div class="empty">Keine Projekte gefunden.</div>';
  projects.querySelectorAll('.project-card').forEach(card=>card.onclick=e=>{
    if(e.target.closest('.create-from-project'))return;
    const p=currentProjects[Number(card.dataset.project)]||null;
    if(p) openProjectDetail(p);
  });
  projects.querySelectorAll('.create-from-project').forEach(btn=>btn.onclick=()=>openNewJob(currentProjects[Number(btn.dataset.project)]||null));
}


async function openProjectDetail(p){
  if(!p)return;
  previousView={
    projects:[...currentProjects],
    docs:[...currentDocs],
    selectedAddress:selectedAddress,
    meta:meta.textContent,
    baseQuery:baseQuery
  };
  projectDetailMode=true;
  selectedProject=p;
  const no=String(p.projectNumber||'').trim();
  const term=no||[p.title,p.company,p.customer].filter(Boolean).join(' ');
  loader.style.display='block';
  addressBar.hidden=true;
  summary.hidden=true;
  projectsTitle.textContent=no?`Projekt ${no}`:'Projekt';
  backToProjects.hidden=false;
  try{
    const r=await fetch('/search?q='+encodeURIComponent(term),{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();if(!data.ok)throw new Error(data.error||'Fehler');

    // Genau den gewählten Auftrag anzeigen.
    const exact=(data.projects||[]).filter(x=>
      no && String(x.projectNumber||'').trim()===no
    );
    currentProjects=exact.length?exact:[p];

    // Dokumente aus der Projektnummer-Suche gehören zum gewählten Auftrag.
    currentDocs=data.documents||[];
    selectedProject=currentProjects[0]||p;
    currentDocType='';

    meta.textContent=`${no?'Projekt '+no+' · ':''}${currentDocs.length} Dokumente`;
    ps.hidden=false;ds.hidden=false;
    renderProjects();
    renderSummary(currentProjects,currentDocs);
    renderDocumentTypes();
    ps.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){
    meta.innerHTML='<span class="error">Projekt konnte nicht geöffnet werden: '+esc(e.message)+'</span>';
  }finally{
    loader.style.display='none';
  }
}

function restorePreviousView(){
  if(!previousView)return;
  currentProjects=previousView.projects||[];
  currentDocs=previousView.docs||[];
  selectedAddress=previousView.selectedAddress||null;
  baseQuery=previousView.baseQuery||baseQuery;
  selectedProject=currentProjects[0]||null;
  currentDocType='';
  projectDetailMode=false;
  meta.textContent=previousView.meta||`${currentProjects.length} Projekte · ${currentDocs.length} Dokumente`;
  previousView=null;
  backToProjects.hidden=true;
  projectsTitle.textContent='Projekte / Aufträge';
  renderAddressChoices(currentProjects);
  renderSummary(currentProjects,currentDocs);
  ps.hidden=false;ds.hidden=false;
  renderProjects();
  renderDocumentTypes();
  ps.scrollIntoView({behavior:'smooth',block:'start'});
}

backToProjects.onclick=restorePreviousView;

function renderDoc(d){
  const pd=d.printDate?d.printDate.split('-').reverse().join('.'):'';
  return `<div class="card doc">
    <img class="thumb" loading="lazy" src="${urlFor('/thumb',d.path)}" alt="">
    <div>
      <div class="docname">${esc(d.filename||'Dokument')}</div>
      <div class="doctype">${esc(docType(d))}</div>
      ${pd?`<div class="docmeta">${esc(pd)}</div>`:''}
      <div class="actions"><a class="action" href="${urlFor('/pdf',d.path)}" target="_blank" rel="noopener">PDF öffnen</a></div>
    </div>
  </div>`;
}

function renderDocumentTypes(sourceFilter=''){
  const sourceDocs=sourceFilter?currentDocs.filter(d=>docSource(d)===sourceFilter):currentDocs;
  const sourceTitle=sourceFilter?`<div class="sub" style="margin-bottom:8px">${esc(sourceFilter)} · ${sourceDocs.length} Treffer</div>`:'';
  const types=groupCounts(sourceDocs,docType);
  sourceTypes.innerHTML=sourceTitle+`<div class="type-list">`+
    types.map(([t,c])=>`<button class="chip ${currentDocType===t?'active':''}" type="button" data-type="${esc(t)}">${esc(t)} <strong>${c}</strong></button>`).join('')+
    `</div>`;
  docs.innerHTML='<div class="empty">Dokumenttyp anklicken.</div>';
  sourceTypes.querySelectorAll('[data-type]').forEach(btn=>btn.onclick=()=>{
    currentDocType=btn.dataset.type;
    const filtered=sourceDocs.filter(d=>docType(d)===currentDocType);
    renderDocumentTypes(sourceFilter);
    docs.innerHTML=filtered.length?filtered.map(renderDoc).join(''):'<div class="empty">Keine Dokumente.</div>';
  });
}


function setSearchMode(mode){
  searchMode=mode;
  modeProjects.classList.toggle('active',mode==='projects');
  modeIncoming.classList.toggle('active',mode==='incoming');

  ps.hidden=true;ds.hidden=true;
  incomingSupplierSection.hidden=true;incomingSection.hidden=true;
  addressBar.hidden=true;summary.hidden=true;
  projects.innerHTML='';docs.innerHTML='';sourceTypes.innerHTML='';
  incomingSuppliers.innerHTML='';incomingGrouped.innerHTML='';

  if(mode==='incoming'){
    q.placeholder='Lieferant oder Adresse in WinWorker suchen, z. B. Morscher …';
    meta.textContent='Schritt 1: echte WinWorker-Adresse auswählen';
  }else{
    q.placeholder='Baustelle, Kunde, Nummer, Adresse …';
    meta.textContent='WinWorker + PDF-Archiv';
  }
  q.focus();
}

modeProjects.onclick=()=>setSearchMode('projects');
modeIncoming.onclick=()=>setSearchMode('incoming');

function invoiceMoney(v){
  if(v===null||v===undefined||v==='')return '';
  try{return new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(v))}
  catch{return ''}
}

function renderSupplierCandidates(){
  incomingSupplierSection.hidden=false;
  incomingSuppliers.innerHTML=incomingCandidates.length
    ? incomingCandidates.map((s,i)=>`
      <div class="card ww-address-card" data-supplier="${i}">
        <div class="project-title">${esc(s.name||'Adresse')}</div>
        ${s.person&&s.person!==s.name?`<div class="sub">${esc(s.person)}</div>`:''}
        ${s.address?`<div class="sub">${esc(s.address)}</div>`:''}
        ${s.customerNumber?`<div class="sub">WW-Nr. ${esc(s.customerNumber)}</div>`:''}
        <div class="supplier-actions">
          <button type="button" data-supplier="${i}" class="choose-address">Diese Adresse auswählen</button>
        </div>
      </div>`).join('')
    : '<div class="empty">Keine passende WinWorker-Adresse gefunden.</div>';

  incomingSuppliers.querySelectorAll('.choose-address').forEach(btn=>{
    btn.onclick=e=>{
      e.stopPropagation();
      selectIncomingSupplier(incomingCandidates[Number(btn.dataset.supplier)]);
    };
  });
  incomingSuppliers.querySelectorAll('.ww-address-card').forEach(card=>{
    card.onclick=()=>selectIncomingSupplier(incomingCandidates[Number(card.dataset.supplier)]);
  });
}

async function runIncomingSupplierSearch(term){
  term=String(term||'').trim();
  if(term.length<2){
    meta.innerHTML='<span class="error">Bitte mindestens 2 Zeichen eingeben.</span>';
    q.focus();return;
  }

  loader.style.display='block';
  ps.hidden=true;ds.hidden=true;addressBar.hidden=true;summary.hidden=true;
  incomingSection.hidden=true;incomingSupplierSection.hidden=true;
  meta.textContent='Suche echte WinWorker-Adressen …';

  try{
    const r=await fetch('/incoming/address-search?q='+encodeURIComponent(term),{cache:'no-store'});
    const data=await r.json();
    if(!r.ok||!data.ok)throw new Error(data.error||'Fehler');

    incomingCandidates=data.addresses||[];
    renderSupplierCandidates();
    meta.textContent=incomingCandidates.length+
      ' WinWorker-Adresse(n) gefunden · bitte einmal die richtige auswählen';
  }catch(e){
    meta.innerHTML='<span class="error">Adresssuche fehlgeschlagen: '+esc(e.message)+'</span>';
  }finally{
    loader.style.display='none';
  }
}

async function selectIncomingSupplier(address){
  if(!address)return;
  selectedSupplier=address;
  selectedWwAddress=address;

  incomingSupplierSection.hidden=true;
  incomingSection.hidden=false;
  incomingTitle.textContent=address.name||'Lieferant';
  incomingSupplierAddress.textContent=address.address||'';
  incomingSupplierNumber.textContent=address.customerNumber
    ? 'WinWorker-Nr. '+address.customerNumber : '';
  incomingSub.textContent='Verknüpfte Rechnungen werden geladen …';
  incomingTextQ.value='';
  incomingTextMeta.textContent='';
  incomingGrouped.innerHTML='<div class="empty">Lieferantenakte wird geladen …</div>';

  await loadSupplierInvoices('');
  await loadUnassignedCandidates();
  incomingSection.scrollIntoView({behavior:'smooth',block:'start'});
}

async function loadUnassignedCandidates(){
  if(!selectedWwAddress)return;
  incomingReviewSection.hidden=false;
  incomingReview.innerHTML='<div class="empty">Suche noch nicht zugeordnete Rechnungen …</div>';
  try{
    const params=new URLSearchParams({
      addressId:selectedWwAddress.addressId||'',
      name:selectedWwAddress.name||'',
      person:selectedWwAddress.person||'',
      street:selectedWwAddress.street||'',
      postalCode:selectedWwAddress.postalCode||'',
      city:selectedWwAddress.city||'',
      customerNumber:selectedWwAddress.customerNumber||''
    });
    const r=await fetch('/incoming/unassigned?'+params.toString(),{cache:'no-store'});
    const d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'Fehler');
    renderUnassignedCandidates(d.documents||[]);
  }catch(e){
    incomingReview.innerHTML='<div class="empty error">'+esc(e.message)+'</div>';
  }
}

function renderUnassignedCandidates(rows){
  if(!rows.length){
    incomingReview.innerHTML='<div class="empty">Keine offenen Kandidaten.</div>';
    return;
  }
  incomingReview.innerHTML=`<div class="review-grid">`+rows.map((d,i)=>`
    <div class="review-card">
      <img class="review-thumb" loading="lazy" src="${urlFor('/thumb',d.path)}" alt="">
      <div class="review-title">${esc(d.filename||'Eingangsrechnung')}</div>
      ${d.invoiceDate?`<div class="sub">${esc(d.invoiceDate.split('-').reverse().join('.'))}</div>`:''}
      ${d.amount!==null&&d.amount!==undefined?`<div class="invoice-amount">${esc(invoiceMoney(d.amount))}${Number(d.amountConfidence||0)>=80?' <span class="pill">Summe geprüft</span>':''}</div>`:''}
      ${d.detectedSupplierName?`<div class="sub">erkannt: ${esc(d.detectedSupplierName)}</div>`:''}
      ${d.fingerprint?.customerNumberExternal?`<div class="sub">KundenNr. ${esc(d.fingerprint.customerNumberExternal)}</div>`:''}
      ${d.fingerprint?.uid?`<div class="sub">UID ${esc(d.fingerprint.uid)}</div>`:''}
      ${Number(d.matchScore||0)>0?`<div class="review-match">möglicher Treffer · ${Number(d.matchScore)} Punkte</div>`:''}
      <div class="review-actions">
        <a class="action" href="${urlFor('/pdf',d.path)}" target="_blank" rel="noopener">PDF prüfen</a>
        <button type="button" data-link="${i}">✓ Gehört dazu</button>
        <button type="button" class="dark" data-reject="${i}">✕ Gehört nicht dazu</button>
      </div>
    </div>`).join('')+`</div>`;

  incomingReview.querySelectorAll('[data-link]').forEach(btn=>{
    btn.onclick=()=>marryInvoice(rows[Number(btn.dataset.link)],btn);
  });
  incomingReview.querySelectorAll('[data-reject]').forEach(btn=>{
    btn.onclick=()=>rejectInvoice(rows[Number(btn.dataset.reject)],btn);
  });
}

async function marryInvoice(doc,button){
  if(!doc||!selectedWwAddress)return;
  if(button){button.disabled=true;button.textContent='✓ gespeichert';}
  try{
    const r=await fetch('/incoming/address-link',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        addressId:selectedWwAddress.addressId,
        invoiceId:doc.invoiceId||'',
        supplierKey:doc.detectedSupplierKey||''
      })
    });
    const d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'Speichern fehlgeschlagen');
    incomingTextMeta.textContent=d.autoLinked
      ? `✓ gelernt · ${Number(d.autoLinked)} weitere eindeutige Rechnung(en) automatisch zugeordnet`
      : '✓ dauerhaft zugeordnet und gelernt';
    await loadSupplierInvoices('');
    await loadUnassignedCandidates();
  }catch(e){
    if(button){button.disabled=false;button.textContent='✓ Gehört dazu';}
    incomingTextMeta.innerHTML='<span class="error">'+esc(e.message)+'</span>';
  }
}

async function rejectInvoice(doc,button){
  if(!doc||!selectedWwAddress)return;
  if(button){button.disabled=true;button.textContent='✕ ausgeschlossen';}
  try{
    const r=await fetch('/incoming/address-reject',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        addressId:selectedWwAddress.addressId,
        invoiceId:doc.invoiceId||''
      })
    });
    const d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'Speichern fehlgeschlagen');
    incomingTextMeta.textContent='✕ dauerhaft für diese Adresse ausgeschlossen';
    await loadUnassignedCandidates();
  }catch(e){
    if(button){button.disabled=false;button.textContent='✕ Gehört nicht dazu';}
    incomingTextMeta.innerHTML='<span class="error">'+esc(e.message)+'</span>';
  }
}

async function loadSupplierInvoices(textQuery=''){
  if(!selectedWwAddress)return;

  loader.style.display='block';
  incomingTextMeta.textContent=textQuery
    ? 'Suche innerhalb der zugeordneten Rechnungen …'
    : 'Lade Lieferantenakte …';

  try{
    const params=new URLSearchParams({
      addressId:selectedWwAddress.addressId||'',
      q:textQuery||''
    });
    const r=await fetch('/incoming/address-invoices?'+params.toString(),{cache:'no-store'});
    const data=await r.json();
    if(!r.ok||!data.ok)throw new Error(data.error||'Fehler');

    incomingAll=data.documents||[];
    incomingSub.textContent=incomingAll.length+' dauerhaft zugeordnete Eingangsrechnungen'+
      (textQuery?' · Textfilter: "'+textQuery+'"':'');
    incomingTextMeta.textContent=textQuery
      ? incomingAll.length+' Treffer innerhalb dieses Lieferanten'
      : 'Diese Akte wächst mit jeder bestätigten Zuordnung';

    renderIncomingGrouped(incomingAll,data.years||{});
  }catch(e){
    incomingTextMeta.innerHTML='<span class="error">'+esc(e.message)+'</span>';
  }finally{
    loader.style.display='none';
  }
}

function monthLabel(month, fallback){
  const names=['','Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  return names[Number(month)||0]||fallback||'Ohne Monat';
}

function renderIncomingDoc(d){
  const date=d.invoiceDate
    ? d.invoiceDate.split('-').reverse().join('.')
    : '';
  return `<div class="card doc">
    <img class="thumb" loading="lazy" src="${urlFor('/thumb',d.path)}" alt="">
    <div>
      ${date?`<div class="day-date">${esc(date)}</div>`:''}
      <div class="docname">${esc(d.filename||'Eingangsrechnung')}</div>
      ${d.amount!==null&&d.amount!==undefined
        ? `<div class="invoice-amount">${esc(invoiceMoney(d.amount))}</div>`:''}
      ${d.snippet?`<div class="invoice-snippet">${esc(d.snippet)}</div>`:''}
      <div class="actions">
        <a class="action" href="${urlFor('/pdf',d.path)}" target="_blank" rel="noopener">PDF öffnen</a>
      </div>
    </div>
  </div>`;
}

function renderIncomingGrouped(rows, yearSummary){
  if(!rows.length){
    incomingGrouped.innerHTML='<div class="empty">Keine Rechnungen für diese Auswahl gefunden.</div>';
    return;
  }

  const years=new Map();
  rows.forEach(d=>{
    const y=String(d.year||'ohne Jahr');
    if(!years.has(y))years.set(y,new Map());
    const m=String(d.month||0);
    if(!years.get(y).has(m))years.get(y).set(m,[]);
    years.get(y).get(m).push(d);
  });

  const yearKeys=[...years.keys()].sort((a,b)=>{
    if(a==='ohne Jahr')return 1;if(b==='ohne Jahr')return -1;
    return Number(b)-Number(a);
  });

  incomingGrouped.innerHTML=yearKeys.map(y=>{
    const ys=yearSummary?.[y]||{};
    const totalKnown=Number(ys.amountCount||0);
    const totalCount=Number(ys.count||0);
    const yearAmount=Number(ys.amount||0);

    const months=years.get(y);
    const monthKeys=[...months.keys()].sort((a,b)=>Number(b)-Number(a));

    const monthHtml=monthKeys.map(m=>{
      const docsForMonth=months.get(m);
      const title=monthLabel(m,docsForMonth[0]?.monthName);
      return `<div class="month-block">
        <div class="month-title">${esc(title)} · ${docsForMonth.length}</div>
        <div class="doc-list">${docsForMonth.map(renderIncomingDoc).join('')}</div>
      </div>`;
    }).join('');

    return `<div class="year-block">
      <div class="year-header">
        <div class="year-name">${esc(y)}</div>
        <div class="year-total">
          <strong>${totalKnown?esc(invoiceMoney(yearAmount)):'–'}</strong>
          <small>Jahressumme${totalKnown<totalCount?' · '+totalKnown+'/'+totalCount+' Beträge erkannt':''}</small>
        </div>
      </div>
      ${monthHtml}
    </div>`;
  }).join('');
}

async function loadSupplierInvoices(textQuery=''){
  if(!selectedSupplier)return;

  loader.style.display='block';
  incomingTextMeta.textContent=textQuery
    ? 'Suche innerhalb der Rechnungen …'
    : 'Lade Lieferantenakte …';

  try{
    const params=new URLSearchParams({
      key:selectedSupplier.key||'',
      q:textQuery||''
    });

    const r=await fetch('/incoming/invoices?'+params.toString(),{cache:'no-store'});
    const data=await r.json();
    if(!r.ok||!data.ok)throw new Error(data.error||'Fehler');

    incomingAll=data.documents||[];
    incomingSub.textContent=incomingAll.length+' Eingangsrechnungen'+
      (textQuery?' · Textfilter: "'+textQuery+'"':'');
    incomingTextMeta.textContent=textQuery
      ? incomingAll.length+' Treffer innerhalb dieses Lieferanten'
      : 'Eigene Textsuche nur innerhalb der Rechnungen dieses Lieferanten';

    renderIncomingGrouped(incomingAll,data.years||{});
  }catch(e){
    incomingTextMeta.innerHTML='<span class="error">'+esc(e.message)+'</span>';
  }finally{
    loader.style.display='none';
  }
}

incomingTextGo.onclick=()=>loadSupplierInvoices(incomingTextQ.value.trim());
incomingTextQ.addEventListener('keydown',e=>{
  if(e.key==='Enter')loadSupplierInvoices(incomingTextQ.value.trim());
});

backToSuppliers.onclick=()=>{
  selectedSupplier=null;selectedWwAddress=null;
  incomingSection.hidden=true;incomingReviewSection.hidden=true;
  incomingSupplierSection.hidden=false;
  meta.textContent=incomingCandidates.length+' WinWorker-Adresse(n) · bitte auswählen';
  incomingSupplierSection.scrollIntoView({behavior:'smooth',block:'start'});
};


async function runSearch(term,isRefined=false){
  term=String(term||'').trim();if(!term){q.focus();return}
  if(!isRefined){
    baseQuery=term;selectedAddress=null;
    projectDetailMode=false;previousView=null;
    backToProjects.hidden=true;
    projectsTitle.textContent='Projekte / Aufträge';
  }
  loader.style.display='block';meta.textContent='Suche läuft …';
  ps.hidden=true;ds.hidden=true;addressBar.hidden=true;summary.hidden=true;
  projects.innerHTML='';docs.innerHTML='';sourceTypes.innerHTML='';
  try{
    const r=await fetch('/search?q='+encodeURIComponent(term),{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();if(!data.ok)throw new Error(data.error||'Fehler');
    currentProjects=data.projects||[];currentDocs=data.documents||[];selectedProject=currentProjects[0]||null;currentDocType='';
    meta.textContent=`${currentProjects.length} Projekte · ${currentDocs.length} Dokumente${selectedAddress?' · '+selectedAddress.label:''}`;
    renderAddressChoices(currentProjects);renderSummary(currentProjects,currentDocs);
    ps.hidden=false;ds.hidden=false;renderProjects();renderDocumentTypes();
  }catch(e){meta.innerHTML='<span class="error">Suche fehlgeschlagen: '+esc(e.message)+'</span>'}
  finally{loader.style.display='none'}
}

function splitStreet(raw){
  const s=String(raw||'').trim();const m=s.match(/^(.*?)(?:\s+)(\d+[A-Za-z]?[-\/]?\d*[A-Za-z]?)$/);
  return m?{street:m[1],house:m[2]}:{street:s,house:''};
}
async function openNewJob(project){
  const p=project||selectedProject||(selectedAddress&&selectedAddress.p)||currentProjects[0]||{};
  const sh=splitStreet(p.street||'');
  document.getElementById('newJobName').value=p.title||p.site||p.projectDescription||p.company||p.customer||'';
  document.getElementById('newJobStreet').value=sh.street;
  document.getElementById('newJobHouse').value=sh.house;
  document.getElementById('newJobPostal').value=p.postalCode||'';
  document.getElementById('newJobCity').value=p.city||'';
  document.getElementById('newJobStatus').value='Auftrag';
  document.getElementById('newJobId').value='';
  newJobMsg.textContent='Lade nächste Baustellennummer …';newJobMsg.className='notice';
  modal.classList.add('open');
  try{
    const r=await fetch('/kristine-job-next',{cache:'no-store'}),d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'Nummer konnte nicht geladen werden');
    document.getElementById('newJobId').value=d.nextNumber||'';
    newJobMsg.textContent='';
  }catch(e){newJobMsg.textContent=e.message}
}
newFromSelection.onclick=()=>openNewJob();
closeModal.onclick=()=>modal.classList.remove('open');
modal.onclick=e=>{if(e.target===modal)modal.classList.remove('open')};

saveNewJob.onclick=async()=>{
  const body={
    jobId:document.getElementById('newJobId').value.trim(),
    name:document.getElementById('newJobName').value.trim(),
    status:document.getElementById('newJobStatus').value,
    street:document.getElementById('newJobStreet').value.trim(),
    houseNumber:document.getElementById('newJobHouse').value.trim(),
    postalCode:document.getElementById('newJobPostal').value.trim(),
    city:document.getElementById('newJobCity').value.trim()
  };
  if(!body.name){newJobMsg.textContent='Baustellenname fehlt.';return}
  saveNewJob.disabled=true;newJobMsg.textContent='KRISTINE legt die Baustelle an …';newJobMsg.className='notice';
  try{
    const r=await fetch('/kristine-job-create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Anlegen fehlgeschlagen');
    newJobMsg.textContent=`✓ Baustelle ${d.jobId} angelegt`;newJobMsg.className='success';
    setTimeout(()=>modal.classList.remove('open'),1100);
  }catch(e){newJobMsg.textContent=e.message;newJobMsg.className='notice'}
  finally{saveNewJob.disabled=false}
};

go.onclick=()=>searchMode==='incoming'?runIncomingSupplierSearch(q.value):runSearch(q.value,false);
q.addEventListener('keydown',e=>{if(e.key==='Enter'){searchMode==='incoming'?runIncomingSupplierSearch(q.value):runSearch(q.value,false)}});
q.focus();
</script>
</body>
</html>
"""


@app.get("/")
def mobile_home():
    return render_template_string(MOBILE_PAGE)


@app.route("/mobile", methods=["GET"], strict_slashes=False)
def mobile_home_alias():
    return render_template_string(MOBILE_PAGE)


@app.get("/status")
def status():
    return jsonify({
        "ok": True,
        "connector": "kristine-archive",
        "version": "0.11.6",
        "pdfIndex": str(DB),
        "pdfIndexExists": DB.exists(),
        "jobCreateReady": bool(KRISTINE_ADMIN_TOKEN),
        "sqlServer": SQL_SERVER,
        "sqlDatabase": SQL_DATABASE,
        "sqlUser": SQL_USER,
        "sqlPasswordConfigured": bool(os.environ.get("KRISTINE_SQL_PASSWORD", "").strip()),
    })



@app.get("/project-metrics/<int:project_index>")
def project_metrics_debug(project_index):
    try:
        return jsonify({
            "ok": True,
            "projectIndex": project_index,
            "metrics": project_metrics([project_index]).get(project_index, {})
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/project-invoices/<int:project_index>")
def project_invoices_debug(project_index):
    try:
        con = sql_connection("WinWorker_Projekte_Standard")
        cur = con.cursor()
        rows = cur.execute("""
            SELECT
                b.sBuchNummer,
                b.Buchart,
                b.gID,
                b.dzDocDatum,
                b.Geändert,
                r.cUmsatzNetto,
                r.dzRechnungsdatum
            FROM dbo.[Bücher] AS b
            LEFT JOIN dbo.Rechnung AS r
                ON r.gBuchID = b.gID
            WHERE b.ProjektIndex = ?
              AND ISNULL(b.Storno, 0) = 0
              AND r.cUmsatzNetto IS NOT NULL
            ORDER BY
                b.sBuchNummer,
                COALESCE(b.Geändert, b.dzInhaltGeaendert, b.dzDocDatum, b.Aufgenommen) DESC,
                b.gID DESC
        """, project_index).fetchall()
        con.close()

        items = []
        for row in rows:
            items.append({
                "sBuchNummer": row.sBuchNummer,
                "Buchart": row.Buchart,
                "gID": str(row.gID) if row.gID is not None else None,
                "dzDocDatum": clean_date(row.dzDocDatum),
                "Geaendert": clean_date(row.Geändert),
                "cUmsatzNetto": float(row.cUmsatzNetto) if row.cUmsatzNetto is not None else None,
                "dzRechnungsdatum": clean_date(row.dzRechnungsdatum),
            })
        return jsonify({"ok": True, "projectIndex": project_index, "rows": items})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500




@app.route("/schema-index/rebuild", methods=["GET", "POST"])
def schema_index_rebuild():
    try:
        data = build_winworker_schema_index()
        return jsonify({
            "ok": True,
            "generatedAt": data.get("generatedAt"),
            "databaseCount": data.get("databaseCount"),
            "indexedDatabases": len(data.get("databases", [])),
            "errors": data.get("errors", []),
            "file": str(SCHEMA_INDEX_FILE),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/schema-index/status")
def schema_index_status():
    data = load_winworker_schema_index()
    if not data:
        return jsonify({"ok": True, "exists": False, "file": str(SCHEMA_INDEX_FILE)})

    return jsonify({
        "ok": True,
        "exists": True,
        "generatedAt": data.get("generatedAt"),
        "databaseCount": data.get("databaseCount"),
        "indexedDatabases": len(data.get("databases", [])),
        "errors": data.get("errors", []),
        "file": str(SCHEMA_INDEX_FILE),
    })


@app.get("/schema-index/search")
def schema_index_search():
    q = str(request.args.get("q") or "").strip()
    limit = request.args.get("limit", 100)
    try:
        return jsonify(search_winworker_schema_index(q, limit))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/schema-index/table")
def schema_index_table():
    db_name = str(request.args.get("db") or "").strip().lower()
    table_name = str(request.args.get("table") or "").strip().lower()
    data = load_winworker_schema_index()
    if not data:
        return jsonify({"ok": False, "error": "SQL-Strukturindex fehlt."}), 404

    matches = []
    for db in data.get("databases", []):
        if db_name and str(db.get("name") or "").lower() != db_name:
            continue
        for obj in db.get("objects", []):
            if table_name and str(obj.get("name") or "").lower() != table_name:
                continue
            obj_name = str(obj.get("name") or "")
            matches.append({
                "database": db.get("name"),
                **obj,
                "foreignKeys": [
                    fk for fk in db.get("foreignKeys", [])
                    if f".{obj_name}." in str(fk.get("from"))
                    or f".{obj_name}." in str(fk.get("to"))
                ],
                "indexes": [
                    idx for idx in db.get("indexes", [])
                    if str(idx.get("table") or "").lower() == obj_name.lower()
                ],
            })

    return jsonify({
        "ok": True,
        "matches": matches,
        "generatedAt": data.get("generatedAt"),
    })



@app.post("/hours-fusion-source")
def hours_fusion_source():
    try:
        data = request.get_json(silent=True) or {}
        project_indices = data.get("projectIndices") or []
        rows = ww_hours_fusion_source(project_indices)
        return jsonify({
            "ok": True,
            "rows": rows,
            "count": len(rows),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/schema-hints")
def schema_hints():
    try:
        rows = discover_metric_columns()
        return jsonify({
            "ok": True,
            "count": len(rows),
            "columns": rows,
            "note": "Diagnose-Endpunkt. V0.8 verwendet bereits Stundenmitschreibung und pro Rechnungsnummer nur die neueste Version."
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500



@app.get("/ww-hours-schema")
def ww_hours_schema():
    try:
        con = sql_connection("WinWorker_Mitschreibung_Standard")
        cur = con.cursor()
        rows = cur.execute("""
            SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'dbo'
              AND TABLE_NAME = 'Stundenmitschreibung'
            ORDER BY ORDINAL_POSITION
        """).fetchall()
        con.close()
        return jsonify({
            "ok": True,
            "table": "WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung",
            "columns": [
                {"name": row.COLUMN_NAME, "dataType": row.DATA_TYPE, "position": row.ORDINAL_POSITION}
                for row in rows
            ],
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/ww-hours-sample/<int:project_index>")
def ww_hours_sample(project_index):
    try:
        con = sql_connection("WinWorker_Mitschreibung_Standard")
        cur = con.cursor()
        cur.execute("""
            SELECT TOP 5 *
            FROM WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung
            WHERE ProjektIndex = ?
        """, project_index)
        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchall()
        con.close()

        def safe(value):
            if value is None or isinstance(value, (str, int, float, bool)):
                return value
            return str(value)

        return jsonify({
            "ok": True,
            "projectIndex": project_index,
            "columns": columns,
            "rows": [{columns[i]: safe(row[i]) for i in range(len(columns))} for row in rows],
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/search")
def search():
    q = str(request.args.get("q", "")).strip()
    if not q:
        return jsonify({
            "ok": True,
            "query": "",
            "terms": [],
            "projects": [],
            "documents": [],
            "sqlError": None,
        })

    terms = [x.strip() for x in q.split() if x.strip()]

    try:
        documents = search_pdf(terms)
    except Exception as e:
        return jsonify({"ok": False, "error": f"PDF-Index: {e}"}), 500

    projects = []
    sql_error = None
    try:
        projects = search_projects(terms)
    except Exception as e:
        sql_error = str(e)
        print("SQL-Fehler:", e)

    return jsonify({
        "ok": True,
        "query": q,
        "terms": terms,
        "projects": projects,
        "documents": documents,
        "sqlError": sql_error,
    })



@app.get("/kristine-job-next")
def kristine_job_next():
    try:
        data = kristine_api_request("/admin/api/jobs/next-number")
        return jsonify({
            "ok": True,
            "nextNumber": str(data.get("nextNumber") or "")
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.post("/kristine-job-create")
def kristine_job_create():
    try:
        body = request.get_json(silent=True) or {}
        allowed = {
            "jobId": str(body.get("jobId") or "").strip(),
            "name": str(body.get("name") or "").strip(),
            "status": str(body.get("status") or "Auftrag").strip(),
            "street": str(body.get("street") or "").strip(),
            "houseNumber": str(body.get("houseNumber") or "").strip(),
            "postalCode": str(body.get("postalCode") or "").strip(),
            "city": str(body.get("city") or "").strip(),
        }
        if not allowed["name"]:
            return jsonify({"ok": False, "error": "Baustellenname fehlt"}), 400
        data = kristine_api_request("/admin/api/jobs", method="POST", payload=allowed)
        return jsonify({
            "ok": True,
            "jobId": str(data.get("jobId") or allowed["jobId"]),
            "name": str(data.get("name") or allowed["name"])
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502



@app.get("/incoming/address-search")
def incoming_address_search():
    q = str(request.args.get("q", "")).strip()
    if len(q) < 2:
        return jsonify({"ok": False, "error": "Bitte mindestens 2 Zeichen eingeben."}), 400
    try:
        rows = ww_address_search(q)
        return jsonify({"ok": True, "query": q, "addresses": rows, "count": len(rows)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/incoming/address-invoices")
def incoming_address_invoices():
    address_id = str(request.args.get("addressId", "")).strip()
    text_query = str(request.args.get("q", "")).strip()
    if not address_id:
        return jsonify({"ok": False, "error": "WW-Adresse fehlt."}), 400
    try:
        docs = incoming_for_address(address_id, text_query)
        return jsonify({
            "ok": True,
            "addressId": address_id,
            "documents": docs,
            "count": len(docs),
            "years": incoming_year_summary(docs),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/incoming/unassigned")
def incoming_unassigned():
    try:
        address = {
            "addressId": str(request.args.get("addressId", "")).strip(),
            "name": str(request.args.get("name", "")).strip(),
            "person": str(request.args.get("person", "")).strip(),
            "street": str(request.args.get("street", "")).strip(),
            "postalCode": str(request.args.get("postalCode", "")).strip(),
            "city": str(request.args.get("city", "")).strip(),
            "customerNumber": str(request.args.get("customerNumber", "")).strip(),
        }
        if not address["addressId"]:
            return jsonify({"ok": False, "error": "WW-Adresse fehlt."}), 400
        docs = unassigned_invoice_candidates(address)
        return jsonify({"ok": True, "documents": docs, "count": len(docs)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/incoming/address-link")
def incoming_address_link():
    try:
        body = request.get_json(silent=True) or {}
        address_id = str(body.get("addressId") or "").strip()
        invoice_id = str(body.get("invoiceId") or "").strip()
        supplier_key = str(body.get("supplierKey") or "").strip()
        _, learned, auto_linked = link_invoice_or_supplier_to_address(address_id, invoice_id, supplier_key)
        return jsonify({
            "ok": True,
            "addressId": address_id,
            "invoiceId": invoice_id,
            "supplierKey": supplier_key,
            "learned": {
                "customerNumberExternal": learned.get("customerNumberExternal") or "",
                "uid": learned.get("uid") or "",
                "iban": learned.get("iban") or "",
                "invoiceNumber": learned.get("invoiceNumber") or "",
                "amount": learned.get("amountSmart"),
                "amountConfidence": learned.get("amountConfidence", 0),
                "amountReason": learned.get("amountReason") or "",
            },
            "autoLinked": auto_linked,
        })
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/incoming/address-reject")
def incoming_address_reject():
    try:
        body = request.get_json(silent=True) or {}
        address_id = str(body.get("addressId") or "").strip()
        invoice_id = str(body.get("invoiceId") or "").strip()
        reject_invoice_for_address(address_id, invoice_id)
        return jsonify({"ok": True, "addressId": address_id, "invoiceId": invoice_id})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/incoming/suppliers")
def incoming_suppliers():
    q = str(request.args.get("q", "")).strip()
    if len(q) < 2:
        return jsonify({
            "ok": False,
            "error": "Bitte mindestens 2 Zeichen vom Lieferanten oder der Adresse eingeben."
        }), 400
    try:
        suppliers = incoming_supplier_candidates(q)
        return jsonify({
            "ok": True,
            "query": q,
            "suppliers": suppliers,
            "count": len(suppliers),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/incoming/invoices")
def incoming_invoices():
    supplier_key = str(request.args.get("key", "")).strip()
    text_query = str(request.args.get("q", "")).strip()

    if not supplier_key:
        return jsonify({"ok": False, "error": "WW-Adresse ist ausgewählt."}), 400

    try:
        documents = incoming_supplier_invoices(supplier_key, text_query)
        return jsonify({
            "ok": True,
            "supplierKey": supplier_key,
            "textQuery": text_query,
            "documents": documents,
            "count": len(documents),
            "years": incoming_year_summary(documents),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/open")
def open_pdf():
    try:
        data = request.get_json(silent=True) or {}
        path = validate_pdf_path(data.get("path"))
        os.startfile(str(path))
        return jsonify({"ok": True, "path": str(path)})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except FileNotFoundError as e:
        return jsonify({"ok": False, "error": str(e)}), 404
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/thumb")
def thumbnail():
    try:
        path = validate_indexed_pdf_path(request.args.get("path"))
        with pymupdf.open(path) as doc:
            if len(doc) < 1:
                raise ValueError("PDF hat keine Seiten")
            page = doc[0]
            pix = page.get_pixmap(matrix=pymupdf.Matrix(0.72, 0.72), alpha=False)
            png = pix.tobytes("png")

        return send_file(BytesIO(png), mimetype="image/png", max_age=300)
    except (ValueError, FileNotFoundError, PermissionError):
        return ("", 404)
    except Exception as e:
        print("Thumbnail-Fehler:", e)
        return ("", 500)


@app.get("/pdf")
def pdf_inline():
    """
    Liefert ein im KRISTINE-Index vorhandenes PDF direkt an Handy/Browser.
    /open bleibt lokal und öffnet weiterhin nur am Windows-PC.
    """
    try:
        path = validate_indexed_pdf_path(request.args.get("path"))
        return send_file(
            path,
            mimetype="application/pdf",
            as_attachment=False,
            download_name=path.name,
            conditional=True,
            max_age=0,
        )
    except (ValueError, FileNotFoundError, PermissionError):
        return jsonify({"ok": False, "error": "PDF nicht gefunden"}), 404
    except Exception as e:
        print("PDF-Ausgabe-Fehler:", e)
        return jsonify({"ok": False, "error": "PDF konnte nicht geöffnet werden"}), 500


if __name__ == "__main__":
    print()
    print("KRISTINE ARCHIV CONNECTOR")
    print("-------------------------")
    print("Status : http://127.0.0.1:5051/status")
    print("Suche  : http://127.0.0.1:5051/search?q=6844%20Fusonic")
    print("Schema : http://127.0.0.1:5051/schema-hints")
    print("Version: 0.11.6 - Ja/Nein Lernmaschine + Vollscan nach Fingerprint")
    print(f"Handy  : http://{TAILSCALE_IP}:5051/status")
    print("Schema-Index rebuild: http://127.0.0.1:5051/schema-index/rebuild")
    print("Schema-Index status : http://127.0.0.1:5051/schema-index/status")
    print("Schema-Index search : http://127.0.0.1:5051/schema-index/search?q=personalnummer")
    print("Schema-Index table  : http://127.0.0.1:5051/schema-index/table?db=WinWorker_Mitschreibung_Standard&table=Stundenmitschreibung")
    print("Hours fusion        : POST http://127.0.0.1:5051/hours-fusion-source")
    print()

    if not TAILSCALE_IP:
        raise RuntimeError("KRISTINE_TAILSCALE_IP fehlt")

    # Zwei gezielte Listener:
    # 1) localhost für bestehende interne KRISTINE-Aufrufe
    # 2) nur die private Tailscale-IP für das Handy
    # Niemals 0.0.0.0 verwenden.
    serve(
        app,
        listen=f"127.0.0.1:5051 {TAILSCALE_IP}:5051",
        threads=16,
        expose_tracebacks=False,
        clear_untrusted_proxy_headers=True,
        ident="KRISTINE",
    )