# coding: utf-8
"""KRISTA Dienstemanager im Hintergrund.

Diese kleine Huelle startet/restartet lokale Dienste ohne Konsolenfenster.
Kein Selbst-Installer und keine Aenderung am Windows-Autostart.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import krista_service_manager as base

WRAPPER_VERSION = "1.1.1"
REPO_ROOT = Path(__file__).resolve().parent
WRAPPER_PATH = Path(__file__).resolve()
BRAIN_SCRIPT = REPO_ROOT / "archive-connector.py"
PORT = int(os.environ.get("KRISTA_SERVICE_MANAGER_PORT", "8765"))
BRAIN_LOG = Path(base.RUNTIME_DIR) / "brain.log"

_original_status_snapshot = base._status_snapshot
base.PORT = PORT
base.MANAGER_VERSION = WRAPPER_VERSION


def _hidden_flags() -> int:
    if os.name != "nt":
        return 0
    return (
        getattr(subprocess, "DETACHED_PROCESS", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    )


def _spawn_hidden(python_exe: str, script: Path) -> subprocess.Popen:
    env = os.environ.copy()
    env["KRISTA_SERVICE_MANAGER_PORT"] = str(PORT)
    stdout = subprocess.DEVNULL
    stderr = subprocess.DEVNULL
    log_handle = None
    if script.name == BRAIN_SCRIPT.name:
        try:
            BRAIN_LOG.parent.mkdir(parents=True, exist_ok=True)
            log_handle = open(BRAIN_LOG, "ab", buffering=0)
            stdout = log_handle
            stderr = subprocess.STDOUT
        except Exception:
            log_handle = None
    try:
        return subprocess.Popen(
            [python_exe, str(script)],
            cwd=str(REPO_ROOT),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            creationflags=_hidden_flags(),
            close_fds=os.name != "nt",
        )
    finally:
        if log_handle is not None:
            try:
                log_handle.close()
            except Exception:
                pass


def _start_brain(existing: dict | None = None) -> int:
    existing = existing or base._discover_brain_process()
    pid = int(existing.get("pid") or 0)
    if base._pid_alive(pid):
        return pid
    if not BRAIN_SCRIPT.exists():
        raise RuntimeError("archive-connector.py fehlt")
    proc = _spawn_hidden(base._python_for_brain(existing), BRAIN_SCRIPT)
    base._set_manager_action("brain-start", f"PID {proc.pid} · Hintergrund")
    return int(proc.pid)


def _restart_brain() -> int:
    process = base._discover_brain_process()
    old_pid = int(process.get("pid") or 0)
    python_exe = base._python_for_brain(process)
    if old_pid:
        base._kill_pid(old_pid)
    time.sleep(0.8)
    proc = _spawn_hidden(python_exe, BRAIN_SCRIPT)
    base._set_manager_action("brain-restart", f"PID {old_pid or '–'} -> {proc.pid} · Hintergrund")
    return int(proc.pid)


def _restart_manager_later() -> None:
    def worker():
        time.sleep(0.8)
        env = os.environ.copy()
        env["KRISTA_SERVICE_MANAGER_PORT"] = str(PORT)
        subprocess.Popen(
            [sys.executable, str(WRAPPER_PATH)],
            cwd=str(REPO_ROOT),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_hidden_flags(),
            close_fds=os.name != "nt",
        )
        os._exit(0)
    threading.Thread(target=worker, daemon=True).start()


def _status_snapshot() -> dict:
    data = _original_status_snapshot()
    data["managerVersion"] = WRAPPER_VERSION
    cloud_base = str(os.environ.get("KRISTINE_API_BASE") or "https://protokoll.krista.at").rstrip("/")
    access_code, access_body = base._http_json(cloud_base + "/kristine/api/access-health", timeout=4.0)
    for row in data.get("rows") or []:
        if row.get("id") == "manager":
            row["version"] = WRAPPER_VERSION
            row["detail"] = f"Port {PORT} · Hintergrund"
        elif row.get("id") == "access":
            if access_code == 200 and bool(access_body.get("ok")):
                row["level"] = "green"
                row["status"] = "erreichbar"
                row["version"] = str(access_body.get("version") or "")
                row["detail"] = "Cloud Bridge Healthcheck okay"
            elif access_code == 404:
                row["level"] = "yellow"
                row["status"] = "Update wartet"
                row["detail"] = "Cloud läuft · neuer Zutritt-Healthcheck noch nicht deployed"
            else:
                row["level"] = "red"
                row["status"] = "nicht erreichbar"
                row["detail"] = str(access_body.get("error") or f"HTTP {access_code or '–'}")
    return data


base._start_brain = _start_brain
base._restart_brain = _restart_brain
base._restart_manager_later = _restart_manager_later
base._status_snapshot = _status_snapshot


if __name__ == "__main__":
    base.main()
