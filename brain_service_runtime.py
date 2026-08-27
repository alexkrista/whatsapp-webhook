# coding: utf-8
"""Brain-Laufzeitstatus + Bootstrap fuer den separaten KRISTA Dienstemanager."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

BRAIN_CONNECTOR_VERSION = "0.14.8"
SERVICE_MANAGER_PORT = int(os.environ.get("KRISTA_SERVICE_MANAGER_PORT", "8765"))
REPO_ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = Path(tempfile.gettempdir()) / "krista-service-manager"
RUNTIME_FILE = RUNTIME_DIR / "brain-runtime.json"


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


def _spawn_manager() -> bool:
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

def install(ns) -> None:
    _write_runtime()
    _install_gate_route(ns)
    if not _manager_alive():
        started = _spawn_manager()
        if started:
            print(f"✅ KRISTA Dienstemanager gestartet · Port {SERVICE_MANAGER_PORT}")
    ns["BRAIN_CONNECTOR_VERSION"] = BRAIN_CONNECTOR_VERSION
