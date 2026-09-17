# coding: utf-8
"""konfipay connection: account data and explicitly confirmed SEPA submissions."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import urllib.error
import urllib.parse
import urllib.request

API = 'https://portal.konfipay.de/api/v6'


class ConnectionError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def protect(data: bytes, decrypt=False) -> bytes:
    if os.name != 'nt':
        raise ConnectionError('Die Schlüsselablage benötigt den Windows-Brain-Dienst.')
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, output = Blob(len(data), buffer), Blob()
    dll = ctypes.WinDLL('crypt32', use_last_error=True)
    function = dll.CryptUnprotectData if decrypt else dll.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise ConnectionError('Der Schlüssel konnte unter diesem Windows-Dienstkonto nicht geöffnet oder gespeichert werden.')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


class KeyStore:
    def __init__(self):
        self.folder = Path(os.environ.get('PROGRAMDATA', r'C:\ProgramData')) / 'KRISTA' / 'konfipay'
        self.path = self.folder / 'api-key.dpapi'

    def exists(self):
        return self.path.is_file()

    def read(self):
        if not self.exists():
            return ''
        try:
            return protect(self.path.read_bytes(), decrypt=True).decode('utf-8')
        except ConnectionError:
            raise
        except Exception:
            raise ConnectionError('Die gespeicherte Verbindung konnte nicht gelesen werden.') from None

    def save(self, key):
        encrypted = protect(key.encode('utf-8'))
        self.folder.mkdir(parents=True, exist_ok=True)
        # The service identity, SYSTEM and Administrators may access this folder.
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        system32 = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32'
        identity = subprocess.run([str(system32/'whoami.exe'), '/user', '/fo', 'csv', '/nh'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=5, creationflags=flags, check=True)
        sid = re.search(r'S-1-\d+(?:-\d+)+', identity.stdout)
        if not sid:
            raise ConnectionError('Windows-Rechte für die Schlüsselablage konnten nicht eingerichtet werden.')
        grants = sorted({'S-1-5-18', 'S-1-5-32-544', sid.group()})
        command = [str(system32/'icacls.exe'), str(self.folder), '/inheritance:r', '/grant:r'] + ['*'+item+':(OI)(CI)F' for item in grants]
        subprocess.run(command, capture_output=True, timeout=5, creationflags=flags, check=True)
        temporary = self.folder / ('key-'+secrets.token_hex(8)+'.tmp')
        try:
            temporary.write_bytes(encrypted)
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)


class Client:
    def __init__(self, store=None):
        self.store = store or KeyStore()
        self.lock = threading.RLock()
        self.token = ''
        self.expires = 0
        self.snapshot = None
        self.error = None
        self.attempted = 0
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, body=None, token='', raw=False):
        endpoint = path.split('?')[0]
        guid = r'[0-9a-fA-F-]{36}'
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
        allowed = (method, endpoint) in {('POST', '/authentication/token'), ('GET', '/bank-accounts'), ('GET', '/transactions'), ('GET', '/transaction-files'), ('GET', '/payment-files'), ('GET', '/payments')}
        allowed = allowed or (method == 'GET' and bool(re.fullmatch(r'/(?:transaction-files/'+guid+r'/content|payment-files/'+guid+r')', endpoint)))
        allowed = allowed or (method == 'POST' and endpoint == '/payment-files' and query.get('submit') == ['false'])
        allowed = allowed or (method == 'POST' and bool(re.fullmatch(r'/payment-files/'+guid+r'/submit', endpoint)) and query.get('force') == ['false'])
        if not allowed:
            raise ConnectionError('Diese API-Aktion ist nicht freigegeben.')
        headers = {'Accept': 'application/json', 'User-Agent': 'KRISTINE-Brain/1.0'}
        if token:
            headers['Authorization'] = 'Bearer '+token
        payload = None
        if body is not None:
            headers['Content-Type'] = 'application/xml' if isinstance(body, bytes) else 'application/json'
            payload = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(API+path, data=payload, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=12) as response:
                if response.status == 204:
                    return {'results': [], 'totalPages': 1}
                data = response.read(25_000_001)
                if len(data) > 25_000_000:
                    raise ConnectionError('Die konfipay-Antwort ist zu groß.')
                if raw:
                    return data
                if not data:
                    return {}
                return json.loads(data.decode('utf-8'), parse_float=Decimal)
        except urllib.error.HTTPError as exc:
            code = exc.code
            if code == 401:
                raise ConnectionError('Anmeldung abgelehnt. Bitte API-Schlüssel und Aktivierung in konfipay prüfen.') from None
            if code == 403:
                raise ConnectionError('Dem API-Schlüssel fehlt die Berechtigung für diesen Bereich. Bitte den Scope in konfipay prüfen.') from None
            if code == 429:
                raise ConnectionError('konfipay begrenzt gerade die Abrufe. Bitte später erneut versuchen.') from None
            raise ConnectionError('konfipay meldet HTTP '+str(code)+'. Bitte später erneut versuchen.') from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ConnectionError('konfipay ist nicht erreichbar. Internetverbindung prüfen und erneut versuchen.') from None
        except (ValueError, TypeError):
            raise ConnectionError('konfipay hat eine unerwartete Antwort geliefert.') from None

    def authenticate(self, key):
        data = self.request('POST', '/authentication/token', {'apiKey': key, 'client': {'name': 'KRISTINE Brain', 'version': '1.0.0'}})
        if not isinstance(data, dict) or not isinstance(data.get('accessToken'), str) or not data['accessToken']:
            raise ConnectionError('konfipay hat kein gültiges Zugriffstoken geliefert.')
        return data['accessToken'], time.monotonic()+min(int(data.get('expiresIn', 1800)), 1800)-60

    def accounts(self, token):
        result, seen = [], set()
        for page in range(1, 101):
            data = self.request('GET', '/bank-accounts?'+urllib.parse.urlencode({'page-number': page, 'page-size': 100, 'status': 'active', 'bank-account-type': 'production'}), token=token)
            if not isinstance(data, dict) or not isinstance(data.get('results'), list):
                raise ConnectionError('Die Kontenliste konnte nicht gelesen werden.')
            for account in data['results']:
                if account.get('isTest') or account.get('isActive') is False:
                    continue
                rid = account.get('rId')
                if not rid or rid in seen:
                    continue
                seen.add(rid)
                balance = account.get('balance') or {}
                amount = None
                if balance.get('amount') is not None:
                    try:
                        number = Decimal(str(balance['amount']))
                        if not number.is_finite():
                            raise InvalidOperation
                        amount = format(number, 'f')
                    except (InvalidOperation, ValueError):
                        raise ConnectionError('Ein Kontosaldo ist ungültig.') from None
                result.append({'id': rid, 'name': account.get('description') or 'Bankkonto', 'iban': account.get('iban') or '',
                               'currency': balance.get('currency') or account.get('currency') or '', 'amount': amount, 'date': balance.get('date') or None})
            if page >= int(data.get('totalPages', 1)):
                return result
        raise ConnectionError('Die Kontenliste ist zu umfangreich; der Abruf wurde abgebrochen.')

    def connect(self, key):
        if not isinstance(key, str) or len(key.strip()) != 64 or any(ord(c)<33 or ord(c)>126 for c in key.strip()):
            raise ConnectionError('Bitte den vollständigen 64-stelligen API-Schlüssel eingeben.')
        with self.lock:
            key = key.strip()
            stage = 'Anmeldung bei konfipay'
            try:
                token, expires = self.authenticate(key)
                stage = 'Kontenabruf bei konfipay'
                accounts = self.accounts(token)
                stage = 'Verschlüsselte Ablage auf dem Brain-PC'
                # Existing working credentials survive a failed connection attempt.
                self.store.save(key)
            except ConnectionError:
                raise
            except Exception as exc:
                # Report only phase and exception class; never credentials or response bodies.
                raise ConnectionError(stage+' fehlgeschlagen ('+type(exc).__name__+').') from None
            self.token, self.expires = token, expires
            self.snapshot = self.make_snapshot(accounts)
            self.error = None
            self.attempted = time.monotonic()
            return self.state()

    @staticmethod
    def make_snapshot(accounts):
        totals = {}
        for account in accounts:
            if account['amount'] is not None:
                currency = account['currency']
                totals[currency] = totals.get(currency, Decimal('0'))+Decimal(account['amount'])
        return {'accounts': accounts, 'totals': {c: format(a, 'f') for c, a in totals.items()},
                'missingBalances': sum(a['amount'] is None for a in accounts), 'fetchedAt': datetime.now(timezone.utc).isoformat()}

    def state(self):
        with self.lock:
            configured = self.store.exists()
            return {'configured': configured, 'connected': configured and self.snapshot is not None and not self.error,
                    'error': self.error, 'stale': bool(self.error and self.snapshot is not None),
                    'snapshot': self.snapshot, 'mode': 'banking'}

    def authenticated(self, method, path, body=None, raw=False):
        with self.lock:
            if not self.store.exists():
                raise ConnectionError('Bitte zuerst die konfipay-Verbindung einrichten.')
            if not self.token or time.monotonic() >= self.expires:
                self.token, self.expires = self.authenticate(self.store.read())
            # Never retry a payment POST automatically, even after a timeout.
            try:
                return self.request(method, path, body=body, token=self.token, raw=raw)
            except ConnectionError:
                self.token = ''; self.expires = 0
                raise

    def auth_token(self):
        with self.lock:
            if not self.store.exists():raise ConnectionError('Bitte zuerst konfipay verbinden.')
            if not self.token or time.monotonic() >= self.expires:
                self.token, self.expires = self.authenticate(self.store.read())
            return self.token

    def refresh(self):
        with self.lock:
            if not self.store.exists():
                return self.state()
            if time.monotonic()-self.attempted < 20:
                return self.state()
            self.attempted = time.monotonic()
            try:
                if not self.token or time.monotonic() >= self.expires:
                    self.token, self.expires = self.authenticate(self.store.read())
                self.snapshot = self.make_snapshot(self.accounts(self.token))
                self.error = None
            except ConnectionError as exc:
                self.token = ''; self.expires = 0
                self.error = str(exc)
            except Exception:
                self.error = 'Die Verbindung konnte nicht aktualisiert werden. Bitte erneut versuchen.'
            return self.state()


def install(ns):
    from flask import request, jsonify, make_response
    app = ns['app']
    if 'brain_konfipay_page' in app.view_functions:
        return
    client, csrf = Client(), secrets.token_urlsafe(32)
    ns['MOBILE_ALLOWED_PATHS'].update({'/konfipay', '/konfipay/api/status', '/konfipay/api/refresh', '/konfipay/api/connect'})

    def can_configure():
        host = urllib.parse.urlsplit('http://'+request.host).hostname
        return request.remote_addr in {'127.0.0.1', '::1'} and host in {'127.0.0.1', 'localhost', '::1'}

    def write_allowed():
        origin = urllib.parse.urlsplit(request.headers.get('Origin', ''))
        return (origin.scheme in {'http', 'https'} and origin.netloc == request.host
                and secrets.compare_digest(request.headers.get('X-Brain-Konfipay', ''), csrf))

    @app.get('/konfipay', endpoint='brain_konfipay_page')
    def page():
        html = (Path(__file__).resolve().parent/'public'/'konfipay.html').read_text(encoding='utf-8')
        return make_response(html.replace('__BRAIN_CSRF__', csrf).replace('__CAN_CONFIGURE__', 'true' if can_configure() else 'false'))

    @app.get('/konfipay/api/status', endpoint='brain_konfipay_status')
    def status():
        return jsonify({'ok': True, **client.state()})

    @app.post('/konfipay/api/refresh', endpoint='brain_konfipay_refresh')
    def refresh():
        if not write_allowed():
            return jsonify({'ok': False, 'error': 'Bitte die konfipay-Seite neu laden.'}), 403
        return jsonify({'ok': True, **client.refresh()})

    @app.post('/konfipay/api/connect', endpoint='brain_konfipay_connect')
    def connect():
        if not can_configure() or not write_allowed():
            return jsonify({'ok': False, 'error': 'Bitte den Schlüssel direkt am Brain-PC unter http://127.0.0.1:5051/konfipay hinterlegen.'}), 403
        if request.content_length is None or request.content_length > 4096:
            return jsonify({'ok': False, 'error': 'Ungültige Eingabe.'}), 400
        body = request.get_json(silent=True) or {}
        try:
            result = client.connect(body.get('apiKey'))
            return jsonify({'ok': True, **result})
        except ConnectionError as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400
        except Exception:
            return jsonify({'ok': False, 'error': 'Verbindung oder verschlüsselte Ablage fehlgeschlagen. Die bisherige Verbindung bleibt erhalten.'}), 500

    # Consumers such as Tower can read the same filtered snapshot later.
    ns['konfipay_connection'] = client
    import brain_konfipay_banking
    brain_konfipay_banking.install(ns, client, write_allowed, csrf)
