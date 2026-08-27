# coding: utf-8
"""Sicherer Browser-Proxy zum lokalen KRISTA Dienstemanager.

KRISADMIN laeuft auf protokoll.krista.at. Der eigentliche Dienstemanager bleibt
bewusst nur auf 127.0.0.1:8765 gebunden. Dieser Proxy wird vom Brain Connector
ueber den bestehenden Tailscale-Zugang bereitgestellt und reicht nur die eng
begrenzten Status-/Aktion-Endpunkte weiter.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
MANAGER_PORT = int(os.environ.get("KRISTA_SERVICE_MANAGER_PORT", "8765"))
ALLOWED_ORIGIN = "https://protokoll.krista.at"


def _manager_url(path: str) -> str:
    return f"http://127.0.0.1:{MANAGER_PORT}{path}"


def _manager_request(path: str, method: str = "GET", payload=None):
    body = None
    headers = {"Accept": "application/json", "User-Agent": "KRISTA-Brain-ServiceProxy/1.0"}
    token = str(os.environ.get("KRISTINE_ADMIN_TOKEN") or os.environ.get("ADMIN_TOKEN") or "").strip()
    if token:
        headers["X-Krista-Admin-Token"] = token
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(_manager_url(path), data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            raw = response.read().decode("utf-8", errors="replace")
            data = json.loads(raw or "{}")
            return int(response.status), data
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw or "{}")
        except Exception:
            data = {"ok": False, "error": raw or str(exc)}
        return int(exc.code), data
    except Exception as exc:
        return 0, {"ok": False, "error": str(exc)}


def _manager_alive() -> bool:
    code, data = _manager_request("/healthz")
    return code == 200 and bool(data.get("ok", True))


def _start_manager() -> tuple[bool, str]:
    if _manager_alive():
        return True, "Dienstemanager laeuft bereits."

    errors = []
    if os.name == "nt":
        try:
            ps = (
                "$t=Get-ScheduledTask -TaskName 'KRISTA Dienstemanager' -ErrorAction SilentlyContinue; "
                "if($t){Start-ScheduledTask -TaskName 'KRISTA Dienstemanager' -ErrorAction Stop; 'started'}"
            )
            cp = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
                cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if cp.returncode != 0:
                errors.append((cp.stderr or cp.stdout or "Windows-Task konnte nicht gestartet werden").strip())
        except Exception as exc:
            errors.append(str(exc))

    # Fallback: falls der Windows-Task noch nicht installiert ist, denselben
    # Hintergrund-Runner starten. Aktionen, die SYSTEM-Rechte brauchen, weisen
    # danach weiterhin sauber auf KRISTA_START.cmd hin.
    if not _manager_alive():
        runner = REPO_ROOT / "krista_service_manager_bg.py"
        if not runner.is_file():
            runner = REPO_ROOT / "krista_service_manager.py"
        if runner.is_file():
            try:
                flags = 0
                if os.name == "nt":
                    flags = (
                        getattr(subprocess, "DETACHED_PROCESS", 0)
                        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                        | getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    )
                env = os.environ.copy()
                env["KRISTA_SERVICE_MANAGER_PORT"] = str(MANAGER_PORT)
                subprocess.Popen(
                    [sys.executable, str(runner)], cwd=str(REPO_ROOT), env=env,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=flags, close_fds=os.name != "nt",
                )
            except Exception as exc:
                errors.append(str(exc))

    for _ in range(20):
        if _manager_alive():
            return True, "Dienstemanager gestartet."
        time.sleep(0.35)
    return False, " · ".join(x for x in errors if x) or "Dienstemanager antwortet nach dem Startversuch nicht."


def install(ns) -> None:
    app = ns.get("app")
    if app is None or getattr(app, "__krista_service_proxy", False):
        return

    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    routes = {
        "/service-manager/api/status",
        "/service-manager/api/action",
        "/service-manager/healthz",
        "/service-manager/start",
    }
    if isinstance(allowed, set):
        allowed.update(routes)

    from flask import jsonify, request

    @app.after_request
    def krista_service_proxy_cors(response):
        if request.path.startswith("/service-manager/"):
            origin = str(request.headers.get("Origin") or "").rstrip("/")
            if origin == ALLOWED_ORIGIN:
                response.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
                response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/service-manager/healthz", methods=["GET", "OPTIONS"])
    def krista_service_proxy_health():
        if request.method == "OPTIONS":
            return ("", 204)
        code, data = _manager_request("/healthz")
        if not code:
            return jsonify(ok=False, error=data.get("error") or "Dienstemanager nicht erreichbar"), 503
        return jsonify(data), code

    @app.route("/service-manager/api/status", methods=["GET", "OPTIONS"])
    def krista_service_proxy_status():
        if request.method == "OPTIONS":
            return ("", 204)
        code, data = _manager_request("/api/status")
        if not code:
            return jsonify(ok=False, managerOffline=True, error=data.get("error") or "Dienstemanager nicht erreichbar"), 503
        return jsonify(data), code

    @app.route("/service-manager/api/action", methods=["POST", "OPTIONS"])
    def krista_service_proxy_action():
        if request.method == "OPTIONS":
            return ("", 204)
        body = request.get_json(silent=True)
        if body is None:
            try:
                body = json.loads((request.get_data(as_text=True) or "{}"))
            except Exception:
                body = {}
        service = str((body or {}).get("service") or "")
        action = str((body or {}).get("action") or "")
        if service not in {"brain", "manager"} or action not in {"start", "restart"}:
            return jsonify(ok=False, error="Ungueltige Dienstaktion"), 400
        code, data = _manager_request("/api/action", method="POST", payload={"service": service, "action": action})
        if not code:
            return jsonify(ok=False, managerOffline=True, error=data.get("error") or "Dienstemanager nicht erreichbar"), 503
        return jsonify(data), code

    @app.route("/service-manager/start", methods=["POST", "OPTIONS"])
    def krista_service_proxy_start():
        if request.method == "OPTIONS":
            return ("", 204)
        ok, message = _start_manager()
        return jsonify(ok=ok, message=message, error="" if ok else message), (200 if ok else 503)

    app.__krista_service_proxy = True
    print(f"KRISTA Dienste-Proxy aktiv · Brain/Tailscale -> localhost:{MANAGER_PORT}")
