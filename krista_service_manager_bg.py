# coding: utf-8
"""KRISTA Dienstemanager im Hintergrund.

Startet/restartet The Brain nicht mehr direkt als nackten Python-Prozess,
sondern ueber den produktiven Windows-SYSTEM-Task. Status kommt primaer
ueber den echten Healthcheck auf Port 5051.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import krista_service_manager as base

WRAPPER_VERSION = "1.2.0"
REPO_ROOT = Path(__file__).resolve().parent
WRAPPER_PATH = Path(__file__).resolve()
PORT = int(os.environ.get("KRISTA_SERVICE_MANAGER_PORT", "8765"))
BRAIN_TASK_NAME = "Kristine The Brain Dienst"

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


def _powershell(script: str, timeout: float = 12.0) -> subprocess.CompletedProcess:
    exe = "powershell.exe" if os.name == "nt" else "pwsh"
    return subprocess.run(
        [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _brain_http_ok() -> bool:
    code, body = base._http_json("http://127.0.0.1:5051/status", timeout=2.2)
    return code == 200 and bool(body.get("ok", True))


def _brain_task_state() -> str:
    if os.name != "nt":
        return ""
    quoted = BRAIN_TASK_NAME.replace("'", "''")
    cp = _powershell(
        f"$t=Get-ScheduledTask -TaskName '{quoted}' -ErrorAction SilentlyContinue; "
        "if($t){[string]$t.State}",
        timeout=6.0,
    )
    return (cp.stdout or "").strip()


def _start_brain(existing: dict | None = None) -> int:
    if _brain_http_ok():
        process = base._discover_brain_process()
        return int(process.get("pid") or 0)

    if os.name != "nt":
        raise RuntimeError("Brain-SYSTEM-Task ist nur unter Windows verfuegbar")

    quoted = BRAIN_TASK_NAME.replace("'", "''")
    cp = _powershell(
        f"Start-ScheduledTask -TaskName '{quoted}' -ErrorAction Stop",
        timeout=8.0,
    )
    if cp.returncode != 0:
        raise RuntimeError((cp.stderr or cp.stdout or "Brain-Task konnte nicht gestartet werden").strip())

    deadline = time.time() + 25
    while time.time() < deadline:
        if _brain_http_ok():
            process = base._discover_brain_process()
            pid = int(process.get("pid") or 0)
            base._set_manager_action("brain-start", f"SYSTEM-Task · PID {pid or '–'}")
            return pid
        time.sleep(0.7)

    state = _brain_task_state() or "unbekannt"
    raise RuntimeError(f"Brain-Task gestartet, aber Port 5051 bleibt offline (Task: {state})")


def _restart_brain() -> int:
    if os.name != "nt":
        raise RuntimeError("Brain-SYSTEM-Task ist nur unter Windows verfuegbar")

    # Als SYSTEM darf der Dienstemanager auch den SYSTEM-Brain-Prozess sauber
    # beenden. Danach den produktiven Scheduled Task wieder starten.
    process = base._discover_brain_process()
    old_pid = int(process.get("pid") or 0)
    if old_pid:
        try:
            base._kill_pid(old_pid)
        except Exception:
            pass

    quoted = BRAIN_TASK_NAME.replace("'", "''")
    _powershell(
        f"Stop-ScheduledTask -TaskName '{quoted}' -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700",
        timeout=8.0,
    )

    cp = _powershell(
        f"Start-ScheduledTask -TaskName '{quoted}' -ErrorAction Stop",
        timeout=8.0,
    )
    if cp.returncode != 0:
        raise RuntimeError((cp.stderr or cp.stdout or "Brain-Task konnte nicht neu gestartet werden").strip())

    deadline = time.time() + 25
    while time.time() < deadline:
        if _brain_http_ok():
            process = base._discover_brain_process()
            pid = int(process.get("pid") or 0)
            base._set_manager_action("brain-restart", f"SYSTEM-Task · PID {old_pid or '–'} -> {pid or '–'}")
            return pid
        time.sleep(0.7)

    state = _brain_task_state() or "unbekannt"
    raise RuntimeError(f"Brain-Neustart ohne Port 5051 (Task: {state})")


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

    brain_ok = _brain_http_ok()
    brain_task_state = _brain_task_state()

    cloud_base = str(os.environ.get("KRISTINE_API_BASE") or "https://protokoll.krista.at").rstrip("/")
    access_code, access_body = base._http_json(cloud_base + "/kristine/api/access-health", timeout=4.0)

    for row in data.get("rows") or []:
        if row.get("id") == "manager":
            row["version"] = WRAPPER_VERSION
            row["detail"] = f"Port {PORT} · SYSTEM-Hintergrund"

        elif row.get("id") == "brain":
            # Port 5051 ist die Wahrheit. Prozess-Erkennung ist bei SYSTEM-
            # Prozessen aus einem normalen Benutzerkontext nicht verlaesslich.
            if brain_ok:
                row["level"] = "green"
                row["status"] = "laeuft"
                row["detail"] = f"Port 5051 · Windows-Task {brain_task_state or 'Running'}"
                row["canStart"] = False
                row["canRestart"] = True
            else:
                row["level"] = "red"
                row["status"] = "gestoppt"
                row["detail"] = f"Port 5051 offline · Windows-Task {brain_task_state or 'unbekannt'}"
                row["canStart"] = True
                row["canRestart"] = False

        elif row.get("id") == "access":
            if access_code == 200 and bool(access_body.get("ok")):
                row["level"] = "green"
                row["status"] = "erreichbar"
                row["version"] = str(access_body.get("version") or "")
                row["detail"] = "Cloud Bridge Healthcheck okay"
            elif access_code == 404:
                row["level"] = "yellow"
                row["status"] = "Update wartet"
                row["detail"] = "Cloud laeuft · Zutritt-Healthcheck noch nicht deployed"
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
