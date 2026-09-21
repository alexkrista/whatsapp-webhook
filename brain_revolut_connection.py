# coding: utf-8
r"""Vorhandene, nur lesende Revolut-Business-Verbindung des Brain-Connectors.

Die bereits eingerichteten OAuth-Daten bleiben DPAPI-verschluesselt unter
C:\ProgramData\KRISTA\revolut. Dieses Modul liest nur Konten, Umsaetze, Ausgaben
und Originalbelege; Schreibzugriffe auf Revolut sind technisch nicht erlaubt.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from brain_konfipay import KeyStore, KonfipayError, NoRedirect, protect


HOST = "pc-alex02.tail610122.ts.net"
API = "https://b2b.revolut.com/api/1.0"


class Vault(KeyStore):
    def __init__(self):
        self.folder = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "KRISTA" / "revolut"
        self.path = self.folder / "connection.dpapi"


def _encode(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class Connection:
    def __init__(self, vault=None):
        self.vault = vault or Vault()
        self.lock = threading.RLock()
        self.opener = urllib.request.build_opener(NoRedirect())

    def read(self):
        return json.loads(self.vault.read()) if self.vault.exists() else {}

    def save(self, data):
        self.vault.save(json.dumps(data))

    def public(self):
        data = self.read()
        return {
            "connected": bool(data.get("refresh_token")),
            "clientId": data.get("clientId", ""),
            "scope": "READ",
        }

    def assertion(self, data):
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        key = serialization.load_pem_private_key(data["private"].encode(), password=None)
        content = _encode(b'{"alg":"RS256","typ":"JWT"}') + "." + _encode(json.dumps({
            "iss": HOST,
            "sub": data["clientId"],
            "aud": "https://revolut.com",
            "exp": int(time.time()) + 120,
        }).encode())
        return content + "." + _encode(key.sign(content.encode(), padding.PKCS1v15(), hashes.SHA256()))

    def call(self, path, form=None, token=None, raw=False):
        if form is not None and path != "/auth/token":
            raise ValueError("Nur die Anmeldung darf Daten an Revolut senden.")
        endpoint = urllib.parse.urlsplit(path).path
        is_receipt = bool(re.fullmatch(r"/expenses/[0-9a-fA-F-]{36}/receipts/[0-9a-fA-F-]{36}/content", endpoint))
        if form is None and endpoint not in {"/accounts", "/transactions", "/expenses"} and not is_receipt:
            raise ValueError("Diese Revolut-API-Funktion ist nicht freigegeben.")
        if raw and not is_receipt:
            raise ValueError("Ungültiger Belegabruf.")
        headers = {"Accept": "application/json", "User-Agent": "KRISTINE-Brain/1.0"}
        body = None
        if form is not None:
            body = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(API + path, data=body, headers=headers, method="POST" if form is not None else "GET")
        try:
            with self.opener.open(req, timeout=20) as response:
                limit = 20_000_000 if raw else 4_000_000
                content = response.read(limit + 1)
                if len(content) > limit:
                    raise ValueError("Revolut-Antwort ist zu groß.")
                return content if raw else json.loads(content)
        except urllib.error.HTTPError as exc:
            if endpoint.startswith("/expenses") and exc.code in {403, 422}:
                raise ValueError("Revolut gibt den Belegabruf für dieses Konto nicht frei.") from None
            raise ValueError("Revolut-Abruf fehlgeschlagen (HTTP " + str(exc.code) + ").") from None
        except (ValueError, KonfipayError):
            raise
        except Exception:
            raise ValueError("Revolut hat die Anfrage nicht bestätigt.") from None

    def get(self, path, raw=False):
        with self.lock:
            data = self.read()
            if not data.get("refresh_token"):
                raise ValueError("Revolut Business ist noch nicht verbunden.")
            if data.get("expires", 0) <= time.time():
                result = self.call("/auth/token", form={
                    "grant_type": "refresh_token",
                    "refresh_token": data["refresh_token"],
                    "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
                    "client_assertion": self.assertion(data),
                })
                if not result.get("access_token"):
                    raise ValueError("Bitte Revolut erneut verbinden.")
                data.update(access_token=result["access_token"], expires=time.time() + int(result.get("expires_in", 0)) - 30)
                if result.get("refresh_token"):
                    data["refresh_token"] = result["refresh_token"]
                self.save(data)
            return self.call(path, token=data["access_token"], raw=raw)

    def accounts(self):
        rows = self.get("/accounts")
        if not isinstance(rows, list):
            raise ValueError("Unerwartete Revolut-Kontenantwort.")
        return [{key: row.get(key) for key in ("id", "name", "currency", "balance", "state")} for row in rows]

    def receipt(self, expense_id, receipt_id):
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", str(expense_id or "")) or not re.fullmatch(r"[0-9a-fA-F-]{36}", str(receipt_id or "")):
            raise ValueError("Ungültige Revolut-Belegkennung.")
        folder = self.vault.folder / "receipts"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / (str(expense_id) + "_" + str(receipt_id) + ".dpapi")
        if target.exists():
            return protect(target.read_bytes(), decrypt=True)
        data = self.get("/expenses/" + str(expense_id) + "/receipts/" + str(receipt_id) + "/content", raw=True)
        temporary = folder / (secrets.token_hex(16) + ".tmp")
        try:
            temporary.write_bytes(protect(data))
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return data


def install(ns):
    if "revolut_connection" in ns:
        return ns["revolut_connection"]
    connection = Connection()
    ns["revolut_connection"] = connection
    app = ns.get("app")
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.add("/revolut/balances")
    if app is not None and "brain_revolut_balances" not in app.view_functions:
        from decimal import Decimal, InvalidOperation
        from flask import jsonify

        @app.get("/revolut/balances")
        def brain_revolut_balances():
            try:
                accounts = connection.accounts()
                totals = {}
                cleaned = []
                for account in accounts:
                    currency = str(account.get("currency") or "EUR").upper()
                    try:
                        balance = Decimal(str(account.get("balance") or "0"))
                    except InvalidOperation:
                        raise ValueError("Revolut Business liefert einen ungültigen Kontostand.") from None
                    totals[currency] = totals.get(currency, Decimal("0")) + balance
                    cleaned.append({
                        "id": str(account.get("id") or ""),
                        "name": str(account.get("name") or "Revolut Business"),
                        "currency": currency,
                        "balance": format(balance, "f"),
                        "state": str(account.get("state") or ""),
                    })
                return jsonify(ok=True, accounts=cleaned, totals={key: format(value, "f") for key, value in totals.items()}, fetchedAt=datetime.now(timezone.utc).isoformat())
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 503
    print("✅ Revolut Business API: bestehende READ-Verbindung eingebunden · " + datetime.now(timezone.utc).isoformat())
    return connection
