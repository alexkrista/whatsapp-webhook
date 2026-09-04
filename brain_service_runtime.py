# coding: utf-8
"""Brain-Laufzeitstatus + Bootstrap fuer den separaten KRISTA Dienstemanager."""
from __future__ import annotations

import hmac
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

BRAIN_CONNECTOR_VERSION = "0.14.50"
SERVICE_MANAGER_PORT = int(os.environ.get("KRISTA_SERVICE_MANAGER_PORT", "8765"))
REPO_ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = Path(tempfile.gettempdir()) / "krista-service-manager"
RUNTIME_FILE = RUNTIME_DIR / "brain-runtime.json"
MANAGER_TASK_NAME = "KRISTA Dienstemanager"


def _git_head() -> str:
    try:
        cp = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return cp.stdout.strip() if cp.returncode == 0 else ""
    except Exception:
        return ""


def _manager_alive() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", SERVICE_MANAGER_PORT), timeout=0.45):
            return True
    except Exception:
        return False


def _start_manager_windows_task() -> bool:
    """Bevorzugt den als SYSTEM installierten Windows-Task statt eines Benutzerprozesses."""
    if os.name != "nt":
        return False
    try:
        cp = subprocess.run(
            ["schtasks", "/Run", "/TN", MANAGER_TASK_NAME],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return cp.returncode == 0
    except Exception:
        return False


def _spawn_manager() -> bool:
    # Wenn KRISTA_START.cmd den SYSTEM-Task bereits installiert hat, immer diesen
    # verwenden. Damit bleiben Neustartrechte fuer Brain und andere Dienste erhalten.
    if _start_manager_windows_task():
        return True

    manager = REPO_ROOT / "krista_service_manager_bg.py"
    if not manager.is_file():
        manager = REPO_ROOT / "krista_service_manager.py"
    if not manager.is_file():
        return False
    flags = 0
    if os.name == "nt":
        flags = (
            getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    try:
        env = os.environ.copy()
        env["KRISTA_SERVICE_MANAGER_PORT"] = str(SERVICE_MANAGER_PORT)
        subprocess.Popen(
            [sys.executable, str(manager)],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=flags,
            close_fds=os.name != "nt",
        )
        return True
    except Exception as exc:
        print("⚠️ KRISTA Dienstemanager konnte nicht gestartet werden:", exc)
        return False


def _wait_for_manager(seconds: float = 8.0) -> bool:
    deadline = time.time() + max(0.5, float(seconds))
    while time.time() < deadline:
        if _manager_alive():
            return True
        time.sleep(0.35)
    return _manager_alive()


def _write_runtime() -> None:
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "pid": os.getpid(),
            "version": BRAIN_CONNECTOR_VERSION,
            "runningCommit": _git_head(),
            "startedAt": datetime.now(timezone.utc).isoformat(),
            "pythonExecutable": sys.executable,
            "script": str(REPO_ROOT / "archive-connector.py"),
            "repoRoot": str(REPO_ROOT),
            "commandLine": " ".join([sys.executable, str(REPO_ROOT / "archive-connector.py")]),
        }
        tmp = RUNTIME_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(RUNTIME_FILE)
    except Exception as exc:
        print("⚠️ Brain-Laufzeitstatus konnte nicht geschrieben werden:", exc)


def _install_gate_route(ns) -> None:
    """Header-Torimpuls: Browser -> Tailscale -> Brain -> localhost:8787."""
    app = ns.get("app")
    if app is None or getattr(app, "__krista_gate_header_installed", False):
        return

    from flask import jsonify
    import urllib.request

    def krista_access_control_gate():
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:8787/admin/gate/open",
                data=b"",
                method="POST",
                headers={
                    "Accept": "text/html",
                    "User-Agent": "KRISTA-Brain-Gate/1.0",
                },
            )
            with urllib.request.urlopen(req, timeout=12) as response:
                if int(response.status) != 200:
                    raise RuntimeError(f"Tor-Gateway HTTP {response.status}")
            return jsonify({"ok": True, "gate": "impulse"})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502

    app.add_url_rule(
        "/access-control/gate",
        "krista_access_control_gate",
        krista_access_control_gate,
        methods=["POST"],
    )
    app.__krista_gate_header_installed = True
    print("KRISTA Tor-Headerroute aktiv")


def _install_manager_bootstrap_route(ns) -> None:
    """Notstart fuer den Manager, solange der Brain-Connector auf 5051 noch lebt."""
    app = ns.get("app")
    if app is None or getattr(app, "__krista_manager_bootstrap_installed", False):
        return

    from flask import jsonify, make_response, request

    allowed_origins = {
        "https://protokoll.krista.at",
        "http://127.0.0.1:5051",
        "http://localhost:5051",
    }

    def with_cors(response):
        origin = str(request.headers.get("Origin") or "").rstrip("/")
        if origin in allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Methods"] = "POST,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type,X-Krista-Admin-Token"
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        response.headers["Cache-Control"] = "no-store"
        return response

    def manager_bootstrap():
        if request.method == "OPTIONS":
            return with_cors(make_response("", 204))

        expected = str(os.environ.get("KRISTINE_ADMIN_TOKEN") or os.environ.get("ADMIN_TOKEN") or "").strip()
        supplied = str(request.headers.get("X-Krista-Admin-Token") or "").strip()
        if expected and not hmac.compare_digest(supplied, expected):
            response = jsonify({"ok": False, "error": "Nicht freigegeben"})
            response.status_code = 403
            return with_cors(response)

        if _manager_alive():
            return with_cors(jsonify({"ok": True, "status": "running", "port": SERVICE_MANAGER_PORT}))

        if not _spawn_manager():
            response = jsonify({"ok": False, "error": "Dienstemanager konnte nicht gestartet werden. KRISTA_START.cmd einmal ausführen."})
            response.status_code = 503
            return with_cors(response)

        if not _wait_for_manager(9.0):
            response = jsonify({"ok": False, "error": "Start wurde ausgelöst, Port 8765 antwortet aber noch nicht."})
            response.status_code = 504
            return with_cors(response)

        return with_cors(jsonify({"ok": True, "status": "started", "port": SERVICE_MANAGER_PORT}))

    app.add_url_rule(
        "/service-manager/bootstrap",
        "krista_service_manager_bootstrap",
        manager_bootstrap,
        methods=["POST", "OPTIONS"],
    )
    app.__krista_manager_bootstrap_installed = True
    print("KRISTA Dienstemanager-Notstart aktiv")


def _start_manager_watchdog(ns) -> None:
    """Solange Brain lebt, darf der Dienstemanager nicht dauerhaft verschwinden."""
    app = ns.get("app")
    if app is None or getattr(app, "__krista_manager_watchdog_started", False):
        return
    app.__krista_manager_watchdog_started = True

    def worker():
        while True:
            time.sleep(20)
            try:
                if not _manager_alive():
                    _spawn_manager()
            except Exception as exc:
                print("⚠️ KRISTA Dienstemanager-Watchdog:", exc)

    threading.Thread(target=worker, name="krista-manager-watchdog", daemon=True).start()


def install(ns) -> None:
    _write_runtime()
    _install_gate_route(ns)
    _install_manager_bootstrap_route(ns)
    _start_manager_watchdog(ns)
    try:
        from brain_service_proxy import install as install_service_proxy
        install_service_proxy(ns)
    except Exception as exc:
        print("⚠️ KRISTA Dienste-Tailscale-Proxy:", exc)
    if not _manager_alive():
        started = _spawn_manager()
        if started:
            print(f"✅ KRISTA Dienstemanager gestartet · Port {SERVICE_MANAGER_PORT}")
    ns["BRAIN_CONNECTOR_VERSION"] = BRAIN_CONNECTOR_VERSION
