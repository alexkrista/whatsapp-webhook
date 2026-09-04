from flask import Flask, request, jsonify, send_file, render_template_string
import sqlite3
from pathlib import Path
from io import BytesIO
from datetime import datetime, timedelta
import os
import re
import json
import hmac
import hashlib
import urllib.request
import urllib.error
import urllib.parse
import shutil
import threading
import math
import difflib

import pymupdf
import pyodbc
from waitress import serve

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("KRISTINE_INCOMING_MAX_MB", "40")) * 1024 * 1024

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
MOBILE_ALLOWED_PATHS = {"/", "/mobile", "/mobile/", "/incoming-capture", "/status", "/search", "/project/address-search", "/project/address-projects", "/project/documents", "/thumb", "/pdf", "/pdf-info", "/pdf-page", "/contacts", "/material-search", "/kristine-job-next", "/kristine-job-create", "/search-incoming", "/incoming/suppliers", "/incoming/invoices", "/incoming/address-search", "/incoming/address-invoices", "/incoming/address-link", "/incoming/address-reject", "/incoming/unassigned", "/incoming/watch-ack"}


def _request_is_local():
    return (request.remote_addr or "") in {"127.0.0.1", "::1"}


@app.before_request
def protect_remote_archive_access():
    # Bestehende lokale KRISTINE-Aufrufe auf 127.0.0.1 bleiben unverändert.
    if _request_is_local():
        return None

    # KRISTINE ACCESS CONTROL V3 AUTH
    # Physisch nur am Tailscale-Listener; zusätzlich KRISTINE Admin-Token.
    if request.path.startswith("/access-control/") or request.path == "/tower/live-summary":
        if request.method == "OPTIONS":
            return None
        supplied = str(request.headers.get("X-Krista-Token") or "")
        if KRISTINE_ADMIN_TOKEN and hmac.compare_digest(supplied, KRISTINE_ADMIN_TOKEN):
            return None
        return jsonify({"ok": False, "error": "Zutritt nicht freigegeben"}), 403

    # KRISTINE darf die freigegebene WW-Suche im Browser direkt verwenden.
    # Der Schlüssel wird von der bestehenden KRISTINE-Navigation bereits als
    # krista_token an den Brain-Rechner weitergegeben.
    supplied_query_token = str(request.args.get("krista_token") or "")
    if (
        request.path in {"/project/address-search", "/project/address-projects", "/ww-materials/sync", "/ww-materials/search"}
        and KRISTINE_ADMIN_TOKEN
        and hmac.compare_digest(supplied_query_token, KRISTINE_ADMIN_TOKEN)
    ):
        return None

    # Über Tailscale nur die minimale Handy-API freigeben.
    if request.path not in MOBILE_ALLOWED_PATHS and not request.path.startswith("/incoming/capture/"):
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
        "object-src 'self' blob:; frame-src 'self' blob:; "
        "base-uri 'none'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    )
    # KRISTINE ACCESS CONTROL V3 CORS
    if request.path.startswith("/access-control/") or request.path in {"/project/address-search", "/project/address-projects", "/ww-materials/sync", "/ww-materials/search"}:
        origin = str(request.headers.get("Origin") or "")
        if origin == "https://protokoll.krista.at":
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "X-Krista-Token, Content-Type"
            response.headers["Access-Control-Max-Age"] = "600"

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
DOKMAN_ROOT = Path(os.environ.get(
    "KRISTINE_WW_DOKMAN_ROOT",
    r"\\srv-db01\WWDaten\Dokman\{FF8BE8FE-F2DA-409B-B71B-8737C40B510F}",
))
SQL_SERVER = r"SRV-DB01\WINWORKER"
SQL_DATABASE = "WinWorker_Projekte_Standard"
SQL_USER = "kristine_reader"

SCHEMA_INDEX_FILE = DB.parent / "winworker_sql_structure_index.json"

BRAIN_SUPPLIER_MAP_FILE = DB.parent / "brain_supplier_map.json"


# ---------------------------------------------------------------------------
# KRISTINE Eingangsrechnungen · Dunja
# ---------------------------------------------------------------------------
CAPTURE_DB = Path(os.environ.get(
    "KRISTINE_INCOMING_DB",
    str(DB.parent / "kristine_incoming_capture.db")
))
CAPTURE_TEST_DB = Path(os.environ.get(
    "KRISTINE_INCOMING_TEST_DB",
    str(DB.parent / "kristine_incoming_training.db")
))
CAPTURE_ROOT = Path(os.environ.get(
    "KRISTINE_INCOMING_DIR",
    r"N:\OneDrive\Dokumente\Kristine\Eingangsrechnungen"
))
CAPTURE_TEST_ROOT = Path(os.environ.get(
    "KRISTINE_INCOMING_TEST_DIR",
    r"N:\OneDrive\Dokumente\Kristine\Testgelaende\Eingangsrechnungen"
))
CAPTURE_PREFIX = str(os.environ.get("KRISTINE_INCOMING_PREFIX", "1150")).strip() or "1150"
CAPTURE_ALLOW_OFFLINE_SEQUENCE = str(
    os.environ.get("KRISTINE_INCOMING_ALLOW_OFFLINE_SEQUENCE", "0")
).strip() == "1"
CAPTURE_NUMBER_LOCK = threading.Lock()
CAPTURE_TEST_LOCK = threading.Lock()
CAPTURE_OCR_LANG = str(os.environ.get("KRISTINE_INCOMING_OCR_LANG", "deu+eng")).strip() or "deu+eng"
CAPTURE_OCR_DPI = max(120, min(300, int(os.environ.get("KRISTINE_INCOMING_OCR_DPI", "190"))))

CAPTURE_COST_TYPES = [
    "Material",
    "Fremdleistung",
    "Miete",
    "Strom",
    "Gas / Heizung",
    "Versicherung",
    "Fahrzeug",
    "IT / Telefon",
    "Werkstatt",
    "Büro",
    "Werbung",
    "Steuerberater",
    "Maschinen",
    "Sonstiges",
]


def _capture_connection(db_path=None):
    target = Path(db_path or CAPTURE_DB)
    target.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(target, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=DELETE")
    con.execute("PRAGMA synchronous=FULL")
    con.execute("PRAGMA busy_timeout=30000")
    _ensure_capture_schema(con)
    return con


def _ensure_capture_schema(con):
    con.executescript("""
        CREATE TABLE IF NOT EXISTS incoming_invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL UNIQUE,
            document_type TEXT NOT NULL DEFAULT 'Rechnung',
            supplier_address_id TEXT NOT NULL,
            supplier_name TEXT NOT NULL,
            supplier_address TEXT,
            supplier_number TEXT,
            our_customer_number TEXT,
            supplier_invoice_number TEXT NOT NULL,
            supplier_invoice_number_norm TEXT NOT NULL,
            invoice_date TEXT NOT NULL,
            due_date TEXT,
            net_amount REAL NOT NULL,
            vat_amount REAL NOT NULL,
            gross_amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'EUR',
            iban TEXT,
            swift TEXT,
            account_holder TEXT,
            customer_number_external TEXT,
            workflow_status TEXT NOT NULL DEFAULT 'zu_pruefen',
            payment_status TEXT NOT NULL DEFAULT 'Offen',
            payment_state TEXT NOT NULL DEFAULT 'open',
            booking_text TEXT,
            note TEXT,
            original_filename TEXT,
            pdf_path TEXT NOT NULL,
            original_path TEXT NOT NULL,
            file_sha256 TEXT NOT NULL,
            pdf_text TEXT,
            page_count INTEGER,
            created_by TEXT NOT NULL DEFAULT 'Dunja',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(supplier_address_id, supplier_invoice_number_norm),
            UNIQUE(file_sha256)
        );

        CREATE TABLE IF NOT EXISTS incoming_allocations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            line_no INTEGER NOT NULL,
            account TEXT,
            cost_type TEXT NOT NULL,
            cost_center TEXT,
            project_id TEXT,
            description TEXT,
            net_amount REAL NOT NULL,
            vat_rate REAL,
            FOREIGN KEY(invoice_id) REFERENCES incoming_invoices(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS supplier_bank_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_address_id TEXT NOT NULL,
            iban TEXT NOT NULL,
            source_invoice_id INTEGER,
            source_doc_id TEXT,
            confirmed_by TEXT,
            confirmed_at TEXT NOT NULL,
            note TEXT,
            FOREIGN KEY(source_invoice_id) REFERENCES incoming_invoices(id) ON DELETE SET NULL,
            UNIQUE(supplier_address_id, iban)
        );

        CREATE INDEX IF NOT EXISTS idx_incoming_supplier
            ON incoming_invoices(supplier_address_id, invoice_date DESC);
        CREATE INDEX IF NOT EXISTS idx_incoming_status
            ON incoming_invoices(workflow_status, payment_state);
        CREATE INDEX IF NOT EXISTS idx_incoming_alloc_invoice
            ON incoming_allocations(invoice_id, line_no);
        CREATE INDEX IF NOT EXISTS idx_supplier_bank_address
            ON supplier_bank_accounts(supplier_address_id, confirmed_at DESC);

        CREATE TABLE IF NOT EXISTS brain_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            location TEXT,
            name TEXT,
            role TEXT,
            phone TEXT NOT NULL,
            email TEXT,
            note TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_brain_contacts_entity
            ON brain_contacts(entity_type, entity_id, sort_order, id);
    """)

    # Bestehende 0.13.x-Datenbanken werden ohne Datenverlust erweitert.
    existing = {
        str(row[1])
        for row in con.execute("PRAGMA table_info(incoming_invoices)").fetchall()
    }
    migrations = {
        "skonto_enabled": "INTEGER NOT NULL DEFAULT 0",
        "skonto_percent": "REAL",
        "skonto_due_date": "TEXT",
        "net_due_date": "TEXT",
        "payment_terms": "TEXT",
        "invoice_iban": "TEXT",
        "master_iban": "TEXT",
        "bank_change_accepted": "INTEGER NOT NULL DEFAULT 0",
        "ocr_used": "INTEGER NOT NULL DEFAULT 0",
        "ocr_pages": "INTEGER NOT NULL DEFAULT 0",
        "ocr_warning": "TEXT",
    }
    for name, sql_type in migrations.items():
        if name not in existing:
            con.execute(f"ALTER TABLE incoming_invoices ADD COLUMN {name} {sql_type}")
    con.commit()


def _contact_entity_type(value):
    raw = str(value or "").strip().lower()
    aliases = {
        "supplier": "supplier", "lieferant": "supplier",
        "customer": "customer", "kunde": "customer",
        "project": "project", "projekt": "project",
    }
    return aliases.get(raw, "")


def brain_contacts(entity_type, entity_id):
    entity_type = _contact_entity_type(entity_type)
    entity_id = str(entity_id or "").strip()
    if not entity_type or not entity_id:
        return []
    con = _capture_connection()
    try:
        rows = con.execute(
            """SELECT id, entity_type, entity_id, location, name, role, phone, email, note, sort_order
               FROM brain_contacts
               WHERE entity_type=? AND entity_id=?
               ORDER BY sort_order ASC, location COLLATE NOCASE, name COLLATE NOCASE, id ASC""",
            (entity_type, entity_id),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        con.close()


def _save_brain_contact(payload):
    payload = payload or {}
    entity_type = _contact_entity_type(payload.get("entityType"))
    entity_id = str(payload.get("entityId") or "").strip()
    phone = re.sub(r"\s+", " ", str(payload.get("phone") or "").strip())
    if not entity_type or not entity_id:
        raise ValueError("Kontakt-Zuordnung fehlt.")
    if not phone:
        raise ValueError("Telefonnummer fehlt.")
    now = datetime.now().isoformat(timespec="seconds")
    contact_id = int(payload.get("id") or 0)
    values = (
        str(payload.get("location") or "").strip(),
        str(payload.get("name") or "").strip(),
        str(payload.get("role") or "").strip(),
        phone,
        str(payload.get("email") or "").strip(),
        str(payload.get("note") or "").strip(),
        int(payload.get("sortOrder") or 0),
        now,
    )
    con = _capture_connection()
    try:
        if contact_id:
            found = con.execute(
                "SELECT id FROM brain_contacts WHERE id=? AND entity_type=? AND entity_id=?",
                (contact_id, entity_type, entity_id),
            ).fetchone()
            if not found:
                raise ValueError("Kontakt nicht gefunden.")
            con.execute(
                """UPDATE brain_contacts
                   SET location=?, name=?, role=?, phone=?, email=?, note=?, sort_order=?, updated_at=?
                   WHERE id=?""",
                values + (contact_id,),
            )
        else:
            cur = con.execute(
                """INSERT INTO brain_contacts
                   (entity_type, entity_id, location, name, role, phone, email, note, sort_order, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (entity_type, entity_id) + values[:-1] + (now, now),
            )
            contact_id = int(cur.lastrowid)
        con.commit()
        return contact_id
    finally:
        con.close()


def _delete_brain_contact(contact_id, entity_type, entity_id):
    entity_type = _contact_entity_type(entity_type)
    entity_id = str(entity_id or "").strip()
    con = _capture_connection()
    try:
        cur = con.execute(
            "DELETE FROM brain_contacts WHERE id=? AND entity_type=? AND entity_id=?",
            (int(contact_id), entity_type, entity_id),
        )
        con.commit()
        return bool(cur.rowcount)
    finally:
        con.close()


def _capture_area(value="live"):
    raw = str(value or "live").strip().lower()
    return "test" if raw in {"test", "training", "sandbox", "testgelaende", "testgelände"} else "live"


def _capture_truthy(value):
    if value is True:
        return True
    return str(value or "").strip().lower() in {"1", "true", "yes", "ja", "on", "test", "training"}


def _capture_area_connection(area="live"):
    return _capture_connection(CAPTURE_TEST_DB if _capture_area(area) == "test" else CAPTURE_DB)


def _capture_area_root(area="live"):
    return CAPTURE_TEST_ROOT if _capture_area(area) == "test" else CAPTURE_ROOT


def _capture_invoice_number_norm(value):
    return re.sub(r"[^A-Z0-9]+", "", str(value or "").upper())


def _capture_float(value, field, allow_none=False):
    if value in (None, "") and allow_none:
        return None
    try:
        number = float(value)
    except Exception as exc:
        raise ValueError(f"{field} ist keine gültige Zahl.") from exc
    if not math.isfinite(number):
        raise ValueError(f"{field} ist keine gültige Zahl.")
    return round(number, 2)


def _capture_date(value, field, allow_empty=False):
    raw = str(value or "").strip()
    if not raw and allow_empty:
        return ""
    if not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", raw):
        raise ValueError(f"{field} muss ein gültiges Datum sein.")
    try:
        datetime.strptime(raw, "%Y-%m-%d")
    except Exception as exc:
        raise ValueError(f"{field} muss ein gültiges Datum sein.") from exc
    return raw


def _capture_doc_prefix(year):
    return f"{CAPTURE_PREFIX}{int(year) % 100:02d}"


def _ww_max_capture_counter(year):
    prefix = _capture_doc_prefix(year)
    con = sql_connection("WinWorker_Projekte_Standard")
    try:
        row = con.cursor().execute("""
            SELECT MAX(TRY_CONVERT(int, RIGHT(LTRIM(RTRIM(sDocID)), 5))) AS MaxCounter
            FROM dbo.DokumentenManagement
            WHERE LEN(LTRIM(RTRIM(ISNULL(sDocID,'')))) = 11
              AND LEFT(LTRIM(RTRIM(sDocID)), 6) = ?
        """, prefix).fetchone()
        return int(row.MaxCounter or 0)
    finally:
        con.close()


def _local_max_capture_counter(con, year):
    prefix = _capture_doc_prefix(year)
    row = con.execute("""
        SELECT MAX(CAST(SUBSTR(doc_id, 7, 5) AS INTEGER)) AS max_counter
        FROM incoming_invoices
        WHERE LENGTH(doc_id) = 11 AND SUBSTR(doc_id, 1, 6) = ?
    """, (prefix,)).fetchone()
    return int(row["max_counter"] or 0)


def _capture_number_status(year=None, con=None):
    year = int(year or datetime.now().year)
    owns = con is None
    if owns:
        con = _capture_connection()
    try:
        local_max = _local_max_capture_counter(con, year)
        ww_error = ""
        try:
            ww_max = _ww_max_capture_counter(year)
        except Exception as exc:
            if not CAPTURE_ALLOW_OFFLINE_SEQUENCE:
                raise RuntimeError(
                    "WinWorker-Nummernkreis ist nicht erreichbar. Nummer wird aus Sicherheitsgründen nicht vergeben."
                ) from exc
            ww_max = 0
            ww_error = str(exc)
        next_counter = max(local_max, ww_max) + 1
        if next_counter > 99999:
            raise RuntimeError(f"Nummernkreis {year} ist ausgeschöpft.")
        return {
            "year": year,
            "prefix": _capture_doc_prefix(year),
            "wwMax": ww_max,
            "localMax": local_max,
            "nextCounter": next_counter,
            "nextDocId": f"{_capture_doc_prefix(year)}{next_counter:05d}",
            "wwError": ww_error,
        }
    finally:
        if owns:
            con.close()



def _capture_test_doc_prefix(year):
    return f"TEST-{int(year) % 100:02d}-"


def _local_max_test_counter(con, year):
    prefix = _capture_test_doc_prefix(year)
    rows = con.execute(
        "SELECT doc_id FROM incoming_invoices WHERE doc_id LIKE ?",
        (prefix + "%",),
    ).fetchall()
    maximum = 0
    for row in rows:
        match = re.fullmatch(re.escape(prefix) + r"(\d{5})", str(row["doc_id"] or ""))
        if match:
            maximum = max(maximum, int(match.group(1)))
    return maximum


def _capture_test_number_status(year=None, con=None):
    year = int(year or datetime.now().year)
    owns = con is None
    if owns:
        con = _capture_area_connection("test")
    try:
        local_max = _local_max_test_counter(con, year)
        next_counter = local_max + 1
        if next_counter > 99999:
            raise RuntimeError(f"Test-Nummernkreis {year} ist ausgeschöpft.")
        prefix = _capture_test_doc_prefix(year)
        return {
            "year": year,
            "prefix": prefix,
            "wwMax": 0,
            "localMax": local_max,
            "nextCounter": next_counter,
            "nextDocId": f"{prefix}{next_counter:05d}",
            "wwError": "",
            "area": "test",
            "trainingMode": True,
        }
    finally:
        if owns:
            con.close()


def _capture_number_status_for_area(year=None, area="live", con=None):
    if _capture_area(area) == "test":
        return _capture_test_number_status(year, con)
    return _capture_number_status(year, con)


def _capture_pdf_text(pdf_bytes, max_pages=12):
    """Text zuerst direkt lesen; bei echten Scan-Seiten OCR als Fallback."""
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        if len(doc) < 1:
            raise ValueError("PDF hat keine Seiten.")
        chunks = []
        ocr_pages = 0
        ocr_errors = []
        for page_no, page in enumerate(list(doc)[:max_pages], start=1):
            try:
                direct = page.get_text("text") or ""
            except Exception:
                direct = ""
            meaningful = re.sub(r"\s+", "", direct)
            if len(meaningful) >= 40:
                chunks.append(direct)
                continue
            try:
                textpage = page.get_textpage_ocr(
                    language=CAPTURE_OCR_LANG,
                    dpi=CAPTURE_OCR_DPI,
                    full=True,
                )
                ocr_text = page.get_text("text", textpage=textpage) or ""
                if len(re.sub(r"\s+", "", ocr_text)) > len(meaningful):
                    direct = ocr_text
                    ocr_pages += 1
            except Exception as exc:
                ocr_errors.append(f"Seite {page_no}: {exc}")
            chunks.append(direct)
        warning = ""
        if ocr_errors and not any(re.sub(r"\s+", "", chunk) for chunk in chunks):
            warning = "OCR nicht verfügbar: " + " | ".join(ocr_errors[:2])
        elif ocr_errors:
            warning = "Einzelne Scan-Seiten konnten nicht per OCR gelesen werden."
        return "\n".join(chunks), len(doc), ocr_pages, warning


def _capture_clean_text(text):
    return (
        str(text or "")
        .replace("\u00ad", "")
        .replace("\xa0", " ")
        .replace("\u2011", "-")
        .replace("\u2013", "-")
    )


def _capture_lines(text):
    return [
        re.sub(r"\s+", " ", line).strip()
        for line in _capture_clean_text(text).splitlines()
        if re.sub(r"\s+", " ", line).strip()
    ]


def _capture_parse_date_token(value):
    match = re.search(r"\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b", str(value or ""))
    if not match:
        return ""
    try:
        day, month, year = map(int, match.groups())
        return datetime(year, month, day).date().isoformat()
    except Exception:
        return ""


def _capture_date_plus_days(date_iso, days):
    try:
        return (datetime.strptime(date_iso, "%Y-%m-%d").date() + timedelta(days=int(days))).isoformat()
    except Exception:
        return ""


def _capture_invoice_number(text, filename=""):
    cleaned = _capture_clean_text(text)
    flat = re.sub(r"\s+", " ", cleaned)
    patterns = [
        r"(?i)\bRechnung\s*(?:Nr\.?|Nummer)?\s*[:#-]\s*([A-Z0-9][A-Z0-9./_-]{1,30})",
        r"(?i)\bRechnungs(?:nummer|nr\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{1,30})",
        r"(?i)\bBeleg(?:nummer|nr\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{1,30})",
        r"(?i)\bInvoice\s*(?:No\.?|Number)?\s*[:#-]\s*([A-Z0-9][A-Z0-9./_-]{1,30})",
    ]
    for pattern in patterns:
        match = re.search(pattern, flat)
        if match:
            value = match.group(1).strip(" .,:;-")
            if value and not re.fullmatch(r"\d{1,2}[.-]\d{1,2}[.-]20\d{2}", value):
                return value

    # Viele Rechnungen drucken die Nummer allein ganz oben und später nochmals.
    lines = _capture_lines(cleaned)
    for line in lines[:5]:
        candidate = line.strip()
        if re.fullmatch(r"[A-Z0-9][A-Z0-9./_-]{2,24}", candidate) and not re.fullmatch(r"\d{1,2}[.-]\d{1,2}[.-]20\d{2}", candidate):
            if re.search(rf"(?i)\bRechnung\b[^\n]{{0,30}}\b{re.escape(candidate)}\b", flat):
                return candidate

    # Dateiname nur als letzte Notlösung; Wörter wie Kopie/Vorg/Rech werden ignoriert.
    stem = Path(str(filename or "")).stem
    for match in re.finditer(r"(?<!\d)(\d{3,12})(?!\d)", stem):
        value = match.group(1)
        if not value.startswith("20") or len(value) > 8:
            return value
    return ""


def _capture_invoice_date(text):
    lines = _capture_lines(text)
    label = re.compile(r"(?i)\b(rechnungsdatum|belegdatum|invoice date)\b")
    for index, line in enumerate(lines):
        if not label.search(line):
            continue
        same = _capture_parse_date_token(line)
        if same:
            return same
        # PDF-Text wird oft spaltenweise ausgegeben: Wert steht vor dem Label.
        for offset in (1, 2, 3, -1, -2, -3):
            pos = index - offset if offset > 0 else index - offset
            if 0 <= pos < len(lines):
                found = _capture_parse_date_token(lines[pos])
                if found:
                    return found
    for line in lines[:15]:
        found = _capture_parse_date_token(line)
        if found:
            return found
    fallback = _extract_invoice_date(text)
    return fallback.date().isoformat() if fallback else ""


def _capture_money_near_labels(text, labels, max_follow=4):
    lines = _capture_lines(text)
    for index, line in enumerate(lines):
        low = line.lower()
        if not any(label in low for label in labels):
            continue
        values = []
        for offset in range(0, max_follow + 1):
            if index + offset >= len(lines):
                break
            candidate = lines[index + offset]
            if "%" in candidate:
                continue
            values.extend(_line_money_values(candidate))
        if values:
            return values[-1]
    return None


def _capture_vat_rate(text):
    cleaned = _capture_clean_text(text)
    patterns = [
        r"(?i)(?:MwSt|USt|VAT)\s*(?:\(\d+\))?\s*[:\-]?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%",
        r"(?i)\b(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*(?:MwSt|USt|VAT)\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, cleaned)
        if match:
            try:
                value = float(match.group(1).replace(",", "."))
                if 0 <= value <= 30:
                    return round(value, 2)
            except Exception:
                pass
    return None


def _capture_payment_terms(text, invoice_date):
    lines = _capture_lines(text)
    selected = []
    for index, line in enumerate(lines):
        if re.search(r"(?i)\b(zahlung|zahlungsbeding|fällig|faellig|skonto|zahlbar|payment terms|due date)\b", line):
            selected.extend(lines[index:index + 4])
    phrase = " ".join(dict.fromkeys(selected))
    if not phrase:
        phrase = re.sub(r"\s+", " ", _capture_clean_text(text))[:3500]
    compact = re.sub(r"\s+", " ", phrase).strip()

    skonto_match = re.search(r"(?i)(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*Skonto", compact)
    if not skonto_match:
        skonto_match = re.search(r"(?i)Skonto[^\d]{0,20}(\d{1,2}(?:[.,]\d{1,2})?)\s*%", compact)
    skonto_percent = round(float(skonto_match.group(1).replace(",", ".")), 2) if skonto_match else None
    skonto_enabled = bool(skonto_match or re.search(r"(?i)\bSkonto\b", compact))

    skonto_due = ""
    skonto_date_match = re.search(
        r"(?i)Skonto.{0,80}?(\d{1,2}[./-]\d{1,2}[./-]20\d{2})",
        compact,
    )
    if skonto_date_match:
        skonto_due = _capture_parse_date_token(skonto_date_match.group(1))
    if not skonto_due and invoice_date:
        days_match = re.search(r"(?i)(\d{1,3})\s*Tage?[^.]{0,40}Skonto|Skonto[^.]{0,40}?(\d{1,3})\s*Tage?", compact)
        if days_match:
            skonto_due = _capture_date_plus_days(invoice_date, next(x for x in days_match.groups() if x))

    net_due = ""
    explicit_net = re.search(
        r"(?i)(?:fällig(?:keitsdatum)?|faellig|zahlbar bis|netto(?:fällig)?|ohne Abzug|Zahlung)"
        r".{0,60}?(\d{1,2}[./-]\d{1,2}[./-]20\d{2})",
        compact,
    )
    if explicit_net:
        net_due = _capture_parse_date_token(explicit_net.group(1))
    if not net_due and invoice_date:
        net_days = re.search(r"(?i)(\d{1,3})\s*Tage?\s*(?:netto|ohne Abzug)", compact)
        if net_days:
            net_due = _capture_date_plus_days(invoice_date, net_days.group(1))
        elif re.search(r"(?i)\bsofort\b", compact):
            net_due = invoice_date

    # Eine nackte Zahlungsdatumszeile direkt nach "Zahlung" gilt ebenfalls als Nettofälligkeit.
    if not net_due:
        for index, line in enumerate(lines):
            if re.search(r"(?i)\bZahlung\b", line):
                for candidate in lines[index:index + 4]:
                    found = _capture_parse_date_token(candidate)
                    if found:
                        net_due = found
                        break
            if net_due:
                break

    payment_line = ""
    for index, line in enumerate(lines):
        if re.search(r"(?i)\b(Zahlung|Zahlungsbeding|Skonto|zahlbar)\b", line):
            parts = []
            for candidate in lines[index:index + 5]:
                if parts and re.search(r"(?i)\b(USt|UID|Kasse|Kreditkarte|Rechnung|IBAN|BIC)\b", candidate):
                    break
                parts.append(candidate)
            payment_line = " ".join(parts)[:260]
            break
    return {
        "skontoEnabled": skonto_enabled,
        "skontoPercent": skonto_percent,
        "skontoDueDate": skonto_due,
        "netDueDate": net_due,
        "paymentTerms": payment_line or compact[:260],
    }


def _capture_booking_text(text):
    lines = _capture_lines(text)
    for index, line in enumerate(lines):
        match = re.search(r"(?i)\b(?:Betreff|Betrifft|Buchungstext|Verwendungszweck)\s*[:\-]\s*(.+)$", line)
        if match and match.group(1).strip():
            return match.group(1).strip()[:220]
        if re.fullmatch(r"(?i)(?:Betreff|Betrifft|Buchungstext|Verwendungszweck)\s*[:\-]?", line) and index + 1 < len(lines):
            candidate = lines[index + 1].strip()
            if candidate:
                return candidate[:220]
    return ""


def _capture_supplier_identity(text):
    lines = _capture_lines(text)
    own = re.compile(r"(?i)\b(farben\s*[- ]?krista|malerische\s+wohnideen|studio\s+raum\s*&\s*bad)\b")
    legal = re.compile(r"(?i)\b(gmbh|ges\.?\s*m\.?\s*b\.?\s*h\.?|ag|kg|ohg|gmbh\s*&\s*co|sarl|sa|ltd|limited)\b")
    generic = re.compile(r"(?i)^(kopie|original|rechnung|gutschrift|seite\s*\d+|firma|bezeichnung)$")
    candidates = []

    def add_candidate(name, index, bonus=0, source="line"):
        clean = re.sub(r"\s+", " ", str(name or "")).strip(" ,;:-")
        clean = re.sub(r"\s*[-–]\s*", "-", clean)
        clean = re.sub(r"\s*&\s*", " & ", clean)
        if len(clean) < 3 or len(clean) > 150 or own.search(clean) or generic.fullmatch(clean):
            return
        score = bonus
        if legal.search(clean):
            score += 55
        if re.search(r"[A-Za-zÄÖÜäöü]{3}", clean):
            score += 8
        if index >= max(0, len(lines) - 20):
            score += 8
        nearby = " ".join(lines[index + 1:index + 6]) if 0 <= index < len(lines) else ""
        if re.search(r"\b\d{4}\s+[A-Za-zÄÖÜäöü]", nearby):
            score += 15
        if re.search(r"(?i)(?:straße|strasse|str\.?|weg|gasse|platz)", nearby):
            score += 8
        if "@" in nearby or re.search(r"\+\d", nearby):
            score += 5
        normalized = _norm_supplier(clean)
        repeats = sum(1 for line in lines if _norm_supplier(line) == normalized)
        score += min(20, repeats * 8)
        candidates.append({"name": clean, "index": index, "score": score, "source": source, "norm": normalized})

    for index, line in enumerate(lines):
        explicit = re.search(r"(?i)\bBezeichnung\s*:\s*(.+)$", line)
        if explicit:
            add_candidate(explicit.group(1), index, 80, "bezeichnung")
        if legal.search(line):
            add_candidate(line, index, 20, "legal")

    if not candidates:
        return {}
    candidates.sort(key=lambda row: (-row["score"], len(row["name"]), row["index"]))
    best = candidates[0]
    # Bei gleicher Identität die sauberste alleinstehende Firmenzeile bevorzugen.
    same = [row for row in candidates if row["norm"] == best["norm"] and row["score"] >= best["score"] - 20]
    if same:
        best = min(same, key=lambda row: (0 if row["source"] == "legal" else 1, len(row["name"])))

    index = best["index"]
    street = ""
    postal = ""
    for line in lines[index + 1:index + 10]:
        if own.search(line):
            continue
        if not street and re.search(r"(?i)(?:straße|strasse|str\.?|weg|gasse|platz|allee)", line) and re.search(r"\d", line):
            street = line
        if not postal and re.search(r"\b(?:A-|AT-|CH-|LI-)?\d{4}\s+[A-Za-zÄÖÜäöü]", line):
            postal = line
        if street and postal:
            break
    address = ", ".join(part for part in (street, postal) if part)
    email = next((line for line in lines[index:index + 12] if "@" in line), "")
    phone = next((line for line in lines[index:index + 12] if re.search(r"\+\d{2}", line)), "")
    return {
        "name": best["name"],
        "address": address,
        "email": email,
        "phone": phone,
        "confidence": min(100, max(0, int(best["score"]))),
    }


def _capture_customer_number(text):
    lines = _capture_lines(text)
    generic = {"firma", "rechnung", "kunde", "kundennr", "kundennummer"}
    for index, line in enumerate(lines):
        if not re.search(r"(?i)Kunden[-\s]?Nr|Kundennummer", line):
            continue
        same = re.search(r"(?i)(?:Kunden[-\s]?Nr\.?|Kundennummer)\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{1,30})", line)
        if same:
            value = same.group(1).strip()
            if re.search(r"\d", value) and value.lower() not in generic:
                return value
        # Spaltenweise PDF-Ausgabe: Wert steht häufig unmittelbar VOR dem Label.
        for pos in range(index - 1, max(-1, index - 5), -1):
            if pos < 0:
                break
            value = lines[pos].strip()
            if re.fullmatch(r"[A-Z0-9./_-]{2,30}", value) and re.search(r"\d", value):
                if not _capture_parse_date_token(value):
                    return value

    flat = re.sub(r"\s+", " ", _capture_clean_text(text))
    for pattern in (
        r"(?i)Kunden[-\s]?Nr\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{1,30})",
        r"(?i)Kundennummer\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{1,30})",
    ):
        match = re.search(pattern, flat)
        if match:
            value = match.group(1).strip()
            if re.search(r"\d", value) and value.lower() not in generic:
                return value
    return ""


def _capture_uid(text):
    flat = re.sub(r"\s+", " ", _capture_clean_text(text))
    match = re.search(r"(?i)\b(?:UID|USt[-\s]?ID(?:Nr\.?)?)\s*[:#-]?\s*(ATU\d{8})\b", flat)
    if match:
        return match.group(1).upper()
    match = re.search(r"\bATU\d{8}\b", flat, re.I)
    return match.group(0).upper() if match else ""


def _capture_analyze_pdf(pdf_bytes, filename=""):
    text, page_count, ocr_pages, ocr_warning = _capture_pdf_text(pdf_bytes)
    supplier = _capture_supplier_identity(text)
    invoice_date = _capture_invoice_date(text)
    invoice_number = _capture_invoice_number(text, filename)
    amount_info = _extract_invoice_amount_smart(text)
    gross = amount_info.get("amount")
    net = _capture_money_near_labels(text, (
        "nettobetrag", "netto gesamt", "waren- und dienstleistungswert",
        "total eur ohne mwst", "ust-basis", "ust basis", "steuerbasis",
        "grundlagen", "zw. summe", "zw summe", "net amount",
    ))
    vat = _capture_money_near_labels(text, (
        "mwst-betrag", "ust-betrag", "umsatzsteuer", "mwst gesamt",
        "ust gesamtbetrag", "steuerwerte", "vat amount",
    ))
    vat_rate = _capture_vat_rate(text)

    if gross is not None and net is not None and vat is None:
        vat = round(float(gross) - float(net), 2)
    elif gross is not None and vat is not None and net is None:
        net = round(float(gross) - float(vat), 2)
    elif gross is None and net is not None and vat is not None:
        gross = round(float(net) + float(vat), 2)
    elif gross is not None and net is None and vat is None and vat_rate not in (None, 0):
        net = round(float(gross) / (1 + float(vat_rate) / 100), 2)
        vat = round(float(gross) - float(net), 2)

    # Plausibilisierung: Grundbetrag + Steuer muss die Endsumme ergeben.
    if gross is not None and net is not None and vat is not None and abs((float(net) + float(vat)) - float(gross)) > 0.08:
        derived_vat = round(float(gross) - float(net), 2)
        if derived_vat >= 0:
            vat = derived_vat

    terms = _capture_payment_terms(text, invoice_date)
    iban = _extract_iban_from_text(text)
    return {
        "filename": str(filename or ""),
        "pageCount": page_count,
        "sha256": hashlib.sha256(pdf_bytes).hexdigest(),
        "text": text,
        "textPreview": " ".join(text.split())[:900],
        "supplierName": supplier.get("name") or "",
        "supplierAddress": supplier.get("address") or "",
        "supplierEmail": supplier.get("email") or "",
        "supplierPhone": supplier.get("phone") or "",
        "supplierConfidence": int(supplier.get("confidence") or 0),
        "supplierInvoiceNumber": invoice_number,
        "invoiceDate": invoice_date,
        "dueDate": terms.get("netDueDate") or "",
        "netDueDate": terms.get("netDueDate") or "",
        "skontoEnabled": bool(terms.get("skontoEnabled")),
        "skontoPercent": terms.get("skontoPercent"),
        "skontoDueDate": terms.get("skontoDueDate") or "",
        "paymentTerms": terms.get("paymentTerms") or "",
        "grossAmount": gross,
        "netAmount": net,
        "vatAmount": vat,
        "vatRate": vat_rate,
        "iban": iban,
        "ibanValid": _iban_valid(iban) if iban else False,
        "uid": _capture_uid(text),
        "customerNumberExternal": _capture_customer_number(text),
        "bookingText": _capture_booking_text(text),
        "amountConfidence": int(amount_info.get("confidence") or 0),
        "amountReason": amount_info.get("reason") or "",
        "ocrUsed": ocr_pages > 0,
        "ocrPages": ocr_pages,
        "ocrWarning": ocr_warning,
    }



def _capture_supplier_match_score(address, analysis):
    score = 0
    reasons = []
    wanted_name = _norm_supplier(analysis.get("supplierName"))
    actual_name = _norm_supplier(address.get("name"))
    if wanted_name and actual_name:
        ratio = difflib.SequenceMatcher(None, wanted_name, actual_name).ratio()
        if ratio >= 0.92:
            score += 80
            reasons.append("Firmenname sehr sicher")
        elif ratio >= 0.72:
            score += 50
            reasons.append("Firmenname ähnlich")
        else:
            wanted_tokens = {x for x in wanted_name.split() if len(x) >= 3}
            actual_tokens = {x for x in actual_name.split() if len(x) >= 3}
            overlap = len(wanted_tokens & actual_tokens)
            if overlap:
                score += min(35, overlap * 12)
                reasons.append("Namensbestandteile stimmen")

    wanted_uid = re.sub(r"\s+", "", str(analysis.get("uid") or "")).upper()
    actual_uid = re.sub(r"\s+", "", str(address.get("vatId") or "")).upper()
    if wanted_uid and actual_uid and wanted_uid == actual_uid:
        score += 100
        reasons.append("UID stimmt")

    wanted_customer = _capture_invoice_number_norm(analysis.get("customerNumberExternal"))
    actual_customer = _capture_invoice_number_norm(address.get("ourCustomerNumber"))
    if wanted_customer and actual_customer and wanted_customer == actual_customer:
        score += 110
        reasons.append("Unsere Kundennummer stimmt")

    wanted_address = _norm_supplier(analysis.get("supplierAddress"))
    actual_address = _norm_supplier(address.get("address"))
    if wanted_address and actual_address:
        wanted_postal = re.search(r"\b\d{4}\b", wanted_address)
        actual_postal = re.search(r"\b\d{4}\b", actual_address)
        if wanted_postal and actual_postal and wanted_postal.group(0) == actual_postal.group(0):
            score += 25
            reasons.append("PLZ stimmt")
        ratio = difflib.SequenceMatcher(None, wanted_address, actual_address).ratio()
        if ratio >= 0.7:
            score += 20
            reasons.append("Adresse ähnlich")

    if int(address.get("incomingCount") or 0) > 0:
        score += 5
    return score, reasons


def _capture_supplier_suggestions(analysis, limit=8):
    queries = []
    for value in (
        analysis.get("customerNumberExternal"),
        analysis.get("uid"),
        analysis.get("supplierName"),
        analysis.get("supplierAddress"),
    ):
        clean = str(value or "").strip()
        if len(clean) >= 2 and clean.lower() not in {"kopie", "rechnung", "original"}:
            queries.append(clean)

    rows_by_id = {}
    errors = []
    for query in queries[:4]:
        try:
            for row in ww_address_search(query, 20):
                rows_by_id[str(row.get("addressId"))] = row
        except Exception as exc:
            errors.append(str(exc))

    ranked = []
    for row in rows_by_id.values():
        score, reasons = _capture_supplier_match_score(row, analysis)
        decorated = dict(row)
        decorated["matchScore"] = int(score)
        decorated["matchReasons"] = reasons
        decorated["idealMatch"] = score >= 100
        ranked.append(decorated)
    ranked.sort(key=lambda row: (-int(row.get("matchScore") or 0), -int(row.get("incomingCount") or 0), str(row.get("name") or "")))
    return ranked[:max(1, min(int(limit or 8), 20))], (errors[0] if errors and not ranked else "")

def _capture_address_summary(address_ids=None):
    con = _capture_connection()
    try:
        params = []
        where = ""
        ids = [str(x) for x in (address_ids or []) if str(x)]
        if ids:
            placeholders = ",".join("?" for _ in ids)
            where = f"WHERE supplier_address_id IN ({placeholders})"
            params.extend(ids)
        rows = con.execute(f"""
            SELECT supplier_address_id,
                   COUNT(*) AS cnt,
                   MAX(invoice_date) AS last_date
            FROM incoming_invoices
            {where}
            GROUP BY supplier_address_id
        """, params).fetchall()
        return {
            str(row["supplier_address_id"]): {
                "count": int(row["cnt"] or 0),
                "lastDate": str(row["last_date"] or ""),
            }
            for row in rows
        }
    finally:
        con.close()


def _capture_allocations(con, invoice_id):
    return [dict(row) for row in con.execute("""
        SELECT line_no, account, cost_type, cost_center, project_id,
               description, net_amount, vat_rate
        FROM incoming_allocations
        WHERE invoice_id = ?
        ORDER BY line_no
    """, (invoice_id,)).fetchall()]


def _capture_row_public(row, allocations=None, include_text=False, area="live"):
    data = dict(row)
    public = {
        "id": int(data["id"]),
        "docId": data["doc_id"],
        "documentType": data["document_type"],
        "addressId": data["supplier_address_id"],
        "supplierName": data["supplier_name"],
        "supplierAddress": data.get("supplier_address") or "",
        "supplierNumber": data.get("supplier_number") or "",
        "ourCustomerNumber": data.get("our_customer_number") or "",
        "invoiceNumber": data["supplier_invoice_number"],
        "invoiceDate": data["invoice_date"],
        "dueDate": data.get("net_due_date") or data.get("due_date") or "",
        "netDueDate": data.get("net_due_date") or data.get("due_date") or "",
        "skontoEnabled": bool(data.get("skonto_enabled") or 0),
        "skontoPercent": float(data.get("skonto_percent") or 0),
        "skontoDueDate": data.get("skonto_due_date") or "",
        "paymentTerms": data.get("payment_terms") or "",
        "netAmount": float(data["net_amount"] or 0),
        "vatAmount": float(data["vat_amount"] or 0),
        "amount": float(data["gross_amount"] or 0),
        "grossAmount": float(data["gross_amount"] or 0),
        "currency": data.get("currency") or "EUR",
        "iban": data.get("iban") or "",
        "invoiceIban": data.get("invoice_iban") or data.get("iban") or "",
        "masterIban": data.get("master_iban") or "",
        "bankChangeAccepted": bool(data.get("bank_change_accepted") or 0),
        "swift": data.get("swift") or "",
        "accountHolder": data.get("account_holder") or "",
        "customerNumberExternal": data.get("customer_number_external") or "",
        "workflowStatus": data.get("workflow_status") or "zu_pruefen",
        "paymentStatus": data.get("payment_status") or "Offen",
        "paymentState": data.get("payment_state") or _payment_state(data.get("payment_status")),
        "bookingText": data.get("booking_text") or "",
        "note": data.get("note") or "",
        "filename": Path(data.get("pdf_path") or "").name,
        "path": data.get("pdf_path") or "",
        "originalPath": data.get("original_path") or "",
        "pageCount": int(data.get("page_count") or 0),
        "ocrUsed": bool(data.get("ocr_used") or 0),
        "ocrPages": int(data.get("ocr_pages") or 0),
        "ocrWarning": data.get("ocr_warning") or "",
        "createdBy": data.get("created_by") or "Dunja",
        "createdAt": data.get("created_at") or "",
        "updatedAt": data.get("updated_at") or "",
        "area": _capture_area(area),
        "trainingMode": _capture_area(area) == "test",
        "sourceOfTruth": "KRISTINE Testgelände" if _capture_area(area) == "test" else "KRISTINE Eingangsrechnungen",
        "allocations": allocations or [],
        "snippet": " ".join(str(data.get("pdf_text") or "").split())[:420],
    }
    date_iso = public["invoiceDate"]
    public["invoiceDateTime"] = f"{date_iso}T00:00:00" if date_iso else None
    public["year"] = int(date_iso[:4]) if len(date_iso) >= 4 else None
    public["month"] = int(date_iso[5:7]) if len(date_iso) >= 7 else None
    public["monthName"] = MONTH_NAMES_DE.get(public["month"], "") if public["month"] else ""
    public["day"] = int(date_iso[8:10]) if len(date_iso) >= 10 else None
    public["invoiceId"] = f"kristine-test:{public['id']}" if public["trainingMode"] else f"kristine:{public['id']}"
    public["logical_id"] = public["docId"]
    public["dokumenttyp"] = "Eingangsrechnung"
    public["pdfLinked"] = bool(public["path"])
    if include_text:
        public["pdfText"] = data.get("pdf_text") or ""
    return public


def kristine_incoming_for_address(address_id, include_text=False):
    con = _capture_connection()
    try:
        rows = con.execute("""
            SELECT * FROM incoming_invoices
            WHERE supplier_address_id = ?
            ORDER BY invoice_date DESC, id DESC
        """, (str(address_id),)).fetchall()
        result = []
        for row in rows:
            result.append(_capture_row_public(
                row,
                _capture_allocations(con, row["id"]),
                include_text=bool(include_text),
            ))
        return result
    finally:
        con.close()


def _capture_supplier_context(address_id, area="live"):
    address_id = str(address_id or "").strip()
    area = _capture_area(area)
    ww_rows = ww_incoming_for_address(address_id) if address_id else []
    historical_ibans = []
    for row in sorted(ww_rows, key=lambda x: (x.get("invoiceDate") or "", str(x.get("docId") or ""))):
        iban = _norm_iban(row.get("iban"))
        if iban and iban not in historical_ibans:
            historical_ibans.append(iban)

    con = _capture_area_connection(area)
    try:
        accepted_rows = con.execute("""
            SELECT iban, confirmed_at, source_doc_id
            FROM supplier_bank_accounts
            WHERE supplier_address_id = ?
            ORDER BY confirmed_at, id
        """, (address_id,)).fetchall()
        accepted_ibans = []
        for row in accepted_rows:
            iban = _norm_iban(row["iban"])
            if iban and iban not in accepted_ibans:
                accepted_ibans.append(iban)

        observed_rows = con.execute("""
            SELECT invoice_iban, iban
            FROM incoming_invoices
            WHERE supplier_address_id = ?
            ORDER BY invoice_date, id
        """, (address_id,)).fetchall()
        observed_ibans = []
        for row in observed_rows:
            iban = _norm_iban(row["invoice_iban"] or row["iban"])
            if iban and iban not in observed_ibans:
                observed_ibans.append(iban)

        known = []
        for iban in historical_ibans + accepted_ibans:
            if iban not in known:
                known.append(iban)
        latest = accepted_ibans[-1] if accepted_ibans else (historical_ibans[-1] if historical_ibans else "")

        latest_invoice = con.execute("""
            SELECT id FROM incoming_invoices
            WHERE supplier_address_id = ?
            ORDER BY invoice_date DESC, id DESC LIMIT 1
        """, (address_id,)).fetchone()
        defaults = {}
        if latest_invoice:
            allocation = con.execute("""
                SELECT account, cost_type, cost_center, project_id, description, vat_rate
                FROM incoming_allocations
                WHERE invoice_id = ?
                ORDER BY line_no LIMIT 1
            """, (latest_invoice["id"],)).fetchone()
            if allocation:
                defaults = dict(allocation)
        return {
            "area": area,
            "knownIbans": known,
            "historicalIbans": historical_ibans,
            "acceptedIbans": accepted_ibans,
            "observedIbans": observed_ibans,
            "latestIban": latest,
            "latestIbanSource": "KRISTINE bestätigt" if accepted_ibans else ("WinWorker" if historical_ibans else ""),
            "defaults": defaults,
        }
    finally:
        con.close()


def _capture_recent(limit=50, workflow_status="", area="live"):
    area = _capture_area(area)
    con = _capture_area_connection(area)
    try:
        params = []
        where = ""
        if workflow_status:
            where = "WHERE workflow_status = ?"
            params.append(workflow_status)
        params.append(max(1, min(int(limit or 50), 200)))
        rows = con.execute(f"""
            SELECT * FROM incoming_invoices
            {where}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        """, params).fetchall()
        return [
            _capture_row_public(row, _capture_allocations(con, row["id"]), area=area)
            for row in rows
        ]
    finally:
        con.close()


def _capture_cost_summary(year, area="live"):
    area = _capture_area(area)
    con = _capture_area_connection(area)
    try:
        rows = con.execute("""
            SELECT a.cost_type,
                   SUBSTR(i.invoice_date, 6, 2) AS month,
                   COUNT(DISTINCT i.id) AS invoice_count,
                   SUM(a.net_amount) AS net_sum
            FROM incoming_allocations AS a
            JOIN incoming_invoices AS i ON i.id = a.invoice_id
            WHERE SUBSTR(i.invoice_date, 1, 4) = ?
            GROUP BY a.cost_type, SUBSTR(i.invoice_date, 6, 2)
            ORDER BY a.cost_type, month
        """, (str(int(year)),)).fetchall()
        categories = {}
        for row in rows:
            name = str(row["cost_type"] or "Sonstiges")
            bucket = categories.setdefault(name, {
                "costType": name,
                "netSum": 0.0,
                "invoiceCount": 0,
                "months": {},
            })
            amount = round(float(row["net_sum"] or 0), 2)
            bucket["netSum"] += amount
            bucket["invoiceCount"] += int(row["invoice_count"] or 0)
            bucket["months"][str(row["month"] or "00")] = amount
        result = list(categories.values())
        for row in result:
            row["netSum"] = round(row["netSum"], 2)
        result.sort(key=lambda x: (-abs(x["netSum"]), x["costType"]))
        return result
    finally:
        con.close()


def _capture_dashboard(year=None, area="live"):
    year = int(year or datetime.now().year)
    area = _capture_area(area)
    con = _capture_area_connection(area)
    try:
        row = con.execute("""
            SELECT
                COUNT(*) AS total_count,
                SUM(CASE WHEN workflow_status = 'zu_pruefen' THEN 1 ELSE 0 END) AS review_count,
                SUM(CASE WHEN payment_state = 'open' THEN gross_amount ELSE 0 END) AS open_sum,
                SUM(CASE WHEN SUBSTR(invoice_date,1,4) = ? THEN 1 ELSE 0 END) AS year_count,
                SUM(CASE WHEN SUBSTR(invoice_date,1,4) = ? THEN gross_amount ELSE 0 END) AS year_sum
            FROM incoming_invoices
        """, (str(year), str(year))).fetchone()
        number = _capture_number_status_for_area(year, area, con)
        return {
            "year": year,
            "area": area,
            "trainingMode": area == "test",
            "totalCount": int(row["total_count"] or 0),
            "reviewCount": int(row["review_count"] or 0),
            "openSum": round(float(row["open_sum"] or 0), 2),
            "yearCount": int(row["year_count"] or 0),
            "yearSum": round(float(row["year_sum"] or 0), 2),
            "numbering": number,
            "costSummary": _capture_cost_summary(year, area),
        }
    finally:
        con.close()


def _capture_path_is_allowed(path):
    wanted = str(Path(path))
    for area in ("live", "test"):
        con = _capture_area_connection(area)
        try:
            row = con.execute("""
                SELECT 1 FROM incoming_invoices
                WHERE pdf_path = ? OR original_path = ?
                LIMIT 1
            """, (wanted, wanted)).fetchone()
            if row:
                return True
        finally:
            con.close()
    return False


def _capture_path_within(path_value, root):
    try:
        path_obj = Path(str(path_value or "")).resolve(strict=False)
        root_obj = Path(root).resolve(strict=False)
        return path_obj == root_obj or root_obj in path_obj.parents
    except Exception:
        return False


def _capture_delete_test_files(row):
    deleted = []
    warnings = []
    for key in ("pdf_path", "original_path"):
        raw = str(row.get(key) or "")
        if not raw:
            continue
        if not _capture_path_within(raw, CAPTURE_TEST_ROOT):
            warnings.append(f"Datei außerhalb des Testgeländes nicht gelöscht: {raw}")
            continue
        try:
            path_obj = Path(raw)
            path_obj.unlink(missing_ok=True)
            deleted.append(raw)
            parent = path_obj.parent
            root_resolved = Path(CAPTURE_TEST_ROOT).resolve(strict=False)
            while parent.exists() and parent.resolve(strict=False) != root_resolved:
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent
        except Exception as exc:
            warnings.append(f"{raw}: {exc}")
    return deleted, warnings


def _load_brain_supplier_map():
    """
    Persistente Brain-Zuordnung.
    - addressLinks: erkannter PDF-Supplier-Key -> WW-StammIndex
    - invoiceLinks: einzelne Rechnung/logical_id/path -> WW-StammIndex
    Originaldaten werden nie verändert.
    """
    if not BRAIN_SUPPLIER_MAP_FILE.exists():
        return {"addressLinks": {}, "invoiceLinks": {}, "fingerprints": {}, "rejections": {}, "negativeFingerprints": {}, "watchAcks": {}}
    try:
        data = json.loads(BRAIN_SUPPLIER_MAP_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
        return {
            "addressLinks": dict(data.get("addressLinks") or {}),
            "invoiceLinks": dict(data.get("invoiceLinks") or {}),
            "fingerprints": dict(data.get("fingerprints") or {}),
            "rejections": dict(data.get("rejections") or {}),
            "negativeFingerprints": dict(data.get("negativeFingerprints") or {}),
            "watchAcks": dict(data.get("watchAcks") or {}),
        }
    except Exception:
        return {"addressLinks": {}, "invoiceLinks": {}, "fingerprints": {}, "rejections": {}, "negativeFingerprints": {}, "watchAcks": {}}


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

    Suche ist bewusst tolerant:
    LED findet auch L.E.D., L-E-D, L E D usw.
    Punkte, Bindestriche, Leerzeichen, / und & werden für eine zweite
    Vergleichsspur ignoriert.
    """
    q = str(query or "").strip()
    if len(q) < 2:
        return []

    terms = [x for x in re.split(r"\s+", q) if x]

    def compact(v):
        return re.sub(r"[\s\.\-_/&]+", "", str(v or "")).lower()

    q_compact = compact(q)

    con = sql_connection("WinWorker_Adressen_Standard")
    cur = con.cursor()

    # SQL expression equivalent to compact(), for the WW address fields.
    def sql_compact(expr):
        return (
            "LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE("
            f"ISNULL({expr},''),'.',''),'-',''),' ',''),'/',''),'&',''),'_',''))"
        )

    compact_fields = [
        sql_compact("k.sFirma"),
        sql_compact("k.sName"),
        sql_compact("k.sVorname"),
        sql_compact("k.sStrasse"),
        sql_compact("k.sOrt"),
    ]

    conditions = []
    params = []

    for term in terms:
        like = f"%{term}%"
        term_compact = compact(term)
        compact_like = f"%{term_compact}%"

        normal_clause = """
            (
                ISNULL(k.sFirma,'') LIKE ?
                OR ISNULL(k.sName,'') LIKE ?
                OR ISNULL(k.sVorname,'') LIKE ?
                OR ISNULL(k.sStrasse,'') LIKE ?
                OR ISNULL(k.sPLZ,'') LIKE ?
                OR ISNULL(k.sOrt,'') LIKE ?
                OR CAST(ISNULL(k.lKundenNr,0) AS varchar(40)) LIKE ?
                OR CAST(ISNULL(k.lLieferantenNr,0) AS varchar(40)) LIKE ?
                OR ISNULL(k.sUStIDNr,'') LIKE ?
                OR ISNULL(k.sL_KdnNr,'') LIKE ?
            )
        """
        compact_clause = "(" + " OR ".join(f"{f} LIKE ?" for f in compact_fields) + ")"

        conditions.append(f"({normal_clause} OR {compact_clause})")
        params.extend([like] * 10)
        params.extend([compact_like] * len(compact_fields))

    compact_firma = sql_compact("k.sFirma")

    sql = f"""
        SELECT TOP {max(1, min(int(limit or 25), 100))}
            k.StammIndex,
            k.lKundenNr,
            k.sFirma,
            k.sName,
            k.sVorname,
            k.sStrasse,
            k.sPLZ,
            k.sOrt,
            k.lLieferantenNr,
            k.sUStIDNr,
            k.sL_KdnNr,
            ISNULL(eb.cnt, 0) AS IncomingCount,
            eb.LastIncomingDate
        FROM dbo.Kunden AS k
        OUTER APPLY (
            SELECT
                COUNT(*) AS cnt,
                MAX(e.dzBelegdatum) AS LastIncomingDate
            FROM WinWorker_Projekte_Standard.dbo.Eingangsbelege AS e
            WHERE e.lVonAdrIndex = k.StammIndex
        ) AS eb
        WHERE {" AND ".join(conditions)}
        ORDER BY
            CASE WHEN ISNULL(eb.cnt,0) > 0 THEN 0 ELSE 1 END,
            CASE WHEN {compact_firma} LIKE ? THEN 0 ELSE 1 END,
            ISNULL(eb.cnt,0) DESC,
            CASE WHEN ISNULL(k.sFirma,'') LIKE ? THEN 0 ELSE 1 END,
            CASE WHEN k.lLieferantenNr IS NULL THEN 1 ELSE 0 END,
            k.sFirma,
            k.sName,
            k.sOrt
    """
    exact_like = f"%{q}%"
    compact_exact_like = f"%{q_compact}%"
    rows = cur.execute(sql, *(params + [compact_exact_like, exact_like])).fetchall()
    con.close()

    local_summary = _capture_address_summary([str(r.StammIndex) for r in rows])
    out = []
    for r in rows:
        address_id = str(r.StammIndex)
        local = local_summary.get(address_id, {})
        ww_count = int(r.IncomingCount or 0)
        local_count = int(local.get("count") or 0)
        ww_last = _iso_date(r.LastIncomingDate) or ""
        local_last = str(local.get("lastDate") or "")
        last_date = max(ww_last, local_last)
        name = (r.sFirma or "").strip()
        person = " ".join(x for x in [r.sVorname or "", r.sName or ""] if x).strip()
        if not name:
            name = person or f"Adresse {r.StammIndex}"
        out.append({
            "addressId": address_id,
            "customerNumber": str(r.lKundenNr or ""),
            "name": name,
            "person": person,
            "street": r.sStrasse or "",
            "postalCode": r.sPLZ or "",
            "city": r.sOrt or "",
            "supplierNumber": str(r.lLieferantenNr or ""),
            "vatId": str(r.sUStIDNr or "").strip(),
            "ourCustomerNumber": str(r.sL_KdnNr or "").strip(),
            "wwIncomingCount": ww_count,
            "kristineIncomingCount": local_count,
            "incomingCount": ww_count + local_count,
            "lastIncomingDate": last_date,
            "address": ", ".join(
                x for x in [
                    (r.sStrasse or "").strip(),
                    " ".join(x for x in [(r.sPLZ or "").strip(), (r.sOrt or "").strip()] if x)
                ] if x
            ),
        })
    out.sort(key=lambda x: (
        0 if x["incomingCount"] > 0 else 1,
        -x["incomingCount"],
        x["name"].lower(),
        x["address"].lower(),
    ))
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



def _iso_date(value):
    if value is None:
        return None
    try:
        return value.date().isoformat()
    except Exception:
        s = str(value)
        return s[:10] if len(s) >= 10 else s


IBAN_LENGTHS = {
    "AT": 20,
    "DE": 22,
    "CH": 21,
    "LI": 21,
    "IT": 27,
    "FR": 27,
    "NL": 18,
    "BE": 16,
    "LU": 20,
}


def _norm_iban(value):
    """IBAN säubern und exakt an der länderspezifischen Länge abschneiden.

    Damit wird z. B. ``AT68...3295BIC`` zuverlässig zu der 20-stelligen
    österreichischen IBAN und BIC/SWIFT kann nie mehr hinten ankleben.
    """
    raw = re.sub(r"[^A-Z0-9]", "", str(value or "").upper())
    raw = re.sub(r"^IBAN", "", raw)
    match = re.search(r"([A-Z]{2}\d{2}[A-Z0-9]{10,32})", raw)
    if not match:
        return ""
    candidate = match.group(1)
    expected = IBAN_LENGTHS.get(candidate[:2])
    if expected:
        return candidate[:expected] if len(candidate) >= expected else candidate
    return candidate[:34]


def _iban_valid(value):
    iban = _norm_iban(value)
    expected = IBAN_LENGTHS.get(iban[:2])
    if not iban or (expected and len(iban) != expected):
        return False
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]+", iban):
        return False
    rearranged = iban[4:] + iban[:4]
    digits = "".join(str(int(ch, 36)) if ch.isalpha() else ch for ch in rearranged)
    try:
        remainder = 0
        for ch in digits:
            remainder = (remainder * 10 + int(ch)) % 97
        return remainder == 1
    except Exception:
        return False


def _extract_iban_from_text(text):
    normalized = str(text or "").replace("\u00ad", "").replace("\xa0", " ")
    flat = re.sub(r"\s+", " ", normalized)
    patterns = [
        r"(?i)\bIBAN\s*[:\-]?\s*([A-Z]{2}\s*\d{2}(?:[\s-]*[A-Z0-9]){10,34}?)(?=\s+(?:BIC|SWIFT|Bank|Bezeichnung|Konto)\b|$)",
        r"(?i)\b([A-Z]{2}\s*\d{2}(?:[\s-]*[A-Z0-9]){12,30})\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, flat)
        if match:
            value = _norm_iban(match.group(1))
            if value:
                return value
    return ""


def _payment_state(status_text):
    """
    Erste feste OP-Regeln:
    - Beglichen/bezahlt = bezahlt
    - SEPA übergeben = bezahlt (User-Regel)
    - Offen = offen
    - Rest = unbekannt
    """
    s = _norm_supplier(status_text)
    if not s:
        return "unknown"

    paid_terms = (
        "beglichen",
        "bezahlt",
        "sepa ubergeben",
        "sepa übergeben",
        "lastschrift beglichen",
    )
    if any(t in s for t in paid_terms):
        return "paid"

    open_terms = (
        "offen",
        "noch zu begleichen",
        "zu begleichen",
    )
    if any(t in s for t in open_terms):
        return "open"

    return "unknown"


def ww_incoming_for_address(address_id):
    """
    Fachliche Wahrheit für Eingangsrechnungen direkt aus WinWorker.
    Kein OCR-Raten für Lieferant, Datum oder Betrag.
    """
    try:
        address_int = int(str(address_id).strip())
    except Exception:
        return []

    con = sql_connection("WinWorker_Projekte_Standard")
    cur = con.cursor()
    rows = cur.execute("""
        SELECT
            e.cID,
            e.sBelegnummer,
            e.dzBelegdatum,
            e.dblBruttoBetrag,
            e.dblNettoBetrag,
            e.dblUStBetrag,
            e.dblFreigegebenerBetrag,
            e.dblSkontobetrag,
            e.lVonAdrIndex,
            e.nFibuStatus,
            e.nZahlungsStatus,
            e.sZahlungsStatus,
            e.nZahlungsart,
            e.sIban,
            e.sSwift,
            e.sBankkontoInhaber,
            e.sBemerkung,
            e.gDMID,
            e.dzAufgenommen,
            e.dzGeaendert,
            dm.sDocID
        FROM dbo.Eingangsbelege AS e
        LEFT JOIN dbo.DokumentenManagement AS dm
            ON dm.gID = e.gDMID
        WHERE e.lVonAdrIndex = ?
        ORDER BY e.dzBelegdatum DESC, e.cID DESC
    """, address_int).fetchall()
    con.close()

    out = []
    for r in rows:
        gross = float(r.dblBruttoBetrag) if r.dblBruttoBetrag is not None else None
        net = float(r.dblNettoBetrag) if r.dblNettoBetrag is not None else None
        vat = float(r.dblUStBetrag) if r.dblUStBetrag is not None else None
        date_iso = _iso_date(r.dzBelegdatum)
        out.append({
            "wwIncomingId": int(r.cID),
            "invoiceNumber": str(r.sBelegnummer or "").strip(),
            "invoiceDate": date_iso,
            "invoiceDateTime": (date_iso + "T00:00:00") if date_iso else None,
            "year": int(date_iso[:4]) if date_iso and len(date_iso) >= 4 else None,
            "month": int(date_iso[5:7]) if date_iso and len(date_iso) >= 7 else None,
            "monthName": MONTH_NAMES_DE.get(int(date_iso[5:7]), "") if date_iso and len(date_iso) >= 7 else "",
            "day": int(date_iso[8:10]) if date_iso and len(date_iso) >= 10 else None,
            "amount": gross,
            "netAmount": net,
            "vatAmount": vat,
            "releasedAmount": float(r.dblFreigegebenerBetrag) if r.dblFreigegebenerBetrag is not None else None,
            "discountAmount": float(r.dblSkontobetrag) if r.dblSkontobetrag is not None else None,
            "addressId": str(r.lVonAdrIndex or ""),
            "fibuStatus": r.nFibuStatus,
            "paymentStatusCode": r.nZahlungsStatus,
            "paymentStatus": str(r.sZahlungsStatus or "").strip(),
            "paymentState": _payment_state(r.sZahlungsStatus),
            "paymentTypeCode": r.nZahlungsart,
            "iban": _norm_iban(r.sIban),
            "swift": str(r.sSwift or "").strip(),
            "accountHolder": str(r.sBankkontoInhaber or "").strip(),
            "remark": str(r.sBemerkung or "").strip(),
            "gDMID": str(r.gDMID or "").strip(),
            "docId": str(r.sDocID or "").strip(),
            "recordedAt": str(r.dzAufgenommen or ""),
            "changedAt": str(r.dzGeaendert or ""),
            "sourceOfTruth": "WinWorker Eingangsbelege",
        })
    return out


def _pdf_match_score_for_ww(item, ww):
    """
    Verknüpft den WW-Eingangsbeleg mit dem bereits indexierten PDF.
    Die WW-Daten bleiben trotzdem fachliche Wahrheit.
    """
    filename = str(item.get("filename") or "")
    if filename.lower().endswith("_original.pdf"):
        return -1000

    raw = str(item.get("_raw_text") or "")
    raw_norm = _norm_supplier(raw)
    score = 0

    nr = str(ww.get("invoiceNumber") or "").strip()
    if nr:
        # Exact token-ish occurrence
        if re.search(rf"(?<![A-Z0-9]){re.escape(nr)}(?![A-Z0-9])", raw, re.I):
            score += 100
        elif _norm_supplier(nr) in raw_norm:
            score += 70

    date_iso = str(ww.get("invoiceDate") or "")
    if date_iso:
        try:
            y, m, d = date_iso.split("-")
            variants = {
                f"{d}.{m}.{y}",
                f"{int(d)}.{int(m)}.{y}",
                date_iso,
            }
            if any(v in raw for v in variants):
                score += 15
        except Exception:
            pass

    ww_amount = ww.get("amount")
    if ww_amount is not None:
        try:
            smart = _extract_invoice_amount_smart(raw)
            pdf_amount = smart.get("amount")
            if pdf_amount is not None and abs(float(pdf_amount) - float(ww_amount)) <= 0.02:
                score += 20
        except Exception:
            pass

    return score



def _build_pdf_invoice_lookup(catalog):
    """
    Einmaliger Lookup pro Request statt für JEDE WW-Rechnung den kompletten
    PDF-Katalog neu zu durchsuchen.
    """
    by_number = {}
    fallback = []

    for item in catalog:
        filename = str(item.get("filename") or "")
        if filename.lower().endswith("_original.pdf"):
            continue

        raw = str(item.get("_raw_text") or "")
        fp = _extract_supplier_fingerprint(raw)
        nr = str(fp.get("invoiceNumber") or "").strip()

        if nr:
            key = _norm_supplier(nr)
            if key:
                by_number.setdefault(key, []).append(item)
        else:
            fallback.append(item)

    return {"byNumber": by_number, "fallback": fallback}


def _attach_pdf_to_ww_invoice(ww, catalog, lookup=None):
    """
    Schnelle PDF-Verknüpfung:
    1. Rechnungsnummer-Index
    2. nur bei Bedarf kleiner Fallback
    WW bleibt fachliche Wahrheit.
    """
    lookup = lookup or _build_pdf_invoice_lookup(catalog)

    nr = str(ww.get("invoiceNumber") or "").strip()
    candidates = []
    if nr:
        candidates = list(lookup.get("byNumber", {}).get(_norm_supplier(nr), []))

    # Falls Parser die Rechnungsnummer im PDF nicht sauber erkannt hat:
    # nur Fallback-Dokumente + maximal einige Kandidaten prüfen, nicht den ganzen Katalog.
    if not candidates:
        candidates = list(lookup.get("fallback", []))[:250]

    best = None
    best_score = 0
    for item in candidates:
        score = _pdf_match_score_for_ww(item, ww)
        if score > best_score:
            best_score = score
            best = item

    result = dict(ww)
    if best is not None and best_score >= 70:
        pub = _incoming_public_item(best)
        pub.update({
            "wwIncomingId": ww.get("wwIncomingId"),
            "invoiceNumber": ww.get("invoiceNumber"),
            "invoiceDate": ww.get("invoiceDate"),
            "invoiceDateTime": ww.get("invoiceDateTime"),
            "year": ww.get("year"),
            "month": ww.get("month"),
            "monthName": ww.get("monthName"),
            "day": ww.get("day"),
            "amount": ww.get("amount"),
            "netAmount": ww.get("netAmount"),
            "vatAmount": ww.get("vatAmount"),
            "paymentStatus": ww.get("paymentStatus"),
            "paymentStatusCode": ww.get("paymentStatusCode"),
            "iban": ww.get("iban"),
            "swift": ww.get("swift"),
            "accountHolder": ww.get("accountHolder"),
            "gDMID": ww.get("gDMID"),
            "sourceOfTruth": "WinWorker Eingangsbelege",
            "pdfMatchScore": best_score,
        })
        return pub

    result.update({
        "filename": "",
        "path": "",
        "logical_id": "",
        "invoiceId": f"ww:{ww.get('wwIncomingId')}",
        "dokumenttyp": "Eingangsrechnung",
        "snippet": "",
        "fingerprint": {},
        "pdfMatchScore": best_score,
    })
    return result


def incoming_watch_alerts(address_id, ww_rows=None):
    """
    Stammdatenwächter:
    Erkennt einen Wechsel der Bankverbindung beim selben WW-Lieferanten.
    Zeigt nur den jüngsten echten Wechsel und lässt ihn in Brain quittieren.
    """
    rows = list(ww_rows if ww_rows is not None else ww_incoming_for_address(address_id))
    rows.sort(key=lambda x: (x.get("invoiceDate") or "", x.get("wwIncomingId") or 0))

    bank_rows = [r for r in rows if _norm_iban(r.get("iban"))]
    if len(bank_rows) < 2:
        return []

    latest = bank_rows[-1]
    latest_iban = _norm_iban(latest.get("iban"))
    previous = None
    for r in reversed(bank_rows[:-1]):
        if _norm_iban(r.get("iban")) != latest_iban:
            previous = r
            break
    if previous is None:
        return []

    prev_iban = _norm_iban(previous.get("iban"))
    alert_key = f"bank:{latest_iban}"
    acks = _load_brain_supplier_map().get("watchAcks", {}).get(str(address_id), {})
    if acks.get(alert_key):
        return []

    return [{
        "key": alert_key,
        "type": "bank_change",
        "severity": "warning",
        "title": "Neue Bankverbindung erkannt",
        "message": "WinWorker zeigt bei neueren Eingangsbelegen eine andere IBAN als zuvor.",
        "previousIban": prev_iban,
        "currentIban": latest_iban,
        "previousInvoice": previous.get("invoiceNumber") or "",
        "currentInvoice": latest.get("invoiceNumber") or "",
        "previousDate": previous.get("invoiceDate") or "",
        "currentDate": latest.get("invoiceDate") or "",
        "previousHolder": previous.get("accountHolder") or "",
        "currentHolder": latest.get("accountHolder") or "",
    }]


def acknowledge_watch_alert(address_id, alert_key, decision="known"):
    address_id = str(address_id or "").strip()
    alert_key = str(alert_key or "").strip()
    if not address_id or not alert_key:
        raise ValueError("Adresse oder Hinweis fehlt.")
    data = _load_brain_supplier_map()
    bucket = data.setdefault("watchAcks", {}).setdefault(address_id, {})
    bucket[alert_key] = {
        "decision": str(decision or "known"),
        "at": datetime.now().isoformat(timespec="seconds"),
    }
    _save_brain_supplier_map(data)
    return bucket[alert_key]



def _ww_dokman_paths(doc_id, invoice_date=""):
    """Findet ein frisches WW-PDF direkt, noch bevor der Nachtindex gelaufen ist."""
    doc_id = str(doc_id or "").strip()
    if not re.fullmatch(r"\d+", doc_id):
        return {}

    date_match = re.match(r"^(20\d{2})-(0[1-9]|1[0-2])", str(invoice_date or ""))
    year_months = []
    if date_match:
        year_months.append((date_match.group(1), date_match.group(2)))
    else:
        prefix = str(CAPTURE_PREFIX or "").strip()
        if prefix and doc_id.startswith(prefix) and len(doc_id) >= len(prefix) + 2:
            yy = doc_id[len(prefix):len(prefix) + 2]
            if yy.isdigit():
                year_months.extend((f"20{yy}", f"{month:02d}") for month in range(1, 13))

    for year, month in year_months:
        folder = DOKMAN_ROOT / year / month
        processed = folder / f"{doc_id}.pdf"
        original = folder / f"{doc_id}_Original.pdf"
        processed_path = str(processed) if processed.is_file() else ""
        original_path = str(original) if original.is_file() else ""
        if processed_path or original_path:
            return {
                "pdfPath": processed_path,
                "originalPath": original_path,
                "pdfText": "",
                "originalText": "",
                "ocrTexts": [],
            }
    return {}


def _index_live_ww_pdf(doc_id, found, invoice_date=""):
    """Nimmt genau den über WW referenzierten Beleg sofort in den PDF-Index auf."""
    pdf_path = str(found.get("pdfPath") or "")
    original_path = str(found.get("originalPath") or "")
    primary = Path(pdf_path or original_path)
    if not primary.is_file():
        return False

    date_match = re.match(r"^(20\d{2})-(0[1-9]|1[0-2])", str(invoice_date or ""))
    doc_year = int(date_match.group(1)) if date_match else None
    doc_month = int(date_match.group(2)) if date_match else None
    stat = primary.stat()
    indexed_at = datetime.now().isoformat(timespec="seconds")

    con = sqlite3.connect(DB, timeout=15)
    try:
        con.execute("PRAGMA busy_timeout=15000")
        row = con.execute(
            "SELECT rowid FROM pdf_index WHERE path=? OR filename=? ORDER BY path=? DESC LIMIT 1",
            (str(primary), primary.name, str(primary)),
        ).fetchone()
        values = (
            primary.name, str(primary), "Eingangsrechnung", float(stat.st_mtime),
            int(stat.st_size), "EINGANG", doc_year, doc_month, str(doc_id),
            original_path or None, int(stat.st_size), indexed_at,
        )
        if row:
            con.execute("""
                UPDATE pdf_index
                SET filename=?, path=?, dokumenttyp=?, modified=?, size=?, source=?,
                    doc_year=?, doc_month=?, logical_id=?, original_path=?,
                    file_size=?, indexed_at=?
                WHERE rowid=?
            """, values + (int(row[0]),))
        else:
            con.execute("""
                INSERT INTO pdf_index
                (filename, path, dokumenttyp, modified, size, source, doc_year,
                 doc_month, logical_id, original_path, file_size, indexed_at, text)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?, '')
            """, values)
        con.commit()
        return True
    except Exception as exc:
        print(f"WW-PDF konnte nicht sofort indexiert werden ({doc_id}): {exc}")
        return False
    finally:
        con.close()


def _pdf_paths_by_docids(doc_ids, include_text=False, invoice_dates=None):
    """
    Exakte WW-Verknüpfung:
    DokumentenManagement.sDocID == PDF-Dateiname ohne .pdf/_Original.pdf.

    Für die normale Lieferantenakte werden nur Pfade gelesen. Erst bei einer
    gezielten Materialsuche wird zusätzlich der bereits indexierte OCR-/PDF-Text
    geladen. Dadurch bleibt die normale Ansicht schnell.
    """
    wanted = {str(x or "").strip() for x in doc_ids if str(x or "").strip()}
    if not wanted:
        return {}

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(pdf_index)").fetchall()}
        has_source = "source" in cols
        has_text = bool(include_text and "text" in cols)
        result = {}

        ids = sorted(wanted)
        for pos in range(0, len(ids), 400):
            chunk = ids[pos:pos+400]
            conditions = []
            params = []
            for doc_id in chunk:
                conditions.append("(filename = ? OR filename = ?)")
                params.extend([f"{doc_id}.pdf", f"{doc_id}_Original.pdf"])

            select = "filename,path" + (",text" if has_text else "")
            sql = f"SELECT {select} FROM pdf_index WHERE (" + " OR ".join(conditions) + ")"
            if has_source:
                sql += " AND source='EINGANG'"

            for row in con.execute(sql, params).fetchall():
                fn = str(row["filename"] or "")
                pdf_path = str(row["path"] or "")
                m = re.match(r"^(\d+)(?:_Original)?\.pdf$", fn, re.I)
                if not m:
                    continue
                doc_id = m.group(1)
                bucket = result.setdefault(doc_id, {
                    "pdfPath": "",
                    "originalPath": "",
                    "pdfText": "",
                    "originalText": "",
                    "ocrTexts": [],
                })
                raw_text = str(row["text"] or "") if has_text else ""
                is_original = bool(re.search(r"_Original\.pdf$", fn, re.I))
                if is_original:
                    bucket["originalPath"] = pdf_path or bucket["originalPath"]
                    if len(raw_text) > len(bucket["originalText"]):
                        bucket["originalText"] = raw_text
                else:
                    bucket["pdfPath"] = pdf_path or bucket["pdfPath"]
                    if len(raw_text) > len(bucket["pdfText"]):
                        bucket["pdfText"] = raw_text

        for bucket in result.values():
            seen_texts = set()
            texts = []
            for raw_text in (bucket.get("pdfText"), bucket.get("originalText")):
                value = str(raw_text or "").strip()
                if not value:
                    continue
                fingerprint = hashlib.sha1(value.encode("utf-8", errors="ignore")).hexdigest()
                if fingerprint in seen_texts:
                    continue
                seen_texts.add(fingerprint)
                texts.append(value)
            bucket["ocrTexts"] = texts
    finally:
        con.close()

    # WW-Belege sind sofort in der Datenbank sichtbar. Der große PDF-Index läuft
    # dagegen nachts. Darum fehlende, aber eindeutig benannte Dokumente direkt
    # im WW-Dokumentenspeicher nachschlagen.
    dates = invoice_dates or {}
    for doc_id in wanted.difference(result):
        invoice_date = dates.get(doc_id, "")
        found = _ww_dokman_paths(doc_id, invoice_date)
        if found and _index_live_ww_pdf(doc_id, found, invoice_date):
            result[doc_id] = found
    return result


_MATERIAL_END_MARKERS = (
    "rechnungsbetrag", "endbetrag", "zahlbetrag", "zu zahlen",
    "nettobetrag", "nettowarenwert", "warenwert netto", "summe netto",
    "gesamt netto", "umsatzsteuer", "mehrwertsteuer", "mwst",
    "ust basis", "ust betrag", "zahlungsbedingungen", "zahlungsziel",
    "bankverbindung", "iban", "bic", "swift", "skonto",
)

_MATERIAL_NOISE_MARKERS = (
    "rechnungsnummer", "rechnung nr", "rechnungs nr", "belegnummer",
    "kundennummer", "kunden nr", "lieferantennummer", "lieferanten nr",
    "rechnungsdatum", "lieferdatum", "leistungsdatum", "bestelldatum",
    "lieferschein nr", "lieferscheinnummer", "ihre bestellung",
    "bestellung vom", "bestellnummer", "bestell nr", "auftragsnummer",
    "auftrag nr", "lieferadresse", "rechnungsadresse", "bearbeiter",
    "ansprechpartner", "telefon", "fax", "email", "e mail", "www",
    "uid", "ust id", "bankverbindung", "iban", "bic", "swift",
    "zahlungsbedingungen", "zahlungsziel", "seite", "blatt",
)

_MATERIAL_SEARCH_CACHE = {}
_MATERIAL_SEARCH_CACHE_LIMIT = 1200


def _material_header_score(line):
    n = _norm_supplier(line)
    if not n:
        return 0
    score = 0
    if "bezeichnung" in n or "beschreibung" in n:
        score += 3
    if re.search(r"\b(artikel|artikelnummer|artnr|art nr|produkt)\b", n):
        score += 2
    if re.search(r"\b(pos|position)\b", n):
        score += 1
    if "menge" in n:
        score += 2
    if re.search(r"\b(einheit|eh|me)\b", n):
        score += 1
    if "preis" in n or "einzelpreis" in n:
        score += 2
    if "betrag" in n or "gesamtpreis" in n:
        score += 2
    return score


def _is_material_header(line):
    n = _norm_supplier(line)
    score = _material_header_score(line)
    if not n:
        return False
    if ("bezeichnung" in n or "beschreibung" in n) and score >= 5:
        return True
    if re.search(r"\b(artikel|artikelnummer|artnr|art nr)\b", n) and "menge" in n and score >= 5:
        return True
    return score >= 7


def _is_material_end_line(line):
    n = _norm_supplier(line)
    if not n:
        return False
    if any(marker in n for marker in _MATERIAL_END_MARKERS):
        return True
    return bool(re.search(r"\b(zwischensumme|gesamtsumme|bruttosumme)\b", n))


def _is_material_noise_line(line):
    clean = re.sub(r"\s+", " ", str(line or "")).strip()
    n = _norm_supplier(clean)
    if not n:
        return True
    if _is_material_header(clean) or _is_material_end_line(clean):
        return True
    for marker in _MATERIAL_NOISE_MARKERS:
        if marker in {"seite", "blatt"}:
            if re.match(rf"^{marker}\b", n):
                return True
        elif marker in {"uid", "iban", "bic", "swift", "telefon", "fax", "email", "www", "bearbeiter", "ansprechpartner"}:
            if re.search(rf"\b{re.escape(marker)}\b", n):
                return True
        elif marker in n:
            return True
    if n in {"rechnung", "gutschrift", "lieferschein", "angebot", "ubertrag", "übertrag"}:
        return True
    if re.fullmatch(r"(?:seite|blatt)?\s*\d+\s*(?:von|\/)?\s*\d*", n):
        return True
    return False


def _looks_like_material_line(line):
    clean = re.sub(r"\s+", " ", str(line or "")).strip()
    if _is_material_noise_line(clean):
        return False
    has_word = bool(re.search(r"[A-Za-zÄÖÜäöüß]{3,}", clean))
    has_number = bool(re.search(r"\d", clean))
    has_unit = bool(re.search(
        r"(?i)\b(?:stk|stck|stück|kg|g|to|t|l|lt|liter|ml|m|m2|m²|m3|m³|lfm|sack|skt|pkg|pack|dose|eimer|kanister|rolle|paar|set)\b",
        clean,
    ))
    has_article_code = bool(re.search(
        r"\b(?=[A-Z0-9._/-]{4,}\b)(?=[A-Z0-9._/-]*\d)[A-Z0-9][A-Z0-9._/-]{3,}\b",
        clean,
        re.I,
    ))
    return bool((has_word and has_number) or has_unit or (has_word and has_article_code))


def _material_flat_segment(raw_text):
    flat = re.sub(r"\s+", " ", str(raw_text or "")).strip()
    if not flat:
        return ""

    start_patterns = (
        r"(?i)\b(?:pos(?:ition)?|artikel(?:nummer)?|art\.?\s*nr\.?)\b.{0,100}\b(?:bezeichnung|beschreibung)\b.{0,100}\b(?:menge|preis|betrag|gesamtpreis)\b",
        r"(?i)\b(?:bezeichnung|beschreibung)\b.{0,80}\bmenge\b.{0,80}\b(?:preis|betrag|gesamtpreis)\b",
    )
    starts = []
    for pattern in start_patterns:
        m = re.search(pattern, flat)
        if m:
            starts.append(m.end())
    if not starts:
        return ""
    start = min(starts)

    tail = flat[start:]
    stop_positions = []
    for marker in _MATERIAL_END_MARKERS + ("zwischensumme", "gesamtsumme", "bruttosumme"):
        m = re.search(rf"(?i)\b{re.escape(marker)}\b", tail)
        if m:
            stop_positions.append(m.start())
    end = start + (min(stop_positions) if stop_positions else len(tail))
    segment = flat[start:end].strip(" ·|-")
    return segment if len(segment) >= 12 else ""


def _material_search_lines(raw_text):
    raw = str(raw_text or "").replace("\x00", " ")
    lines = [re.sub(r"\s+", " ", row).strip() for row in raw.splitlines()]
    lines = [row for row in lines if row]
    if not lines:
        return [], "none"

    header_indices = set()
    for index, line in enumerate(lines):
        if _is_material_header(line):
            header_indices.add(index)
            # Eine bereits erkennbare Kopfzeile kann noch eine kurze Fortsetzung
            # wie „Einzelpreis · Betrag“ direkt darunter haben.
            for offset in (1, 2):
                next_index = index + offset
                if next_index >= len(lines):
                    break
                next_line = lines[next_index]
                if _material_header_score(next_line) <= 0 or _looks_like_material_line(next_line):
                    break
                if _is_material_header(" ".join(lines[index:next_index+1])):
                    header_indices.add(next_index)
            continue

        # Manche PDFs teilen die Tabellenüberschrift auf zwei oder drei Zeilen.
        # Nur Zeilen mit echten Überschriftswörtern markieren – niemals bereits
        # die erste Materialposition hinter der Überschrift mit verschlucken.
        for span in (2, 3):
            parts = lines[index:index+span]
            if len(parts) != span or not _is_material_header(" ".join(parts)):
                continue
            marked = [index + offset for offset, part in enumerate(parts) if _material_header_score(part) > 0]
            if len(marked) >= 2:
                header_indices.update(marked)
                break

    regions = []
    current = []
    in_table = False
    for index, line in enumerate(lines):
        if index in header_indices:
            if current:
                regions.append(current)
                current = []
            in_table = True
            continue
        if in_table and _is_material_end_line(line):
            if current:
                regions.append(current)
                current = []
            in_table = False
            continue
        if in_table and not _is_material_noise_line(line):
            current.append(line)
    if current:
        regions.append(current)

    table_lines = [line for region in regions for line in region]
    if table_lines:
        return table_lines, "table"

    flat_segment = _material_flat_segment(raw)
    if flat_segment:
        return [flat_segment], "flat-table"

    # Konservativer Rückfall für schlecht strukturierte Scans: nur der mittlere
    # Dokumentbereich und nur zeilenartige Materialkandidaten samt Nachbarzeilen.
    start = max(3, int(len(lines) * 0.08))
    end = max(start + 1, int(len(lines) * 0.90))
    eligible = set()
    for index in range(start, min(end, len(lines))):
        if _looks_like_material_line(lines[index]):
            eligible.update({index - 1, index, index + 1})

    fallback = []
    for index in sorted(i for i in eligible if start <= i < end and 0 <= i < len(lines)):
        line = lines[index]
        if not _is_material_noise_line(line):
            fallback.append(line)
    return fallback, "fallback" if fallback else "none"


def _material_search_index(raw_text):
    raw = str(raw_text or "")
    if not raw.strip():
        return {"lines": [], "mode": "none", "joinedNorm": "", "joinedCompact": ""}
    key = hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()
    cached = _MATERIAL_SEARCH_CACHE.get(key)
    if cached is not None:
        return cached

    lines, mode = _material_search_lines(raw)
    joined = " ".join(lines)
    data = {
        "lines": lines,
        "mode": mode,
        "joinedNorm": _norm_supplier(joined),
        "joinedCompact": _compact_search_value(joined),
    }
    if len(_MATERIAL_SEARCH_CACHE) >= _MATERIAL_SEARCH_CACHE_LIMIT:
        _MATERIAL_SEARCH_CACHE.clear()
    _MATERIAL_SEARCH_CACHE[key] = data
    return data


def _compact_search_value(value):
    return re.sub(r"[^a-z0-9äöü]+", "", str(value or "").lower().replace("ß", "ss"))


def _focus_material_snippet(value, query, limit=560):
    compact = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(compact) <= limit:
        return compact
    low = compact.lower()
    raw_terms = [part for part in re.split(r"\s+", str(query or "").strip()) if part]
    positions = [low.find(term.lower()) for term in raw_terms if low.find(term.lower()) >= 0]
    pos = min(positions) if positions else max(0, len(compact) // 2)
    start = max(0, pos - 170)
    end = min(len(compact), start + limit)
    start = max(0, end - limit)
    return ("… " if start else "") + compact[start:end].strip() + (" …" if end < len(compact) else "")


def _material_search_result(raw_text, text_query):
    query = str(text_query or "").strip()
    qnorm = _norm_supplier(query)
    qcompact = _compact_search_value(query)
    tokens = [token for token in qnorm.split() if token]
    if not query or (not tokens and not qcompact):
        return {
            "matched": False, "searchable": False, "matchCount": 0,
            "ideal": False, "score": 0, "matches": [], "mode": "none",
        }

    search_index = _material_search_index(raw_text)
    lines = search_index["lines"]
    mode = search_index["mode"]
    if not lines:
        return {
            "matched": False, "searchable": False, "matchCount": 0,
            "ideal": False, "score": 0, "matches": [], "mode": mode,
        }

    joined = " ".join(lines)
    joined_norm = search_index["joinedNorm"]
    joined_compact = search_index["joinedCompact"]

    phrase_count = joined_norm.count(qnorm) if qnorm else 0
    compact_count = joined_compact.count(qcompact) if len(qcompact) >= 3 else 0
    token_counts = [joined_norm.count(token) for token in tokens]
    body_match = bool(
        phrase_count > 0 or
        compact_count > 0 or
        (tokens and all(count > 0 for count in token_counts))
    )
    if not body_match:
        return {
            "matched": False, "searchable": True, "matchCount": 0,
            "ideal": False, "score": 0, "matches": [], "mode": mode,
        }

    matches = []
    seen = set()
    ideal = False
    best_window_score = 0
    for index in range(len(lines)):
        start = max(0, index - 1)
        end = min(len(lines), index + 3)
        window = " · ".join(lines[start:end])
        wnorm = _norm_supplier(window)
        wcompact = _compact_search_value(window)
        token_window = bool(tokens and all(token in wnorm for token in tokens))
        compact_window = bool(len(qcompact) >= 3 and qcompact in wcompact)
        phrase_window = bool(qnorm and qnorm in wnorm)
        if not (phrase_window or compact_window or token_window):
            continue
        exact = phrase_window or compact_window
        ideal = ideal or exact
        window_score = 100 if exact else 70
        best_window_score = max(best_window_score, window_score)
        snippet = _focus_material_snippet(window, query)
        key = _norm_supplier(snippet)
        if key and key not in seen:
            seen.add(key)
            matches.append(snippet)
        if len(matches) >= 5:
            break

    if not matches:
        matches = [_focus_material_snippet(joined, query)]

    if phrase_count > 0:
        match_count = phrase_count
    elif compact_count > 0:
        match_count = compact_count
    elif token_counts:
        match_count = min(token_counts)
    else:
        match_count = 1
    match_count = max(1, int(match_count or 1))
    score = (1000 if ideal else 0) + best_window_score + min(match_count, 99) * 10

    return {
        "matched": True,
        "searchable": True,
        "matchCount": match_count,
        "ideal": bool(ideal),
        "score": score,
        "matches": matches,
        "mode": mode,
    }


def _best_material_search(texts, text_query):
    best = None
    searchable = False
    for raw_text in texts or []:
        result = _material_search_result(raw_text, text_query)
        searchable = searchable or bool(result.get("searchable"))
        if not result.get("matched"):
            continue
        if best is None or (
            int(result.get("score") or 0),
            int(result.get("matchCount") or 0),
        ) > (
            int(best.get("score") or 0),
            int(best.get("matchCount") or 0),
        ):
            best = result
    if best is not None:
        return best
    return {
        "matched": False, "searchable": searchable, "matchCount": 0,
        "ideal": False, "score": 0, "matches": [], "mode": "none",
    }


def incoming_for_address(address_id, text_query="", return_context=False):
    """
    WW sofort + exakte PDF-Verknüpfung über:
    Eingangsbelege.gDMID -> DokumentenManagement.gID -> sDocID -> PDF-Dateiname.

    Eine Textsuche arbeitet ausschließlich im OCR-Materialbereich der PDFs.
    Kopfzeilen wie Datum, Rechnungsnummer, Kundennummer oder Zahlungsdaten sind
    bewusst kein Suchraum.
    """
    address_id = str(address_id or "").strip()
    if not address_id:
        empty = {
            "documents": [], "allDocuments": [], "search": {"active": False},
            "wwRows": [], "localRows": [],
        }
        return empty if return_context else []

    query = str(text_query or "").strip()
    search_active = bool(query)
    ww_rows = ww_incoming_for_address(address_id)
    local_rows = kristine_incoming_for_address(address_id, include_text=search_active)
    paths = _pdf_paths_by_docids(
        [x.get("docId") for x in ww_rows],
        include_text=search_active,
        invoice_dates={
            str(x.get("docId") or "").strip(): str(
                x.get("recordedAt") or x.get("invoiceDate") or ""
            )
            for x in ww_rows
            if str(x.get("docId") or "").strip()
        },
    )

    all_result = []
    ocr_invoices = 0
    material_searchable = 0
    pdf_linked = 0
    total_matches = 0
    ideal_hits = 0

    def apply_material_search(item, texts):
        nonlocal ocr_invoices, material_searchable, total_matches, ideal_hits
        clean_texts = [str(value or "") for value in (texts or []) if str(value or "").strip()]
        if clean_texts:
            ocr_invoices += 1
        result = _best_material_search(clean_texts, query) if search_active else None
        if not search_active:
            return
        if result.get("searchable"):
            material_searchable += 1
        item["materialMatched"] = bool(result.get("matched"))
        item["materialMatchCount"] = int(result.get("matchCount") or 0)
        item["materialMatchIdeal"] = bool(result.get("ideal"))
        item["materialMatchScore"] = int(result.get("score") or 0)
        item["materialMatches"] = list(result.get("matches") or [])
        item["materialSearchMode"] = str(result.get("mode") or "none")
        if item["materialMatched"]:
            total_matches += item["materialMatchCount"]
            ideal_hits += 1 if item["materialMatchIdeal"] else 0

    for ww in ww_rows:
        doc_id = str(ww.get("docId") or "").strip()
        found = paths.get(doc_id, {})
        pdf_path = found.get("pdfPath") or ""
        original_path = found.get("originalPath") or ""
        if pdf_path or original_path:
            pdf_linked += 1

        item = dict(ww)
        item.update({
            "filename": Path(pdf_path).name if pdf_path else (Path(original_path).name if original_path else (f"{doc_id}.pdf" if doc_id else "")),
            "path": pdf_path or original_path,
            "originalPath": original_path if original_path and original_path != (pdf_path or original_path) else "",
            "logical_id": doc_id,
            "invoiceId": f"ww:{ww.get('wwIncomingId')}",
            "dokumenttyp": "Eingangsrechnung",
            "snippet": "",
            "fingerprint": {},
            "pdfLinked": bool(pdf_path or original_path),
        })
        apply_material_search(item, found.get("ocrTexts") or [])
        all_result.append(item)

    for local in local_rows:
        item = dict(local)
        pdf_text = str(item.pop("pdfText", "") or "")
        if item.get("path"):
            pdf_linked += 1
        apply_material_search(item, [pdf_text] if pdf_text else [])
        if search_active:
            # In der Trefferansicht niemals wieder den kompletten Rechnungskopf
            # als Snippet zeigen – nur die erkannten Materialzeilen.
            item["snippet"] = ""
        all_result.append(item)

    if search_active:
        documents = [item for item in all_result if item.get("materialMatched")]
        documents.sort(
            key=lambda x: (
                1 if x.get("materialMatchIdeal") else 0,
                int(x.get("materialMatchScore") or 0),
                int(x.get("materialMatchCount") or 0),
                x.get("invoiceDateTime") or "",
                str(x.get("docId") or ""),
            ),
            reverse=True,
        )
    else:
        documents = list(all_result)
        documents.sort(
            key=lambda x: (
                x.get("invoiceDateTime") or "",
                str(x.get("docId") or ""),
                int(x.get("id") or 0),
            ),
            reverse=True,
        )

    search_meta = {
        "active": search_active,
        "query": query,
        "scope": "selected_supplier",
        "addressId": address_id,
        "scannedInvoices": len(all_result),
        "pdfLinkedInvoices": pdf_linked,
        "ocrInvoices": ocr_invoices if search_active else 0,
        "materialSearchableInvoices": material_searchable if search_active else 0,
        "withoutOcr": max(0, len(all_result) - ocr_invoices) if search_active else 0,
        "hitInvoices": len(documents) if search_active else 0,
        "matchCount": total_matches if search_active else 0,
        "idealHitInvoices": ideal_hits if search_active else 0,
    }

    if return_context:
        return {
            "documents": documents,
            "allDocuments": all_result,
            "search": search_meta,
            "wwRows": ww_rows,
            "localRows": local_rows,
        }
    return documents


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
        if _negative_match(item, address_id, supplier_map):
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


def _fingerprint_signature(fp):
    """Stable supplier identity hints. Never use invoice number/date/amount."""
    out=[]
    customer=str(fp.get("customerNumberExternal") or "").strip()
    uid=str(fp.get("uid") or "").strip().upper()
    iban=str(fp.get("iban") or "").strip().upper()
    if customer:
        out.append("customer:"+_norm_supplier(customer))
    if uid:
        out.append("uid:"+_norm_supplier(uid))
    if iban:
        out.append("iban:"+_norm_supplier(iban))
    return [x for x in out if x.split(":",1)[-1]]


def _negative_match(item, address_id, supplier_map):
    bucket=set(supplier_map.get("negativeFingerprints", {}).get(str(address_id), []))
    if not bucket:
        return False
    fp=_extract_supplier_fingerprint(str(item.get("_raw_text") or ""))
    return bool(bucket.intersection(_fingerprint_signature(fp)))


def reject_invoice_for_address(address_id, invoice_id):
    address_id = str(address_id or "").strip()
    invoice_id = str(invoice_id or "").strip()
    if not address_id or not invoice_id:
        raise ValueError("Adresse oder Rechnung fehlt.")

    data = _load_brain_supplier_map()
    bucket = data.setdefault("rejections", {}).setdefault(address_id, [])
    if invoice_id not in bucket:
        bucket.append(invoice_id)

    learned_negative=[]
    for item in _incoming_catalog():
        if _invoice_identity(item) != invoice_id:
            continue
        fp=_extract_supplier_fingerprint(str(item.get("_raw_text") or ""))
        learned_negative=_fingerprint_signature(fp)
        neg=data.setdefault("negativeFingerprints", {}).setdefault(address_id, [])
        for sig in learned_negative:
            if sig not in neg:
                neg.append(sig)
        break

    _save_brain_supplier_map(data)
    return data, learned_negative


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


def ww_material_master_rows():
    """Liest den aktiven WW-Materialstamm samt bevorzugtem Lieferanten und Preisen."""
    con = sql_connection("WinWorker_Stammdaten_Standard")
    try:
        rows = con.cursor().execute("""
            SELECT
                m.StammIndex AS SourceId,
                m.sKurztext AS Product,
                m.sGruppe AS MaterialGroup,
                m.sHersteller AS Manufacturer,
                m.sEinheit AS UnitName,
                COALESCE(NULLIF(li.EK, 0), NULLIF(m.gewEK, 0), NULLIF(m.EKFestpreis, 0), 0) AS PurchasePrice,
                COALESCE(NULLIF(m.VK, 0), NULLIF(m.gewVK, 0), NULLIF(m.cCalcVK, 0), 0) AS SalePrice,
                COALESCE(NULLIF(li.sFirma, ''), '') AS Supplier,
                COALESCE(NULLIF(li.sDNArtikelNr, ''), NULLIF(li.sBestellNr, ''), '') AS SupplierArticleNumber,
                COALESCE(NULLIF(li.sBestellNr, ''), '') AS OrderNumber,
                COALESCE(NULLIF(m.sCalcDNMatchCode, ''), NULLIF(li.sDNMatchCode, ''), '') AS MatchCode,
                COALESCE(NULLIF(v.sName, ''), '') AS DirectoryName,
                COALESCE(li.dzPreisStand, li.dzLetztePreisaenderung, m.dzLetztePreisaenderung, m.[Geändert], m.Aufgenommen) AS PriceCheckedAt,
                COALESCE(m.[Geändert], m.Aufgenommen) AS SourceUpdatedAt
            FROM dbo.Material AS m
            OUTER APPLY (
                SELECT TOP (1) info.*
                FROM dbo.MatLieferInfo_MIdx AS info
                WHERE info.MaterialIndex = m.StammIndex
                ORDER BY
                    CASE WHEN info.nLieferant = m.Lieferant THEN 0 ELSE 1 END,
                    COALESCE(info.dzPreisStand, info.dzLetztePreisaenderung, info.dzGeaendert, info.dzAufgenommen) DESC,
                    info.nLieferant
            ) AS li
            LEFT JOIN dbo.Verzeichnisse AS v ON v.gID = m.gVerzeichnis
            WHERE ISNULL(m.bIstMusterdatensatz, 0) = 0
              AND (m.dzAuslaufArtikel IS NULL OR m.dzAuslaufArtikel > GETDATE())
              AND NULLIF(LTRIM(RTRIM(m.sKurztext)), '') IS NOT NULL
            ORDER BY m.StammIndex
        """).fetchall()
    finally:
        con.close()

    materials = []
    for row in rows:
        source_id = str(int(row.SourceId))
        supplier_article = str(row.SupplierArticleNumber or "").strip()
        order_number = str(row.OrderNumber or "").strip()
        match_code = str(row.MatchCode or "").strip()
        materials.append({
            "sourceId": source_id,
            "materialId": source_id,
            "articleNumber": source_id,
            "product": str(row.Product or "").strip(),
            "group": str(row.MaterialGroup or "").strip(),
            "manufacturer": str(row.Manufacturer or "").strip(),
            "unit": str(row.UnitName or "").strip(),
            "purchasePrice": float(row.PurchasePrice or 0),
            "salePrice": float(row.SalePrice or 0),
            "supplier": str(row.Supplier or "").strip(),
            "supplierArticleNumber": supplier_article or order_number,
            "orderNumber": order_number,
            "matchCode": match_code,
            "directory": str(row.DirectoryName or "").strip(),
            "priceCheckedAt": clean_date(row.PriceCheckedAt),
            "sourceUpdatedAt": clean_date(row.SourceUpdatedAt),
            "active": True,
        })
    return materials




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
    Projektkennzahlen für The Brain.

    STUNDEN
    -------
    Produktive WinWorker-Stunden. Pro Mitarbeiter und Arbeitstag wird die
    unbezahlte 15-Minuten-Pause einmal proportional auf alle produktiven
    Projekte dieses Tages verteilt. Damit entspricht die Kennzahl der
    Nachkalkulationslogik von KRISTINE.

    UMSATZ
    ------
    Pro Projekt + Rechnungsnummer zählt nur die jüngste, nicht stornierte
    WinWorker-Version. Erst danach wird cUmsatzNetto summiert.
    """
    ids = sorted({int(x) for x in project_indices if x is not None})
    if not ids:
        return {}

    placeholders = ",".join("?" for _ in ids)
    result = {
        pid: {
            "hoursTotal": None,
            "hoursProductive": None,
            "hoursRecorded": None,
            "breakHours": None,
            "netInvoiced": None,
            "revenuePerHour": None,
            "hoursSource": None,
        }
        for pid in ids
    }

    # 1) Produktive Stunden inkl. proportionalem 15-Minuten-Abzug.
    try:
        rows = ww_hours_fusion_source(ids)
        sums = {
            pid: {"net": 0.0, "raw": 0.0, "break": 0.0, "seen": False}
            for pid in ids
        }
        for row in rows:
            pid = row.get("projectIndex")
            if pid not in sums:
                continue
            sums[pid]["net"] += float(row.get("netHours") or 0)
            sums[pid]["raw"] += float(row.get("rawHours") or 0)
            sums[pid]["break"] += float(row.get("breakHours") or 0)
            sums[pid]["seen"] = True

        for pid, values in sums.items():
            if not values["seen"]:
                continue
            productive = round(values["net"], 4)
            result[pid]["hoursTotal"] = productive
            result[pid]["hoursProductive"] = productive
            result[pid]["hoursRecorded"] = round(values["raw"], 4)
            result[pid]["breakHours"] = round(values["break"], 4)
            result[pid]["hoursSource"] = "WinWorker produktiv · 15 Min anteilig abgezogen"
    except Exception as e:
        print("SQL produktive Stunden-Metrik FEHLER:", repr(e))

        # Rückfall: wenigstens produktive Rohstunden liefern, falls die
        # tageweise Fusion auf einer älteren WW-Struktur nicht möglich ist.
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
                  AND ISNULL(sm.bUnproduktiv, 0) = 0
                GROUP BY sm.ProjektIndex
            """
            rows = cur.execute(sql, *ids).fetchall()
            con.close()
            for row in rows:
                pid = int(row.ProjektIndex)
                if pid not in result:
                    continue
                hours = float(row.IstStunden) if row.IstStunden is not None else None
                result[pid]["hoursTotal"] = hours
                result[pid]["hoursProductive"] = hours
                result[pid]["hoursRecorded"] = hours
                result[pid]["breakHours"] = None
                result[pid]["hoursSource"] = "WinWorker produktive Rohstunden · Pause nicht abziehbar"
        except Exception as fallback_error:
            print("SQL Stunden-Fallback FEHLER:", repr(fallback_error))

    # 2) Aktueller Netto-Abrechnungsstand.
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
                        ORDER BY VersionZeit DESC, gID DESC
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

    for metric in result.values():
        hours = metric.get("hoursProductive")
        revenue = metric.get("netInvoiced")
        if hours is not None and hours > 0 and revenue is not None:
            metric["revenuePerHour"] = round(float(revenue) / float(hours), 2)

    return result


def _project_row_to_dict(row):
    street = row.sStrasse or ""
    postal = row.sPLZ or ""
    city = row.sOrt or ""
    address = " ".join(x for x in [street, postal, city] if x).strip()
    customer = " ".join(
        x for x in [row.sVorname or "", row.sName or ""] if x
    ).strip()

    return {
        "projectIndex": int(row.ProjektIndex) if row.ProjektIndex is not None else None,
        "projectNumber": row.sProjektNummer or "",
        "title": row.sProjekt or row.sBaustelle or row.sBauvorhaben or "",
        "site": row.sBaustelle or "",
        "projectDescription": row.sBauvorhaben or "",
        "customerIndex": int(row.KundenIndex) if row.KundenIndex is not None else None,
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
    }


def _attach_project_metrics(projects):
    metrics = project_metrics([item.get("projectIndex") for item in projects])
    for item in projects:
        project_index = item.get("projectIndex")
        metric = metrics.get(int(project_index)) if project_index is not None else None
        metric = metric or {}
        item["hoursTotal"] = metric.get("hoursTotal")
        item["hoursProductive"] = metric.get("hoursProductive")
        item["hoursRecorded"] = metric.get("hoursRecorded")
        item["breakHours"] = metric.get("breakHours")
        item["hoursSource"] = metric.get("hoursSource")
        item["netInvoiced"] = metric.get("netInvoiced")
        item["revenuePerHour"] = metric.get("revenuePerHour")
    return projects


def search_projects(terms, include_metrics=True, limit=100):
    if not terms:
        return []

    limit = max(1, min(int(limit or 100), 500))
    con = sql_connection()
    cur = con.cursor()

    conditions = []
    params = []

    # Alle Suchbegriffe müssen irgendwo im Projekt, Kundenstamm oder in einer
    # WW-Belegnummer vorkommen. Dadurch funktioniert auch die Eingabe einer
    # Angebots-, Auftrags- oder Rechnungsnummer.
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
                OR EXISTS (
                    SELECT 1
                    FROM dbo.[Bücher] AS sb
                    WHERE sb.ProjektIndex = p.ProjektIndex
                      AND ISNULL(sb.sBuchNummer, '') LIKE ?
                )
            )
            """
        )
        params.extend([like] * 11)

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
        SELECT TOP {limit}
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
        LEFT JOIN dbo.[Bücher] AS b
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
        ORDER BY {order_by}
    """

    cur.execute(sql, params + order_params)
    rows = cur.fetchall()
    con.close()

    result = [_project_row_to_dict(row) for row in rows]
    if include_metrics:
        _attach_project_metrics(result)
    return result


def projects_for_customer(customer_index):
    customer_index = int(customer_index)
    con = sql_connection()
    cur = con.cursor()
    rows = cur.execute("""
        SELECT TOP 500
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
        LEFT JOIN dbo.[Bücher] AS b
            ON b.ProjektIndex = p.ProjektIndex
        WHERE p.KundenIndex = ?
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
            MAX(b.dzDocDatum) DESC,
            p.ProjektIndex DESC
    """, customer_index).fetchall()
    con.close()

    result = [_project_row_to_dict(row) for row in rows]
    return _attach_project_metrics(result)


def _customer_revenue_by_year(project_indices):
    ids = sorted({int(x) for x in project_indices if x is not None})
    if not ids:
        return []

    placeholders = ",".join("?" for _ in ids)
    con = sql_connection("WinWorker_Projekte_Standard")
    cur = con.cursor()
    rows = cur.execute(f"""
        WITH InvoiceRows AS (
            SELECT
                b.ProjektIndex,
                LTRIM(RTRIM(b.sBuchNummer)) AS sBuchNummer,
                r.cUmsatzNetto,
                COALESCE(
                    r.dzRechnungsdatum,
                    b.dzDocDatum,
                    b.Geändert,
                    b.dzInhaltGeaendert,
                    b.Aufgenommen
                ) AS Rechnungsdatum,
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
                Rechnungsdatum,
                ROW_NUMBER() OVER (
                    PARTITION BY ProjektIndex, sBuchNummer
                    ORDER BY VersionZeit DESC, gID DESC
                ) AS rn
            FROM InvoiceRows
        )
        SELECT
            YEAR(Rechnungsdatum) AS UmsatzJahr,
            SUM(CAST(cUmsatzNetto AS decimal(18,2))) AS NettoUmsatz,
            COUNT(*) AS BelegAnzahl
        FROM LatestPerInvoiceNumber
        WHERE rn = 1
        GROUP BY YEAR(Rechnungsdatum)
        ORDER BY UmsatzJahr DESC
    """, *ids).fetchall()
    con.close()

    result = []
    for row in rows:
        result.append({
            "year": int(row.UmsatzJahr) if row.UmsatzJahr is not None else None,
            "netRevenue": float(row.NettoUmsatz or 0),
            "invoiceCount": int(row.BelegAnzahl or 0),
        })
    return result


def company_planning_year(year):
    """Monatliche, deduplizierte WW-Rechnungsumsätze für den Tower."""
    year = int(year)
    con = sql_connection("WinWorker_Projekte_Standard")
    cur = con.cursor()
    rows = cur.execute("""
        WITH InvoiceRows AS (
            SELECT
                b.ProjektIndex,
                LTRIM(RTRIM(b.sBuchNummer)) AS sBuchNummer,
                r.cUmsatzNetto,
                COALESCE(r.dzRechnungsdatum,b.dzDocDatum,b.Geändert,b.dzInhaltGeaendert,b.Aufgenommen) AS Rechnungsdatum,
                COALESCE(b.Geändert,b.dzInhaltGeaendert,b.dzDocDatum,b.Aufgenommen) AS VersionZeit,
                b.gID
            FROM dbo.[Bücher] AS b
            INNER JOIN dbo.Rechnung AS r ON r.gBuchID = b.gID
            WHERE NULLIF(LTRIM(RTRIM(ISNULL(b.sBuchNummer, ''))), '') IS NOT NULL
              AND ISNULL(b.Storno, 0) = 0
              AND r.cUmsatzNetto IS NOT NULL
        ), LatestPerInvoiceNumber AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY ProjektIndex, sBuchNummer
                ORDER BY VersionZeit DESC, gID DESC
            ) AS rn
            FROM InvoiceRows
        )
        SELECT MONTH(Rechnungsdatum) AS UmsatzMonat,
               SUM(CAST(cUmsatzNetto AS decimal(18,2))) AS NettoUmsatz,
               COUNT(*) AS BelegAnzahl
        FROM LatestPerInvoiceNumber
        WHERE rn = 1 AND YEAR(Rechnungsdatum) = ?
        GROUP BY MONTH(Rechnungsdatum)
        ORDER BY UmsatzMonat
    """, year).fetchall()
    con.close()
    monthly = [{"month": i, "netRevenue": 0.0, "invoiceCount": 0} for i in range(1, 13)]
    for row in rows:
        month = int(row.UmsatzMonat)
        monthly[month - 1] = {
            "month": month,
            "netRevenue": float(row.NettoUmsatz or 0),
            "invoiceCount": int(row.BelegAnzahl or 0),
        }
    return {
        "year": year,
        "monthlyRevenue": monthly,
        "netRevenue": round(sum(x["netRevenue"] for x in monthly), 2),
        "invoiceCount": sum(x["invoiceCount"] for x in monthly),
        "revenueSource": "WinWorker Rechnungen netto · je Rechnungsnummer nur jüngste Version",
    }


def project_address_candidates(query, limit=30):
    terms = [x.strip() for x in str(query or "").split() if x.strip()]
    if not terms:
        return []

    projects = search_projects(
        terms,
        include_metrics=False,
        limit=max(100, min(int(limit or 30) * 8, 400)),
    )
    grouped = {}
    for project in projects:
        customer_index = project.get("customerIndex")
        if customer_index is not None:
            key = f"customer:{customer_index}"
        else:
            key = "address:" + hashlib.sha1(
                "|".join([
                    str(project.get("company") or ""),
                    str(project.get("customer") or ""),
                    str(project.get("address") or ""),
                ]).encode("utf-8", errors="ignore")
            ).hexdigest()[:16]

        if key not in grouped:
            display_name = project.get("company") or project.get("customer") or "Adresse"
            grouped[key] = {
                "key": key,
                "customerIndex": customer_index,
                "customerNumber": project.get("customerNumber"),
                "name": display_name,
                "company": project.get("company") or "",
                "person": project.get("customer") or "",
                "street": project.get("street") or "",
                "postalCode": project.get("postalCode") or "",
                "city": project.get("city") or "",
                "address": project.get("address") or "",
                "matchingProjectCount": 0,
                "sampleProjects": [],
                "lastDate": project.get("lastDate"),
            }

        candidate = grouped[key]
        candidate["matchingProjectCount"] += 1
        number = str(project.get("projectNumber") or "").strip()
        title = str(project.get("title") or "").strip()
        label = " · ".join(x for x in [number, title] if x)
        if label and label not in candidate["sampleProjects"] and len(candidate["sampleProjects"]) < 4:
            candidate["sampleProjects"].append(label)
        if str(project.get("lastDate") or "") > str(candidate.get("lastDate") or ""):
            candidate["lastDate"] = project.get("lastDate")

    qnorm = _norm_supplier(query)
    qcompact = re.sub(r"\s+", "", qnorm)

    def score(candidate):
        name = _norm_supplier(candidate.get("name"))
        address = _norm_supplier(candidate.get("address"))
        customer_no = _norm_supplier(candidate.get("customerNumber"))
        hay = " ".join([name, address, customer_no])
        value = 0
        if qnorm and name == qnorm:
            value += 1000
        elif qnorm and name.startswith(qnorm):
            value += 700
        if qnorm and qnorm in address:
            value += 350
        if qcompact and qcompact == re.sub(r"\s+", "", customer_no):
            value += 900
        value += min(int(candidate.get("matchingProjectCount") or 0), 50)
        return (-value, -int(candidate.get("matchingProjectCount") or 0), hay)

    rows = sorted(grouped.values(), key=score)
    return rows[:max(1, min(int(limit or 30), 100))]


def customer_project_overview(customer_index):
    projects = projects_for_customer(customer_index)
    ids = [p.get("projectIndex") for p in projects]
    try:
        yearly = _customer_revenue_by_year(ids)
    except Exception as e:
        print("SQL Jahresumsatz FEHLER:", repr(e))
        yearly = []

    revenue_values = [
        float(p["netInvoiced"])
        for p in projects
        if p.get("netInvoiced") is not None
    ]
    hour_values = [
        float(p["hoursProductive"])
        for p in projects
        if p.get("hoursProductive") is not None
    ]
    total_revenue = round(sum(revenue_values), 2) if revenue_values else None
    total_hours = round(sum(hour_values), 2) if hour_values else None

    comparable_projects = [
        project for project in projects
        if project.get("netInvoiced") is not None
        and project.get("hoursProductive") is not None
        and float(project.get("hoursProductive") or 0) > 0
    ]
    comparable_revenue = sum(float(project["netInvoiced"]) for project in comparable_projects)
    comparable_hours = sum(float(project["hoursProductive"]) for project in comparable_projects)
    revenue_per_hour = (
        round(comparable_revenue / comparable_hours, 2)
        if comparable_hours > 0
        else None
    )

    first = projects[0] if projects else {}
    overview = {
        "customerIndex": int(customer_index),
        "customerNumber": first.get("customerNumber"),
        "name": first.get("company") or first.get("customer") or "Adresse",
        "company": first.get("company") or "",
        "person": first.get("customer") or "",
        "address": first.get("address") or "",
        "projectCount": len(projects),
        "projectsWithRevenue": len(revenue_values),
        "projectsWithHours": len(hour_values),
        "projectsComparable": len(comparable_projects),
        "totalRevenue": total_revenue,
        "totalProductiveHours": total_hours,
        "revenuePerHour": revenue_per_hour,
        "revenueByYear": yearly,
        "revenueSource": "WinWorker Rechnungen netto · je Rechnungsnummer nur jüngste Version",
        "hoursSource": "WinWorker produktive Stunden · 15 Minuten pro MA/Tag anteilig abgezogen",
        "ratioSource": "Umsatz/Std. nur aus Projekten mit vollständig vorhandenem Umsatz und Stunden",
    }
    return overview, projects


def _normalize_project_identifier(value):
    return re.sub(r"[^A-Z0-9]+", "", str(value or "").upper())


def canonical_project_document_type(*values, is_invoice=False, ww_book_art=None):
    text = _norm_supplier(" ".join(str(v or "") for v in values))

    if re.search(r"\b(auftragssteuerung|auftrag steuerung|projektsteuerung)\b", text):
        return "Auftragssteuerung"
    if re.search(r"\b(nachkalkulation|vorkalkulation|kalkulation|kalkulationsblatt)\b", text):
        return "Kalkulation"
    if re.search(r"\b(schlussrechnung|schluss rechnung|endabrechnung|end abrechnung)\b", text):
        return "Schlussrechnung"
    if re.search(r"\b(teilrechnung|teil rechnung|abschlagsrechnung|akontorechnung|acontorechnung)\b", text):
        return "Teilrechnung"
    if re.search(r"\b(gutschrift|storno|stornorechnung)\b", text):
        return "Gutschrift / Storno"
    if re.search(r"\b(auftragsbestätigung|auftragsbestatigung|auftragsbestaetigung|auftrag bestätigung|auftrag bestatigung|auftrag bestaetigung)\b", text):
        return "Auftrag / Auftragsbestätigung"
    if re.search(r"\b(angebot|offerte|kostenvoranschlag)\b", text):
        return "Angebot"
    if re.search(r"\b(auftrag|bestellung)\b", text):
        return "Auftrag / Auftragsbestätigung"
    if re.search(r"\b(aufmass|aufmaß|massenermittlung)\b", text):
        return "Aufmaß"
    if re.search(r"\b(regiebericht|regie bericht|regiezettel)\b", text):
        return "Regiebericht"
    if re.search(r"\b(lieferschein)\b", text):
        return "Lieferschein"
    if re.search(r"\b(rechnung|faktura|invoice)\b", text) or is_invoice:
        return "Rechnung"
    if ww_book_art not in (None, ""):
        return "Weitere WW-Belege"
    return "Sonstige Dokumente"


def _project_pdf_rows(project_number, book_numbers=None, limit=600):
    project_number = str(project_number or "").strip()
    needles = []
    for value in [project_number] + list(book_numbers or []):
        value = str(value or "").strip()
        if len(value) >= 3 and value not in needles:
            needles.append(value)
    if not needles or not DB.exists():
        return []

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(pdf_index)").fetchall()}
        select = ["filename", "path", "dokumenttyp", "modified", "text"]
        for optional in ("source", "doc_year", "logical_id"):
            if optional in cols:
                select.append(optional)

        or_parts = []
        params = []
        for needle in needles[:80]:
            like = f"%{needle}%"
            or_parts.append("(text LIKE ? OR filename LIKE ? OR path LIKE ?)")
            params.extend([like, like, like])

        sql = "SELECT " + ",".join(select) + " FROM pdf_index WHERE (" + " OR ".join(or_parts) + ")"
        if "source" in cols:
            sql += " AND (source IS NULL OR source <> 'EINGANG')"
        else:
            sql += r" AND path NOT LIKE '%\Dokman\%'"
        sql += " ORDER BY modified DESC LIMIT ?"
        params.append(max(1, min(int(limit or 600), 1000)))
        rows = con.execute(sql, params).fetchall()
    finally:
        con.close()

    result = []
    seen = set()
    for row in rows:
        item = dict(row)
        path = str(item.get("path") or "")
        key = path.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        dt = parse_print_time(item.get("filename"), item.get("modified"))
        item["printDate"] = dt.date().isoformat() if dt else None
        item["printDateTime"] = dt.isoformat(timespec="seconds") if dt else None
        item["year"] = dt.year if dt else item.get("doc_year")
        item["_raw_text"] = item.pop("text", "") or ""
        item["pdfFound"] = True
        item["sourceOfTruth"] = "PDF-Archiv"
        result.append(item)
    return result



def _project_sql_ident(value):
    """SQL-Identifier ausschließlich aus gelesenen SQL-Metadaten quoten."""
    return "[" + str(value or "").replace("]", "]]" ) + "]"


def _project_type_priority(label):
    order = {
        "Angebot": 10,
        "Kalkulation": 20,
        "Auftrag / Auftragsbestätigung": 30,
        "Auftragssteuerung": 40,
        "Aufmaß": 50,
        "Teilrechnung": 60,
        "Schlussrechnung": 70,
        "Rechnung": 80,
        "Gutschrift / Storno": 90,
        "Regiebericht": 100,
        "Lieferschein": 110,
        "Weitere WW-Belege": 900,
        "Sonstige Dokumente": 999,
    }
    return order.get(label, 950)


def _ww_project_book_types(con, book_ids):
    """
    Erkennt Belegarten anhand der in dieser WW-Installation tatsächlich
    vorhandenen Tabellen mit gBuchID. Dadurch bleiben wir unabhängig von einer
    geratenen numerischen Buchart-Zuordnung.
    """
    original = [value for value in book_ids if value is not None]
    result = {str(value).lower(): set() for value in original}
    if not original:
        return result

    cur = con.cursor()
    try:
        candidates = cur.execute("""
            SELECT TABLE_SCHEMA, TABLE_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE LOWER(COLUMN_NAME) = 'gbuchid'
              AND (
                    LOWER(TABLE_NAME) LIKE '%angebot%'
                 OR LOWER(TABLE_NAME) LIKE '%auftrag%'
                 OR LOWER(TABLE_NAME) LIKE '%steuerung%'
                 OR LOWER(TABLE_NAME) LIKE '%kalk%'
                 OR LOWER(TABLE_NAME) LIKE '%rechnung%'
                 OR LOWER(TABLE_NAME) LIKE '%gutschrift%'
                 OR LOWER(TABLE_NAME) LIKE '%lieferschein%'
                 OR LOWER(TABLE_NAME) LIKE '%aufmass%'
                 OR LOWER(TABLE_NAME) LIKE '%aufmaß%'
                 OR LOWER(TABLE_NAME) LIKE '%regie%'
              )
            GROUP BY TABLE_SCHEMA, TABLE_NAME
        """).fetchall()
    except Exception as e:
        print("WW Belegart-Metadaten FEHLER:", repr(e))
        return result

    for table in candidates:
        label = canonical_project_document_type(table.TABLE_NAME)
        if label in {"Sonstige Dokumente", "Weitere WW-Belege"}:
            continue
        for pos in range(0, len(original), 350):
            chunk = original[pos:pos + 350]
            placeholders = ",".join("?" for _ in chunk)
            try:
                rows = cur.execute(
                    f"SELECT DISTINCT gBuchID FROM "
                    f"{_project_sql_ident(table.TABLE_SCHEMA)}.{_project_sql_ident(table.TABLE_NAME)} "
                    f"WHERE gBuchID IN ({placeholders})",
                    *chunk,
                ).fetchall()
            except Exception:
                continue
            for row in rows:
                result.setdefault(str(row.gBuchID).lower(), set()).add(label)
    return result


def _ww_project_document_links(con, project_index):
    """
    Liefert je Bücher.gID die exakten DokumentenManagement.sDocID-Werte.

    Reihenfolge:
    1. direkte deklarierte Fremdschlüssel,
    2. eindeutig benannte ID-Spalten direkt in Bücher/DokumentenManagement,
    3. WW-Zwischentabellen mit Buch- und Dokument-ID.

    Es werden ausschließlich gelesene SQL-Metadaten verwendet. Ist in einer
    älteren WW-Struktur keine eindeutige Beziehung auffindbar, bleibt die
    Belegnummern-/Archivsuche als sicherer Rückfall aktiv.
    """
    cur = con.cursor()
    direct_relations = []

    try:
        rows = cur.execute("""
            SELECT
                ps.name AS parent_schema,
                pt.name AS parent_table,
                pc.name AS parent_column,
                rs.name AS ref_schema,
                rt.name AS ref_table,
                rc.name AS ref_column
            FROM sys.foreign_key_columns AS fkc
            JOIN sys.tables AS pt ON pt.object_id = fkc.parent_object_id
            JOIN sys.schemas AS ps ON ps.schema_id = pt.schema_id
            JOIN sys.columns AS pc
              ON pc.object_id = fkc.parent_object_id
             AND pc.column_id = fkc.parent_column_id
            JOIN sys.tables AS rt ON rt.object_id = fkc.referenced_object_id
            JOIN sys.schemas AS rs ON rs.schema_id = rt.schema_id
            JOIN sys.columns AS rc
              ON rc.object_id = fkc.referenced_object_id
             AND rc.column_id = fkc.referenced_column_id
            WHERE (pt.name = N'Bücher' AND rt.name = N'DokumentenManagement')
               OR (pt.name = N'DokumentenManagement' AND rt.name = N'Bücher')
        """).fetchall()
        for row in rows:
            if row.parent_table == "Bücher":
                direct_relations.append(
                    (row.parent_schema, row.parent_column, row.ref_schema, row.ref_column)
                )
            else:
                direct_relations.append(
                    (row.ref_schema, row.ref_column, row.parent_schema, row.parent_column)
                )
    except Exception as exc:
        print("WW Dokument-FK Diagnose FEHLER:", repr(exc))

    try:
        book_columns = {
            str(row.COLUMN_NAME).lower(): str(row.COLUMN_NAME)
            for row in cur.execute("""
                SELECT COLUMN_NAME
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=N'Bücher'
            """).fetchall()
        }
        dm_columns = {
            str(row.COLUMN_NAME).lower(): str(row.COLUMN_NAME)
            for row in cur.execute("""
                SELECT COLUMN_NAME
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=N'DokumentenManagement'
            """).fetchall()
        }
        for candidate in ("gdmid", "gdokumentid", "dokumentid", "dmid"):
            if candidate in book_columns and "gid" in dm_columns:
                direct_relations.append(
                    ("dbo", book_columns[candidate], "dbo", dm_columns["gid"])
                )
        for candidate in ("gbuchid", "buchid", "gbelegid", "belegid"):
            if candidate in dm_columns and "gid" in book_columns:
                direct_relations.append(
                    ("dbo", book_columns["gid"], "dbo", dm_columns[candidate])
                )
    except Exception as exc:
        print("WW Dokument-ID Diagnose FEHLER:", repr(exc))

    unique_relations = []
    seen_relations = set()
    for relation in direct_relations:
        key = tuple(str(value).lower() for value in relation)
        if key in seen_relations:
            continue
        seen_relations.add(key)
        unique_relations.append(relation)

    links = {}

    def add_link(book_id, doc_id):
        book_key = str(book_id or "").strip().lower()
        doc_value = str(doc_id or "").strip()
        if not book_key or not doc_value:
            return
        bucket = links.setdefault(book_key, [])
        if doc_value not in bucket:
            bucket.append(doc_value)

    for book_schema, book_column, dm_schema, dm_column in unique_relations:
        try:
            rows = cur.execute(f"""
                SELECT
                    CONVERT(varchar(80), b.gID) AS BookGID,
                    LTRIM(RTRIM(dm.sDocID)) AS DocID
                FROM {_project_sql_ident(book_schema)}.[Bücher] AS b
                INNER JOIN {_project_sql_ident(dm_schema)}.[DokumentenManagement] AS dm
                    ON b.{_project_sql_ident(book_column)} = dm.{_project_sql_ident(dm_column)}
                WHERE b.ProjektIndex = ?
                  AND NULLIF(LTRIM(RTRIM(ISNULL(dm.sDocID,''))), '') IS NOT NULL
            """, int(project_index)).fetchall()
        except Exception:
            continue
        for row in rows:
            add_link(row.BookGID, row.DocID)

    # Manche WW-Versionen verwenden eine Zwischentabelle statt einer direkten
    # Beziehung. Nur Tabellen mit klar benannter Buch- UND Dokument-ID werden
    # berücksichtigt, damit keine zufälligen GUID-Gleichheiten entstehen.
    book_id_names = {"gbuchid", "buchid", "gbelegid", "belegid"}
    document_id_names = {"gdmid", "gdokumentid", "dokumentid", "dmid"}
    try:
        metadata_rows = cur.execute("""
            SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE LOWER(COLUMN_NAME) IN (
                'gbuchid','buchid','gbelegid','belegid',
                'gdmid','gdokumentid','dokumentid','dmid'
            )
            ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
        """).fetchall()
        tables = {}
        for row in metadata_rows:
            table_key = (str(row.TABLE_SCHEMA), str(row.TABLE_NAME))
            tables.setdefault(table_key, {})[str(row.COLUMN_NAME).lower()] = str(row.COLUMN_NAME)

        for (schema, table_name), columns in tables.items():
            if table_name in {"Bücher", "DokumentenManagement"}:
                continue
            book_column = next((columns[name] for name in book_id_names if name in columns), None)
            dm_column = next((columns[name] for name in document_id_names if name in columns), None)
            if not book_column or not dm_column:
                continue
            try:
                rows = cur.execute(f"""
                    SELECT DISTINCT
                        CONVERT(varchar(80), b.gID) AS BookGID,
                        LTRIM(RTRIM(dm.sDocID)) AS DocID
                    FROM dbo.[Bücher] AS b
                    INNER JOIN {_project_sql_ident(schema)}.{_project_sql_ident(table_name)} AS bridge
                        ON bridge.{_project_sql_ident(book_column)} = b.gID
                    INNER JOIN dbo.[DokumentenManagement] AS dm
                        ON dm.gID = bridge.{_project_sql_ident(dm_column)}
                    WHERE b.ProjektIndex = ?
                      AND NULLIF(LTRIM(RTRIM(ISNULL(dm.sDocID,''))), '') IS NOT NULL
                """, int(project_index)).fetchall()
            except Exception:
                continue
            for row in rows:
                add_link(row.BookGID, row.DocID)
    except Exception as exc:
        print("WW Dokument-Zwischentabellen Diagnose FEHLER:", repr(exc))

    return links


def _project_pdf_rows_by_docids(doc_ids):
    """
    Exakte PDF-Treffer:
    DokumentenManagement.sDocID == Dateiname ohne .pdf/_Original.pdf.

    Pro Dokument-ID wird die normale Arbeits-PDF bevorzugt. Ist nur das
    unveränderte Original indexiert, wird dieses angezeigt. Doppelte
    Indexpfade werden nicht mehrfach ausgegeben.
    """
    def normalize_doc_id(value):
        raw = Path(str(value or "").strip()).name
        raw = re.sub(r"_Original\.pdf$", "", raw, flags=re.I)
        raw = re.sub(r"\.pdf$", "", raw, flags=re.I)
        return raw.strip()

    normalized = {}
    for value in doc_ids:
        doc_id = normalize_doc_id(value)
        if doc_id:
            normalized.setdefault(doc_id.lower(), doc_id)
    if not normalized or not DB.exists():
        return {}

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    buckets = {}
    try:
        cols = {row[1] for row in con.execute("PRAGMA table_info(pdf_index)").fetchall()}
        select = ["filename", "path", "dokumenttyp", "modified"]
        for optional in ("source", "doc_year", "logical_id"):
            if optional in cols:
                select.append(optional)

        ids = sorted(normalized.values(), key=str.lower)
        for pos in range(0, len(ids), 300):
            chunk = ids[pos:pos + 300]
            conditions = []
            params = []
            filename_map = {}
            for doc_id in chunk:
                work = f"{doc_id}.pdf"
                original = f"{doc_id}_Original.pdf"
                conditions.append("(LOWER(filename)=LOWER(?) OR LOWER(filename)=LOWER(?))")
                params.extend([work, original])
                filename_map[work.lower()] = doc_id.lower()
                filename_map[original.lower()] = doc_id.lower()

            sql = (
                "SELECT " + ",".join(select) +
                " FROM pdf_index WHERE (" + " OR ".join(conditions) + ")"
            )
            if "source" in cols:
                sql += " AND (source IS NULL OR source <> 'EINGANG')"
            else:
                sql += r" AND path NOT LIKE '%\Dokman\%'"
            sql += " ORDER BY modified DESC"

            rows = con.execute(sql, params).fetchall()
            for row in rows:
                item = dict(row)
                filename = str(item.get("filename") or "")
                doc_key = filename_map.get(filename.lower())
                if not doc_key:
                    continue
                path_value = str(item.get("path") or "")
                if not path_value:
                    continue
                dt = parse_print_time(filename, item.get("modified"))
                item["printDate"] = dt.date().isoformat() if dt else None
                item["printDateTime"] = dt.isoformat(timespec="seconds") if dt else None
                item["year"] = dt.year if dt else item.get("doc_year")
                item["pdfFound"] = True
                item["sourceOfTruth"] = "WinWorker-Dokument-ID + PDF-Archiv"
                bucket = buckets.setdefault(doc_key, {"work": [], "original": []})
                target = "original" if re.search(r"_Original\.pdf$", filename, re.I) else "work"
                if not any(str(x.get("path") or "").lower() == path_value.lower() for x in bucket[target]):
                    bucket[target].append(item)
    finally:
        con.close()

    result = {}
    for doc_key, bucket in buckets.items():
        work_rows = bucket["work"]
        original_rows = bucket["original"]
        chosen = dict(work_rows[0] if work_rows else original_rows[0])
        if original_rows:
            chosen["originalPath"] = original_rows[0].get("path") or ""
        else:
            chosen["originalPath"] = ""
        chosen["wwDocId"] = normalized.get(doc_key, doc_key)
        result[doc_key] = [chosen]
    return result


def _merged_project_document_type(book, pdf=None):
    pdf = pdf or {}
    book_type = str(book.get("documentType") or "Weitere WW-Belege")
    pdf_type = canonical_project_document_type(
        pdf.get("dokumenttyp"),
        pdf.get("filename"),
        pdf.get("path"),
        book.get("bookNumber"),
        is_invoice=book.get("isInvoice", False),
        ww_book_art=book.get("wwBookArt"),
    )
    generic = {"Sonstige Dokumente", "Weitere WW-Belege"}
    if pdf_type in generic:
        return book_type
    if book_type in {"Teilrechnung", "Schlussrechnung", "Gutschrift / Storno"} and pdf_type == "Rechnung":
        return book_type
    return pdf_type


def _ww_project_books(project_index):
    con = sql_connection("WinWorker_Projekte_Standard")
    cur = con.cursor()
    rows = cur.execute("""
        SELECT
            b.gID,
            b.sBuchNummer,
            b.Buchart,
            b.dzDocDatum,
            b.Geändert,
            b.dzInhaltGeaendert,
            b.Aufgenommen,
            b.Storno,
            r.cUmsatzNetto,
            r.dzRechnungsdatum
        FROM dbo.[Bücher] AS b
        LEFT JOIN dbo.Rechnung AS r
            ON r.gBuchID = b.gID
        WHERE b.ProjektIndex = ?
          AND ISNULL(b.Storno, 0) = 0
        ORDER BY
            COALESCE(b.Geändert, b.dzInhaltGeaendert, b.dzDocDatum, b.Aufgenommen) DESC,
            b.gID DESC
    """, int(project_index)).fetchall()

    book_ids = [row.gID for row in rows if row.gID is not None]
    try:
        type_map = _ww_project_book_types(con, book_ids)
    except Exception as exc:
        print("WW Projekt-Belegarten FEHLER:", repr(exc))
        type_map = {}
    try:
        document_links = _ww_project_document_links(con, project_index)
    except Exception as exc:
        print("WW Projekt-Dokumentlinks FEHLER:", repr(exc))
        document_links = {}
    con.close()

    def select_type(labels, fallback):
        labels = {str(label) for label in labels if str(label)}
        # Spezifische Typen schlagen allgemeine Oberbegriffe.
        specificity = {
            "Schlussrechnung": 10,
            "Teilrechnung": 20,
            "Gutschrift / Storno": 30,
            "Auftragssteuerung": 40,
            "Kalkulation": 50,
            "Aufmaß": 60,
            "Regiebericht": 70,
            "Lieferschein": 80,
            "Angebot": 90,
            "Auftrag / Auftragsbestätigung": 100,
            "Rechnung": 110,
            "Weitere WW-Belege": 900,
            "Sonstige Dokumente": 999,
        }
        if labels:
            return min(labels, key=lambda label: specificity.get(label, 950))
        return fallback

    # Dieselbe WW-Belegnummer kann als Druck-/Buchversion mehrfach vorkommen.
    # Die jüngste Version liefert Datum/Betrag; exakte Dokument-IDs älterer
    # Versionen bleiben dennoch erhalten, damit kein auffindbares PDF verloren
    # geht. Buchart ist Teil des Schlüssels, weil unterschiedliche Belegarten
    # in WW dieselbe sichtbare Nummer tragen können.
    latest = {}
    for row in rows:
        number = str(row.sBuchNummer or "").strip()
        gid = str(row.gID or "").strip()
        gid_key = gid.lower()
        art_key = _normalize_project_identifier(row.Buchart)
        number_key = _normalize_project_identifier(number)
        key = f"{art_key}|{number_key}" if number_key else f"GID:{gid_key}"

        amount = float(row.cUmsatzNetto) if row.cUmsatzNetto is not None else None
        doc_date = clean_date(
            row.dzRechnungsdatum or row.dzDocDatum or row.Geändert or row.Aufgenommen
        )
        labels = set(type_map.get(gid_key, set()))
        fallback_type = canonical_project_document_type(
            number,
            is_invoice=amount is not None,
            ww_book_art=row.Buchart,
        )

        if key not in latest:
            latest[key] = {
                "wwBookId": gid,
                "wwBookIds": [gid] if gid else [],
                "bookNumber": number,
                "wwBookArt": row.Buchart,
                "documentDate": doc_date,
                "netAmount": amount,
                "isInvoice": amount is not None,
                "documentType": select_type(labels, fallback_type),
                "docIds": [],
                "_typeCandidates": set(labels),
            }
        else:
            item = latest[key]
            if gid and gid not in item["wwBookIds"]:
                item["wwBookIds"].append(gid)
            item["_typeCandidates"].update(labels)
            if amount is not None:
                item["isInvoice"] = True
                if item.get("netAmount") is None:
                    item["netAmount"] = amount
            if not item.get("documentDate") and doc_date:
                item["documentDate"] = doc_date

        item = latest[key]
        for doc_id in document_links.get(gid_key, []):
            if doc_id not in item["docIds"]:
                item["docIds"].append(doc_id)

    for item in latest.values():
        fallback_type = canonical_project_document_type(
            item.get("bookNumber"),
            is_invoice=item.get("isInvoice", False),
            ww_book_art=item.get("wwBookArt"),
        )
        item["documentType"] = select_type(item.pop("_typeCandidates", set()), fallback_type)

    return list(latest.values())


def _project_by_index(project_index):
    con = sql_connection()
    cur = con.cursor()
    row = cur.execute("""
        SELECT
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
        LEFT JOIN dbo.[Bücher] AS b
            ON b.ProjektIndex = p.ProjektIndex
        WHERE p.ProjektIndex = ?
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
    """, int(project_index)).fetchone()
    con.close()
    if not row:
        return None
    project = _project_row_to_dict(row)
    _attach_project_metrics([project])
    return project


def project_document_catalog(project_index):
    project = _project_by_index(project_index)
    if not project:
        raise ValueError("Projekt wurde in WinWorker nicht gefunden.")

    books = _ww_project_books(project_index)
    all_doc_ids = [doc_id for book in books for doc_id in book.get("docIds", [])]
    exact_by_doc_id = _project_pdf_rows_by_docids(all_doc_ids)

    book_numbers = [book.get("bookNumber") for book in books if book.get("bookNumber")]
    fallback_pdfs = _project_pdf_rows(project.get("projectNumber"), book_numbers)

    # Rückfall-Zuordnung über sichtbare Belegnummer. Eine PDF wird dabei
    # höchstens einem WW-Beleg zugeordnet; Dateiname ist stärker als Pfad,
    # OCR-Text ist nur die letzte Stufe.
    fallback_assignments = {}
    for pdf_index, pdf in enumerate(fallback_pdfs):
        filename_norm = _normalize_project_identifier(pdf.get("filename"))
        path_norm = _normalize_project_identifier(pdf.get("path"))
        text_norm = _normalize_project_identifier(pdf.get("_raw_text"))
        best = None
        for book_index, book in enumerate(books):
            number_norm = _normalize_project_identifier(book.get("bookNumber"))
            if len(number_norm) < 3:
                continue
            score = 0
            if number_norm in filename_norm:
                score += 100
            if number_norm in path_norm:
                score += 60
            if number_norm in text_norm:
                score += 15
            rank = (score, len(number_norm))
            if score and (best is None or rank > best[:2]):
                best = (score, len(number_norm), book_index)
        if best is not None:
            fallback_assignments.setdefault(best[2], []).append(pdf_index)

    documents = []
    used_paths = set()
    used_fallback_indices = set()

    def append_book_pdf(book, pdf, exact=False):
        item = dict(pdf)
        path_key = str(item.get("path") or "").strip().lower()
        if not path_key or path_key in used_paths:
            return False
        used_paths.add(path_key)
        doc_type = _merged_project_document_type(book, item)
        item.update({
            "documentType": doc_type,
            "dokumenttyp": doc_type,
            "bookNumber": book.get("bookNumber") or "",
            "documentDate": book.get("documentDate") or item.get("printDate"),
            "netAmount": book.get("netAmount"),
            "wwBookArt": book.get("wwBookArt"),
            "wwBookId": book.get("wwBookId"),
            "wwBookIds": book.get("wwBookIds") or [],
            "wwDocIds": book.get("docIds") or [],
            "sourceOfTruth": (
                "WinWorker-Dokument-ID + PDF-Archiv"
                if exact
                else "WinWorker-Belegnummer + PDF-Archiv"
            ),
            "pdfFound": True,
        })
        item.pop("_raw_text", None)
        documents.append(item)
        return True

    for book_index, book in enumerate(books):
        found_for_book = False

        # 1. exakte WW-Dokument-ID
        for doc_id in book.get("docIds", []):
            for pdf in exact_by_doc_id.get(str(doc_id).strip().lower(), []):
                found_for_book = append_book_pdf(book, pdf, exact=True) or found_for_book

        # 2. Rückfall über Belegnummer/Projektindex
        for pdf_index in fallback_assignments.get(book_index, []):
            if pdf_index in used_fallback_indices:
                continue
            pdf = fallback_pdfs[pdf_index]
            if append_book_pdf(book, pdf, exact=False):
                used_fallback_indices.add(pdf_index)
                found_for_book = True

        # WW-Beleg bleibt sichtbar, auch wenn kein PDF im Index auffindbar ist.
        if not found_for_book:
            doc_type = book.get("documentType") or canonical_project_document_type(
                book.get("bookNumber"),
                is_invoice=book.get("isInvoice", False),
                ww_book_art=book.get("wwBookArt"),
            )
            documents.append({
                "filename": book.get("bookNumber") or f"WinWorker-Beleg {book.get('wwBookArt') or ''}".strip(),
                "path": "",
                "documentType": doc_type,
                "dokumenttyp": doc_type,
                "bookNumber": book.get("bookNumber") or "",
                "documentDate": book.get("documentDate"),
                "printDate": book.get("documentDate"),
                "netAmount": book.get("netAmount"),
                "wwBookArt": book.get("wwBookArt"),
                "wwBookId": book.get("wwBookId"),
                "wwBookIds": book.get("wwBookIds") or [],
                "wwDocIds": book.get("docIds") or [],
                "sourceOfTruth": "WinWorker · PDF nicht gefunden",
                "pdfFound": False,
            })

    # Projekt-PDFs, die nicht eindeutig an einen WW-Beleg gekoppelt werden
    # konnten, bleiben unter ihrem erkannten Dokumenttyp auffindbar.
    for pdf_index, pdf in enumerate(fallback_pdfs):
        path_key = str(pdf.get("path") or "").strip().lower()
        if pdf_index in used_fallback_indices or not path_key or path_key in used_paths:
            continue
        used_paths.add(path_key)
        item = dict(pdf)
        doc_type = canonical_project_document_type(
            item.get("dokumenttyp"), item.get("filename"), item.get("path")
        )
        item.update({
            "documentType": doc_type,
            "dokumenttyp": doc_type,
            "documentDate": item.get("printDate"),
            "sourceOfTruth": "PDF-Archiv · kein eindeutiger WW-Beleg",
            "pdfFound": True,
        })
        item.pop("_raw_text", None)
        documents.append(item)

    # Erst fachliche Reihenfolge, innerhalb einer Gruppe neueste Dokumente oben.
    documents.sort(key=lambda d: str(d.get("filename") or "").lower())
    documents.sort(key=lambda d: 0 if d.get("pdfFound") else 1)
    documents.sort(
        key=lambda d: str(d.get("documentDate") or d.get("printDate") or ""),
        reverse=True,
    )
    documents.sort(key=lambda d: _project_type_priority(d.get("documentType")))

    counts = {}
    for document in documents:
        kind = document.get("documentType") or "Sonstige Dokumente"
        counts[kind] = counts.get(kind, 0) + 1

    return {
        "project": project,
        "documents": documents,
        "documentTypeCounts": counts,
        "wwBookCount": len(books),
        "pdfCount": sum(1 for document in documents if document.get("pdfFound")),
        "missingPdfCount": sum(1 for document in documents if not document.get("pdfFound")),
    }


# ---------------------------------------------------------------------------
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


def global_material_search(query, limit=80):
    """Lieferantenübergreifende Materialsuche für The Brain.

    Exakte Material-/Artikel-Treffer kommen vor ähnlichen Vorschlägen. Innerhalb
    derselben Qualität steht die neueste Rechnung zuerst.
    """
    query = str(query or "").strip()
    if len(query) < 2:
        return {"query": query, "results": [], "exactCount": 0, "similarCount": 0, "scanned": 0}
    try:
        limit = max(10, min(200, int(limit)))
    except Exception:
        limit = 80

    qnorm = _norm_supplier(query)
    qtokens = [x for x in qnorm.split() if len(x) >= 2]
    exact, similar = [], []
    scanned = 0
    for row in _incoming_catalog():
        raw = str(row.get("_raw_text") or "")
        if not raw.strip():
            continue
        scanned += 1
        hit = _material_search_result(raw, query)
        supplier = dict(row.get("_supplier") or {})
        base = {
            "filename": row.get("filename") or "",
            "path": row.get("path") or "",
            "invoiceDate": row.get("invoiceDate"),
            "invoiceDateTime": row.get("invoiceDateTime"),
            "amount": row.get("amount"),
            "supplierName": supplier.get("name") or "Lieferant nicht sicher erkannt",
            "supplierAddress": supplier.get("address") or "",
            "supplierNumber": supplier.get("supplierNumber") or "",
            "materialMatches": [],
            "matchScore": 0,
            "matchType": "",
        }
        if hit.get("matched"):
            base.update({
                "materialMatches": list(hit.get("matches") or []),
                "matchScore": int(hit.get("score") or 0),
                "matchType": "exact" if hit.get("ideal") else "good",
                "matchCount": int(hit.get("matchCount") or 1),
            })
            exact.append(base)
            continue

        # Ähnliche Vorschläge nur aus erkannten Materialzeilen, niemals aus dem
        # Rechnungskopf. Dadurch bleibt "ähnlich" nützlich statt beliebig.
        idx = _material_search_index(raw)
        best_ratio, best_line = 0.0, ""
        for line in idx.get("lines") or []:
            lnorm = _norm_supplier(line)
            if not lnorm:
                continue
            ratio = difflib.SequenceMatcher(None, qnorm, lnorm[:max(len(qnorm)*3, 40)]).ratio()
            if qtokens:
                token_ratio = max((difflib.SequenceMatcher(None, token, word).ratio() for token in qtokens for word in lnorm.split()), default=0.0)
                ratio = max(ratio, token_ratio * 0.88)
            if ratio > best_ratio:
                best_ratio, best_line = ratio, line
        if best_ratio >= 0.62 and best_line:
            base.update({
                "materialMatches": [_focus_material_snippet(best_line, query)],
                "matchScore": int(best_ratio * 1000),
                "matchType": "similar",
                "matchCount": 1,
            })
            similar.append(base)

    date_key = lambda x: str(x.get("invoiceDateTime") or "")
    exact.sort(key=lambda x: (2 if x.get("matchType") == "exact" else 1, int(x.get("matchScore") or 0), date_key(x)), reverse=True)
    similar.sort(key=lambda x: (int(x.get("matchScore") or 0), date_key(x)), reverse=True)
    results = (exact + similar)[:limit]
    return {
        "query": query, "results": results, "exactCount": len(exact),
        "similarCount": len(similar), "scanned": scanned,
    }


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
    Direkte Auswahl über den erkannten Supplier-Key.
    Bei Suchbegriff werden ausschließlich OCR-Materialzeilen durchsucht.
    """
    supplier_key = str(supplier_key or "").strip()
    text_query = str(text_query or "").strip()

    if not supplier_key:
        return []

    result = []
    for item in _incoming_catalog():
        ident = item.get("_supplier")
        if not ident or ident.get("key") != supplier_key:
            continue

        raw = str(item.get("_raw_text") or "")
        material = _material_search_result(raw, text_query) if text_query else None
        if text_query and not material.get("matched"):
            continue

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
            "snippet": "" if text_query else " ".join(raw.split())[:420],
            "materialMatched": bool(material and material.get("matched")),
            "materialMatchCount": int((material or {}).get("matchCount") or 0),
            "materialMatchIdeal": bool((material or {}).get("ideal")),
            "materialMatchScore": int((material or {}).get("score") or 0),
            "materialMatches": list((material or {}).get("matches") or []),
        })

    if text_query:
        result.sort(key=lambda x: (
            1 if x.get("materialMatchIdeal") else 0,
            int(x.get("materialMatchScore") or 0),
            int(x.get("materialMatchCount") or 0),
            x.get("invoiceDateTime") or "",
        ), reverse=True)
    else:
        result.sort(
            key=lambda x: (x.get("invoiceDateTime") or "", x.get("filename") or ""),
            reverse=True,
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
            "openCount": 0,
            "openSum": 0.0,
        })
        row["count"] += 1
        if d.get("amount") is not None:
            row["amount"] += float(d["amount"])
            row["amountCount"] += 1
        if d.get("paymentState") == "open":
            row["openCount"] += 1
            if d.get("amount") is not None:
                row["openSum"] += float(d["amount"])

    for row in summary.values():
        row["amount"] = round(row["amount"], 2)
        row["openSum"] = round(row["openSum"], 2)
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

    if not row and not _capture_path_is_allowed(path):
        raise PermissionError("PDF ist weder im KRISTINE-Archivindex noch in der Eingangsrechnungserfassung")
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
.pill.metric-missing{color:var(--warn);border-color:#69562c}
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
.brain-watch{margin:12px 0;padding:14px 16px;border:1px solid #7c652a;border-radius:16px;background:#241f13}
.brain-watch-title{font-weight:900;font-size:16px;margin-bottom:6px}
.brain-watch-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
.brain-watch-value{padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#17191d}
.brain-watch-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.ww-truth{font-size:12px;color:var(--good);font-weight:750}
.payment-ok{color:var(--good);font-weight:750}
@media(max-width:700px){.brain-watch-grid{grid-template-columns:1fr}}
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

.material-search-note{margin-top:8px;color:var(--muted);font-size:11px;line-height:1.4}
.material-search-status{margin-top:10px;padding:11px 12px;border:1px solid #48556a;border-radius:13px;background:#121820;color:#dfe7f2;line-height:1.45}
.material-search-status strong{color:#fff}
.material-search-status .subline{display:block;color:var(--muted);font-size:11px;margin-top:4px}
.material-search-clear{margin-top:9px;background:#252a32;color:#fff;border:1px solid #444c58;padding:7px 10px;height:auto}
.doc.material-search-hit{border-color:#617b9d;box-shadow:0 0 0 1px rgba(129,166,214,.13)}
.material-hit-head{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:0 0 7px}
.material-hit-badge{display:inline-flex;align-items:center;border:1px solid #526986;border-radius:999px;padding:5px 8px;background:#172131;color:#d9e9ff;font-size:11px;font-weight:900}
.material-hit-badge.ideal{border-color:#9b7d27;background:#2a2412;color:#ffe393}
.material-hit-box{margin-top:10px;padding:10px;border-radius:12px;background:#10151d;border:1px solid #354359}
.material-hit-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#9fb5d3;font-weight:900;margin-bottom:6px}
.material-hit-line{font-size:12px;line-height:1.45;color:#dfe6ef;padding:5px 0;border-top:1px solid rgba(255,255,255,.06)}
.material-hit-line:first-of-type{border-top:0}
mark.material-hit-mark{background:#ffe86b;color:#111;border-radius:3px;padding:0 2px;font-weight:900}
.material-no-hit{padding:18px;border:1px dashed #4d5663;border-radius:16px;background:#15181d;color:#c8ced8}
.material-no-hit strong{display:block;color:#fff;font-size:17px;margin-bottom:6px}

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

/* 0.12.6: Jahresübersicht lesbar – keine überlappenden Pills */
#incomingYears{
  display:grid !important;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:8px;
  width:100%;
  margin-top:10px;
  overflow:visible !important;
}
#incomingYears .year-pill,
#incomingYears button,
#incomingYears > *{
  width:100%;
  min-width:0;
  height:auto !important;
  min-height:42px;
  margin:0 !important;
  padding:9px 12px;
  white-space:normal !important;
  overflow:visible !important;
  line-height:1.25;
  text-align:left;
  box-sizing:border-box;
}
@media(max-width:700px){
  #incomingYears{
    grid-template-columns:1fr;
  }
}


.year-summary-grid{
  display:grid !important;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:8px;
  width:100%;
  margin-top:10px;
  overflow:visible !important;
}
.year-summary-grid .year-summary-pill{
  display:block;
  width:100%;
  min-width:0;
  margin:0 !important;
  padding:9px 12px;
  white-space:normal !important;
  line-height:1.3;
  box-sizing:border-box;
}
@media(max-width:700px){
  .year-summary-grid{
    grid-template-columns:1fr;
  }
}


.payment-open{color:#ff7777;font-weight:850}
.payment-paid{color:var(--good);font-weight:850}
.payment-unknown{color:var(--warn);font-weight:850}
.open-total{color:#ff7777;font-weight:850}
.open-total-zero{color:var(--good);font-weight:850}


/* 0.13.3 · Projektsuche wie Eingangsrechnungen */
.project-address-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.project-address-card{cursor:pointer;margin:0}
.project-address-card:hover{border-color:#8994a5}
.project-address-card .project-title{font-size:17px}
.project-address-samples{margin-top:9px;color:var(--muted);font-size:12px;line-height:1.45}
.customer-overview{margin-bottom:14px}
.customer-overview-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px}
.customer-overview-name{font-size:21px;font-weight:900}
.overview-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}
.overview-kpi{background:#111318;border:1px solid var(--line);border-radius:14px;padding:11px;min-width:0}
.overview-kpi small{display:block;color:var(--muted);margin-bottom:5px;line-height:1.3}
.overview-kpi strong{display:block;font-size:17px;overflow-wrap:anywhere}
.year-revenue-title{font-size:12px;color:var(--muted);font-weight:800;margin:14px 0 7px}
.year-revenue-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.year-revenue{background:#111318;border:1px solid var(--line);border-radius:12px;padding:9px 11px}
.year-revenue strong{display:block;margin-top:3px}
.overview-note{color:var(--muted);font-size:11px;line-height:1.45;margin-top:10px}
.project-open-hint{font-size:12px;color:var(--blue);font-weight:750;margin-top:10px}
.ww-placeholder{display:flex;align-items:center;justify-content:center;text-align:center;color:#20242a;font-weight:900;line-height:1.35}
.doc-source{margin-top:6px;color:var(--good);font-size:11px;font-weight:750;line-height:1.35}
.doc-missing{margin-top:9px;color:var(--warn);font-size:12px;font-weight:800}
@media(max-width:700px){
  .project-address-grid{grid-template-columns:1fr}
  .overview-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .year-revenue-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:440px){
  .overview-kpis,.year-revenue-grid{grid-template-columns:1fr}
}

/* KRISTINE Eingangsrechnungen · Dunja */
.capture-dashboard{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}
.capture-kpi{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:13px}
.capture-kpi small{display:block;color:var(--muted);margin-bottom:5px}.capture-kpi strong{font-size:20px}
.capture-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.capture-grid .span-2{grid-column:span 2}.capture-grid .span-4{grid-column:1/-1}
.capture-drop{border:1px dashed #5f6774;border-radius:16px;padding:18px;text-align:center;background:#111318}
.capture-drop.has-file{border-color:var(--good);background:#102017}
.capture-drop input{width:100%;margin-top:10px}
.capture-supplier-results{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
.capture-supplier-choice{cursor:pointer;margin:0}.capture-supplier-choice:hover{border-color:#8994a5}
.capture-selected{border-color:var(--good)!important;box-shadow:0 0 0 2px rgba(159,224,180,.09)}
.capture-allocation{display:grid;grid-template-columns:110px 1.25fr 1fr 1fr 1fr 120px 90px 44px;gap:7px;align-items:end;margin-bottom:8px}
.capture-allocation input,.capture-allocation select{padding:10px 9px;font-size:14px;border-radius:10px}
.capture-allocation .remove{height:42px;padding:0;background:#351b1b;color:#ffb3b3;border:1px solid #653232}
.capture-total{display:flex;justify-content:flex-end;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:14px}
.capture-total.bad{color:#ff7777}.capture-total.good{color:var(--good)}
.capture-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
.capture-actions button{min-height:48px}.capture-message{font-size:13px;color:var(--muted)}
.capture-message.error{color:#ffb3b3}.capture-message.success{color:var(--good)}
.capture-recent{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.capture-recent .card{margin:0}.capture-badge{display:inline-flex;padding:5px 8px;border-radius:999px;font-size:11px;font-weight:850;background:#242831;border:1px solid var(--line)}
.capture-badge.review{color:var(--warn)}.capture-badge.done{color:var(--good)}
.capture-costs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.capture-cost-card{background:#111318;border:1px solid var(--line);border-radius:13px;padding:11px}
.capture-cost-card strong{display:block;font-size:16px;margin-top:5px}
.capture-bank-warning{margin-top:10px;padding:10px 12px;border-radius:12px;background:#2a2011;border:1px solid #765d24;color:var(--warn)}
@media(max-width:900px){.capture-dashboard{grid-template-columns:repeat(2,minmax(0,1fr))}.capture-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.capture-grid .span-4{grid-column:1/-1}.capture-allocation{grid-template-columns:1fr 1fr}.capture-allocation .remove{grid-column:2}.capture-recent,.capture-costs{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.capture-dashboard,.capture-grid,.capture-supplier-results,.capture-recent,.capture-costs{grid-template-columns:1fr}.capture-grid .span-2,.capture-grid .span-4{grid-column:auto}.capture-allocation{grid-template-columns:1fr}.capture-allocation .remove{grid-column:auto}}


/* 0.13.1 · Dunja-Kontierung: breiter Arbeitsbereich und saubere Spalten */
body.capture-wide .wrap{
  max-width:1480px;
}

.capture-allocation{
  width:100%;
  max-width:100%;
  grid-template-columns:
    minmax(100px,.75fr)
    minmax(155px,1.15fr)
    minmax(145px,1fr)
    minmax(115px,.8fr)
    minmax(170px,1.25fr)
    minmax(110px,.75fr)
    minmax(82px,.55fr)
    44px;
}

.capture-allocation > *{
  min-width:0;
}

.capture-allocation input,
.capture-allocation select{
  display:block;
  width:100%;
  min-width:0;
}

@media(max-width:1250px){
  body.capture-wide .wrap{
    max-width:1040px;
  }

  .capture-allocation{
    grid-template-columns:repeat(12,minmax(0,1fr));
  }

  .capture-allocation > div:nth-child(1){grid-column:span 2}
  .capture-allocation > div:nth-child(2){grid-column:span 3}
  .capture-allocation > div:nth-child(3){grid-column:span 3}
  .capture-allocation > div:nth-child(4){grid-column:span 3}
  .capture-allocation > div:nth-child(5){grid-column:span 6}
  .capture-allocation > div:nth-child(6){grid-column:span 3}
  .capture-allocation > div:nth-child(7){grid-column:span 3}
  .capture-allocation .remove{
    grid-column:12;
    grid-row:1;
  }
}

@media(max-width:800px){
  body.capture-wide .wrap{
    max-width:820px;
  }

  .capture-allocation{
    grid-template-columns:1fr 1fr;
  }

  .capture-allocation > div{
    grid-column:auto!important;
  }

  .capture-allocation .remove{
    grid-column:2;
    grid-row:auto;
  }
}

@media(max-width:560px){
  .capture-allocation{
    grid-template-columns:1fr;
  }

  .capture-allocation .remove{
    grid-column:1;
  }
}


/* 0.13.2 · Eingangsrechnungen: getrenntes Testgelände */
.capture-area-switch{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 10px}
.capture-area-switch button{min-height:52px;font-weight:900;border:1px solid var(--line);background:#20242c;color:#eef1f5}
.capture-area-switch button.active.test{background:#392b10;border-color:#9a7426;color:#ffe29a;box-shadow:0 0 0 2px rgba(213,166,64,.12)}
.capture-area-switch button.active.live{background:#173421;border-color:#4d9464;color:#b9f3ca;box-shadow:0 0 0 2px rgba(100,194,127,.12)}
.capture-area-banner{border-radius:14px;padding:12px 14px;margin-bottom:14px;line-height:1.45;border:1px solid var(--line)}
.capture-area-banner.test{background:#2b210f;border-color:#7d6124;color:#ffe19a}
.capture-area-banner.live{background:#13281a;border-color:#3e7650;color:#b9efc8}
.capture-area-banner strong{display:block;font-size:16px;margin-bottom:2px}
body.capture-training #captureSection>.card{border-color:#5f4a1d}
.capture-badge.training{color:#ffe19a;background:#382b12;border-color:#7d6124}
.capture-delete,.capture-clear-test{background:#401d1d!important;border-color:#713333!important;color:#ffc0c0!important}
@media(max-width:620px){.capture-area-switch{grid-template-columns:1fr}}



/* 0.13.5 · Rechnungsprüfplatz: PDF links, Kontrolle rechts */
.capture-workbench{display:grid;grid-template-columns:minmax(520px,1.28fr) minmax(500px,.95fr);gap:16px;align-items:start;margin-top:14px}
.capture-preview-column{min-width:0;position:sticky;top:12px;align-self:start}
.capture-editor-column{min-width:0;display:grid;gap:14px}
.capture-preview-card{margin:0;padding:14px;min-height:720px}
.capture-preview-head{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.capture-drop{padding:12px;transition:.18s ease}
.capture-drop.dragover{border-color:#9fe0b4;background:#13261a;box-shadow:0 0 0 3px rgba(159,224,180,.12)}
.capture-file-tools{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;margin-top:8px}
.capture-file-label{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 15px;border-radius:12px;background:#fff;color:#090a0c;font-weight:900;cursor:pointer}
.capture-file-label input{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.capture-pdf-shell{margin-top:12px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#0b0d10;min-height:610px;display:flex;align-items:stretch;justify-content:stretch}
.capture-pdf-shell iframe{display:block;width:100%;height:calc(100vh - 185px);min-height:610px;border:0;background:#fff}
.capture-pdf-empty{display:flex;align-items:center;justify-content:center;text-align:center;width:100%;min-height:610px;padding:30px;color:var(--muted);line-height:1.55}
.capture-form-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 12px;margin-top:12px}
.capture-form-two .full{grid-column:1/-1}
.capture-form-two input,.capture-form-two select,.capture-form-two textarea{width:100%;min-width:0;box-sizing:border-box}
.capture-form-two textarea{min-height:72px;resize:vertical}
.capture-readonly{background:#111318!important;color:#cbd1d9!important;border-color:#303640!important}
.capture-field-note{font-size:11px;color:var(--muted);line-height:1.35;margin-top:4px}
.capture-supplier-results{grid-template-columns:1fr}
.capture-supplier-choice{position:relative}
.capture-supplier-choice.best{border-color:#9fe0b4;box-shadow:0 0 0 2px rgba(159,224,180,.1)}
.capture-match-badge{display:inline-flex;padding:4px 8px;border-radius:999px;background:#173421;border:1px solid #4d9464;color:#b9f3ca;font-size:11px;font-weight:900;margin-bottom:6px}
.capture-match-reasons{font-size:11px;color:var(--good);margin-top:5px;line-height:1.4}
.capture-bank-warning{padding:13px 14px}
.capture-bank-warning.ok{background:#13281a;border-color:#3e7650;color:#b9efc8}
.capture-bank-warning.bad{background:#321717;border-color:#753333;color:#ffb3b3}
.capture-bank-comparison{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
.capture-bank-value{background:#111318;border:1px solid var(--line);border-radius:11px;padding:9px;overflow-wrap:anywhere}
.capture-bank-value small{display:block;color:var(--muted);margin-bottom:3px}
.capture-accept-bank{display:flex;align-items:flex-start;gap:9px;background:#fff;color:#111;border-radius:12px;padding:11px 13px;font-weight:900;cursor:pointer}
.capture-accept-bank input{width:auto;min-width:auto;margin-top:3px;transform:scale(1.15)}
.capture-payment-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}
.capture-skonto-off{opacity:.48}
.capture-analyze-steps{display:flex;gap:7px;flex-wrap:wrap;justify-content:center;margin-top:8px}
.capture-analyze-step{font-size:11px;padding:4px 7px;border-radius:999px;background:#242831;border:1px solid var(--line);color:var(--muted)}
.capture-analyze-step.ok{color:var(--good);border-color:#3e7650}
.capture-analyze-step.warn{color:var(--warn);border-color:#765d24}
@media(max-width:1180px){
  .capture-workbench{grid-template-columns:minmax(420px,1fr) minmax(430px,1fr)}
  .capture-preview-column{position:static}
  .capture-pdf-shell iframe{height:720px}
}
@media(max-width:920px){
  .capture-workbench{grid-template-columns:1fr}
  .capture-preview-column{order:0}
  .capture-editor-column{order:1}
  .capture-preview-card{min-height:auto}
  .capture-pdf-shell,.capture-pdf-empty{min-height:520px}
  .capture-pdf-shell iframe{height:620px;min-height:520px}
}
@media(max-width:590px){
  .capture-form-two,.capture-payment-grid,.capture-bank-comparison{grid-template-columns:1fr}
  .capture-form-two .full{grid-column:auto}
  .capture-pdf-shell,.capture-pdf-empty{min-height:430px}
  .capture-pdf-shell iframe{height:520px;min-height:430px}
}

/* Linie 2 · Kontakte + Materialsuche + PDF-Superviewer */
.contact-button{background:#1f6f50;border:1px solid #2f8d68;color:#fff;font-weight:900;padding:9px 12px;border-radius:11px;height:auto}
.contact-button:hover{filter:brightness(1.08)}
.contact-summary{margin-top:10px;display:flex;gap:7px;flex-wrap:wrap}
.contact-chip{display:inline-flex;gap:6px;align-items:center;padding:6px 9px;border:1px solid #3c4958;border-radius:999px;background:#151b22;color:#e9eef5;font-size:12px}
.contact-modal,.pdf-super-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.76);display:flex;align-items:center;justify-content:center;padding:18px}
.contact-modal[hidden],.pdf-super-modal[hidden]{display:none!important}
.contact-panel{width:min(820px,100%);max-height:92vh;overflow:auto;background:#10141a;border:1px solid #3a4552;border-radius:18px;box-shadow:0 22px 80px rgba(0,0,0,.55)}
.contact-panel-head,.pdf-super-head{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;gap:10px;align-items:center;padding:14px 16px;background:#141a22;border-bottom:1px solid #303946}
.contact-panel-body{padding:14px 16px}
.contact-list{display:grid;gap:9px;margin:10px 0 16px}
.contact-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(120px,1fr) minmax(140px,1.2fr) auto;gap:8px;align-items:center;padding:11px;border:1px solid #303946;border-radius:13px;background:#0d1117}
.contact-row .who{font-weight:900}.contact-row .role,.contact-row .where{color:var(--muted);font-size:12px}
.contact-call{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;background:#1f6f50;color:#fff;border-radius:10px;padding:9px 11px;font-weight:900;white-space:nowrap}
.contact-edit{background:#252d38;color:#fff;border:1px solid #424d5d;padding:7px 9px;height:auto}
.contact-form{display:grid;grid-template-columns:1fr 1fr;gap:9px;padding-top:12px;border-top:1px solid #303946}
.contact-form .full{grid-column:1/-1}.contact-form input{width:100%}
.material-global-results{display:grid;gap:10px}
.material-global-card{display:grid;grid-template-columns:95px 1fr;gap:12px;border:1px solid #394655;background:#10151c;border-radius:14px;padding:11px}
.material-global-card.exact{border-color:#5d836f}.material-global-card.similar{border-color:#665d3f}
.material-global-card .thumb{width:95px;height:132px;object-fit:cover;border-radius:8px;background:#fff}
.material-global-top{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.material-global-supplier{font-size:17px;font-weight:950}
.pdf-super-panel{width:min(1500px,98vw);height:96vh;background:#0b0e12;border:1px solid #35404d;border-radius:18px;display:flex;flex-direction:column;overflow:hidden}
.pdf-super-head{position:relative;flex:0 0 auto}.pdf-super-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.pdf-super-tools button{height:auto;padding:7px 10px;background:#242c36;color:#fff;border:1px solid #455160}
.pdf-super-stage{position:relative;flex:1;overflow:auto;background:#262a2f;text-align:center;padding:14px}
.pdf-super-stage img{display:inline-block;max-width:none;box-shadow:0 4px 24px rgba(0,0,0,.42);background:#fff}
.pdf-loupe{position:fixed;z-index:10020;width:320px;height:220px;border:3px solid #fff;border-radius:14px;box-shadow:0 10px 45px rgba(0,0,0,.65);background:#111 no-repeat;pointer-events:none;display:none;overflow:hidden}
.pdf-super-status{font-size:12px;color:#c8d1dc;min-width:90px;text-align:center}
@media(max-width:720px){
  .contact-modal,.pdf-super-modal{padding:0}.contact-panel,.pdf-super-panel{width:100%;height:100%;max-height:none;border-radius:0}
  .contact-row{grid-template-columns:1fr auto}.contact-row .where,.contact-row .role{grid-column:1/-1}.contact-form{grid-template-columns:1fr}
  .material-global-card{grid-template-columns:72px 1fr}.material-global-card .thumb{width:72px;height:100px}
  .pdf-loupe{width:260px;height:180px}.pdf-super-stage{padding:6px}
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
      <button id="modeMaterial" class="mode" type="button">🔎 Material</button>
      <button id="modeCapture" class="mode" type="button">📥 Erfassen · Dunja</button>
    </div>
    <div class="searchrow" id="mainSearchRow">
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

  <div class="section" id="projectAddressSection" hidden>
    <div class="section-head"><h2>Kunde / Adresse auswählen</h2></div>
    <div class="meta">Die erste Eingabe grenzt nur den richtigen WinWorker-Kunden über seine Adresse ein.</div>
    <div id="projectAddresses" class="project-address-grid" style="margin-top:10px"></div>
  </div>

  <div class="section" id="projectsSection" hidden>
    <div class="section-head">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button id="backToProjectAddresses" class="dark" type="button" hidden>← Adresse wechseln</button>
        <button id="backToProjects" class="dark" type="button" hidden>← Projekte</button>
        <h2 id="projectsTitle">Projekte auswählen</h2>
      </div>
      <button id="newFromSelection" class="plus" type="button">＋ Neue Baustelle</button>
    </div>
    <div id="projectCustomerOverview" class="card customer-overview" hidden></div>
    <div id="projects"></div>
  </div>

  <div class="section" id="docsSection" hidden>
    <div class="section-head"><h2>Dokumente & Quellen</h2></div>
    <div id="sourceTypes"></div>
    <div id="docs"></div>
  </div>
  <div class="section" id="materialSection" hidden>
    <div class="section-head"><h2>Material finden · lieferantenübergreifend</h2></div>
    <div class="card">
      <div class="project-title">Materialname, Artikel oder Artikelnummer</div>
      <div class="sub">The Brain durchsucht die Materialblöcke aller Eingangsrechnungen. Beste Treffer zuerst, bei gleicher Qualität die neuesten.</div>
      <div class="searchrow" style="margin-top:10px">
        <input id="materialQ" type="search" placeholder="z. B. StoPrim Plex, Unistar, 180 g Vlies …" autocomplete="off">
        <button id="materialGo" type="button">Material suchen</button>
      </div>
      <div id="materialMeta" class="meta"></div>
    </div>
    <div id="materialResults" class="material-global-results"></div>
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
      <div style="margin-top:10px"><button id="incomingCall" class="contact-button" type="button">📞 Anrufen / Kontakte</button></div>

      <div class="invoice-text-search">
        <div class="formlabel">Welches Material suche ich?</div>
        <div class="searchrow">
          <input id="incomingTextQ" type="search"
                 placeholder="Material, Artikelname oder Artikelnummer …" autocomplete="off">
          <button id="incomingTextGo" type="button">Alle Rechnungen durchsuchen</button>
        </div>
        <div class="material-search-note" id="incomingTextHint">Durchsucht alle Rechnungen des ausgewählten Lieferanten – ausschließlich die OCR-Materialzeilen.</div>
        <div class="meta" id="incomingTextMeta"></div>
      </div>
    </div>

    <div id="incomingWatch"></div>
    <div id="incomingGrouped"></div>

    <div class="section" id="incomingReviewSection" hidden>
      <div class="section-head"><h2>Noch nicht zugeordnet · einmal prüfen</h2></div>
      <div class="meta">Unsichere Rechnung einmal anklicken → danach dauerhaft mit dieser WW-Adresse verheiratet.</div>
      <div id="incomingReview"></div>
    </div>
  </div>



  <div id="contactModal" class="contact-modal" hidden>
    <div class="contact-panel">
      <div class="contact-panel-head"><div><strong id="contactTitle">Kontakte</strong><div class="sub" id="contactSub"></div></div><button id="contactClose" class="dark" type="button">✕</button></div>
      <div class="contact-panel-body">
        <div id="contactList" class="contact-list"></div>
        <form id="contactForm" class="contact-form">
          <input id="contactId" type="hidden">
          <div><div class="formlabel">Standort</div><input id="contactLocation" placeholder="z. B. Rankweil"></div>
          <div><div class="formlabel">Name</div><input id="contactName" placeholder="z. B. Stefan Walser"></div>
          <div><div class="formlabel">Funktion</div><input id="contactRole" placeholder="Außendienst, Bauleiter, Zentrale …"></div>
          <div><div class="formlabel">Telefonnummer *</div><input id="contactPhone" type="tel" required placeholder="+43 …"></div>
          <div><div class="formlabel">E-Mail</div><input id="contactEmail" type="email"></div>
          <div><div class="formlabel">Notiz</div><input id="contactNote" placeholder="z. B. Schlüssel, nur vormittags …"></div>
          <div class="full" style="display:flex;gap:8px;flex-wrap:wrap"><button type="submit">Kontakt speichern</button><button id="contactReset" class="dark" type="button">Neu / leeren</button><button id="contactDelete" class="danger" type="button" hidden>Kontakt löschen</button></div>
        </form>
      </div>
    </div>
  </div>

  <div id="pdfSuperModal" class="pdf-super-modal" hidden>
    <div class="pdf-super-panel">
      <div class="pdf-super-head">
        <div><strong id="pdfSuperTitle">PDF</strong><div class="sub">Breite · Zoom · Superlupe</div></div>
        <div class="pdf-super-tools">
          <button id="pdfPrev" type="button">←</button><span id="pdfStatus" class="pdf-super-status">1 / 1</span><button id="pdfNext" type="button">→</button>
          <button id="pdfMinus" type="button">−</button><button id="pdf100" type="button">100 %</button><button id="pdfWidth" type="button">Breite</button><button id="pdfPlus" type="button">＋</button>
          <button id="pdfLoupeToggle" type="button">🔎 Lupe</button><a id="pdfOriginal" class="action" href="#" target="_blank" rel="noopener">Original</a><button id="pdfClose" class="dark" type="button">✕</button>
        </div>
      </div>
      <div id="pdfStage" class="pdf-super-stage"><img id="pdfImage" alt="PDF Seite"></div>
    </div>
  </div>
  <div id="pdfLoupe" class="pdf-loupe"></div>

  <div class="section" id="captureSection" hidden>
    <div class="section-head">
      <div>
        <h2>📥 Eingangsrechnung erfassen · Dunja</h2>
        <div class="sub">Rechnung links ablesen · rechts Lieferant, Zahlungsbedingungen, Beträge und Kontierung kontrollieren.</div>
      </div>
      <span class="pill" id="captureNextNumber">Nächste Nummer wird geladen …</span>
    </div>

    <div class="capture-area-switch" aria-label="Arbeitsbereich auswählen">
      <button id="captureAreaTest" class="test" type="button">🧪 Testgelände / Training</button>
      <button id="captureAreaLive" class="live" type="button">🔒 Echtbetrieb</button>
    </div>
    <div id="captureAreaBanner" class="capture-area-banner test"></div>
    <div class="capture-dashboard" id="captureDashboard"></div>

    <div class="capture-workbench">
      <aside class="capture-preview-column">
        <div class="card capture-preview-card">
          <div class="capture-preview-head">
            <div><div class="project-title">1 · Rechnung</div><div class="sub">PDF bleibt beim Prüfen immer sichtbar.</div></div>
            <a id="captureOpenPdf" class="action secondary" href="#" target="_blank" rel="noopener" hidden>PDF groß öffnen</a>
          </div>
          <div class="capture-drop" id="captureDrop">
            <strong>PDF hier hineinziehen</strong>
            <div class="sub">oder Datei auswählen · Text wird gelesen, Scan-Seiten erhalten automatisch OCR.</div>
            <div class="capture-file-tools">
              <label class="capture-file-label">PDF auswählen<input id="captureFile" type="file" accept="application/pdf,.pdf"></label>
            </div>
            <div class="capture-analyze-steps" id="captureAnalyzeSteps"></div>
            <div class="meta" id="captureAnalyzeMeta"></div>
          </div>
          <div class="capture-pdf-shell">
            <div id="capturePdfEmpty" class="capture-pdf-empty">Noch keine Rechnung ausgewählt.<br>Nach dem Reinziehen erscheint sie hier direkt neben der Kontrolle.</div>
            <iframe id="capturePdfPreview" title="Vorschau der Eingangsrechnung" hidden></iframe>
          </div>
        </div>
      </aside>

      <div class="capture-editor-column">
        <div class="card">
          <div class="project-title">2 · Lieferant aus WinWorker</div>
          <div class="sub">KRISTINE schlägt nach PDF-Text, UID, Kundennummer und Adresse vor. Dunja wählt bewusst aus.</div>
          <div class="searchrow" style="margin-top:10px">
            <input id="captureSupplierQ" type="search" placeholder="Lieferant händisch suchen …" autocomplete="off">
            <button id="captureSupplierGo" type="button">Suchen</button>
          </div>
          <div id="captureSelectedSupplier" class="meta">Noch kein Lieferant ausgewählt.</div>
          <div id="captureSupplierResults" class="capture-supplier-results"></div>
        </div>

        <div class="card">
          <div class="project-title">3 · Rechnungsdaten</div>
          <div class="capture-form-two">
            <div><div class="formlabel">Belegart</div><select id="captureDocumentType"><option>Rechnung</option><option>Gutschrift</option></select></div>
            <div><div class="formlabel">Lieferanten-Rechnungsnummer</div><input id="captureInvoiceNumber" type="text"></div>

            <div><div class="formlabel">Rechnungsdatum</div><input id="captureInvoiceDate" type="date"></div>
            <div><div class="formlabel">Nettofällig am</div><input id="captureNetDueDate" type="date"></div>

            <div><div class="formlabel">Skonto</div><select id="captureSkontoEnabled"><option value="0">Nein</option><option value="1">Ja</option></select></div>
            <div id="captureSkontoPercentWrap"><div class="formlabel">Skonto %</div><input id="captureSkontoPercent" type="number" min="0" max="100" step="0.01"></div>
            <div id="captureSkontoDueWrap"><div class="formlabel">Skonto fällig am</div><input id="captureSkontoDueDate" type="date"></div>
            <div><div class="formlabel">Währung</div><select id="captureCurrency"><option>EUR</option><option>CHF</option></select></div>

            <div><div class="formlabel">Netto</div><input id="captureNet" type="number" step="0.01"></div>
            <div><div class="formlabel">USt</div><input id="captureVat" type="number" step="0.01"></div>
            <div><div class="formlabel">Brutto</div><input id="captureGross" type="number" step="0.01"></div>
            <div><div class="formlabel">Unsere KundenNr. dort</div><input id="captureExternalCustomerNo" type="text"><div class="capture-field-note">Nach Lieferantenauswahl aus WinWorker; falls dort leer, händisch ergänzbar.</div></div>

            <div class="full"><div class="formlabel">Zahlungsbedingungen laut Rechnung</div><input id="capturePaymentTerms" type="text" placeholder="z. B. sofort ohne Abzug"></div>
            <div class="full"><div class="formlabel">IBAN laut Stammdaten</div><input id="captureMasterIban" class="capture-readonly" type="text" readonly placeholder="wird nach Lieferantenauswahl geladen"></div>
            <div class="full"><div class="formlabel">IBAN auf dieser Rechnung</div><input id="captureInvoiceIban" type="text" placeholder="nur zur Gegenprüfung"></div>
            <div id="captureBankWarning" class="full"></div>

            <div class="full"><div class="formlabel">Buchungstext / Betreff</div><input id="captureBookingText" type="text" placeholder="wird nur bei eindeutigem Betreff vorgeschlagen"></div>
            <div class="full"><div class="formlabel">Interne Notiz</div><textarea id="captureNote"></textarea></div>
            <div><div class="formlabel">Bearbeiter</div><input id="captureCreatedBy" type="text" value="Dunja"></div>
            <div><div class="formlabel">Arbeitsstatus</div><select id="captureWorkflow"><option value="zu_pruefen">Zu prüfen</option><option value="geprueft">Geprüft</option></select></div>
          </div>
        </div>

        <div class="card">
          <div class="section-head">
            <div><div class="project-title">4 · Kontierung</div><div class="sub">Summe der Kontierungszeilen muss dem Rechnungs-Netto entsprechen.</div></div>
            <button id="captureAddAllocation" type="button" class="dark">＋ Kontierungszeile</button>
          </div>
          <div id="captureAllocations"></div>
          <div id="captureAllocationTotal" class="capture-total"></div>
          <div class="capture-actions">
            <button id="captureSave" type="button">Rechnung verbindlich erfassen</button>
            <span id="captureSaveMessage" class="capture-message"></span>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2><span id="captureCostTitle">Kostenentwicklung</span> <span id="captureCostYear"></span></h2></div>
      <div id="captureCostSummary" class="capture-costs"></div>
    </div>

    <div class="section">
      <div class="section-head"><h2 id="captureRecentTitle">Zuletzt erfasst</h2><div class="actions"><button id="captureClearTest" class="capture-clear-test" type="button" hidden>Testgelände leeren</button><button id="captureReload" class="dark" type="button">↻ Aktualisieren</button></div></div>
      <div id="captureRecent" class="capture-recent"></div>
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
const projectAddressSection=document.getElementById('projectAddressSection'),projectAddresses=document.getElementById('projectAddresses');
const projectCustomerOverview=document.getElementById('projectCustomerOverview'),backToProjectAddresses=document.getElementById('backToProjectAddresses');
const addressBar=document.getElementById('addressBar'),addresses=document.getElementById('addresses');
const summary=document.getElementById('summary'),sourceTypes=document.getElementById('sourceTypes');
const newFromSelection=document.getElementById('newFromSelection');
const modeProjects=document.getElementById('modeProjects'),modeIncoming=document.getElementById('modeIncoming'),modeMaterial=document.getElementById('modeMaterial'),modeCapture=document.getElementById('modeCapture');
const materialSection=document.getElementById('materialSection'),materialQ=document.getElementById('materialQ'),materialGo=document.getElementById('materialGo'),materialMeta=document.getElementById('materialMeta'),materialResults=document.getElementById('materialResults');
const mainSearchRow=document.getElementById('mainSearchRow');
const incomingSupplierSection=document.getElementById('incomingSupplierSection'),incomingSuppliers=document.getElementById('incomingSuppliers');
const incomingSection=document.getElementById('incomingSection'),incomingGrouped=document.getElementById('incomingGrouped');
const incomingTitle=document.getElementById('incomingTitle'),incomingSub=document.getElementById('incomingSub');
const incomingSupplierAddress=document.getElementById('incomingSupplierAddress'),incomingSupplierNumber=document.getElementById('incomingSupplierNumber');
const incomingTextQ=document.getElementById('incomingTextQ'),incomingTextGo=document.getElementById('incomingTextGo'),incomingTextHint=document.getElementById('incomingTextHint'),incomingTextMeta=document.getElementById('incomingTextMeta');
const backToSuppliers=document.getElementById('backToSuppliers');
const incomingWatch=document.getElementById('incomingWatch');
const incomingReviewSection=document.getElementById('incomingReviewSection'),incomingReview=document.getElementById('incomingReview');
const backToProjects=document.getElementById('backToProjects'),projectsTitle=document.getElementById('projectsTitle');
const modal=document.getElementById('newJobModal'),closeModal=document.getElementById('closeModal');
const saveNewJob=document.getElementById('saveNewJob'),newJobMsg=document.getElementById('newJobMsg');

const captureSection=document.getElementById('captureSection'),captureDashboard=document.getElementById('captureDashboard');
const captureAreaTest=document.getElementById('captureAreaTest'),captureAreaLive=document.getElementById('captureAreaLive'),captureAreaBanner=document.getElementById('captureAreaBanner');
const captureNextNumber=document.getElementById('captureNextNumber'),captureFile=document.getElementById('captureFile'),captureDrop=document.getElementById('captureDrop'),captureAnalyzeMeta=document.getElementById('captureAnalyzeMeta'),captureAnalyzeSteps=document.getElementById('captureAnalyzeSteps');
const capturePdfPreview=document.getElementById('capturePdfPreview'),capturePdfEmpty=document.getElementById('capturePdfEmpty'),captureOpenPdf=document.getElementById('captureOpenPdf');
const captureSupplierQ=document.getElementById('captureSupplierQ'),captureSupplierGo=document.getElementById('captureSupplierGo'),captureSupplierResults=document.getElementById('captureSupplierResults'),captureSelectedSupplierBox=document.getElementById('captureSelectedSupplier'),captureBankWarning=document.getElementById('captureBankWarning');
const captureDocumentType=document.getElementById('captureDocumentType'),captureInvoiceNumber=document.getElementById('captureInvoiceNumber'),captureInvoiceDate=document.getElementById('captureInvoiceDate'),captureNetDueDate=document.getElementById('captureNetDueDate');
const captureSkontoEnabled=document.getElementById('captureSkontoEnabled'),captureSkontoPercent=document.getElementById('captureSkontoPercent'),captureSkontoDueDate=document.getElementById('captureSkontoDueDate'),captureSkontoPercentWrap=document.getElementById('captureSkontoPercentWrap'),captureSkontoDueWrap=document.getElementById('captureSkontoDueWrap'),capturePaymentTerms=document.getElementById('capturePaymentTerms');
const captureNet=document.getElementById('captureNet'),captureVat=document.getElementById('captureVat'),captureGross=document.getElementById('captureGross'),captureCurrency=document.getElementById('captureCurrency');
const captureMasterIban=document.getElementById('captureMasterIban'),captureInvoiceIban=document.getElementById('captureInvoiceIban'),captureExternalCustomerNo=document.getElementById('captureExternalCustomerNo'),captureBookingText=document.getElementById('captureBookingText'),captureNote=document.getElementById('captureNote'),captureCreatedBy=document.getElementById('captureCreatedBy'),captureWorkflow=document.getElementById('captureWorkflow');
const captureAllocations=document.getElementById('captureAllocations'),captureAllocationTotal=document.getElementById('captureAllocationTotal'),captureAddAllocation=document.getElementById('captureAddAllocation'),captureSave=document.getElementById('captureSave'),captureSaveMessage=document.getElementById('captureSaveMessage');
const captureCostSummary=document.getElementById('captureCostSummary'),captureCostYear=document.getElementById('captureCostYear'),captureCostTitle=document.getElementById('captureCostTitle');
const captureRecent=document.getElementById('captureRecent'),captureRecentTitle=document.getElementById('captureRecentTitle'),captureReload=document.getElementById('captureReload'),captureClearTest=document.getElementById('captureClearTest');


let baseQuery='',currentProjects=[],currentDocs=[],selectedProject=null,selectedAddress=null,currentDocType='',projectDetailMode=false,previousView=null,searchMode='projects',projectAddressCandidates=[],selectedProjectAddress=null,projectOverview=null,incomingAll=[],incomingCandidates=[],selectedSupplier=null,selectedWwAddress=null,incomingMaterialQuery='',captureSelectedSupplier=null,captureAnalysis=null,captureAllocationRows=[],capturePdfObjectUrl='',captureAcceptNewIban=false;
let captureArea=localStorage.getItem('kristineCaptureArea')==='live'?'live':'test';

function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function money(v){if(v===null||v===undefined||v==='')return null;try{return new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(v))}catch{return v}}
function num(v){if(v===null||v===undefined||v==='')return null;return new Intl.NumberFormat('de-AT',{maximumFractionDigits:2}).format(Number(v))}
function urlFor(path,p){return path+'?path='+encodeURIComponent(p)}

let activeContactContext=null;
const contactModal=document.getElementById('contactModal'),contactTitle=document.getElementById('contactTitle'),contactSub=document.getElementById('contactSub'),contactList=document.getElementById('contactList'),contactForm=document.getElementById('contactForm');
const contactId=document.getElementById('contactId'),contactLocation=document.getElementById('contactLocation'),contactName=document.getElementById('contactName'),contactRole=document.getElementById('contactRole'),contactPhone=document.getElementById('contactPhone'),contactEmail=document.getElementById('contactEmail'),contactNote=document.getElementById('contactNote'),contactDelete=document.getElementById('contactDelete');
function phoneHref(value){const raw=String(value||'').trim();return 'tel:'+raw.replace(/[^+\d]/g,'')}
function resetContactForm(){contactForm?.reset();if(contactId)contactId.value='';if(contactDelete)contactDelete.hidden=true}
async function loadContacts(){
  if(!activeContactContext)return;
  const p=new URLSearchParams({entityType:activeContactContext.entityType,entityId:activeContactContext.entityId});
  const r=await fetch('/contacts?'+p.toString(),{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Kontakte konnten nicht geladen werden');
  const rows=d.contacts||[];
  contactList.innerHTML=rows.length?rows.map(c=>`<div class="contact-row">
    <div><div class="who">${esc(c.name||c.role||'Kontakt')}</div><div class="where">${esc(c.location||'')}</div></div>
    <div class="role">${esc(c.role||'')}</div>
    <a class="contact-call" href="${phoneHref(c.phone)}">📞 ${esc(c.phone)}</a>
    <button class="contact-edit" type="button" data-contact='${esc(JSON.stringify(c))}'>Bearbeiten</button>
  </div>`).join(''):'<div class="empty">Noch keine Telefonnummer gespeichert.</div>';
  contactList.querySelectorAll('[data-contact]').forEach(btn=>btn.onclick=()=>{const c=JSON.parse(btn.dataset.contact);contactId.value=c.id||'';contactLocation.value=c.location||'';contactName.value=c.name||'';contactRole.value=c.role||'';contactPhone.value=c.phone||'';contactEmail.value=c.email||'';contactNote.value=c.note||'';contactDelete.hidden=false;});
}
async function openContacts(ctx){activeContactContext=ctx;contactTitle.textContent='📞 '+(ctx.title||'Kontakte');contactSub.textContent=ctx.subtitle||'';resetContactForm();contactModal.hidden=false;await loadContacts();}
document.getElementById('contactClose')?.addEventListener('click',()=>contactModal.hidden=true);document.getElementById('contactReset')?.addEventListener('click',resetContactForm);
contactForm?.addEventListener('submit',async e=>{e.preventDefault();if(!activeContactContext)return;const payload={id:Number(contactId.value||0)||undefined,entityType:activeContactContext.entityType,entityId:activeContactContext.entityId,location:contactLocation.value,name:contactName.value,role:contactRole.value,phone:contactPhone.value,email:contactEmail.value,note:contactNote.value};const r=await fetch('/contacts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok||!d.ok)return alert(d.error||'Speichern fehlgeschlagen');resetContactForm();await loadContacts();});
contactDelete?.addEventListener('click',async()=>{if(!activeContactContext||!contactId.value||!confirm('Kontakt wirklich löschen?'))return;const p=new URLSearchParams({id:contactId.value,entityType:activeContactContext.entityType,entityId:activeContactContext.entityId});const r=await fetch('/contacts?'+p.toString(),{method:'DELETE'}),d=await r.json();if(!r.ok||!d.ok)return alert(d.error||'Löschen fehlgeschlagen');resetContactForm();await loadContacts();});

let pdfState={path:'',page:1,pages:1,scale:1.45,loupe:false,baseWidth:0};
const pdfModal=document.getElementById('pdfSuperModal'),pdfImage=document.getElementById('pdfImage'),pdfStage=document.getElementById('pdfStage'),pdfStatus=document.getElementById('pdfStatus'),pdfLoupe=document.getElementById('pdfLoupe');
function pdfPageUrl(){return '/pdf-page?path='+encodeURIComponent(pdfState.path)+'&page='+pdfState.page+'&scale='+pdfState.scale.toFixed(2)}
function renderPdfPage(){pdfStatus.textContent=pdfState.page+' / '+pdfState.pages;pdfImage.src=pdfPageUrl();document.getElementById('pdfPrev').disabled=pdfState.page<=1;document.getElementById('pdfNext').disabled=pdfState.page>=pdfState.pages;}
async function openBrainPdf(path,title='PDF'){if(!path)return;pdfState={path,page:1,pages:1,scale:1.45,loupe:false,baseWidth:0};document.getElementById('pdfSuperTitle').textContent=title||'PDF';document.getElementById('pdfOriginal').href=urlFor('/pdf',path);pdfModal.hidden=false;const r=await fetch('/pdf-info?path='+encodeURIComponent(path),{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok){pdfModal.hidden=true;return window.open(urlFor('/pdf',path),'_blank')}pdfState.pages=Number(d.pages||1);pdfState.baseWidth=Number(d.width||0);fitPdfWidth();}
function fitPdfWidth(){if(!pdfState.baseWidth)return renderPdfPage();const usable=Math.max(320,pdfStage.clientWidth-34);pdfState.scale=Math.max(.55,Math.min(4.5,usable/pdfState.baseWidth));renderPdfPage();}
document.getElementById('pdfClose')?.addEventListener('click',()=>{pdfModal.hidden=true;pdfLoupe.style.display='none'});document.getElementById('pdfPrev')?.addEventListener('click',()=>{if(pdfState.page>1){pdfState.page--;renderPdfPage()}});document.getElementById('pdfNext')?.addEventListener('click',()=>{if(pdfState.page<pdfState.pages){pdfState.page++;renderPdfPage()}});document.getElementById('pdfMinus')?.addEventListener('click',()=>{pdfState.scale=Math.max(.45,pdfState.scale-.2);renderPdfPage()});document.getElementById('pdfPlus')?.addEventListener('click',()=>{pdfState.scale=Math.min(5,pdfState.scale+.2);renderPdfPage()});document.getElementById('pdf100')?.addEventListener('click',()=>{pdfState.scale=1;renderPdfPage()});document.getElementById('pdfWidth')?.addEventListener('click',fitPdfWidth);document.getElementById('pdfLoupeToggle')?.addEventListener('click',()=>{pdfState.loupe=!pdfState.loupe;if(!pdfState.loupe)pdfLoupe.style.display='none'});
pdfStage?.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();pdfState.scale=Math.max(.45,Math.min(5,pdfState.scale+(e.deltaY<0?.18:-.18)));renderPdfPage()},{passive:false});
pdfImage?.addEventListener('mousemove',e=>{if(!pdfState.loupe)return;const r=pdfImage.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(x<0||y<0||x>r.width||y>r.height)return;const zoom=2.6;pdfLoupe.style.display='block';pdfLoupe.style.left=Math.min(window.innerWidth-335,e.clientX+24)+'px';pdfLoupe.style.top=Math.max(8,Math.min(window.innerHeight-235,e.clientY-110))+'px';pdfLoupe.style.backgroundImage=`url("${pdfImage.src}")`;pdfLoupe.style.backgroundSize=(r.width*zoom)+'px '+(r.height*zoom)+'px';pdfLoupe.style.backgroundPosition=(-x*zoom+160)+'px '+(-y*zoom+110)+'px';});pdfImage?.addEventListener('mouseleave',()=>pdfLoupe.style.display='none');
document.addEventListener('click',e=>{const a=e.target.closest('a.action[href*="/pdf?path="]');if(!a)return;try{const u=new URL(a.href,location.href),path=u.searchParams.get('path');if(path){e.preventDefault();openBrainPdf(path,a.closest('.doc')?.querySelector('.docname')?.textContent||a.textContent||'PDF')}}catch(_){}});

function norm(v){return String(v||'').trim().toLowerCase().replace(/\s+/g,' ')}
function addressLabel(p){return [p.street,[p.postalCode,p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
function addressKey(p){return norm([p.street,p.postalCode,p.city].filter(Boolean).join('|'))}

function regexEscape(v){return String(v||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
function highlightMaterialText(value,query){
  const terms=String(query||'').trim().split(/[^0-9A-Za-zÄÖÜäöüß]+/).filter(Boolean).sort((a,b)=>b.length-a.length);
  if(!terms.length)return esc(value);
  const pattern=new RegExp('('+terms.map(regexEscape).join('|')+')','gi');
  return String(value??'').split(pattern).map((part,index)=>index%2
    ?`<mark class="material-hit-mark">${esc(part)}</mark>`
    :esc(part)).join('');
}
function supplierSearchLabel(){
  const name=String(selectedWwAddress?.name||'').trim();
  return name||'diesem Lieferanten';
}
function updateIncomingMaterialScope(){
  const name=supplierSearchLabel();
  incomingTextGo.textContent='Alle Rechnungen durchsuchen';
  incomingTextHint.textContent=`Durchsucht alle Rechnungen von ${name} – ausschließlich die OCR-Materialzeilen, nicht Datum, Rechnungsnummer oder Rechnungskopf.`;
}
function clearIncomingMaterialSearch(){
  incomingTextQ.value='';
  loadSupplierInvoices('');
}

function docSource(d){
  const s=norm([d.path,d.filename,d.dokumenttyp].filter(Boolean).join(' '));
  if(s.includes('moser'))return 'MOSER';
  if(/eingangs?rechnung|kreditor|kredi/.test(s))return 'Eingangsrechnungen';
  if(/archiv|altarchiv|scanarchiv/.test(s))return 'Archiv';
  return 'Dokumente';
}
function docType(d){return String(d.documentType||d.dokumenttyp||'Sonstige Dokumente').trim()||'Sonstige Dokumente'}

function groupCounts(list,fn){
  const m=new Map(); list.forEach(x=>{const k=fn(x);m.set(k,(m.get(k)||0)+1)}); return [...m.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'de'));
}

function renderProjectAddressCandidates(){
  projectAddressSection.hidden=false;
  projectAddresses.innerHTML=projectAddressCandidates.length
    ? projectAddressCandidates.map((a,i)=>`<div class="card project-address-card" data-project-address="${i}">
        <div class="project-title">${esc(a.name||a.person||'Adresse')}</div>
        ${a.person&&a.person!==a.name?`<div class="sub">${esc(a.person)}</div>`:''}
        ${a.address?`<div class="sub">${esc(a.address)}</div>`:''}
        <div class="metrics">
          <span class="pill">${Number(a.matchingProjectCount||0)} passende Projekt${Number(a.matchingProjectCount||0)===1?'':'e'}</span>
          ${a.customerNumber!==null&&a.customerNumber!==undefined&&a.customerNumber!==''?`<span class="pill">WW-Kundennr. ${esc(a.customerNumber)}</span>`:''}
        </div>
        ${Array.isArray(a.sampleProjects)&&a.sampleProjects.length?`<div class="project-address-samples">${a.sampleProjects.map(esc).join('<br>')}</div>`:''}
        <div class="actions"><button type="button" data-choose-project-address="${i}">Diese Adresse auswählen</button></div>
      </div>`).join('')
    : '<div class="empty">Keine passende WinWorker-Adresse gefunden.</div>';

  projectAddresses.querySelectorAll('[data-choose-project-address]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();selectProjectAddress(projectAddressCandidates[Number(btn.dataset.chooseProjectAddress)]||null)};
  });
  projectAddresses.querySelectorAll('[data-project-address]').forEach(card=>{
    card.onclick=()=>selectProjectAddress(projectAddressCandidates[Number(card.dataset.projectAddress)]||null);
  });
}

function renderProjectCustomerOverview(o){
  projectCustomerOverview.hidden=false;
  const years=Array.isArray(o?.revenueByYear)?o.revenueByYear.filter(x=>x.year):[];
  projectCustomerOverview.innerHTML=`
    <div class="customer-overview-head">
      <div>
        <div class="customer-overview-name">${esc(o?.name||selectedProjectAddress?.name||'Kunde')}</div>
        ${o?.person&&o.person!==o.name?`<div class="sub">${esc(o.person)}</div>`:''}
        ${o?.address?`<div class="sub">${esc(o.address)}</div>`:''}
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${o?.customerNumber!==null&&o?.customerNumber!==undefined&&o?.customerNumber!==''?`<span class="pill">WW-Kundennr. ${esc(o.customerNumber)}</span>`:''}
        <button id="customerContactBtn" class="contact-button" type="button">📞 Kunde / Kontakte</button>
      </div>
    </div>
    <div class="overview-kpis">
      <div class="overview-kpi"><small>Umsatz gesamt · netto</small><strong>${esc(money(o?.totalRevenue)||'–')}</strong></div>
      <div class="overview-kpi"><small>Produktive Stunden gesamt</small><strong>${o?.totalProductiveHours!==null&&o?.totalProductiveHours!==undefined?esc(num(o.totalProductiveHours))+' h':'–'}</strong></div>
      <div class="overview-kpi"><small>Umsatz je produktiver Stunde</small><strong>${esc(money(o?.revenuePerHour)||'–')}</strong></div>
      <div class="overview-kpi"><small>Projekte</small><strong>${Number(o?.projectCount||0)}</strong></div>
    </div>
    <div class="year-revenue-title">Umsatz netto pro Jahr</div>
    <div class="year-revenue-grid">${years.length?years.map(y=>`<div class="year-revenue"><span>${esc(y.year)}</span><strong>${esc(money(y.netRevenue)||'–')}</strong><small>${Number(y.invoiceCount||0)} Rechnung${Number(y.invoiceCount||0)===1?'':'en'}</small></div>`).join(''):'<div class="empty">Noch kein Jahresumsatz gefunden.</div>'}</div>
    <div class="overview-note">Datenabdeckung: ${Number(o?.projectsWithRevenue||0)}/${Number(o?.projectCount||0)} Projekte mit Umsatz · ${Number(o?.projectsWithHours||0)}/${Number(o?.projectCount||0)} mit Stunden · ${Number(o?.projectsComparable||0)}/${Number(o?.projectCount||0)} für Umsatz/Std.<br>${esc(o?.revenueSource||'')}<br>${esc(o?.hoursSource||'')}<br>${esc(o?.ratioSource||'')}</div>`;
  document.getElementById('customerContactBtn')?.addEventListener('click',()=>openContacts({entityType:'customer',entityId:String(o?.customerIndex??selectedProjectAddress?.customerIndex??''),title:o?.name||selectedProjectAddress?.name||'Kunde',subtitle:o?.address||selectedProjectAddress?.address||''}));
}

async function selectProjectAddress(address){
  if(!address)return;
  if(address.customerIndex===null||address.customerIndex===undefined||address.customerIndex===''){
    meta.innerHTML='<span class="error">Diese Adresse hat keinen eindeutigen WinWorker-Kundenindex.</span>';
    return;
  }
  selectedProjectAddress=address;
  selectedProject=null;projectOverview=null;projectDetailMode=false;previousView=null;
  loader.style.display='block';meta.textContent='Lade Projekte, Umsatz und Stunden aus WinWorker …';
  projectAddressSection.hidden=true;ps.hidden=true;ds.hidden=true;summary.hidden=true;addressBar.hidden=true;
  try{
    const r=await fetch('/project/address-projects?customerIndex='+encodeURIComponent(address.customerIndex),{cache:'no-store'});
    const data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||'Fehler');
    currentProjects=data.projects||[];currentDocs=[];projectOverview=data.overview||{};currentDocType='';
    projectsTitle.textContent='Projekte auswählen';
    backToProjectAddresses.hidden=false;backToProjects.hidden=true;
    ps.hidden=false;ds.hidden=true;summary.hidden=true;
    renderProjectCustomerOverview(projectOverview);renderProjects();
    meta.textContent=`${address.name||'Adresse'} · ${currentProjects.length} Projekte · bitte Projekt auswählen`;
    ps.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){
    projectAddressSection.hidden=false;
    meta.innerHTML='<span class="error">Projekte konnten nicht geladen werden: '+esc(e.message)+'</span>';
  }finally{loader.style.display='none'}
}

function showProjectAddressSelection(){
  selectedProjectAddress=null;selectedProject=null;projectOverview=null;projectDetailMode=false;previousView=null;
  currentProjects=[];currentDocs=[];currentDocType='';
  ps.hidden=true;ds.hidden=true;summary.hidden=true;projectCustomerOverview.hidden=true;
  backToProjectAddresses.hidden=true;backToProjects.hidden=true;
  projectsTitle.textContent='Projekte auswählen';
  renderProjectAddressCandidates();
  meta.textContent=`${projectAddressCandidates.length} WinWorker-Adresse(n) · bitte die richtige Adresse auswählen`;
  projectAddressSection.scrollIntoView({behavior:'smooth',block:'start'});
}

backToProjectAddresses.onclick=showProjectAddressSelection;

function renderSummary(pp,dd){
  const sourceCounts=groupCounts(dd,docSource);
  const pdfCount=dd.filter(d=>Boolean(d.path)).length;
  const missingCount=dd.length-pdfCount;
  summary.hidden=false;
  summary.innerHTML=
    `<a class="chip" href="#docsSection">Dokumente <strong>${dd.length}</strong></a>`+
    `<a class="chip" href="#docsSection">PDF <strong>${pdfCount}</strong></a>`+
    (missingCount?`<a class="chip" href="#docsSection">ohne PDF <strong>${missingCount}</strong></a>`:'')+
    sourceCounts.filter(([s])=>s!=='Dokumente').map(([s,c])=>`<a class="chip" href="#docsSection" data-source="${esc(s)}">${esc(s)} <strong>${c}</strong></a>`).join('');
  summary.querySelectorAll('[data-source]').forEach(a=>a.onclick=e=>{e.preventDefault();renderDocumentTypes(a.dataset.source);ds.scrollIntoView({behavior:'smooth'})});
}

function renderProject(p,index){
  const title=p.title||p.site||p.projectDescription||p.customer||'Projekt';
  const customer=[p.company,p.customer].filter(Boolean).join(' · ');
  const addr=p.address||addressLabel(p);
  const hours=p.hoursProductive??p.hoursTotal;
  const hoursText=num(hours),netText=money(p.netInvoiced),perHourText=money(p.revenuePerHour);
  let metrics='';
  if(hours!==null&&hours!==undefined)metrics+=`<span class="pill">${esc(hoursText)} h produktiv</span>`;
  else metrics+='<span class="pill metric-missing">Stunden nicht gefunden</span>';
  if(p.netInvoiced!==null&&p.netInvoiced!==undefined)metrics+=`<span class="pill">${esc(netText)} Umsatz netto</span>`;
  else metrics+='<span class="pill metric-missing">Umsatz nicht gefunden</span>';
  if(p.revenuePerHour!==null&&p.revenuePerHour!==undefined)metrics+=`<span class="pill">${esc(perHourText)} / Std.</span>`;
  else metrics+='<span class="pill metric-missing">Umsatz/Std. nicht berechenbar</span>';
  return `<div class="card project-card ${selectedProject===p?'selected':''}" data-project="${index}">
    <div class="project-title">${esc(title)}</div>
    ${p.projectNumber?`<span class="project-no">${esc(p.projectNumber)}</span>`:''}
    ${customer?`<div class="sub">${esc(customer)}</div>`:''}
    ${addr?`<div class="sub">${esc(addr)}</div>`:''}
    ${metrics?`<div class="metrics">${metrics}</div>`:''}
    ${!projectDetailMode?'<div class="project-open-hint">Projekt anklicken → WW-Dokumente und PDFs</div>':''}
    <div class="actions"><button class="dark create-from-project" type="button" data-project="${index}">＋ Neue Baustelle daraus</button></div>
  </div>`;
}

function renderProjects(){
  projects.innerHTML=currentProjects.length?currentProjects.map(renderProject).join(''):'<div class="empty">Keine Projekte gefunden.</div>';
  projects.querySelectorAll('.project-card').forEach(card=>card.onclick=e=>{
    if(e.target.closest('.create-from-project')||projectDetailMode)return;
    const p=currentProjects[Number(card.dataset.project)]||null;
    if(p)openProjectDetail(p);
  });
  projects.querySelectorAll('.create-from-project').forEach(btn=>btn.onclick=e=>{e.stopPropagation();openNewJob(currentProjects[Number(btn.dataset.project)]||null)});
}

async function openProjectDetail(p){
  if(!p)return;
  previousView={
    projects:[...currentProjects],
    overview:projectOverview,
    selectedProjectAddress:selectedProjectAddress,
    meta:meta.textContent,
    baseQuery:baseQuery
  };
  projectDetailMode=true;selectedProject=p;currentDocs=[];currentDocType='';
  const no=String(p.projectNumber||'').trim();
  loader.style.display='block';addressBar.hidden=true;summary.hidden=true;ds.hidden=true;
  projectsTitle.textContent=no?`Projekt ${no} · Dokumente`:'Projekt · Dokumente';
  backToProjectAddresses.hidden=true;backToProjects.hidden=false;projectCustomerOverview.hidden=true;
  currentProjects=[p];renderProjects();
  meta.textContent='Lade WW-Belege und suche die zugehörigen PDFs …';
  try{
    const r=await fetch('/project/documents?projectIndex='+encodeURIComponent(p.projectIndex),{cache:'no-store'});
    const data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||'Fehler');
    selectedProject=data.project||p;currentProjects=[selectedProject];currentDocs=data.documents||[];currentDocType='';
    renderProjects();
    meta.textContent=`${no?'Projekt '+no+' · ':''}${currentDocs.length} Dokumente · ${Number(data.pdfCount||0)} PDF${Number(data.missingPdfCount||0)?' · '+Number(data.missingPdfCount)+' ohne PDF':''}`;
    meta.innerHTML += ` · <button class="contact-button" id="projectContactBtn" type="button">📞 Projektkontakte</button>`;
    document.getElementById('projectContactBtn')?.addEventListener('click',()=>openContacts({entityType:'project',entityId:String(p.projectIndex||''),title:'Projekt '+(p.projectNumber||p.projectIndex||''),subtitle:p.address||p.name||''}));
    ds.hidden=false;renderSummary(currentProjects,currentDocs);renderDocumentTypes();
    ds.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){
    meta.innerHTML='<span class="error">Projekt konnte nicht geöffnet werden: '+esc(e.message)+'</span>';
  }finally{loader.style.display='none'}
}

function restorePreviousView(){
  if(!previousView)return;
  currentProjects=previousView.projects||[];projectOverview=previousView.overview||{};
  selectedProjectAddress=previousView.selectedProjectAddress||null;baseQuery=previousView.baseQuery||baseQuery;
  selectedProject=null;currentDocs=[];currentDocType='';projectDetailMode=false;
  meta.textContent=previousView.meta||`${currentProjects.length} Projekte · bitte auswählen`;
  previousView=null;backToProjects.hidden=true;backToProjectAddresses.hidden=false;
  projectsTitle.textContent='Projekte auswählen';summary.hidden=true;ds.hidden=true;
  projectCustomerOverview.hidden=false;renderProjectCustomerOverview(projectOverview);
  ps.hidden=false;renderProjects();ps.scrollIntoView({behavior:'smooth',block:'start'});
}

backToProjects.onclick=restorePreviousView;

function renderDoc(d){
  const rawDate=d.documentDate||d.printDate||'';
  const pd=/^\d{4}-\d{2}-\d{2}$/.test(rawDate)?rawDate.split('-').reverse().join('.'):rawDate;
  const amount=money(d.netAmount),source=d.sourceOfTruth||'';
  const title=d.filename||d.bookNumber||docType(d)||'Dokument';
  return `<div class="card doc">
    ${d.path?`<img class="thumb" loading="lazy" src="${urlFor('/thumb',d.path)}" alt="">`:'<div class="thumb ww-placeholder">WINWORKER<br>PDF nicht gefunden</div>'}
    <div>
      <div class="docname">${esc(title)}</div>
      <div class="doctype">${esc(docType(d))}</div>
      ${d.bookNumber&&d.bookNumber!==title?`<div class="docmeta">Beleg ${esc(d.bookNumber)}</div>`:''}
      ${pd?`<div class="docmeta">${esc(pd)}</div>`:''}
      ${amount?`<div class="invoice-amount">${esc(amount)} netto</div>`:''}
      ${source?`<div class="doc-source">${esc(source)}</div>`:''}
      ${d.path?`<div class="actions"><a class="action" href="${urlFor('/pdf',d.path)}" target="_blank" rel="noopener">PDF öffnen</a></div>`:'<div class="doc-missing">WW-Datensatz vorhanden · kein PDF gefunden</div>'}
    </div>
  </div>`;
}

const PROJECT_DOC_ORDER=['Angebot','Kalkulation','Auftrag / Auftragsbestätigung','Auftragssteuerung','Aufmaß','Teilrechnung','Schlussrechnung','Rechnung','Gutschrift / Storno','Regiebericht','Lieferschein','Weitere WW-Belege','Sonstige Dokumente'];
function renderDocumentTypes(sourceFilter=''){
  const sourceDocs=sourceFilter?currentDocs.filter(d=>docSource(d)===sourceFilter):currentDocs;
  const sourceTitle=sourceFilter?`<div class="sub" style="margin-bottom:8px">${esc(sourceFilter)} · ${sourceDocs.length} Treffer</div>`:'';
  const types=groupCounts(sourceDocs,docType).sort((a,b)=>{
    const ai=PROJECT_DOC_ORDER.indexOf(a[0]),bi=PROJECT_DOC_ORDER.indexOf(b[0]);
    return (ai<0?999:ai)-(bi<0?999:bi)||a[0].localeCompare(b[0],'de');
  });
  sourceTypes.innerHTML=sourceTitle+`<div class="type-list">`+
    types.map(([t,c])=>`<button class="chip ${currentDocType===t?'active':''}" type="button" data-type="${esc(t)}">${esc(t)} <strong>${c}</strong></button>`).join('')+
    `</div>`;
  docs.innerHTML=types.length?'<div class="empty">Dokumentart auswählen.</div>':'<div class="empty">Zu diesem Projekt wurden weder WW-Belege noch PDFs gefunden.</div>';
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
  modeMaterial?.classList.toggle('active',mode==='material');
  modeCapture.classList.toggle('active',mode==='capture');
  document.body.classList.toggle('capture-wide',mode==='capture');

  ps.hidden=true;ds.hidden=true;projectAddressSection.hidden=true;projectCustomerOverview.hidden=true;
  incomingSupplierSection.hidden=true;incomingSection.hidden=true;captureSection.hidden=true;materialSection.hidden=true;
  addressBar.hidden=true;summary.hidden=true;backToProjectAddresses.hidden=true;backToProjects.hidden=true;
  projects.innerHTML='';docs.innerHTML='';sourceTypes.innerHTML='';
  incomingSuppliers.innerHTML='';incomingGrouped.innerHTML='';
  incomingTextMeta.classList.remove('year-summary-grid');
  mainSearchRow.hidden=mode==='capture'||mode==='material';

  if(mode==='incoming'){
    q.placeholder='Lieferant oder Adresse in WinWorker suchen, z. B. Morscher …';
    meta.textContent='Schritt 1: echte WinWorker-Adresse auswählen';
    q.focus();
  }else if(mode==='material'){
    meta.textContent='Materialsuche über alle Eingangsrechnungen';
    materialSection.hidden=false;
    materialQ?.focus();
  }else if(mode==='capture'){
    meta.textContent='Dunja · Erfassen · Kontieren · Prüfen';
    captureSection.hidden=false;
    initCapture().catch(e=>setCaptureMessage(e.message,'error'));
  }else{
    q.placeholder='Name, Adresse, Projekt- oder Belegnummer …';
    meta.textContent='Schritt 1: WinWorker-Kunde über die Adresse auswählen';
    q.focus();
  }
}

modeProjects.onclick=()=>setSearchMode('projects');
modeIncoming.onclick=()=>setSearchMode('incoming');
modeMaterial.onclick=()=>setSearchMode('material');
modeCapture.onclick=()=>setSearchMode('capture');

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
        ${Number(s.incomingCount||0)>0
          ? `<div class="payment-ok">${Number(s.incomingCount)} Eingangsbelege${Number(s.kristineIncomingCount||0)>0?' · KRISTINE '+Number(s.kristineIncomingCount):''}${s.lastIncomingDate?' · zuletzt '+esc(s.lastIncomingDate.split('-').reverse().join('.')):''}</div>`
          : `<div class="sub">Keine Eingangsbelege auf dieser Adresse</div>`}
        ${s.supplierNumber?`<div class="sub">Lieferantennr. ${esc(s.supplierNumber)}</div>`:''}
        ${s.ourCustomerNumber?`<div class="sub">Unsere KundenNr. dort: ${esc(s.ourCustomerNumber)}</div>`:''}
        ${s.vatId?`<div class="sub">UID ${esc(s.vatId)}</div>`:''}
        ${s.customerNumber?`<div class="sub">WW-Adressnr. ${esc(s.customerNumber)}</div>`:''}
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
  ps.hidden=true;ds.hidden=true;projectAddressSection.hidden=true;projectCustomerOverview.hidden=true;addressBar.hidden=true;summary.hidden=true;
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
  incomingMaterialQuery='';
  incomingTextMeta.textContent='';
  updateIncomingMaterialScope();
  incomingGrouped.innerHTML='<div class="empty">Lieferantenakte wird geladen …</div>';

  await loadSupplierInvoices('');
  incomingReviewSection.hidden=true;
  incomingReview.innerHTML='';
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
    incomingTextMeta.textContent=Number(d.negativeFingerprintsLearned||0)>0?'✕ ausgeschlossen · gleiche Fremd-Fingerprints werden ebenfalls ausgeblendet':'✕ dauerhaft für diese Adresse ausgeschlossen';
    await loadUnassignedCandidates();
  }catch(e){
    if(button){button.disabled=false;button.textContent='✕ Gehört nicht dazu';}
    incomingTextMeta.innerHTML='<span class="error">'+esc(e.message)+'</span>';
  }
}

function renderIncomingWatch(alerts){
  const rows=Array.isArray(alerts)?alerts:[];
  if(!incomingWatch)return;
  if(!rows.length){
    incomingWatch.innerHTML='';
    return;
  }
  incomingWatch.innerHTML=rows.map(a=>`
    <div class="brain-watch">
      <div class="brain-watch-title">⚠ ${esc(a.title||'Stammdaten prüfen')}</div>
      <div class="sub">${esc(a.message||'')}</div>
      <div class="brain-watch-grid">
        <div class="brain-watch-value">
          <div class="sub">Bisher</div>
          <strong>${esc(a.previousIban||'—')}</strong>
          ${a.previousDate?`<div class="sub">${esc(a.previousDate.split('-').reverse().join('.'))} · ${esc(a.previousInvoice||'')}</div>`:''}
        </div>
        <div class="brain-watch-value">
          <div class="sub">Neu erkannt</div>
          <strong>${esc(a.currentIban||'—')}</strong>
          ${a.currentDate?`<div class="sub">${esc(a.currentDate.split('-').reverse().join('.'))} · ${esc(a.currentInvoice||'')}</div>`:''}
        </div>
      </div>
      <div class="brain-watch-actions">
        <button type="button" data-watch-key="${esc(a.key||'')}">✓ Geprüft · neue Bankverbindung ist bekannt</button>
      </div>
    </div>`).join('');

  incomingWatch.querySelectorAll('[data-watch-key]').forEach(btn=>{
    btn.onclick=async()=>{
      btn.disabled=true;btn.textContent='gespeichert ✓';
      try{
        const r=await fetch('/incoming/watch-ack',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            addressId:selectedWwAddress?.addressId||'',
            key:btn.dataset.watchKey||'',
            decision:'known'
          })
        });
        const d=await r.json();
        if(!r.ok||!d.ok)throw new Error(d.error||'Speichern fehlgeschlagen');
        await loadSupplierInvoices('');
      }catch(e){
        btn.disabled=false;btn.textContent='✓ Geprüft · neue Bankverbindung ist bekannt';
        incomingTextMeta.innerHTML='<span class="error">'+esc(e.message)+'</span>';
      }
    };
  });
}

document.getElementById('incomingCall')?.addEventListener('click',()=>{if(!selectedWwAddress)return;openContacts({entityType:'supplier',entityId:selectedWwAddress.addressId,title:selectedWwAddress.name||'Lieferant',subtitle:selectedWwAddress.address||''})});

async function loadSupplierInvoices(textQuery=''){
  if(!selectedWwAddress)return;

  const query=String(textQuery||'').trim();
  incomingMaterialQuery=query;
  loader.style.display='block';
  incomingTextGo.disabled=true;
  incomingTextMeta.textContent=query
    ? `Durchsuche alle OCR-Materialzeilen von ${supplierSearchLabel()} …`
    : 'Lade Lieferantenakte …';

  try{
    const params=new URLSearchParams({
      addressId:selectedWwAddress.addressId||'',
      q:query
    });
    const r=await fetch('/incoming/address-invoices?'+params.toString(),{cache:'no-store'});
    const data=await r.json();
    if(!r.ok||!data.ok)throw new Error(data.error||'Fehler');

    incomingAll=data.documents||[];
    renderIncomingWatch(data.watchAlerts||[]);
    const stats=data.stats||{};
    const search=data.search||{};
    const totalSum=Number(stats.sum||0);
    const openSum=Number(stats.openSum||0);
    const openCount=Number(stats.openCount||0);
    const count=Number(stats.count||data.allCount||0);
    const yearly=stats.yearly||{};

    incomingSub.innerHTML=
      `<strong>${count} Rechnungen</strong> · `+
      `<strong>${esc(invoiceMoney(totalSum))}</strong> Gesamtsumme · `+
      `<span class="${openCount>0||openSum>0?'open-total':'open-total-zero'}">${openCount} offen · ${esc(invoiceMoney(openSum))}</span> · `+
      `<span class="ww-truth">WW + KRISTINE</span>`+
      (query?` · <span class="material-hit-badge">${Number(search.hitInvoices||0)} Rechnungen mit Materialtreffer</span>`:'');

    incomingTextMeta.classList.toggle('year-summary-grid',!query);
    if(query){
      const scanned=Number(search.scannedInvoices||count||0);
      const ocr=Number(search.ocrInvoices||0);
      const without=Number(search.withoutOcr||0);
      const hits=Number(search.hitInvoices||incomingAll.length||0);
      const matches=Number(search.matchCount||0);
      const ideal=Number(search.idealHitInvoices||0);
      const matchText=matches===1?'1 markiertem Materialtreffer':`${matches} markierten Materialtreffern`;
      incomingTextMeta.innerHTML=`<div class="material-search-status">
        <strong>${hits} Rechnung${hits===1?'':'en'} mit ${matchText}</strong>
        <span class="subline">${scanned} Rechnungen von ${esc(supplierSearchLabel())} geprüft · ${ocr} OCR-Texte gelesen${without?` · ${without} ohne lesbaren OCR-Text`:''}${ideal?` · ${ideal} ideal gereiht`:''}</span>
        <button id="incomingMaterialClear" class="material-search-clear" type="button">× Materialsuche löschen · alle Rechnungen anzeigen</button>
      </div>`;
      document.getElementById('incomingMaterialClear')?.addEventListener('click',clearIncomingMaterialSearch);
    }else{
      incomingTextMeta.innerHTML=Object.keys(yearly).sort((a,b)=>Number(b)-Number(a)).map(y=>{
        const s=yearly[y]||{};
        const oc=Number(s.openCount||0), os=Number(s.openSum||0);
        return `<span class="pill year-summary-pill"><strong>${esc(y)}</strong> · ${Number(s.count||0)} Rechnungen · ${esc(invoiceMoney(Number(s.sum||0)))} · <span class="${oc>0||os>0?'open-total':'open-total-zero'}">${oc} offen · ${esc(invoiceMoney(os))}</span></span>`;
      }).join('');
    }

    renderIncomingGrouped(incomingAll,data.years||{},query,search);
  }catch(e){
    incomingTextMeta.innerHTML='<span class="error">'+esc(e.message)+'</span>';
  }finally{
    loader.style.display='none';
    incomingTextGo.disabled=false;
  }
}


async function runGlobalMaterialSearch(){
  const query=String(materialQ?.value||'').trim();if(query.length<2){materialMeta.textContent='Bitte mindestens 2 Zeichen eingeben.';return}
  materialGo.disabled=true;materialMeta.textContent='The Brain durchsucht alle Materialblöcke …';materialResults.innerHTML='';
  try{const r=await fetch('/material-search?q='+encodeURIComponent(query),{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Materialsuche fehlgeschlagen');
    materialMeta.innerHTML=`<strong>${Number(d.exactCount||0)} passende</strong> · ${Number(d.similarCount||0)} ähnliche Treffer · ${Number(d.scanned||0)} Rechnungen geprüft`;
    const rows=d.results||[];materialResults.innerHTML=rows.length?rows.map(x=>`<div class="material-global-card ${x.matchType==='similar'?'similar':'exact'}">
      ${x.path?`<img class="thumb" loading="lazy" src="${urlFor('/thumb',x.path)}" alt="">`:'<div class="thumb"></div>'}
      <div><div class="material-global-top"><div><div class="material-global-supplier">${esc(x.supplierName||'Lieferant')}</div><div class="sub">${esc(x.supplierAddress||'')}</div></div><span class="material-hit-badge ${x.matchType==='exact'?'ideal':''}">${x.matchType==='similar'?'Ähnlicher Treffer':x.matchType==='exact'?'★ Bester Treffer':'Guter Treffer'}</span></div>
      ${(x.materialMatches||[]).map(m=>`<div class="material-hit-line">${highlightMaterialText(m,query)}</div>`).join('')}
      <div class="sub" style="margin-top:7px">${x.invoiceDate?esc(x.invoiceDate.split('-').reverse().join('.')):''}${x.amount!==null&&x.amount!==undefined?' · '+esc(invoiceMoney(x.amount)):''}</div>
      <div class="actions">${x.path?`<a class="action" href="${urlFor('/pdf',x.path)}">Rechnung öffnen</a>`:''}</div></div>
    </div>`).join(''):'<div class="empty">Kein passendes Material gefunden.</div>';
  }catch(e){materialMeta.innerHTML='<span class="error">'+esc(e.message)+'</span>'}finally{materialGo.disabled=false}
}
materialGo?.addEventListener('click',runGlobalMaterialSearch);materialQ?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();runGlobalMaterialSearch()}});

function monthLabel(month, fallback){
  const names=['','Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  return names[Number(month)||0]||fallback||'Ohne Monat';
}

function renderIncomingDoc(d){
  const date=d.invoiceDate
    ? d.invoiceDate.split('-').reverse().join('.')
    : '';
  const searching=Boolean(incomingMaterialQuery);
  const materialMatches=Array.isArray(d.materialMatches)?d.materialMatches:[];
  const materialBox=searching&&materialMatches.length
    ? `<div class="material-hit-box">
        <div class="material-hit-label">Nur Materialzeilen · ${Number(d.materialMatchCount||materialMatches.length)} Treffer</div>
        ${materialMatches.map(line=>`<div class="material-hit-line">${highlightMaterialText(line,incomingMaterialQuery)}</div>`).join('')}
      </div>`
    : '';
  const hitBadge=searching
    ? `<div class="material-hit-head"><span class="material-hit-badge ${d.materialMatchIdeal?'ideal':''}">${d.materialMatchIdeal?'★ Idealer Treffer':'Materialtreffer'} · ${Number(d.materialMatchCount||1)}</span></div>`
    : '';
  return `<div class="card doc ${searching?'material-search-hit':''}">
    ${d.path
      ? `<img class="thumb" loading="lazy" src="${urlFor('/thumb',d.path)}" alt="">`
      : `<div class="thumb empty" style="display:flex;align-items:center;justify-content:center;color:#666;font-weight:900">WW</div>`}
    <div>
      ${hitBadge}
      ${date?`<div class="day-date">${esc(date)}</div>`:''}
      <div class="docname">${esc(d.invoiceNumber?('Rechnung '+d.invoiceNumber):(d.filename||'Eingangsrechnung'))}</div>
      ${d.amount!==null&&d.amount!==undefined
        ? `<div class="invoice-amount">${esc(invoiceMoney(d.amount))}</div>`:''}
      ${d.paymentStatus?`<div class="${d.paymentState==='open'?'payment-open':d.paymentState==='paid'?'payment-paid':'payment-unknown'}">${esc(d.paymentStatus)}</div>`:''}
      <div class="ww-truth">Quelle: ${esc(d.sourceOfTruth||'WinWorker Eingangsbelege')}</div>
      ${materialBox}
      ${!searching&&d.snippet?`<div class="invoice-snippet">${esc(d.snippet)}</div>`:''}
      <div class="actions">
        ${d.path?`<a class="action" href="${urlFor('/pdf',d.path)}" target="_blank" rel="noopener">PDF öffnen</a>`:'<span class="sub">PDF nicht gefunden</span>'}
        ${d.originalPath?`<a class="action" href="${urlFor('/pdf',d.originalPath)}" target="_blank" rel="noopener">Original</a>`:''}
      </div>
    </div>
  </div>`;
}

function renderIncomingGrouped(rows, yearSummary, textQuery='', searchMeta={}){
  const searching=Boolean(String(textQuery||'').trim());
  if(!rows.length){
    if(searching){
      incomingGrouped.innerHTML=`<div class="material-no-hit">
        <strong>Kein Materialtreffer für „${esc(textQuery)}“</strong>
        Durchsucht wurden ${Number(searchMeta.scannedInvoices||0)} Rechnungen von ${esc(supplierSearchLabel())}. Rechnungskopf, Datum und Rechnungsnummer zählen bewusst nicht als Treffer.
        <div><button class="material-search-clear" type="button" id="incomingMaterialClearEmpty">Alle Rechnungen wieder anzeigen</button></div>
      </div>`;
      document.getElementById('incomingMaterialClearEmpty')?.addEventListener('click',clearIncomingMaterialSearch);
    }else{
      incomingGrouped.innerHTML='<div class="empty">Keine Rechnungen für diese Auswahl gefunden.</div>';
    }
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
    const yearDocs=[...months.values()].flat();
    const yearMatches=yearDocs.reduce((sum,d)=>sum+Number(d.materialMatchCount||0),0);

    const monthHtml=monthKeys.map(m=>{
      const docsForMonth=months.get(m);
      const title=monthLabel(m,docsForMonth[0]?.monthName);
      const monthMatches=docsForMonth.reduce((sum,d)=>sum+Number(d.materialMatchCount||0),0);
      return `<div class="month-block">
        <div class="month-title">${esc(title)} · ${docsForMonth.length}${searching?` Rechnung${docsForMonth.length===1?'':'en'} · ${monthMatches} Materialtreffer`:''}</div>
        <div class="doc-list">${docsForMonth.map(renderIncomingDoc).join('')}</div>
      </div>`;
    }).join('');

    const yearTotal=searching
      ? `<div class="year-total"><strong>${yearDocs.length} Rechnung${yearDocs.length===1?'':'en'}</strong><small>${yearMatches} markierte Materialtreffer</small></div>`
      : `<div class="year-total">
          <strong>${totalKnown?esc(invoiceMoney(yearAmount)):'–'}</strong>
          <small>Jahressumme${totalKnown<totalCount?' · '+totalKnown+'/'+totalCount+' Beträge erkannt':''}</small>
          <small class="${Number(ys.openCount||0)>0||Number(ys.openSum||0)>0?'open-total':'open-total-zero'}">${Number(ys.openCount||0)} offen · ${esc(invoiceMoney(Number(ys.openSum||0)))}</small>
        </div>`;

    return `<div class="year-block">
      <div class="year-header">
        <div class="year-name">${esc(y)}</div>
        ${yearTotal}
      </div>
      ${monthHtml}
    </div>`;
  }).join('');
}

incomingTextGo.onclick=()=>loadSupplierInvoices(incomingTextQ.value.trim());
incomingTextQ.addEventListener('keydown',e=>{
  if(e.key==='Enter')loadSupplierInvoices(incomingTextQ.value.trim());
  if(e.key==='Escape'&&incomingMaterialQuery)clearIncomingMaterialSearch();
});


backToSuppliers.onclick=()=>{
  selectedSupplier=null;selectedWwAddress=null;incomingMaterialQuery='';
  incomingSection.hidden=true;incomingReviewSection.hidden=true;
  incomingSupplierSection.hidden=false;
  meta.textContent=incomingCandidates.length+' WinWorker-Adresse(n) · bitte auswählen';
  incomingSupplierSection.scrollIntoView({behavior:'smooth',block:'start'});
};




function captureAreaIsTest(){return captureArea==='test'}
function updateCaptureAreaUi(){
  const isTest=captureAreaIsTest();
  captureAreaTest.classList.toggle('active',isTest);captureAreaLive.classList.toggle('active',!isTest);
  captureAreaBanner.className='capture-area-banner '+(isTest?'test':'live');
  captureAreaBanner.innerHTML=isTest
    ?'<strong>🧪 Testgelände aktiv</strong>Testnummern, Testdatenbank und Test-PDFs sind vollständig vom Echtbetrieb getrennt. Trainingsbelege dürfen gelöscht werden.'
    :'<strong>🔒 Echtbetrieb aktiv</strong>Die nächste Rechnung erhält eine echte 1150-Nummer. Echtbelege werden nicht gelöscht.';
  captureSave.textContent=isTest?'Testrechnung speichern':'Rechnung verbindlich erfassen';
  captureCostTitle.textContent=isTest?'Test-Kostenentwicklung':'Kostenentwicklung';captureRecentTitle.textContent=isTest?'Trainingsbelege':'Zuletzt erfasst';captureClearTest.hidden=!isTest;
  document.body.classList.toggle('capture-training',isTest);
}
async function setCaptureArea(area,confirmLive=true){
  area=area==='live'?'live':'test';
  if(area==='live'&&captureArea!=='live'&&confirmLive){if(!confirm('In den Echtbetrieb wechseln?\n\nDie nächste gespeicherte Rechnung erhält eine echte 1150-Nummer und kann nicht gelöscht werden.'))return}
  captureArea=area;localStorage.setItem('kristineCaptureArea',captureArea);captureAcceptNewIban=false;updateCaptureAreaUi();resetCaptureForm();await Promise.all([loadCaptureDashboard(),loadCaptureRecent()]);
}
function captureNumber(v){const n=Number(String(v??'').replace(',','.'));return Number.isFinite(n)?n:0}
function setCaptureMessage(text,type=''){captureSaveMessage.textContent=text||'';captureSaveMessage.className='capture-message '+type}
function captureAllocationSeed(seed={}){return {account:seed.account||'',costType:seed.cost_type||seed.costType||'Material',costCenter:seed.cost_center||seed.costCenter||'',projectId:seed.project_id||seed.projectId||'',description:seed.description||'',netAmount:seed.net_amount??seed.netAmount??'',vatRate:seed.vat_rate??seed.vatRate??20}}
function captureNormalizeIban(value){
  let raw=String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^IBAN/,'');
  const lengths={AT:20,DE:22,CH:21,LI:21,IT:27,FR:27,NL:18,BE:16,LU:20};
  const m=raw.match(/([A-Z]{2}\d{2}[A-Z0-9]{10,32})/);if(!m)return '';
  raw=m[1];const len=lengths[raw.slice(0,2)];return len&&raw.length>=len?raw.slice(0,len):raw.slice(0,34);
}
function captureIbanValid(value){
  const iban=captureNormalizeIban(value),lengths={AT:20,DE:22,CH:21,LI:21,IT:27,FR:27,NL:18,BE:16,LU:20};
  if(!iban||lengths[iban.slice(0,2)]&&iban.length!==lengths[iban.slice(0,2)])return false;
  const rearranged=iban.slice(4)+iban.slice(0,4);let remainder=0;
  for(const ch of rearranged){const part=/[A-Z]/.test(ch)?String(ch.charCodeAt(0)-55):ch;for(const digit of part)remainder=(remainder*10+Number(digit))%97}
  return remainder===1;
}
function captureFormatIban(value){return captureNormalizeIban(value).replace(/(.{4})/g,'$1 ').trim()}
function captureDateDE(value){if(!value)return '–';const p=String(value).split('-');return p.length===3?`${p[2]}.${p[1]}.${p[0]}`:value}

function renderCaptureAllocations(){
  if(!captureAllocationRows.length)captureAllocationRows=[captureAllocationSeed()];
  const costOptions=['Material','Fremdleistung','Miete','Strom','Gas / Heizung','Versicherung','Fahrzeug','IT / Telefon','Werkstatt','Büro','Werbung','Steuerberater','Maschinen','Sonstiges'];
  captureAllocations.innerHTML=captureAllocationRows.map((row,i)=>`<div class="capture-allocation" data-allocation="${i}">
    <div><div class="formlabel">Sachkonto</div><input data-field="account" value="${esc(row.account)}" placeholder="z. B. 5100"></div>
    <div><div class="formlabel">Kostenart</div><select data-field="costType">${costOptions.map(x=>`<option ${x===row.costType?'selected':''}>${esc(x)}</option>`).join('')}</select></div>
    <div><div class="formlabel">Kostenstelle</div><input data-field="costCenter" value="${esc(row.costCenter)}" placeholder="Firma / Büro"></div>
    <div><div class="formlabel">Baustelle</div><input data-field="projectId" value="${esc(row.projectId)}" placeholder="26083"></div>
    <div><div class="formlabel">Beschreibung</div><input data-field="description" value="${esc(row.description)}"></div>
    <div><div class="formlabel">Netto</div><input data-field="netAmount" type="number" step="0.01" value="${esc(row.netAmount)}"></div>
    <div><div class="formlabel">USt %</div><input data-field="vatRate" type="number" step="0.01" value="${esc(row.vatRate)}"></div>
    <button class="remove" type="button" data-remove="${i}">×</button>
  </div>`).join('');
  captureAllocations.querySelectorAll('[data-allocation]').forEach(node=>{const i=Number(node.dataset.allocation);node.querySelectorAll('[data-field]').forEach(input=>input.oninput=()=>{captureAllocationRows[i][input.dataset.field]=input.value;updateCaptureAllocationTotal()})});
  captureAllocations.querySelectorAll('[data-remove]').forEach(btn=>btn.onclick=()=>{captureAllocationRows.splice(Number(btn.dataset.remove),1);renderCaptureAllocations()});
  updateCaptureAllocationTotal();
}
function updateCaptureAllocationTotal(){
  const net=captureNumber(captureNet.value),allocated=captureAllocationRows.reduce((sum,row)=>sum+captureNumber(row.netAmount),0),diff=Math.round((net-allocated)*100)/100,ok=Math.abs(diff)<=0.02;
  captureAllocationTotal.className='capture-total '+(ok?'good':'bad');
  captureAllocationTotal.innerHTML=`<span>Rechnungs-Netto <strong>${esc(invoiceMoney(net))}</strong></span><span>Kontiert <strong>${esc(invoiceMoney(allocated))}</strong></span><span>Differenz <strong>${esc(invoiceMoney(diff))}</strong></span>`;return ok;
}
function captureAutoAmounts(source){
  let net=captureNumber(captureNet.value),vat=captureNumber(captureVat.value),gross=captureNumber(captureGross.value);
  const rate=captureNumber(captureAllocationRows[0]?.vatRate??20);
  if(source==='gross'&&gross&&!net&&!vat&&rate>=0){net=rate?gross/(1+rate/100):gross;vat=gross-net;captureNet.value=net.toFixed(2);captureVat.value=vat.toFixed(2)}
  else if(gross&&net){captureVat.value=(gross-net).toFixed(2)}
  else if(net&&vat){captureGross.value=(net+vat).toFixed(2)}
  if(captureAllocationRows.length===1&&!captureAllocationRows[0].netAmount&&captureNumber(captureNet.value))captureAllocationRows[0].netAmount=captureNumber(captureNet.value).toFixed(2);
  renderCaptureAllocations();
}
function updateCaptureSkontoUi(){
  const on=captureSkontoEnabled.value==='1';captureSkontoPercent.disabled=!on;captureSkontoDueDate.disabled=!on;
  captureSkontoPercentWrap.classList.toggle('capture-skonto-off',!on);captureSkontoDueWrap.classList.toggle('capture-skonto-off',!on);
  if(!on){captureSkontoPercent.value='';captureSkontoDueDate.value=''}
}
function captureSetAnalyzeSteps(analysis={},stage='done'){
  if(stage==='loading'){captureAnalyzeSteps.innerHTML='<span class="capture-analyze-step">PDF lesen</span><span class="capture-analyze-step">OCR prüfen</span><span class="capture-analyze-step">Lieferant suchen</span>';return}
  const steps=[`<span class="capture-analyze-step ok">✓ ${Number(analysis.pageCount||0)} Seite(n)</span>`];
  steps.push(`<span class="capture-analyze-step ${analysis.ocrWarning?'warn':'ok'}">${analysis.ocrUsed?'✓ OCR '+Number(analysis.ocrPages||0)+' Seite(n)':'✓ PDF-Text'}</span>`);
  if(analysis.supplierName)steps.push('<span class="capture-analyze-step ok">✓ Lieferant erkannt</span>');
  if(analysis.supplierInvoiceNumber)steps.push('<span class="capture-analyze-step ok">✓ Rechnungsnummer</span>');
  if(analysis.grossAmount!==null&&analysis.grossAmount!==undefined)steps.push('<span class="capture-analyze-step ok">✓ Betrag</span>');
  captureAnalyzeSteps.innerHTML=steps.join('');
}
function showCapturePdf(file){
  if(capturePdfObjectUrl)URL.revokeObjectURL(capturePdfObjectUrl);capturePdfObjectUrl='';
  if(!file){capturePdfPreview.hidden=true;capturePdfPreview.removeAttribute('src');capturePdfEmpty.hidden=false;captureOpenPdf.hidden=true;return}
  capturePdfObjectUrl=URL.createObjectURL(file);capturePdfPreview.src=capturePdfObjectUrl;capturePdfPreview.hidden=false;capturePdfEmpty.hidden=true;captureOpenPdf.href=capturePdfObjectUrl;captureOpenPdf.hidden=false;
}
function setCaptureFile(file){
  if(!file||!String(file.name||'').toLowerCase().endsWith('.pdf')){setCaptureMessage('Bitte eine PDF-Datei verwenden.','error');return}
  const dt=new DataTransfer();dt.items.add(file);captureFile.files=dt.files;analyzeCaptureFile();
}
function renderCaptureSupplierResults(rows=[],suggested=false){
  captureSupplierResults.innerHTML=rows.length?rows.map((s,i)=>`<div class="card capture-supplier-choice ${i===0&&suggested?'best':''}" data-capture-supplier="${i}">
    ${i===0&&suggested?'<span class="capture-match-badge">★ Bester Vorschlag</span>':''}
    <strong>${esc(s.name||'Adresse')}</strong>${s.address?`<div class="sub">${esc(s.address)}</div>`:''}
    <div class="sub">Lieferant ${esc(s.supplierNumber||'–')} · WW-Adresse ${esc(s.customerNumber||s.addressId||'–')}</div>
    ${s.ourCustomerNumber?`<div class="sub">Unsere KundenNr. dort: ${esc(s.ourCustomerNumber)}</div>`:''}
    ${s.vatId?`<div class="sub">UID ${esc(s.vatId)}</div>`:''}
    ${(s.matchReasons||[]).length?`<div class="capture-match-reasons">${esc(s.matchReasons.join(' · '))}</div>`:''}
  </div>`).join(''):'<div class="empty">Keine passende WinWorker-Adresse gefunden. Lieferant kann händisch gesucht werden.</div>';
  captureSupplierResults.querySelectorAll('[data-capture-supplier]').forEach(card=>card.onclick=()=>selectCaptureSupplier(rows[Number(card.dataset.captureSupplier)]));
}
async function analyzeCaptureFile(){
  const file=captureFile.files?.[0];captureAnalysis=null;captureSelectedSupplier=null;captureAcceptNewIban=false;
  captureSelectedSupplierBox.innerHTML='Noch kein Lieferant ausgewählt.';captureSupplierResults.innerHTML='';captureBankWarning.innerHTML='';
  if(!file){captureDrop.classList.remove('has-file');captureAnalyzeMeta.textContent='';captureSetAnalyzeSteps({},'');showCapturePdf(null);return}
  showCapturePdf(file);captureDrop.classList.add('has-file');captureAnalyzeMeta.textContent='PDF wird gelesen …';captureSetAnalyzeSteps({},'loading');
  const fd=new FormData();fd.append('file',file);fd.append('area',captureArea);
  try{
    const r=await fetch('/incoming/capture/analyze',{method:'POST',body:fd});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'PDF konnte nicht gelesen werden');
    captureAnalysis=d.analysis||{};captureSetAnalyzeSteps(captureAnalysis,'done');
    if(captureAnalysis.supplierName)captureSupplierQ.value=captureAnalysis.supplierName;else captureSupplierQ.value='';
    captureInvoiceNumber.value=captureAnalysis.supplierInvoiceNumber||'';captureInvoiceDate.value=captureAnalysis.invoiceDate||'';captureNetDueDate.value=captureAnalysis.netDueDate||captureAnalysis.dueDate||'';
    captureSkontoEnabled.value=captureAnalysis.skontoEnabled?'1':'0';captureSkontoPercent.value=captureAnalysis.skontoPercent??'';captureSkontoDueDate.value=captureAnalysis.skontoDueDate||'';capturePaymentTerms.value=captureAnalysis.paymentTerms||'';updateCaptureSkontoUi();
    if(captureAnalysis.netAmount!==null&&captureAnalysis.netAmount!==undefined)captureNet.value=Number(captureAnalysis.netAmount).toFixed(2);else captureNet.value='';
    if(captureAnalysis.vatAmount!==null&&captureAnalysis.vatAmount!==undefined)captureVat.value=Number(captureAnalysis.vatAmount).toFixed(2);else captureVat.value='';
    if(captureAnalysis.grossAmount!==null&&captureAnalysis.grossAmount!==undefined)captureGross.value=Number(captureAnalysis.grossAmount).toFixed(2);else captureGross.value='';
    captureInvoiceIban.value=captureFormatIban(captureAnalysis.iban||'');captureMasterIban.value='';captureExternalCustomerNo.value='';captureBookingText.value=captureAnalysis.bookingText||'';
    if(captureAnalysis.vatRate!==null&&captureAnalysis.vatRate!==undefined&&captureAllocationRows.length===1)captureAllocationRows[0].vatRate=Number(captureAnalysis.vatRate);
    if(captureAllocationRows.length===1&&captureNet.value)captureAllocationRows[0].netAmount=Number(captureNet.value).toFixed(2);renderCaptureAllocations();
    const suggestions=d.supplierSuggestions||[];renderCaptureSupplierResults(suggestions,true);
    const parts=[];if(d.duplicate)parts.push(`⚠ Bereits als ${d.duplicate.doc_id||'Rechnung'} gespeichert`);else parts.push('✓ Rechnung gelesen');
    if(captureAnalysis.supplierName)parts.push(`Vorschlag: ${captureAnalysis.supplierName}`);if(d.suggestionError)parts.push('WW-Vorschläge konnten nicht vollständig geladen werden');if(captureAnalysis.ocrWarning)parts.push(captureAnalysis.ocrWarning);
    captureAnalyzeMeta.innerHTML=parts.map(esc).join(' · ');
  }catch(e){captureAnalyzeMeta.innerHTML='<span class="error">'+esc(e.message)+'</span>';captureSetAnalyzeSteps({},'')}
}
async function searchCaptureSuppliers(){
  const term=captureSupplierQ.value.trim();if(term.length<2){captureSupplierQ.focus();return}captureSupplierResults.innerHTML='<div class="empty">Suche …</div>';
  try{const r=await fetch('/incoming/capture/suppliers?q='+encodeURIComponent(term),{cache:'no-store'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Adresssuche fehlgeschlagen');renderCaptureSupplierResults(d.addresses||[],false)}catch(e){captureSupplierResults.innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}
}
async function selectCaptureSupplier(supplier){
  captureSelectedSupplier=supplier;captureSupplierResults.innerHTML='';captureAcceptNewIban=false;
  captureSelectedSupplierBox.innerHTML=`<div class="card capture-selected"><strong>${esc(supplier.name||'Lieferant')}</strong>${supplier.address?`<div class="sub">${esc(supplier.address)}</div>`:''}<div class="sub">StammIndex ${esc(supplier.addressId||'')} · Lieferantennr. ${esc(supplier.supplierNumber||'–')}</div>${supplier.ourCustomerNumber?`<div class="payment-ok">Unsere KundenNr. dort: ${esc(supplier.ourCustomerNumber)}</div>`:''}</div>`;
  captureExternalCustomerNo.value=supplier.ourCustomerNumber||captureAnalysis?.customerNumberExternal||'';
  try{
    const r=await fetch('/incoming/capture/supplier-context?addressId='+encodeURIComponent(supplier.addressId||'')+'&area='+encodeURIComponent(captureArea),{cache:'no-store'});const d=await r.json();
    if(r.ok&&d.ok){supplier._context=d.context||{};captureMasterIban.value=captureFormatIban(supplier._context.latestIban||'');const defaults=supplier._context.defaults||{};if(captureAllocationRows.length===1){const row=captureAllocationRows[0];if(!row.account&&!row.costCenter&&!row.projectId){captureAllocationRows[0]={...row,...captureAllocationSeed(defaults)};if(captureNet.value&&!captureAllocationRows[0].netAmount)captureAllocationRows[0].netAmount=Number(captureNet.value).toFixed(2);renderCaptureAllocations()}}}
  }catch(e){captureMasterIban.value=''}
  checkCaptureBankWarning();
}
function checkCaptureBankWarning(){
  const invoice=captureNormalizeIban(captureInvoiceIban.value),master=captureNormalizeIban(captureMasterIban.value),valid=!invoice||captureIbanValid(invoice);
  captureInvoiceIban.value=captureFormatIban(invoice);captureAcceptNewIban=false;
  if(!invoice){captureBankWarning.innerHTML='<div class="capture-bank-warning bad">⚠ Auf der Rechnung wurde keine IBAN sicher erkannt. Stamm-IBAN bleibt unverändert.</div>';return}
  if(!valid){captureBankWarning.innerHTML=`<div class="capture-bank-warning bad">⚠ Die erkannte IBAN ist formal nicht gültig: <strong>${esc(captureFormatIban(invoice))}</strong><br>Bitte anhand der Rechnung korrigieren.</div>`;return}
  if(master&&invoice===master){captureBankWarning.innerHTML=`<div class="capture-bank-warning ok">✓ IBAN auf der Rechnung stimmt mit den Stammdaten überein: <strong>${esc(captureFormatIban(master))}</strong></div>`;return}
  const title=master?'⚠ Neue Bankverbindung auf der Rechnung erkannt':'⚠ Noch keine bestätigte Stamm-IBAN vorhanden';
  captureBankWarning.innerHTML=`<div class="capture-bank-warning"><strong>${title}</strong><div class="capture-bank-comparison"><div class="capture-bank-value"><small>Bisher / Stammdaten</small><strong>${esc(captureFormatIban(master)||'keine')}</strong></div><div class="capture-bank-value"><small>Auf dieser Rechnung</small><strong>${esc(captureFormatIban(invoice))}</strong></div></div><label class="capture-accept-bank"><input id="captureAcceptNewIban" type="checkbox"> <span>Neue IBAN aus dieser Rechnung übernehmen</span></label></div>`;
  const check=document.getElementById('captureAcceptNewIban');if(check)check.onchange=()=>{captureAcceptNewIban=check.checked};
}
function capturePayload(){return {
  area:captureArea,trainingMode:captureAreaIsTest(),documentType:captureDocumentType.value,supplier:captureSelectedSupplier,supplierInvoiceNumber:captureInvoiceNumber.value.trim(),invoiceDate:captureInvoiceDate.value,
  dueDate:captureNetDueDate.value,netDueDate:captureNetDueDate.value,skontoEnabled:captureSkontoEnabled.value==='1',skontoPercent:captureNumber(captureSkontoPercent.value),skontoDueDate:captureSkontoDueDate.value,paymentTerms:capturePaymentTerms.value.trim(),
  netAmount:captureNumber(captureNet.value),vatAmount:captureNumber(captureVat.value),grossAmount:captureNumber(captureGross.value),currency:captureCurrency.value,
  masterIban:captureNormalizeIban(captureMasterIban.value),invoiceIban:captureNormalizeIban(captureInvoiceIban.value),acceptNewIban:captureAcceptNewIban,customerNumberExternal:captureExternalCustomerNo.value.trim(),
  bookingText:captureBookingText.value.trim(),note:captureNote.value.trim(),createdBy:captureCreatedBy.value.trim()||'Dunja',workflowStatus:captureWorkflow.value,
  allocations:captureAllocationRows.map((row,i)=>({lineNo:i+1,account:String(row.account||'').trim(),costType:String(row.costType||'Sonstiges'),costCenter:String(row.costCenter||'').trim(),projectId:String(row.projectId||'').trim(),description:String(row.description||'').trim(),netAmount:captureNumber(row.netAmount),vatRate:captureNumber(row.vatRate)}))
}}
function resetCaptureForm(){
  captureFile.value='';captureDrop.classList.remove('has-file','dragover');captureAnalyzeMeta.textContent='';captureAnalyzeSteps.innerHTML='';captureAnalysis=null;captureSelectedSupplier=null;captureAcceptNewIban=false;showCapturePdf(null);
  captureSelectedSupplierBox.innerHTML='Noch kein Lieferant ausgewählt.';captureSupplierResults.innerHTML='';captureBankWarning.innerHTML='';captureSupplierQ.value='';
  [captureInvoiceNumber,captureInvoiceDate,captureNetDueDate,captureSkontoPercent,captureSkontoDueDate,capturePaymentTerms,captureNet,captureVat,captureGross,captureMasterIban,captureInvoiceIban,captureExternalCustomerNo,captureBookingText,captureNote].forEach(x=>x.value='');
  captureDocumentType.value='Rechnung';captureCurrency.value='EUR';captureWorkflow.value='zu_pruefen';captureSkontoEnabled.value='0';updateCaptureSkontoUi();captureAllocationRows=[captureAllocationSeed()];renderCaptureAllocations();
}
async function saveCaptureInvoice(){
  const file=captureFile.files?.[0];if(!file)return setCaptureMessage('Bitte zuerst ein PDF auswählen.','error');if(!captureSelectedSupplier?.addressId)return setCaptureMessage('Bitte den Lieferanten aus WinWorker auswählen.','error');
  if(!captureInvoiceNumber.value.trim())return setCaptureMessage('Lieferanten-Rechnungsnummer fehlt.','error');if(!captureInvoiceDate.value)return setCaptureMessage('Rechnungsdatum fehlt.','error');
  if(captureSkontoEnabled.value==='1'&&captureNumber(captureSkontoPercent.value)<=0)return setCaptureMessage('Bei Skonto bitte den Prozentsatz eintragen.','error');
  if(!updateCaptureAllocationTotal())return setCaptureMessage('Kontierung stimmt noch nicht mit dem Netto überein.','error');
  captureSave.disabled=true;setCaptureMessage(captureAreaIsTest()?'KRISTINE speichert ins Testgelände …':'KRISTINE vergibt die echte Nummer und speichert …');
  const fd=new FormData();fd.append('file',file);fd.append('payload',JSON.stringify(capturePayload()));
  try{const r=await fetch('/incoming/capture/save',{method:'POST',body:fd});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Speichern fehlgeschlagen');const warning=d.warnings?.length?' · '+d.warnings.join(' · '):'';setCaptureMessage(`✓ ${d.invoice.docId} ${d.trainingMode?'im Testgelände':'verbindlich'} gespeichert${warning}`,'success');resetCaptureForm();await Promise.all([loadCaptureDashboard(),loadCaptureRecent()])}catch(e){setCaptureMessage(e.message,'error')}finally{captureSave.disabled=false}
}
function renderCaptureDashboard(d){
  const n=d.numbering||{},isTest=Boolean(d.trainingMode);captureNextNumber.textContent=(isTest?'Nächste Testnummer ':'Nächste Nummer ')+(n.nextDocId||'–');captureCostYear.textContent=d.year||'';
  captureDashboard.innerHTML=`<div class="capture-kpi"><small>${isTest?'Test · zu prüfen':'Zu prüfen'}</small><strong>${Number(d.reviewCount||0)}</strong></div><div class="capture-kpi"><small>${isTest?'Test-Summe offen':'Offen'}</small><strong>${esc(invoiceMoney(Number(d.openSum||0)))}</strong></div><div class="capture-kpi"><small>${esc(d.year||'')} ${isTest?'Testbelege':'erfasst'}</small><strong>${Number(d.yearCount||0)}</strong></div><div class="capture-kpi"><small>${esc(d.year||'')} ${isTest?'Testsumme':'Summe'}</small><strong>${esc(invoiceMoney(Number(d.yearSum||0)))}</strong></div>`;
  const costs=d.costSummary||[];captureCostSummary.innerHTML=costs.length?costs.map(x=>`<div class="capture-cost-card"><span>${esc(x.costType)}</span><strong>${esc(invoiceMoney(Number(x.netSum||0)))}</strong><small>${Number(x.invoiceCount||0)} Rechnung(en)</small></div>`).join(''):`<div class="empty">${isTest?'Noch keine Trainings-Kontierungen.':'Noch keine KRISTINE-Kontierungen in diesem Jahr.'}</div>`;
}
async function loadCaptureDashboard(){const r=await fetch('/incoming/capture/dashboard?area='+encodeURIComponent(captureArea),{cache:'no-store'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Dashboard konnte nicht geladen werden');renderCaptureDashboard(d.dashboard||{})}
function renderCaptureRecent(rows){
  const isTest=captureAreaIsTest();captureRecent.innerHTML=rows.length?rows.map(x=>`<div class="card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><strong>${esc(x.docId)}</strong><div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${x.trainingMode?'<span class="capture-badge training">TEST</span>':''}<span class="capture-badge ${x.workflowStatus==='geprueft'?'done':'review'}">${x.workflowStatus==='geprueft'?'Geprüft':'Zu prüfen'}</span></div></div><div class="sub">${esc(x.supplierName)} · Rechnung ${esc(x.invoiceNumber)}</div><div class="invoice-amount">${esc(invoiceMoney(x.grossAmount))}</div><div class="sub">${esc((x.allocations||[]).map(a=>a.costType).filter(Boolean).join(' · '))}</div><div class="actions"><a class="action" href="${urlFor('/pdf',x.path)}" target="_blank" rel="noopener">PDF öffnen</a>${x.trainingMode?`<button class="capture-delete" type="button" data-delete-test="${Number(x.id)}" data-doc-id="${esc(x.docId)}">Testrechnung löschen</button>`:''}</div></div>`).join(''):`<div class="empty">${isTest?'Noch keine Trainingsbelege im Testgelände.':'Noch keine Rechnungen in KRISTINE erfasst.'}</div>`;
  captureRecent.querySelectorAll('[data-delete-test]').forEach(btn=>btn.onclick=()=>deleteCaptureTestInvoice(Number(btn.dataset.deleteTest),btn.dataset.docId||''));
}
async function loadCaptureRecent(){const r=await fetch('/incoming/capture/list?limit=30&area='+encodeURIComponent(captureArea),{cache:'no-store'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Liste konnte nicht geladen werden');renderCaptureRecent(d.invoices||[])}
async function deleteCaptureTestInvoice(invoiceId,docId){if(!captureAreaIsTest())return;if(!confirm(`Testrechnung ${docId||invoiceId} wirklich vollständig löschen?\n\nDatensatz, Arbeits-PDF und Original-PDF werden entfernt.`))return;setCaptureMessage(`Lösche ${docId||invoiceId} aus dem Testgelände …`);try{const r=await fetch('/incoming/capture/'+encodeURIComponent(invoiceId)+'?area=test',{method:'DELETE'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Löschen fehlgeschlagen');setCaptureMessage(`✓ ${d.docId||docId} aus dem Testgelände gelöscht`,'success');await Promise.all([loadCaptureDashboard(),loadCaptureRecent()])}catch(e){setCaptureMessage(e.message,'error')}}
async function clearCaptureTestArea(){if(!captureAreaIsTest())return;const typed=prompt('Gesamtes Testgelände leeren?\n\nAlle Trainingsrechnungen und Test-PDFs werden endgültig gelöscht.\n\nZur Sicherheit TEST LEEREN eingeben:');if(typed!=='TEST LEEREN')return;setCaptureMessage('Leere das Testgelände …');try{const r=await fetch('/incoming/capture/test-area',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'TESTGELAENDE LEEREN'})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Testgelände konnte nicht geleert werden');setCaptureMessage(`✓ ${Number(d.deletedCount||0)} Trainingsbeleg(e) gelöscht`,'success');await Promise.all([loadCaptureDashboard(),loadCaptureRecent()])}catch(e){setCaptureMessage(e.message,'error')}}
async function initCapture(){updateCaptureAreaUi();if(!captureAllocationRows.length){captureAllocationRows=[captureAllocationSeed()];renderCaptureAllocations()}updateCaptureSkontoUi();await Promise.all([loadCaptureDashboard(),loadCaptureRecent()])}

captureFile.onchange=analyzeCaptureFile;captureSupplierGo.onclick=searchCaptureSuppliers;captureSupplierQ.addEventListener('keydown',e=>{if(e.key==='Enter')searchCaptureSuppliers()});
captureInvoiceIban.addEventListener('change',checkCaptureBankWarning);captureInvoiceIban.addEventListener('blur',checkCaptureBankWarning);captureSkontoEnabled.onchange=updateCaptureSkontoUi;
captureNet.oninput=()=>captureAutoAmounts('net');captureVat.oninput=()=>captureAutoAmounts('vat');captureGross.oninput=()=>captureAutoAmounts('gross');
captureAddAllocation.onclick=()=>{captureAllocationRows.push(captureAllocationSeed());renderCaptureAllocations()};captureSave.onclick=saveCaptureInvoice;captureReload.onclick=()=>Promise.all([loadCaptureDashboard(),loadCaptureRecent()]);
captureAreaTest.onclick=()=>setCaptureArea('test');captureAreaLive.onclick=()=>setCaptureArea('live');captureClearTest.onclick=clearCaptureTestArea;
['dragenter','dragover'].forEach(type=>captureDrop.addEventListener(type,e=>{e.preventDefault();e.stopPropagation();captureDrop.classList.add('dragover')}));
['dragleave','drop'].forEach(type=>captureDrop.addEventListener(type,e=>{e.preventDefault();e.stopPropagation();captureDrop.classList.remove('dragover')}));
captureDrop.addEventListener('drop',e=>{const file=[...(e.dataTransfer?.files||[])].find(f=>String(f.name||'').toLowerCase().endsWith('.pdf'));if(file)setCaptureFile(file);else setCaptureMessage('Bitte eine PDF-Datei hineinziehen.','error')});

async function runSearch(term,isRefined=false){
  term=String(term||'').trim();
  if(term.length<2){meta.innerHTML='<span class="error">Bitte mindestens 2 Zeichen eingeben.</span>';q.focus();return}

  baseQuery=term;selectedAddress=null;selectedProjectAddress=null;selectedProject=null;projectOverview=null;
  projectDetailMode=false;previousView=null;projectAddressCandidates=[];currentProjects=[];currentDocs=[];currentDocType='';
  loader.style.display='block';meta.textContent='Suche passende WinWorker-Kunden und Adressen …';
  projectAddressSection.hidden=true;ps.hidden=true;ds.hidden=true;addressBar.hidden=true;summary.hidden=true;projectCustomerOverview.hidden=true;
  backToProjectAddresses.hidden=true;backToProjects.hidden=true;projectsTitle.textContent='Projekte auswählen';
  projects.innerHTML='';docs.innerHTML='';sourceTypes.innerHTML='';projectAddresses.innerHTML='';
  try{
    const r=await fetch('/project/address-search?q='+encodeURIComponent(term),{cache:'no-store'});
    const data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||'Fehler');
    projectAddressCandidates=data.addresses||[];
    renderProjectAddressCandidates();
    meta.textContent=projectAddressCandidates.length
      ? `${projectAddressCandidates.length} WinWorker-Adresse(n) gefunden · bitte die richtige Adresse auswählen`
      : 'Keine passende WinWorker-Adresse gefunden.';
  }catch(e){
    meta.innerHTML='<span class="error">Projektsuche fehlgeschlagen: '+esc(e.message)+'</span>';
  }finally{loader.style.display='none'}
}

function splitStreet(raw){
  const s=String(raw||'').trim();const m=s.match(/^(.*?)(?:\s+)(\d+[A-Za-z]?[-\/]?\d*[A-Za-z]?)$/);
  return m?{street:m[1],house:m[2]}:{street:s,house:''};
}
async function openNewJob(project){
  const p=project||selectedProject||selectedProjectAddress||currentProjects[0]||{};
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
const initialMode=new URLSearchParams(location.search).get('mode');
if(initialMode==='capture'||location.pathname.includes('incoming-capture'))setSearchMode('capture');else if(initialMode==='incoming')setSearchMode('incoming');else setSearchMode('projects');
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
        "version": "0.13.6",
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


@app.post("/ww-materials/sync")
def ww_materials_sync():
    """Liest WW live und überträgt ausschließlich Materialstamm-Kopien an KRISTINE."""
    try:
        materials = ww_material_master_rows()
        if not materials:
            return jsonify({"ok": False, "error": "WinWorker lieferte keine Materialien; Abgleich abgebrochen."}), 409
        result = kristine_api_request(
            "/admin/api/materials/sync-winworker",
            method="POST",
            payload={"materials": materials},
        )
        return jsonify({
            "ok": True,
            "sourceCount": len(materials),
            "report": result.get("report") or {},
            "message": f"{len(materials)} WW-Artikel gelesen und an KRISTINE übertragen.",
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/ww-materials/preview")
def ww_materials_preview():
    """Lokale Diagnoseansicht; wird über Tailscale absichtlich nicht freigegeben."""
    try:
        query = re.sub(r"[^a-z0-9]", "", str(request.args.get("q") or "").lower())
        limit = max(1, min(200, int(request.args.get("limit") or 30)))
        materials = ww_material_master_rows()
        if query:
            materials = [item for item in materials if query in re.sub(
                r"[^a-z0-9]", "", " ".join(str(item.get(key) or "") for key in (
                    "sourceId", "product", "supplier", "supplierArticleNumber", "orderNumber", "matchCode", "directory"
                )).lower()
            )]
        return jsonify({"ok": True, "count": len(materials), "materials": materials[:limit]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/ww-materials/search")
def ww_materials_search():
    """Geschützte WinWorker-Materialsuche für KRISADMIN."""
    return ww_materials_preview()


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



@app.route("/contacts", methods=["GET", "POST", "DELETE"])
def contacts_api():
    try:
        if request.method == "GET":
            entity_type = request.args.get("entityType")
            entity_id = request.args.get("entityId")
            return jsonify({"ok": True, "contacts": brain_contacts(entity_type, entity_id)})
        if request.method == "POST":
            payload = request.get_json(silent=True) or {}
            contact_id = _save_brain_contact(payload)
            return jsonify({"ok": True, "id": contact_id, "contacts": brain_contacts(payload.get("entityType"), payload.get("entityId"))})
        deleted = _delete_brain_contact(request.args.get("id"), request.args.get("entityType"), request.args.get("entityId"))
        return jsonify({"ok": True, "deleted": deleted})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/material-search")
def material_search_api():
    try:
        data = global_material_search(request.args.get("q"), request.args.get("limit", 80))
        return jsonify({"ok": True, **data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/project/address-search")
def project_address_search_api():
    q = str(request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"ok": True, "query": q, "addresses": []})
    try:
        rows = project_address_candidates(q, request.args.get("limit", 30))
        return jsonify({
            "ok": True,
            "query": q,
            "addresses": rows,
            "count": len(rows),
            "sourceOfTruth": "WinWorker Projekte + Kunden + Belegnummern",
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/tower/planning")
def tower_planning_api():
    try:
        data = company_planning_year(request.args.get("year", 2026))
        return jsonify({"ok": True, **data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/tower/live-summary")
def tower_live_summary_api():
    """Nur die für den Tower nötigen Summen ausgeben, keine OP-Einzelposten."""
    try:
        with app.test_client() as client:
            debtors = client.get("/api/outgoing/open-items").get_json(silent=True) or {}
            creditors = client.get("/incoming/payment-open-items").get_json(silent=True) or {}
        if debtors.get("ok") is False or creditors.get("ok") is False:
            raise RuntimeError(debtors.get("error") or creditors.get("error") or "OP-Summen nicht verfügbar")
        planning = company_planning_year(request.args.get("year", 2026))
        return jsonify({
            "ok": True,
            "planning": planning,
            "customers": {
                "total": float(debtors.get("totalOpen") or 0),
                "count": len(debtors.get("items") or []),
            },
            "suppliers": {
                "total": float(creditors.get("total") or 0),
                "count": int(creditors.get("count") or 0),
            },
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/project/address-projects")
def project_address_projects_api():
    customer_index = request.args.get("customerIndex")
    try:
        if customer_index in (None, ""):
            raise ValueError("WinWorker-Kundenadresse fehlt.")
        overview, projects = customer_project_overview(int(customer_index))
        return jsonify({
            "ok": True,
            "overview": overview,
            "projects": projects,
            "count": len(projects),
        })
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/project/documents")
def project_documents_api():
    project_index = request.args.get("projectIndex")
    try:
        if project_index in (None, ""):
            raise ValueError("WinWorker-Projekt fehlt.")
        data = project_document_catalog(int(project_index))
        return jsonify({"ok": True, **data})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
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




@app.get("/incoming-capture")
def incoming_capture_home():
    return render_template_string(MOBILE_PAGE)


@app.get("/incoming/capture/next-number")
def incoming_capture_next_number():
    try:
        year = int(request.args.get("year") or datetime.now().year)
        area = _capture_area(request.args.get("area"))
        return jsonify({"ok": True, "area": area, "numbering": _capture_number_status_for_area(year, area)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/incoming/capture/dashboard")
def incoming_capture_dashboard():
    try:
        year = int(request.args.get("year") or datetime.now().year)
        area = _capture_area(request.args.get("area"))
        return jsonify({"ok": True, "area": area, "dashboard": _capture_dashboard(year, area)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/incoming/capture/suppliers")
def incoming_capture_suppliers():
    q = str(request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"ok": False, "error": "Bitte mindestens 2 Zeichen eingeben."}), 400
    try:
        rows = ww_address_search(q, 30)
        return jsonify({"ok": True, "addresses": rows, "count": len(rows)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/incoming/capture/supplier-context")
def incoming_capture_supplier_context():
    address_id = str(request.args.get("addressId") or "").strip()
    if not address_id:
        return jsonify({"ok": False, "error": "WW-Adresse fehlt."}), 400
    try:
        area = _capture_area(request.args.get("area"))
        return jsonify({"ok": True, "area": area, "context": _capture_supplier_context(address_id, area)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/incoming/capture/analyze")
def incoming_capture_analyze():
    upload = request.files.get("file")
    if not upload or not str(upload.filename or "").lower().endswith(".pdf"):
        return jsonify({"ok": False, "error": "Bitte eine PDF-Datei auswählen."}), 400
    try:
        pdf_bytes = upload.read()
        if not pdf_bytes:
            raise ValueError("PDF ist leer.")
        analysis = _capture_analyze_pdf(pdf_bytes, upload.filename)
        area = _capture_area(request.form.get("area") or request.args.get("area"))
        duplicate = None
        if area == "live":
            con = _capture_area_connection(area)
            try:
                duplicate = con.execute(
                    "SELECT id, doc_id, supplier_name, supplier_invoice_number FROM incoming_invoices WHERE file_sha256 = ? LIMIT 1",
                    (analysis["sha256"],)
                ).fetchone()
            finally:
                con.close()
        suggestions, suggestion_error = _capture_supplier_suggestions(analysis, 8)
        return jsonify({
            "ok": True,
            "area": area,
            "trainingMode": area == "test",
            "analysis": {k: v for k, v in analysis.items() if k != "text"},
            "supplierSuggestions": suggestions,
            "suggestionError": suggestion_error,
            "duplicate": dict(duplicate) if duplicate else None,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.post("/incoming/capture/save")
def incoming_capture_save():
    upload = request.files.get("file")
    if not upload or not str(upload.filename or "").lower().endswith(".pdf"):
        return jsonify({"ok": False, "error": "PDF fehlt."}), 400
    try:
        payload = json.loads(str(request.form.get("payload") or "{}"))
    except Exception:
        return jsonify({"ok": False, "error": "Formulardaten sind ungültig."}), 400

    area_hint = payload.get("area") or ("test" if _capture_truthy(payload.get("trainingMode")) else "live")
    area = _capture_area(area_hint)
    created_paths = []
    try:
        supplier = payload.get("supplier") or {}
        address_id = str(supplier.get("addressId") or "").strip()
        supplier_name = str(supplier.get("name") or "").strip()
        if not address_id or not supplier_name:
            raise ValueError("Bitte den Lieferanten aus WinWorker auswählen.")

        invoice_number = str(payload.get("supplierInvoiceNumber") or "").strip()
        invoice_number_norm = _capture_invoice_number_norm(invoice_number)
        if not invoice_number_norm:
            raise ValueError("Lieferanten-Rechnungsnummer fehlt.")
        invoice_date = _capture_date(payload.get("invoiceDate"), "Rechnungsdatum")
        net_due_date = _capture_date(payload.get("netDueDate") or payload.get("dueDate"), "Nettofälligkeit", allow_empty=True)
        due_date = net_due_date
        skonto_enabled = _capture_truthy(payload.get("skontoEnabled"))
        skonto_percent = _capture_float(payload.get("skontoPercent"), "Skonto-Prozent", allow_none=True)
        if skonto_enabled and (skonto_percent is None or skonto_percent <= 0):
            raise ValueError("Bei Skonto bitte einen Prozentsatz größer 0 eintragen.")
        skonto_due_date = _capture_date(payload.get("skontoDueDate"), "Skontofälligkeit", allow_empty=True)
        payment_terms = str(payload.get("paymentTerms") or "").strip()[:500]
        net = _capture_float(payload.get("netAmount"), "Netto")
        vat = _capture_float(payload.get("vatAmount"), "USt")
        gross = _capture_float(payload.get("grossAmount"), "Brutto")
        if abs((net + vat) - gross) > 0.05:
            raise ValueError(f"Netto + USt stimmt nicht mit Brutto überein ({net:.2f} + {vat:.2f} ≠ {gross:.2f}).")

        allocations = payload.get("allocations") or []
        if not isinstance(allocations, list) or not allocations:
            raise ValueError("Mindestens eine Kontierungszeile ist erforderlich.")
        clean_allocations = []
        allocated = 0.0
        for i, row in enumerate(allocations, start=1):
            amount = _capture_float(row.get("netAmount"), f"Kontierung Zeile {i}")
            allocated += amount
            cost_type = str(row.get("costType") or "Sonstiges").strip()
            if cost_type not in CAPTURE_COST_TYPES:
                cost_type = "Sonstiges"
            clean_allocations.append({
                "line_no": i,
                "account": str(row.get("account") or "").strip(),
                "cost_type": cost_type,
                "cost_center": str(row.get("costCenter") or "").strip(),
                "project_id": str(row.get("projectId") or "").strip(),
                "description": str(row.get("description") or "").strip(),
                "net_amount": amount,
                "vat_rate": _capture_float(row.get("vatRate"), f"USt-Satz Zeile {i}", allow_none=True),
            })
        if abs(allocated - net) > 0.02:
            raise ValueError(f"Kontierung stimmt nicht: {allocated:.2f} € kontiert, {net:.2f} € Netto.")

        pdf_bytes = upload.read()
        if not pdf_bytes:
            raise ValueError("PDF ist leer.")
        analysis = _capture_analyze_pdf(pdf_bytes, upload.filename)
        sha256 = analysis["sha256"]
        year = int(invoice_date[:4])
        now = datetime.now().isoformat(timespec="seconds")
        context = _capture_supplier_context(address_id, area)
        invoice_iban = _norm_iban(payload.get("invoiceIban") or analysis.get("iban"))
        master_iban = _norm_iban(payload.get("masterIban") or context.get("latestIban"))
        accept_new_iban = _capture_truthy(payload.get("acceptNewIban"))
        if accept_new_iban and not invoice_iban:
            raise ValueError("Zum Übernehmen wurde keine IBAN auf der Rechnung erkannt.")
        if accept_new_iban and not _iban_valid(invoice_iban):
            raise ValueError("Die neue IBAN ist formal nicht gültig. Bitte zuerst korrigieren.")
        iban = invoice_iban if accept_new_iban else master_iban
        workflow = str(payload.get("workflowStatus") or "zu_pruefen")
        if workflow not in {"zu_pruefen", "geprueft"}:
            workflow = "zu_pruefen"

        warnings = []
        if invoice_iban and master_iban and invoice_iban != master_iban and not accept_new_iban:
            warnings.append("Abweichende IBAN wurde nicht in die Stammdaten übernommen")
        elif invoice_iban and not master_iban and not accept_new_iban:
            warnings.append("Noch keine bestätigte Stamm-IBAN vorhanden")

        lock = CAPTURE_TEST_LOCK if area == "test" else CAPTURE_NUMBER_LOCK
        with lock:
            con = _capture_area_connection(area)
            try:
                con.execute("BEGIN IMMEDIATE")
                if area == "live":
                    duplicate = con.execute("""
                        SELECT id, doc_id, supplier_name, supplier_invoice_number
                        FROM incoming_invoices
                        WHERE file_sha256 = ?
                           OR (supplier_address_id = ? AND supplier_invoice_number_norm = ?)
                        LIMIT 1
                    """, (sha256, address_id, invoice_number_norm)).fetchone()
                    if duplicate:
                        raise ValueError(
                            f"Doppelte Rechnung: bereits als {duplicate['doc_id']} gespeichert ({duplicate['supplier_name']} · {duplicate['supplier_invoice_number']})."
                        )

                number = _capture_number_status_for_area(year, area, con)
                doc_id = number["nextDocId"]
                folder = _capture_area_root(area) / str(year)
                folder.mkdir(parents=True, exist_ok=True)
                pdf_path = folder / f"{doc_id}.pdf"
                original_path = folder / f"{doc_id}_Original.pdf"
                if pdf_path.exists() or original_path.exists():
                    raise RuntimeError(f"Datei {doc_id} existiert bereits. Bitte Nummernkreis prüfen.")

                temp_original = folder / f".{doc_id}_Original.tmp"
                temp_pdf = folder / f".{doc_id}.tmp"
                temp_original.write_bytes(pdf_bytes)
                temp_pdf.write_bytes(pdf_bytes)
                temp_original.replace(original_path)
                temp_pdf.replace(pdf_path)
                created_paths.extend([pdf_path, original_path])

                # Im Testgelände darf dieselbe Übungsrechnung mehrfach gespeichert werden.
                stored_invoice_norm = invoice_number_norm if area == "live" else f"{invoice_number_norm}__{doc_id}"
                stored_sha256 = sha256 if area == "live" else f"{sha256}:{doc_id}"

                cur = con.execute("""
                    INSERT INTO incoming_invoices (
                        doc_id, document_type, supplier_address_id, supplier_name,
                        supplier_address, supplier_number, our_customer_number,
                        supplier_invoice_number, supplier_invoice_number_norm,
                        invoice_date, due_date, net_due_date,
                        skonto_enabled, skonto_percent, skonto_due_date, payment_terms,
                        net_amount, vat_amount, gross_amount,
                        currency, iban, invoice_iban, master_iban, bank_change_accepted,
                        swift, account_holder, customer_number_external,
                        workflow_status, payment_status, payment_state,
                        booking_text, note, original_filename, pdf_path, original_path,
                        file_sha256, pdf_text, page_count, ocr_used, ocr_pages, ocr_warning,
                        created_by, created_at, updated_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    doc_id,
                    str(payload.get("documentType") or "Rechnung"),
                    address_id,
                    supplier_name,
                    str(supplier.get("address") or ""),
                    str(supplier.get("supplierNumber") or ""),
                    str(supplier.get("ourCustomerNumber") or ""),
                    invoice_number,
                    stored_invoice_norm,
                    invoice_date,
                    due_date,
                    net_due_date,
                    1 if skonto_enabled else 0,
                    skonto_percent,
                    skonto_due_date,
                    payment_terms,
                    net,
                    vat,
                    gross,
                    str(payload.get("currency") or "EUR"),
                    iban,
                    invoice_iban,
                    master_iban,
                    1 if accept_new_iban else 0,
                    "",
                    str(payload.get("accountHolder") or "").strip(),
                    str(supplier.get("ourCustomerNumber") or payload.get("customerNumberExternal") or analysis.get("customerNumberExternal") or "").strip(),
                    workflow,
                    "Offen",
                    "open",
                    str(payload.get("bookingText") or analysis.get("bookingText") or "").strip(),
                    str(payload.get("note") or "").strip(),
                    str(upload.filename or ""),
                    str(pdf_path),
                    str(original_path),
                    stored_sha256,
                    analysis.get("text") or "",
                    int(analysis.get("pageCount") or 0),
                    1 if analysis.get("ocrUsed") else 0,
                    int(analysis.get("ocrPages") or 0),
                    str(analysis.get("ocrWarning") or ""),
                    str(payload.get("createdBy") or "Dunja").strip() or "Dunja",
                    now,
                    now,
                ))
                invoice_id = int(cur.lastrowid)
                if accept_new_iban and invoice_iban:
                    con.execute("""
                        INSERT INTO supplier_bank_accounts (
                            supplier_address_id, iban, source_invoice_id, source_doc_id,
                            confirmed_by, confirmed_at, note
                        ) VALUES (?,?,?,?,?,?,?)
                        ON CONFLICT(supplier_address_id, iban) DO UPDATE SET
                            source_invoice_id = excluded.source_invoice_id,
                            source_doc_id = excluded.source_doc_id,
                            confirmed_by = excluded.confirmed_by,
                            confirmed_at = excluded.confirmed_at,
                            note = excluded.note
                    """, (
                        address_id,
                        invoice_iban,
                        invoice_id,
                        doc_id,
                        str(payload.get("createdBy") or "Dunja").strip() or "Dunja",
                        now,
                        "Neue IBAN aus Rechnung übernommen",
                    ))
                for row in clean_allocations:
                    con.execute("""
                        INSERT INTO incoming_allocations (
                            invoice_id, line_no, account, cost_type, cost_center,
                            project_id, description, net_amount, vat_rate
                        ) VALUES (?,?,?,?,?,?,?,?,?)
                    """, (
                        invoice_id, row["line_no"], row["account"], row["cost_type"],
                        row["cost_center"], row["project_id"], row["description"],
                        row["net_amount"], row["vat_rate"],
                    ))
                con.commit()
                saved = con.execute("SELECT * FROM incoming_invoices WHERE id = ?", (invoice_id,)).fetchone()
                public = _capture_row_public(saved, _capture_allocations(con, invoice_id), area=area)
            except Exception:
                con.rollback()
                raise
            finally:
                con.close()

        return jsonify({"ok": True, "area": area, "trainingMode": area == "test", "invoice": public, "warnings": warnings})
    except ValueError as e:
        for path in created_paths:
            try:
                Path(path).unlink(missing_ok=True)
            except Exception:
                pass
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        for path in created_paths:
            try:
                Path(path).unlink(missing_ok=True)
            except Exception:
                pass
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/incoming/capture/list")
def incoming_capture_list():
    try:
        area = _capture_area(request.args.get("area"))
        rows = _capture_recent(
            limit=request.args.get("limit", 50),
            workflow_status=str(request.args.get("workflowStatus") or "").strip(),
            area=area,
        )
        return jsonify({"ok": True, "area": area, "trainingMode": area == "test", "invoices": rows, "count": len(rows)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.put("/incoming/capture/<int:invoice_id>/status")
def incoming_capture_status(invoice_id):
    body = request.get_json(silent=True) or {}
    area = _capture_area(body.get("area") or request.args.get("area"))
    workflow = str(body.get("workflowStatus") or "").strip()
    payment = str(body.get("paymentStatus") or "").strip()
    if workflow and workflow not in {"zu_pruefen", "geprueft", "storniert"}:
        return jsonify({"ok": False, "error": "Ungültiger Arbeitsstatus."}), 400
    try:
        con = _capture_area_connection(area)
        try:
            row = con.execute("SELECT * FROM incoming_invoices WHERE id = ?", (invoice_id,)).fetchone()
            if not row:
                return jsonify({"ok": False, "error": "Rechnung nicht gefunden."}), 404
            new_workflow = workflow or row["workflow_status"]
            new_payment = payment or row["payment_status"]
            con.execute("""
                UPDATE incoming_invoices
                SET workflow_status = ?, payment_status = ?, payment_state = ?, updated_at = ?
                WHERE id = ?
            """, (new_workflow, new_payment, _payment_state(new_payment), datetime.now().isoformat(timespec="seconds"), invoice_id))
            con.commit()
            updated = con.execute("SELECT * FROM incoming_invoices WHERE id = ?", (invoice_id,)).fetchone()
            return jsonify({"ok": True, "area": area, "invoice": _capture_row_public(updated, _capture_allocations(con, invoice_id), area=area)})
        finally:
            con.close()
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.delete("/incoming/capture/<int:invoice_id>")
def incoming_capture_delete(invoice_id):
    area = _capture_area(request.args.get("area"))
    if area != "test":
        return jsonify({
            "ok": False,
            "error": "Echtbelege werden nicht gelöscht. Dafür bitte später den Status 'storniert' verwenden."
        }), 403
    try:
        con = _capture_area_connection("test")
        try:
            row = con.execute("SELECT * FROM incoming_invoices WHERE id = ?", (invoice_id,)).fetchone()
            if not row:
                return jsonify({"ok": False, "error": "Testrechnung nicht gefunden."}), 404
            row_data = dict(row)
            con.execute("DELETE FROM supplier_bank_accounts WHERE source_invoice_id = ?", (invoice_id,))
            con.execute("DELETE FROM incoming_invoices WHERE id = ?", (invoice_id,))
            con.commit()
        finally:
            con.close()
        deleted, warnings = _capture_delete_test_files(row_data)
        return jsonify({
            "ok": True,
            "area": "test",
            "deletedInvoiceId": invoice_id,
            "docId": row_data.get("doc_id") or "",
            "deletedFiles": deleted,
            "warnings": warnings,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.delete("/incoming/capture/test-area")
def incoming_capture_clear_test_area():
    body = request.get_json(silent=True) or {}
    if str(body.get("confirm") or "").strip().upper() != "TESTGELAENDE LEEREN":
        return jsonify({"ok": False, "error": "Bestätigung fehlt."}), 400
    try:
        con = _capture_area_connection("test")
        try:
            rows = [dict(row) for row in con.execute("SELECT * FROM incoming_invoices ORDER BY id").fetchall()]
            con.execute("DELETE FROM supplier_bank_accounts")
            con.execute("DELETE FROM incoming_invoices")
            con.commit()
        finally:
            con.close()
        deleted_files = []
        warnings = []
        for row in rows:
            deleted, row_warnings = _capture_delete_test_files(row)
            deleted_files.extend(deleted)
            warnings.extend(row_warnings)
        return jsonify({
            "ok": True,
            "area": "test",
            "deletedCount": len(rows),
            "deletedFiles": len(deleted_files),
            "warnings": warnings,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


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
        context = incoming_for_address(address_id, text_query, return_context=True)
        docs = context["documents"]
        all_docs = context["allDocuments"]
        ww_rows = context["wwRows"]
        local_rows = context["localRows"]
        years = incoming_year_summary(docs)

        # Lieferantenkopf und OP bleiben auch während einer Materialsuche auf
        # der vollständigen Lieferantenakte – nicht nur auf den Treffern.
        total_sum = round(sum(float(x.get("amount") or 0) for x in all_docs if x.get("amount") is not None), 2)
        amount_count = sum(1 for x in all_docs if x.get("amount") is not None)
        open_sum = round(sum(
            float(x.get("amount") or 0)
            for x in all_docs
            if x.get("paymentState") == "open" and x.get("amount") is not None
        ), 2)
        open_count = sum(1 for x in all_docs if x.get("paymentState") == "open")

        yearly_stats = {}
        for x in all_docs:
            year = str(x.get("year") or "")
            if not year:
                continue
            row = yearly_stats.setdefault(year, {
                "count": 0,
                "amountCount": 0,
                "sum": 0.0,
                "openCount": 0,
                "openSum": 0.0,
            })
            row["count"] += 1
            if x.get("amount") is not None:
                row["amountCount"] += 1
                row["sum"] += float(x.get("amount") or 0)
            if x.get("paymentState") == "open":
                row["openCount"] += 1
                if x.get("amount") is not None:
                    row["openSum"] += float(x.get("amount") or 0)

        for row in yearly_stats.values():
            row["sum"] = round(row["sum"], 2)
            row["openSum"] = round(row["openSum"], 2)

        return jsonify({
            "ok": True,
            "addressId": address_id,
            "documents": docs,
            "count": len(docs),
            "allCount": len(all_docs),
            "years": years,
            "stats": {
                "count": len(all_docs),
                "amountCount": amount_count,
                "sum": total_sum,
                "openCount": open_count,
                "openSum": open_sum,
                "yearly": yearly_stats,
            },
            "search": context["search"],
            "watchAlerts": incoming_watch_alerts(address_id, ww_rows + local_rows),
            "sourceOfTruth": "WinWorker + KRISTINE",
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
        _, learned_negative = reject_invoice_for_address(address_id, invoice_id)
        return jsonify({
            "ok": True,
            "addressId": address_id,
            "invoiceId": invoice_id,
            "negativeFingerprintsLearned": len(learned_negative),
        })
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/incoming/watch-ack")
def incoming_watch_ack():
    try:
        body = request.get_json(silent=True) or {}
        address_id = str(body.get("addressId") or "").strip()
        key = str(body.get("key") or "").strip()
        decision = str(body.get("decision") or "known").strip()
        saved = acknowledge_watch_alert(address_id, key, decision)
        return jsonify({"ok": True, "saved": saved})
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


@app.get("/pdf-info")
def pdf_info():
    try:
        path = validate_indexed_pdf_path(request.args.get("path"))
        with pymupdf.open(path) as doc:
            if doc.page_count < 1:
                raise ValueError("PDF hat keine Seiten.")
            rect = doc[0].rect
            return jsonify({"ok": True, "pages": doc.page_count, "width": float(rect.width), "height": float(rect.height)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.get("/pdf-page")
def pdf_page_image():
    try:
        path = validate_indexed_pdf_path(request.args.get("path"))
        page_no = max(1, int(request.args.get("page", 1)))
        scale = max(0.45, min(5.0, float(request.args.get("scale", 1.45))))
        with pymupdf.open(path) as doc:
            if page_no > doc.page_count:
                raise ValueError("PDF-Seite existiert nicht.")
            page = doc[page_no - 1]
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            data = pix.tobytes("png")
        return send_file(BytesIO(data), mimetype="image/png", max_age=0)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


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



# KRISTINE ACCESS CONTROL V3 ROUTES
def _access_gantner_token():
    data = json.loads(Path(r"C:\Kristine\Zutritt\config.json").read_text(encoding="utf-8"))
    token = str(data.get("admin_token") or "").strip()
    if not token:
        raise RuntimeError("Gantner admin_token fehlt")
    return token


def _access_local_json(url):
    req = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as response:
        return json.loads(response.read().decode("utf-8", errors="replace") or "{}")


@app.get("/access-control/status")
def access_control_status():
    try:
        token = urllib.parse.quote(_access_gantner_token())
        return jsonify(_access_local_json(f"http://127.0.0.1:8788/api/status/{token}"))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.post("/access-control/toggle/<int:door>")
def access_control_toggle(door):
    if door not in {1, 2, 3}:
        return jsonify({"ok": False, "error": "Unbekannte Tür"}), 400
    try:
        token = urllib.parse.quote(_access_gantner_token())
        return jsonify(_access_local_json(f"http://127.0.0.1:8788/api/door-toggle/{door}/{token}"))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


# Linie 2 · The Brain direkte Erweiterung
import brain_line2 as _brain_line2
_brain_line2.install(globals())
import brain_viewer_hotfix as _brain_viewer_hotfix
_brain_viewer_hotfix.install(globals())

if __name__ == "__main__":
    print()
    print("KRISTINE ARCHIV CONNECTOR")
    print("-------------------------")
    print("Status : http://127.0.0.1:5051/status")
    print("Suche  : http://127.0.0.1:5051/search?q=6844%20Fusonic")
    print("Schema : http://127.0.0.1:5051/schema-hints")
    print("Version: 0.13.6 - WW-Materialstamm direkt nach KRISTINE synchronisieren")
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
