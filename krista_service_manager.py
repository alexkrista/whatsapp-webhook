# coding: utf-8
"""KRISTA lokaler Dienstemanager.

Laeuft bewusst getrennt vom Brain Connector auf 127.0.0.1:5060.
Dadurch kann KRISADMIN den Brain Connector auch dann starten/neustarten,
wenn der Brain-Prozess selbst gerade haengt oder beendet ist.

Sicherheit:
- nur Loopback, niemals 0.0.0.0
- CORS nur fuer die KRISTA-Weboberflaeche
- wenn KRISTINE_ADMIN_TOKEN/ADMIN_TOKEN gesetzt ist, muss KRISADMIN denselben Token senden
"""
from __future__ import annotations

import ctypes
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MANAGER_VERSION = "1.0.0"
HOST = "127.0.0.1"
PORT = int(os.environ.get("KRISTA_SERVICE_MANAGER_PORT", "5060"))
REPO_ROOT = Path(__file__).resolve().parent
BRAIN_SCRIPT = REPO_ROOT / "archive-connector.py"
RUNTIME_DIR = Path(tempfile.gettempdir()) / "krista-service-manager"
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
BRAIN_RUNTIME_FILE = RUNTIME_DIR / "brain-runtime.json"
MANAGER_STATE_FILE = RUNTIME_DIR / "manager-state.json"
MANAGER_STARTED_AT = datetime.now(timezone.utc).isoformat()
MANAGER_RUNNING_COMMIT = ""

DEFAULT_ORIGINS = {
    "https://protokoll.krista.at",
    "http://127.0.0.1:5051",
    "http://localhost:5051",
}
for _origin in str(os.environ.get("KRISTA_SERVICE_MANAGER_ORIGINS", "")).split(","):
    if _origin.strip():
        DEFAULT_ORIGINS.add(_origin.strip().rstrip("/"))


def _git(*args: str, timeout: float = 3.0) -> str:
    try:
        cp = subprocess.run(
            ["git", *args],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return cp.stdout.strip() if cp.returncode == 0 else ""
    except Exception:
        return ""


MANAGER_RUNNING_COMMIT = _git("rev-parse", "HEAD")


def _json_read(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def _json_write(path: Path, payload) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass


def _manager_state() -> dict:
    row = _json_read(MANAGER_STATE_FILE, {})
    return row if isinstance(row, dict) else {}


def _set_manager_error(message: str = "") -> None:
    state = _manager_state()
    state["lastError"] = str(message or "")[:2000]
    state["lastErrorAt"] = datetime.now(timezone.utc).isoformat() if message else ""
    _json_write(MANAGER_STATE_FILE, state)


def _set_manager_action(action: str, detail: str = "") -> None:
    state = _manager_state()
    state["lastAction"] = str(action or "")[:100]
    state["lastActionDetail"] = str(detail or "")[:500]
    state["lastActionAt"] = datetime.now(timezone.utc).isoformat()
    _json_write(MANAGER_STATE_FILE, state)


def _pid_alive(pid: int) -> bool:
    try:
        pid = int(pid)
    except Exception:
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _powershell_json(script: str, timeout: float = 4.0):
    if os.name != "nt":
        return None
    exe = shutil.which("powershell") or shutil.which("powershell.exe")
    if not exe:
        return None
    try:
        cp = subprocess.run(
            [exe, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        raw = cp.stdout.strip().lstrip("\ufeff")
        if cp.returncode != 0 or not raw:
            return None
        return json.loads(raw)
    except Exception:
        return None


def _discover_brain_process() -> dict:
    state = _json_read(BRAIN_RUNTIME_FILE, {})
    if isinstance(state, dict):
        pid = int(state.get("pid") or 0)
        if _pid_alive(pid):
            return {
                "pid": pid,
                "commandLine": str(state.get("commandLine") or ""),
                "runtime": state,
            }

    data = _powershell_json(
        "$p=Get-CimInstance Win32_Process | "
        "Where-Object { $_.CommandLine -match 'archive-connector\\.py' } | "
        "Select-Object -First 1 ProcessId,CommandLine; "
        "if($p){$p|ConvertTo-Json -Compress}"
    )
    if isinstance(data, dict):
        pid = int(data.get("ProcessId") or 0)
        if _pid_alive(pid):
            return {"pid": pid, "commandLine": str(data.get("CommandLine") or ""), "runtime": {}}
    return {"pid": 0, "commandLine": "", "runtime": state if isinstance(state, dict) else {}}


def _python_for_brain(process: dict) -> str:
    runtime = process.get("runtime") or {}
    configured = str(runtime.get("pythonExecutable") or "").strip()
    if configured and Path(configured).exists():
        return configured
    cmd = str(process.get("commandLine") or "").strip()
    match = re.match(r'^\s*"([^"]*python(?:w)?\.exe)"', cmd, re.I) or re.match(r"^\s*([^\s]*python(?:w)?\.exe)", cmd, re.I)
    if match and Path(match.group(1)).exists():
        return match.group(1)
    return sys.executable


def _kill_pid(pid: int) -> None:
    if not _pid_alive(pid):
        return
    if os.name == "nt":
        cp = subprocess.run(
            ["taskkill", "/PID", str(pid), "/F"],
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if cp.returncode != 0 and _pid_alive(pid):
            raise RuntimeError((cp.stderr or cp.stdout or "Brain konnte nicht beendet werden").strip())
    else:
        os.kill(pid, 15)
    deadline = time.time() + 8
    while _pid_alive(pid) and time.time() < deadline:
        time.sleep(0.2)
    if _pid_alive(pid):
        raise RuntimeError("Brain-Prozess beendet sich nicht.")


def _start_brain(existing: dict | None = None) -> int:
    existing = existing or _discover_brain_process()
    if _pid_alive(int(existing.get("pid") or 0)):
        return int(existing["pid"])
    python_exe = _python_for_brain(existing)
    if not BRAIN_SCRIPT.exists():
        raise RuntimeError(f"{BRAIN_SCRIPT.name} fehlt")
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    proc = subprocess.Popen(
        [python_exe, str(BRAIN_SCRIPT)],
        cwd=str(REPO_ROOT),
        env=os.environ.copy(),
        creationflags=flags,
    )
    _set_manager_action("brain-start", f"PID {proc.pid}")
    return int(proc.pid)


def _restart_brain() -> int:
    process = _discover_brain_process()
    old_pid = int(process.get("pid") or 0)
    python_exe = _python_for_brain(process)
    if old_pid:
        _kill_pid(old_pid)
    time.sleep(0.7)
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    proc = subprocess.Popen(
        [python_exe, str(BRAIN_SCRIPT)],
        cwd=str(REPO_ROOT),
        env=os.environ.copy(),
        creationflags=flags,
    )
    _set_manager_action("brain-restart", f"PID {old_pid or '–'} -> {proc.pid}")
    return int(proc.pid)


def _restart_manager_later() -> None:
    def worker():
        time.sleep(0.8)
        flags = 0
        if os.name == "nt":
            flags = (
                getattr(subprocess, "DETACHED_PROCESS", 0)
                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
        helper_code = (
            "import subprocess,sys,time,os;"
            "time.sleep(1.4);"
            f"subprocess.Popen([{sys.executable!r},{str(Path(__file__).resolve())!r}],cwd={str(REPO_ROOT)!r},env=os.environ.copy(),creationflags={getattr(subprocess, 'CREATE_NO_WINDOW', 0) | getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) if os.name == 'nt' else 0})"
        )
        subprocess.Popen(
            [sys.executable, "-c", helper_code],
            cwd=str(REPO_ROOT),
            env=os.environ.copy(),
            creationflags=flags,
        )
        os._exit(0)
    threading.Thread(target=worker, daemon=True).start()


def _http_json(url: str, timeout: float = 3.5):
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "KRISTA-ServiceManager/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return int(response.status), json.loads(raw or "{}")
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", errors="replace")
            payload = json.loads(raw or "{}")
        except Exception:
            payload = {"error": str(exc)}
        return int(exc.code), payload
    except Exception as exc:
        return 0, {"error": str(exc)}


def _tailscale_status() -> dict:
    candidates = [
        shutil.which("tailscale"),
        shutil.which("tailscale.exe"),
        r"C:\Program Files\Tailscale\tailscale.exe",
    ]
    exe = next((x for x in candidates if x and Path(x).exists()), None)
    if not exe:
        return {"level": "red", "status": "nicht gefunden", "detail": "tailscale.exe nicht gefunden"}
    try:
        cp = subprocess.run(
            [exe, "status", "--json"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        data = json.loads(cp.stdout or "{}") if cp.returncode == 0 else {}
        backend = str(data.get("BackendState") or "")
        self_row = data.get("Self") or {}
        ips = self_row.get("TailscaleIPs") or []
        online = backend.lower() == "running" or bool(self_row.get("Online"))
        return {
            "level": "green" if online else "red",
            "status": "online" if online else (backend or "offline"),
            "detail": " · ".join(str(x) for x in ips[:2]) or backend,
            "version": str(data.get("Version") or ""),
        }
    except Exception as exc:
        return {"level": "red", "status": "Fehler", "detail": str(exc)}


def _format_uptime(started_at: str) -> int:
    try:
        dt = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0, int((datetime.now(timezone.utc) - dt).total_seconds()))
    except Exception:
        return 0


def _status_snapshot() -> dict:
    current_commit = _git("rev-parse", "HEAD")
    short_current = current_commit[:8] if current_commit else ""
    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    subject = _git("log", "-1", "--pretty=%s")
    dirty = bool(_git("status", "--porcelain", "--untracked-files=no"))

    process = _discover_brain_process()
    runtime = process.get("runtime") or {}
    brain_pid = int(process.get("pid") or 0)
    brain_alive = _pid_alive(brain_pid)
    running_commit = str(runtime.get("runningCommit") or "")
    brain_started = str(runtime.get("startedAt") or "")
    brain_version = str(runtime.get("version") or ("vor Dienstemanager" if brain_alive else ""))
    brain_update = bool(brain_alive and running_commit and current_commit and running_commit != current_commit)

    brain_http_code, brain_http = _http_json("http://127.0.0.1:5051/status", timeout=2.0) if brain_alive else (0, {})
    brain_http_ok = brain_http_code == 200 and bool(brain_http.get("ok", True))
    if brain_alive and not brain_http_ok:
        brain_level = "yellow"
        brain_status = "Prozess läuft · HTTP hängt"
    elif brain_update:
        brain_level = "yellow"
        brain_status = "läuft · Neustart nötig"
    elif brain_alive:
        brain_level = "green"
        brain_status = "läuft"
    else:
        brain_level = "red"
        brain_status = "gestoppt"

    manager_update = bool(MANAGER_RUNNING_COMMIT and current_commit and MANAGER_RUNNING_COMMIT != current_commit)
    manager_state = _manager_state()

    cloud_base = str(os.environ.get("KRISTINE_API_BASE") or "https://protokoll.krista.at").rstrip("/")
    cloud_code, cloud = _http_json(cloud_base + "/health", timeout=4.0)
    cloud_ok = cloud_code == 200 and bool(cloud.get("ok", True))

    admin_token = str(os.environ.get("KRISTINE_ADMIN_TOKEN") or os.environ.get("ADMIN_TOKEN") or "").strip()
    access = {"level": "yellow", "status": "nicht geprüft", "detail": "Admin-Token lokal nicht vorhanden"}
    if admin_token:
        access_url = cloud_base + "/kristine/api/access-presence?token=" + urllib.parse.quote(admin_token)
        access_code, access_body = _http_json(access_url, timeout=4.0)
        if access_code == 200 and access_body.get("ok"):
            access = {"level": "green", "status": "läuft", "detail": "Cloud Bridge erreichbar"}
        else:
            access = {"level": "red", "status": "nicht erreichbar", "detail": str(access_body.get("error") or f"HTTP {access_code or '–'}")}

    index_path = Path(os.environ.get("KRISTINE_BRAIN_INDEX") or r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db")
    if index_path.is_file():
        stat = index_path.stat()
        index = {
            "level": "green",
            "status": "bereit",
            "detail": f"{stat.st_size / 1024 / 1024:.1f} MB · geändert {datetime.fromtimestamp(stat.st_mtime).strftime('%d.%m. %H:%M')}",
        }
    else:
        index = {"level": "red", "status": "fehlt", "detail": str(index_path)}

    tailscale = _tailscale_status()

    rows = [
        {
            "id": "manager", "name": "KRISTA Dienstemanager", "icon": "🛠",
            "level": "yellow" if manager_update else "green",
            "status": "läuft · Update wartet" if manager_update else "läuft",
            "version": MANAGER_VERSION,
            "runningCommit": MANAGER_RUNNING_COMMIT[:8], "currentCommit": short_current,
            "uptimeSeconds": _format_uptime(MANAGER_STARTED_AT),
            "detail": f"Port {PORT} · nur Firmen-PC",
            "lastError": str(manager_state.get("lastError") or ""),
            "canRestart": True, "canStart": False,
        },
        {
            "id": "brain", "name": "Brain Connector", "icon": "🧠",
            "level": brain_level, "status": brain_status, "version": brain_version,
            "runningCommit": running_commit[:8], "currentCommit": short_current,
            "uptimeSeconds": _format_uptime(brain_started) if brain_alive else 0,
            "detail": f"PID {brain_pid}" if brain_pid else "kein Prozess",
            "lastError": "" if brain_http_ok or not brain_alive else str(brain_http.get("error") or "HTTP 5051 antwortet nicht"),
            "canRestart": brain_alive, "canStart": not brain_alive,
        },
        {
            "id": "cloud", "name": "KRISTA Cloud / WhatsApp", "icon": "☁",
            "level": "green" if cloud_ok else "red",
            "status": "online" if cloud_ok else "nicht erreichbar",
            "version": str(cloud.get("version") or ""),
            "runningCommit": "", "currentCommit": "",
            "uptimeSeconds": 0,
            "detail": (f"Build {cloud.get('build')} · {cloud.get('status')}" if cloud_ok else str(cloud.get("error") or f"HTTP {cloud_code or '–'}")),
            "lastError": "", "canRestart": False, "canStart": False,
        },
        {
            "id": "access", "name": "Zutritt Cloud Bridge", "icon": "🚪",
            "level": access["level"], "status": access["status"], "version": "",
            "runningCommit": "", "currentCommit": "", "uptimeSeconds": 0,
            "detail": access["detail"], "lastError": "", "canRestart": False, "canStart": False,
        },
        {
            "id": "tailscale", "name": "Tailscale", "icon": "🔗",
            "level": tailscale["level"], "status": tailscale["status"], "version": str(tailscale.get("version") or ""),
            "runningCommit": "", "currentCommit": "", "uptimeSeconds": 0,
            "detail": tailscale.get("detail") or "", "lastError": "", "canRestart": False, "canStart": False,
        },
        {
            "id": "brain-index", "name": "Brain Index", "icon": "📚",
            "level": index["level"], "status": index["status"], "version": "",
            "runningCommit": "", "currentCommit": "", "uptimeSeconds": 0,
            "detail": index["detail"], "lastError": "", "canRestart": False, "canStart": False,
        },
    ]

    return {
        "ok": True,
        "managerVersion": MANAGER_VERSION,
        "repo": {"branch": branch, "commit": current_commit, "shortCommit": short_current, "subject": subject, "dirty": dirty},
        "rows": rows,
        "lastAction": manager_state.get("lastAction") or "",
        "lastActionDetail": manager_state.get("lastActionDetail") or "",
        "lastActionAt": manager_state.get("lastActionAt") or "",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _token_ok(headers) -> bool:
    expected = str(os.environ.get("KRISTINE_ADMIN_TOKEN") or os.environ.get("ADMIN_TOKEN") or "").strip()
    supplied = str(headers.get("X-Krista-Admin-Token") or "").strip()
    if expected:
        return bool(supplied) and hmac.compare_digest(expected, supplied)
    # Fallback fuer lokale Installationen ohne gesetzten Token: nur Requests der
    # explizit freigegebenen KRISTA-Origin werden akzeptiert.
    origin = str(headers.get("Origin") or "").rstrip("/")
    return origin in DEFAULT_ORIGINS


class Handler(BaseHTTPRequestHandler):
    server_version = "KRISTA-ServiceManager/1.0"

    def log_message(self, fmt, *args):
        return

    def _cors(self):
        origin = str(self.headers.get("Origin") or "").rstrip("/")
        if origin in DEFAULT_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,X-Krista-Admin-Token")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def _send_json(self, code: int, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/healthz":
            return self._send_json(200, {"ok": True, "version": MANAGER_VERSION})
        if self.path.split("?", 1)[0] != "/api/status":
            return self._send_json(404, {"ok": False, "error": "Nicht gefunden"})
        if not _token_ok(self.headers):
            return self._send_json(403, {"ok": False, "error": "Nicht berechtigt"})
        try:
            return self._send_json(200, _status_snapshot())
        except Exception as exc:
            _set_manager_error(str(exc))
            return self._send_json(500, {"ok": False, "error": str(exc)})

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/action":
            return self._send_json(404, {"ok": False, "error": "Nicht gefunden"})
        if not _token_ok(self.headers):
            return self._send_json(403, {"ok": False, "error": "Nicht berechtigt"})
        try:
            length = min(64 * 1024, int(self.headers.get("Content-Length") or 0))
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            service = str(body.get("service") or "").strip().lower()
            action = str(body.get("action") or "").strip().lower()
            if service == "brain" and action == "start":
                pid = _start_brain()
                _set_manager_error("")
                return self._send_json(202, {"ok": True, "message": "Brain wird gestartet", "pid": pid})
            if service == "brain" and action == "restart":
                def restart_worker():
                    try:
                        _restart_brain()
                        _set_manager_error("")
                    except Exception as exc:
                        _set_manager_error(str(exc))
                threading.Thread(target=restart_worker, daemon=True).start()
                return self._send_json(202, {"ok": True, "message": "Brain wird neu gestartet"})
            if service == "manager" and action == "restart":
                _set_manager_action("manager-restart")
                self._send_json(202, {"ok": True, "message": "Dienstemanager wird neu gestartet"})
                _restart_manager_later()
                return
            return self._send_json(400, {"ok": False, "error": "Aktion nicht unterstützt"})
        except Exception as exc:
            _set_manager_error(str(exc))
            return self._send_json(500, {"ok": False, "error": str(exc)})


def main() -> None:
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        print(f"KRISTA Dienstemanager läuft vermutlich bereits auf {HOST}:{PORT}: {exc}")
        return
    print(f"KRISTA Dienstemanager {MANAGER_VERSION} · http://{HOST}:{PORT}")
    print(f"Git {MANAGER_RUNNING_COMMIT[:8] or '–'} · Brain-Steuerung bereit")
    _set_manager_action("manager-start", f"Version {MANAGER_VERSION}")
    try:
        server.serve_forever(poll_interval=0.4)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
