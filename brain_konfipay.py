# coding: utf-8
"""Optional, read-only konfipay connection for the Brain connector.

The integration is disabled by default.  It may read accounts, transactions and
statement files, but deliberately contains no payment or allocation endpoints.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


API = "https://portal.konfipay.de/api/v6"
ENABLED_ENV = "KRISTA_KONFIPAY_ENABLED"
TRUE_VALUES = {"1", "true", "yes", "on", "ja"}


class KonfipayError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def feature_enabled():
    return str(os.environ.get(ENABLED_ENV, "")).strip().lower() in TRUE_VALUES


def normalized(value):
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, list):
        return [normalized(item) for item in value]
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()}
    return value


def protect(data: bytes, decrypt=False) -> bytes:
    if os.name != "nt":
        raise KonfipayError("Die Schlüsselablage benötigt den Windows-Brain-Dienst.")

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, output = Blob(len(data), buffer), Blob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    function.argtypes = [
        ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob),
    ]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise KonfipayError(
            "Der Schlüssel konnte unter diesem Windows-Dienstkonto nicht geöffnet oder gespeichert werden."
        )
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel32.LocalFree(output.data)


class KeyStore:
    def __init__(self):
        self.folder = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "KRISTA" / "konfipay"
        self.path = self.folder / "api-key.dpapi"

    def exists(self):
        return self.path.is_file()

    def read(self):
        if not self.exists():
            return ""
        try:
            return protect(self.path.read_bytes(), decrypt=True).decode("utf-8")
        except KonfipayError:
            raise
        except Exception:
            raise KonfipayError("Die gespeicherte Verbindung konnte nicht gelesen werden.") from None

    def save(self, key):
        encrypted = protect(key.encode("utf-8"))
        self.folder.mkdir(parents=True, exist_ok=True)
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
        identity = subprocess.run(
            [str(system32 / "whoami.exe"), "/user", "/fo", "csv", "/nh"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=5, creationflags=flags, check=True,
        )
        sid = re.search(r"S-1-\d+(?:-\d+)+", identity.stdout)
        if not sid:
            raise KonfipayError("Windows-Rechte für die Schlüsselablage konnten nicht eingerichtet werden.")
        grants = sorted({"S-1-5-18", "S-1-5-32-544", sid.group()})
        command = [str(system32 / "icacls.exe"), str(self.folder), "/inheritance:r", "/grant:r"]
        command.extend("*" + item + ":(OI)(CI)F" for item in grants)
        subprocess.run(command, capture_output=True, timeout=5, creationflags=flags, check=True)
        temporary = self.folder / ("key-" + secrets.token_hex(8) + ".tmp")
        try:
            temporary.write_bytes(encrypted)
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)


class Client:
    """Small allow-listed client.  No konfipay write endpoint is reachable here."""

    def __init__(self, store=None):
        self.store = store or KeyStore()
        self.lock = threading.RLock()
        self.token = ""
        self.expires = 0.0
        self.snapshot = None
        self.error = None
        self.attempted = 0.0
        self.opener = urllib.request.build_opener(NoRedirect())

    @staticmethod
    def _allowed(method, path):
        parsed = urllib.parse.urlsplit(path)
        endpoint = parsed.path
        guid = r"[0-9a-fA-F-]{36}"
        if method == "POST" and endpoint == "/authentication/token":
            return True
        if method != "GET":
            return False
        if endpoint in {"/bank-accounts", "/transactions", "/transaction-files"}:
            return True
        return bool(re.fullmatch(r"/transaction-files/" + guid + r"/content", endpoint))

    def request(self, method, path, body=None, token="", raw=False):
        method = str(method or "GET").upper()
        if not self._allowed(method, path):
            raise KonfipayError("Diese API-Aktion ist in der Nur-Lesen-Verbindung nicht freigegeben.")
        headers = {"Accept": "application/json", "User-Agent": "KRISTINE-Brain-ReadOnly/1.0"}
        if token:
            headers["Authorization"] = "Bearer " + token
        payload = None
        if body is not None:
            if method != "POST" or urllib.parse.urlsplit(path).path != "/authentication/token":
                raise KonfipayError("Nur die Anmeldung darf Daten an konfipay senden.")
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(API + path, data=payload, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=12) as response:
                if response.status == 204:
                    return {"results": [], "totalPages": 1}
                data = response.read(25_000_001)
                if len(data) > 25_000_000:
                    raise KonfipayError("Die konfipay-Antwort ist zu groß.")
                if raw:
                    return data
                if not data:
                    return {}
                return json.loads(data.decode("utf-8"), parse_float=Decimal)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                raise KonfipayError("Anmeldung abgelehnt. Bitte API-Schlüssel und Aktivierung prüfen.") from None
            if exc.code == 403:
                raise KonfipayError("Dem API-Schlüssel fehlt die Berechtigung für diesen Lesebereich.") from None
            if exc.code == 429:
                raise KonfipayError("konfipay begrenzt gerade die Abrufe. Bitte später erneut versuchen.") from None
            raise KonfipayError("konfipay meldet HTTP " + str(exc.code) + ".") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise KonfipayError("konfipay ist nicht erreichbar. Internetverbindung prüfen.") from None
        except (ValueError, TypeError):
            raise KonfipayError("konfipay hat eine unerwartete Antwort geliefert.") from None

    def authenticate(self, key):
        data = self.request(
            "POST", "/authentication/token",
            {"apiKey": key, "client": {"name": "KRISTINE Brain ReadOnly", "version": "1.0.0"}},
        )
        access_token = data.get("accessToken") if isinstance(data, dict) else None
        if not isinstance(access_token, str) or not access_token:
            raise KonfipayError("konfipay hat kein gültiges Zugriffstoken geliefert.")
        return access_token, time.monotonic() + min(int(data.get("expiresIn", 1800)), 1800) - 60

    def auth_token(self):
        with self.lock:
            if not self.store.exists():
                raise KonfipayError("Bitte zuerst die konfipay-Verbindung einrichten.")
            if not self.token or time.monotonic() >= self.expires:
                self.token, self.expires = self.authenticate(self.store.read())
            return self.token

    def authenticated_get(self, path, raw=False):
        return self.request("GET", path, token=self.auth_token(), raw=raw)

    def accounts(self, token=None):
        result, seen = [], set()
        token = token or self.auth_token()
        for page in range(1, 101):
            query = urllib.parse.urlencode({
                "page-number": page, "page-size": 100,
                "status": "active", "bank-account-type": "production",
            })
            data = self.request("GET", "/bank-accounts?" + query, token=token)
            if not isinstance(data, dict) or not isinstance(data.get("results"), list):
                raise KonfipayError("Die Kontenliste konnte nicht gelesen werden.")
            for account in data["results"]:
                if account.get("isTest") or account.get("isActive") is False:
                    continue
                rid = account.get("rId")
                if not rid or rid in seen:
                    continue
                seen.add(rid)
                balance = account.get("balance") or {}
                balance_amount = None
                if balance.get("amount") is not None:
                    try:
                        number = Decimal(str(balance["amount"]))
                        if not number.is_finite():
                            raise InvalidOperation
                        balance_amount = format(number, "f")
                    except (InvalidOperation, ValueError):
                        raise KonfipayError("Ein Kontosaldo ist ungültig.") from None
                result.append({
                    "id": rid,
                    "name": account.get("description") or "Bankkonto",
                    "iban": account.get("iban") or "",
                    "currency": balance.get("currency") or account.get("currency") or "",
                    "amount": balance_amount,
                    "date": balance.get("date") or None,
                })
            if page >= int(data.get("totalPages", 1)):
                return result
        raise KonfipayError("Die Kontenliste ist zu umfangreich; der Abruf wurde abgebrochen.")

    @staticmethod
    def make_snapshot(accounts):
        totals = {}
        for account in accounts:
            if account["amount"] is not None:
                currency = account["currency"]
                totals[currency] = totals.get(currency, Decimal("0")) + Decimal(account["amount"])
        return {
            "accounts": accounts,
            "totals": {currency: format(value, "f") for currency, value in totals.items()},
            "missingBalances": sum(account["amount"] is None for account in accounts),
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }

    def state(self):
        with self.lock:
            configured = self.store.exists()
            return {
                "configured": configured,
                "connected": configured and self.snapshot is not None and not self.error,
                "error": self.error,
                "stale": bool(self.error and self.snapshot is not None),
                "snapshot": self.snapshot,
                "mode": "read-only",
            }

    def connect(self, key):
        if not isinstance(key, str) or len(key.strip()) != 64 or any(ord(char) < 33 or ord(char) > 126 for char in key.strip()):
            raise KonfipayError("Bitte den vollständigen 64-stelligen API-Schlüssel eingeben.")
        with self.lock:
            key = key.strip()
            token, expires = self.authenticate(key)
            accounts = self.accounts(token)
            self.store.save(key)
            self.token, self.expires = token, expires
            self.snapshot = self.make_snapshot(accounts)
            self.error = None
            self.attempted = time.monotonic()
            return self.state()

    def refresh(self):
        with self.lock:
            if not self.store.exists():
                return self.state()
            if time.monotonic() - self.attempted < 20:
                return self.state()
            self.attempted = time.monotonic()
            try:
                self.snapshot = self.make_snapshot(self.accounts())
                self.error = None
            except KonfipayError as exc:
                self.token, self.expires = "", 0.0
                self.error = str(exc)
            except Exception:
                self.error = "Die Verbindung konnte nicht aktualisiert werden."
            return self.state()


def _uuid(value, label="Kennung"):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise KonfipayError(label + " ist ungültig.") from None


def _day(value, label):
    try:
        return date.fromisoformat(str(value)).isoformat()
    except (ValueError, TypeError):
        raise KonfipayError(label + " ist ungültig.") from None


def _query_params(kind, args):
    start = _day(args.get("from"), "Startdatum")
    end = _day(args.get("to"), "Enddatum")
    if start > end:
        raise KonfipayError("Das Startdatum liegt nach dem Enddatum.")
    if (date.fromisoformat(end) - date.fromisoformat(start)).days > 370:
        raise KonfipayError("Bitte höchstens 370 Tage auf einmal abrufen.")
    try:
        page = int(args.get("page", "1"))
    except ValueError:
        raise KonfipayError("Ungültige Seitennummer.") from None
    if not 1 <= page <= 10000:
        raise KonfipayError("Ungültige Seitennummer.")
    result = {"page-number": page, "page-size": 100}
    if kind == "transactions":
        result.update({"min-booking-date": start, "max-booking-date": end})
    else:
        result.update({"min-date": start, "max-date": end})
    account = str(args.get("account") or "").strip()
    if account:
        result["bank-account-rid"] = _uuid(account, "Kontokennung")
    return result


def install(ns):
    """Install K1 only when explicitly enabled. Returns whether it is active."""
    if not feature_enabled():
        ns["KONFIPAY_READONLY_ENABLED"] = False
        return False

    from flask import Response, jsonify, make_response, request
    from functools import wraps

    app = ns.get("app")
    page_source = str(ns.get("MOBILE_PAGE") or "")
    if app is None or not page_source:
        ns["KONFIPAY_READONLY_ENABLED"] = False
        return False
    if "brain_konfipay_page" in app.view_functions:
        ns["KONFIPAY_READONLY_ENABLED"] = True
        return True

    client = Client()
    csrf = secrets.token_urlsafe(32)
    routes = {
        "/konfipay", "/konfipay/api/status", "/konfipay/api/connect",
        "/konfipay/api/refresh", "/konfipay/api/transactions",
        "/konfipay/api/statements", "/konfipay/api/statement-download",
    }
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.update(routes)

    def can_configure():
        host = urllib.parse.urlsplit("http://" + request.host).hostname
        return request.remote_addr in {"127.0.0.1", "::1"} and host in {"127.0.0.1", "localhost", "::1"}

    def valid_csrf():
        origin = urllib.parse.urlsplit(str(request.headers.get("Origin") or ""))
        return (
            origin.scheme in {"http", "https"}
            and origin.netloc == request.host
            and secrets.compare_digest(str(request.headers.get("X-Brain-Konfipay") or ""), csrf)
        )

    def safe(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except KonfipayError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400
            except Exception:
                app.logger.exception("Read-only-konfipay-Abruf fehlgeschlagen")
                return jsonify({"ok": False, "error": "Der Nur-Lesen-Abruf konnte nicht abgeschlossen werden."}), 500
        return wrapped

    @app.get("/konfipay", endpoint="brain_konfipay_page")
    def page():
        html = (Path(__file__).resolve().parent / "public" / "konfipay.html").read_text(encoding="utf-8")
        response = make_response(
            html.replace("__BRAIN_CSRF__", csrf).replace("__CAN_CONFIGURE__", "true" if can_configure() else "false")
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/konfipay/api/status", endpoint="brain_konfipay_status")
    def status():
        return jsonify({"ok": True, **normalized(client.state())})

    @app.post("/konfipay/api/connect", endpoint="brain_konfipay_connect")
    def connect():
        if not can_configure() or not valid_csrf():
            return jsonify({"ok": False, "error": "Den Schlüssel bitte direkt am Brain-PC hinterlegen."}), 403
        if request.content_length is None or request.content_length > 4096:
            return jsonify({"ok": False, "error": "Ungültige Eingabe."}), 400
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"ok": False, "error": "Ungültige Eingabe."}), 400
        try:
            return jsonify({"ok": True, **normalized(client.connect(body.get("apiKey")))})
        except KonfipayError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception:
            app.logger.exception("konfipay-Verbindung konnte nicht gespeichert werden")
            return jsonify({"ok": False, "error": "Verbindung oder verschlüsselte Ablage fehlgeschlagen."}), 500

    @app.get("/konfipay/api/refresh", endpoint="brain_konfipay_refresh")
    @safe
    def refresh():
        return jsonify({"ok": True, **normalized(client.refresh())})

    @app.get("/konfipay/api/transactions", endpoint="brain_konfipay_transactions")
    @safe
    def transactions():
        params = _query_params("transactions", request.args)
        booking = str(request.args.get("booking") or "booked")
        direction = str(request.args.get("direction") or "")
        if booking not in {"booked", "pending"} or direction not in {"", "CRDT", "DBIT"}:
            raise KonfipayError("Ungültiger Umsatzfilter.")
        params["booking-status"] = booking
        if direction:
            params["credit-or-debit-indicator"] = direction
        data = client.authenticated_get("/transactions?" + urllib.parse.urlencode(params))
        container = data.get("results") or {}
        rows = container.get("transactions", []) if isinstance(container, dict) else []
        keys = {
            "rId", "amount", "currency", "creditDebitIndicator", "name", "iban",
            "bookingDate", "valueDate", "purpose", "bookingText", "endToEndId", "bankAccount",
        }
        items = [{key: row.get(key) for key in keys} for row in rows if isinstance(row, dict)]
        return jsonify(normalized({
            "ok": True, "items": items, "page": data.get("pageNumber", 1),
            "pages": data.get("totalPages", 1), "total": data.get("totalItems", len(items)),
        }))

    @app.get("/konfipay/api/statements", endpoint="brain_konfipay_statements")
    @safe
    def statements():
        params = _query_params("statements", request.args)
        statement_format = str(request.args.get("format") or "Pdf")
        if statement_format not in {"Pdf", "53", "52", "54", "940", "942"}:
            raise KonfipayError("Ungültiges Auszugsformat.")
        params["format"] = statement_format
        data = client.authenticated_get("/transaction-files?" + urllib.parse.urlencode(params))
        keys = {"rId", "timestamp", "format", "fileName", "bankAccount"}
        items = [
            {key: row.get(key) for key in keys}
            for row in (data.get("results") or []) if isinstance(row, dict)
        ]
        return jsonify(normalized({
            "ok": True, "items": items, "page": data.get("pageNumber", 1),
            "pages": data.get("totalPages", 1), "total": data.get("totalItems", len(items)),
        }))

    @app.get("/konfipay/api/statement-download", endpoint="brain_konfipay_statement_download")
    @safe
    def statement_download():
        rid = _uuid(request.args.get("rid"), "Dateikennung")
        data = client.authenticated_get(
            "/transaction-files/" + rid + "/content?base64-encoded=false", raw=True,
        )
        extension = "pdf" if data.lstrip().startswith(b"%PDF-") else "xml" if data.lstrip().startswith(b"<") else "bin"
        return Response(
            data, content_type="application/octet-stream",
            headers={
                "Content-Disposition": 'attachment; filename="Kontoauszug_' + rid + "." + extension + '"',
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    ns["konfipay_readonly_client"] = client
    ns["KONFIPAY_READONLY_ENABLED"] = True
    return True
