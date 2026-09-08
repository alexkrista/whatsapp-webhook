#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import csv
import json
import logging
import os
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from threading import Thread

APP = Path(r"C:\Kristine\AccessBridge")
APP.mkdir(parents=True, exist_ok=True)

LOG = APP / "access_bridge.log"
STATE = APP / "state.json"

GANTNER_CONFIG = Path(r"C:\Kristine\Zutritt\config.json")
GANTNER_EVENTS = Path(r"C:\Kristine\Zutritt\events.csv")
GANTNER_LOG = Path(r"C:\Kristine\Zutritt\zutritt.log")

REMOTE_BASE = str(
    os.environ.get("KRISTINE_API_BASE", "https://protokoll.krista.at")
).rstrip("/")
ADMIN_TOKEN = str(os.environ.get("KRISTINE_ADMIN_TOKEN", "")).strip()

ACCESS_SYNC_VERSION = "ACCESS-BRIDGE-ON-DEMAND-V5"
ACCESS_SYNC_SECONDS = 30
LOCAL_JOB_POLL_SECONDS = 5.0

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.FileHandler(LOG, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("access-bridge")


def remote_json(path, method="GET", payload=None, timeout=15):
    if not ADMIN_TOKEN:
        raise RuntimeError("KRISTINE_ADMIN_TOKEN fehlt")

    headers = {
        "Accept": "application/json",
        "X-Admin-Token": ADMIN_TOKEN,
    }

    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(
        REMOTE_BASE + path,
        data=body,
        headers=headers,
        method=method,
    )

    with urllib.request.urlopen(req, timeout=timeout) as response:
        data = json.loads(
            response.read().decode("utf-8", errors="replace") or "{}"
        )
        if not data.get("ok", True):
            raise RuntimeError(data.get("error") or f"HTTP {response.status}")
        return data


def notify(message):
    try:
        remote_json(
            "/kristine/api/access-notify",
            method="POST",
            payload={"message": str(message)[:3300]},
            timeout=20,
        )
    except Exception as exc:
        log.warning("WhatsApp nicht gesendet: %s", exc)


def local_text(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def local_json(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(
            response.read().decode("utf-8", errors="replace") or "{}"
        )


def local_post_json(url, payload, timeout=30):
    body = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8", errors="replace") or "{}")
        if not data.get("ok", True):
            raise RuntimeError(data.get("error") or f"HTTP {response.status}")
        return data


def gantner_config():
    return json.loads(GANTNER_CONFIG.read_text(encoding="utf-8"))


def gantner_status():
    cfg = gantner_config()
    token = urllib.parse.quote(str(cfg["admin_token"]))
    return local_json(
        f"http://127.0.0.1:8788/api/status/{token}",
        timeout=6,
    )


def gantner_read_bookings(terminal_id=3, max_records=1):
    cfg = gantner_config()
    token = urllib.parse.quote(str(cfg["admin_token"]))
    return local_post_json(
        f"http://127.0.0.1:8788/api/bookings-read/{token}",
        {"terminalId": int(terminal_id), "maxRecords": int(max_records)},
        timeout=12,
    )


def set_presence(person, present):
    cfg = gantner_config()
    token = urllib.parse.quote(str(cfg["presence_token"]))
    action = "in" if present else "out"

    local_text(
        f"http://127.0.0.1:8788/presence/{person}/{action}/{token}",
        timeout=8,
    )


def http_health(url):
    try:
        local_text(url, timeout=2)
        return True
    except Exception:
        return False


def powershell(command):
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return (result.stdout or "").strip()
    except Exception:
        return ""


def service_status():
    wlan = bool(
        powershell(
            "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue "
            "| Where-Object IPAddress -like '192.168.1.*' "
            "| Select-Object -First 1 -ExpandProperty IPAddress)"
        )
    )

    tailscale = "Running" in powershell(
        "(Get-Service Tailscale -ErrorAction SilentlyContinue "
        "| Select-Object -ExpandProperty Status)"
    )

    failsafe = powershell(
        "(Get-ScheduledTask -TaskName 'Kristine Gantner 18Uhr Failsafe' "
        "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty State)"
    )

    wlan_watch = powershell(
        "(Get-ScheduledTask -TaskName 'Kristine Firmen-WLAN Waechter' "
        "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty State)"
    )

    return {
        "wlan": {
            "label": "Firmen-WLAN",
            "state": "ok" if wlan else "bad",
            "detail": "192.168.1.x vorhanden" if wlan else "nicht verbunden",
        },
        "tailscale": {
            "label": "Tailscale",
            "state": "ok" if tailscale else "bad",
            "detail": "Dienst läuft" if tailscale else "nicht Running",
        },
        "brain": {
            "label": "The Brain",
            "state": "ok" if http_health("http://127.0.0.1:5051/status") else "bad",
            "detail": "Port 5051",
        },
        "homematic": {
            "label": "Homematic / NFC",
            "state": "ok" if http_health("http://127.0.0.1:8787/health") else "bad",
            "detail": "Port 8787",
        },
        "gantner": {
            "label": "Gantner / Zutritt",
            "state": "ok" if http_health("http://127.0.0.1:8788/health") else "bad",
            "detail": "Port 8788",
        },
        "bridge": {
            "label": "Access Bridge",
            "state": "ok",
            "detail": "Heartbeat aktiv",
        },
        "failsafe": {
            "label": "18:00-Failsafe",
            "state": "ok" if failsafe in ("Ready", "Running") else "bad",
            "detail": failsafe or "Task fehlt",
        },
        "wlanwatch": {
            "label": "WLAN-Wächter",
            "state": "ok" if wlan_watch == "Running" else "warn",
            "detail": wlan_watch or "Task fehlt",
        },
    }


def read_event_rows():
    if not GANTNER_EVENTS.exists():
        return []

    try:
        with GANTNER_EVENTS.open(
            "r",
            encoding="utf-8-sig",
            newline="",
        ) as f:
            return list(csv.DictReader(f, delimiter=";"))
    except Exception:
        return []


def event_message(row):
    event = str(row.get("Ereignis") or "")
    when = str(row.get("Zeit") or "")
    detail = str(row.get("Detail") or "")
    hm = when[-8:-3] if len(when) >= 8 else when

    if event == "ALLE_OFFEN":
        return (
            f"🔓 {hm} Alle 3 – GENERELL OFFEN ✅\n"
            f"Grund: {detail}"
        )

    if event in ("ALLE_NORMAL", "FORCE_NORMAL"):
        return (
            f"❌ {hm} Alle 3 – NORMAL / geschlossen ✅\n"
            f"Grund: {detail}"
        )

    if event == "TUER_KURZ":
        return f"🚪 {hm} {detail} – kurz geöffnet ✅"

    if event == "TUER_MODUS":
        parts = detail.split("|")
        name = parts[1] if len(parts) > 1 else "Tür"
        mode = parts[2] if len(parts) > 2 else ""

        if mode == "OPEN":
            return f"🟢 {hm} {name} – GENERELL OFFEN ✅"

        return f"❌ {hm} {name} – NORMAL / geschlossen ✅"

    return ""


def monitor_gantner_events():
    rows = read_event_rows()
    seen = len(rows)

    if GANTNER_LOG.exists():
        log_lines = GANTNER_LOG.read_text(
            encoding="utf-8",
            errors="replace",
        ).splitlines()
    else:
        log_lines = []

    seen_log = len(log_lines)
    last_error_signature = None
    last_error_notification_at = 0.0
    suppressed_errors = 0
    error_notify_cooldown = 30 * 60

    log.info(
        "Gantner-Ereignismonitor aktiv; historische Einträge werden nicht versendet."
    )

    while True:
        try:
            rows = read_event_rows()

            for row in rows[seen:]:
                message = event_message(row)
                if message:
                    notify(message)

            seen = len(rows)

            if GANTNER_LOG.exists():
                lines = GANTNER_LOG.read_text(
                    encoding="utf-8",
                    errors="replace",
                ).splitlines()

                for line in lines[seen_log:]:
                    if "| ERROR |" not in line and " ERROR " not in line:
                        continue
                    # HTTP-Handler-Fehler entstehen meist durch abgebrochene Browser-/Sync-Requests.
                    # Sie bleiben im lokalen Log, werden aber nicht als WhatsApp-Alarm gespammt.
                    if "HTTP-Fehler" in line or "HTTP-POST-Fehler" in line:
                        continue

                    signature = (
                        line.split("| ERROR |", 1)[1].strip()
                        if "| ERROR |" in line
                        else line.strip()
                    )
                    now_ts = time.time()

                    if (
                        signature == last_error_signature
                        and now_ts - last_error_notification_at < error_notify_cooldown
                    ):
                        suppressed_errors += 1
                        continue

                    suffix = (
                        f"\n({suppressed_errors} gleiche Meldungen unterdrückt)"
                        if suppressed_errors
                        else ""
                    )
                    notify(f"⚠️ Zutritt FEHLER\n{line[-900:]}{suffix}")

                    last_error_signature = signature
                    last_error_notification_at = now_ts
                    suppressed_errors = 0

                seen_log = len(lines)

        except Exception as exc:
            log.warning("Ereignismonitor: %s", exc)

        time.sleep(2)


def _local_access_sync(payload):
    cfg = gantner_config()
    token = urllib.parse.quote(str(cfg["admin_token"]))
    return local_post_json(
        f"http://127.0.0.1:8788/api/access-sync/{token}",
        payload,
        timeout=300,
    )


def sync_access_once():
    pending = remote_json("/admin/api/access/pending", timeout=20)
    queue = list(pending.get("syncQueue") or [])
    if not queue:
        return 0

    chips = list(pending.get("chips") or [])
    groups = list(pending.get("groups") or [])
    by_id = {str(c.get("internalChipNo") or ""): c for c in chips}
    affected = {}

    for item in queue:
        entity = item.get("entity") or {}
        typ = str(entity.get("type") or "all")
        eid = str(entity.get("id") or "")
        if typ == "chip":
            chip = by_id.get(eid)
            if chip:
                affected[str(chip.get("internalChipNo"))] = chip
        elif typ == "group":
            for chip in chips:
                if str(chip.get("groupId") or "") == eid:
                    affected[str(chip.get("internalChipNo"))] = chip
        else:
            for chip in chips:
                affected[str(chip.get("internalChipNo"))] = chip

    queue_ids = [str(x.get("id")) for x in queue if x.get("id")]
    try:
        result = _local_access_sync({
            "chips": list(affected.values()),
            "groups": groups,
            "queueIds": queue_ids,
            "source": ACCESS_SYNC_VERSION,
        })
        remote_json(
            "/admin/api/access/sync/ack",
            method="POST",
            payload={"ids": queue_ids, "ok": True, "local": result},
            timeout=20,
        )
        if affected:
            log.info("GAT-Sync OK: %s Chip(s), %s Queue-Eintrag(e)", len(affected), len(queue_ids))
        return len(affected)
    except Exception as exc:
        log.warning("GAT-Sync fehlgeschlagen: %s", exc)
        try:
            remote_json(
                "/admin/api/access/sync/ack",
                method="POST",
                payload={"ids": queue_ids, "ok": False, "error": str(exc)},
                timeout=15,
            )
        except Exception:
            pass
        raise


def sync_access_loop():
    log.info("GAT-Stammdaten-Sync aktiv: alle %s Sekunden.", ACCESS_SYNC_SECONDS)
    time.sleep(4)
    while True:
        try:
            sync_access_once()
        except Exception:
            pass
        time.sleep(ACCESS_SYNC_SECONDS)


def monitor_learning_jobs():
    # #610 wird ausschliesslich waehrend eines aktiven Lernauftrags verwendet.
    # Pro Durchlauf wird nur ein Satz vom ausgewaehlten Terminal gelesen.
    log.info("Chip-Lesen auf Abruf aktiv (keine dauernden Tibbo-Abfragen).")
    while True:
        try:
            response = remote_json("/admin/api/access/local-job", timeout=15)
            job = response.get("job") or {}
            job_type = str(job.get("type") or "")
            if job_type in ("learn-read", "bookings-read"):
                terminals = [int(job.get("terminalId") or 3)] if job_type == "learn-read" else [1, 2, 3]
                all_bookings = []
                for terminal_id in terminals:
                    result = gantner_read_bookings(terminal_id, max_records=1)
                    all_bookings.extend(result.get("bookings") or [])
                    if len(terminals) > 1:
                        time.sleep(0.5)
                for event in all_bookings:
                    remote_json(
                        "/admin/api/access/chip-read",
                        method="POST",
                        payload=event,
                        timeout=15,
                    )
                    log.info("Chip gelesen: %s an Terminal %s", event.get("hardwareId"), event.get("terminalId"))
                if job_type in ("learn-read", "bookings-read"):
                    remote_json(
                        "/admin/api/access/local-job/ack",
                        method="POST",
                        payload={"id": job.get("id"), "sessionId": job.get("sessionId"), "type": job_type, "ok": True, "result": {"bookings": all_bookings}},
                        timeout=15,
                    )
            elif job_type == "learn-finish":
                remote_json(
                    "/admin/api/access/local-job/ack",
                    method="POST",
                    payload={"id": job.get("id"), "sessionId": job.get("sessionId"), "type": job_type, "ok": True, "result": {}},
                    timeout=15,
                )
        except Exception as exc:
            log.debug("Chip-Lernauftrag: %s", exc)
        time.sleep(LOCAL_JOB_POLL_SECONDS)


def send_heartbeat():
    try:
        gantner = gantner_status()
    except Exception as exc:
        gantner = {
            "ok": False,
            "error": str(exc),
            "doors": {},
        }

    payload = {
        "host": "KRISTINE-PC",
        "gantner": gantner,
        "services": service_status(),
        "sentAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "accessSyncVersion": ACCESS_SYNC_VERSION,
    }

    remote_json(
        "/kristine/api/access-heartbeat",
        method="POST",
        payload=payload,
        timeout=15,
    )

    STATE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main():
    log.info("KRISTINE Access Bridge V5 startet · Chip-Lesen nur auf Abruf + 30s Cloud-Sync.")

    while not http_health("http://127.0.0.1:8788/health"):
        log.info("Warte auf Gantner 8788 ...")
        time.sleep(3)

    Thread(
        target=monitor_gantner_events,
        daemon=True,
    ).start()
    Thread(target=monitor_learning_jobs, daemon=True).start()
    Thread(target=sync_access_loop, daemon=True).start()

    applied = {
        "bettina": None,
        "dunja": None,
    }

    while True:
        try:
            data = remote_json(
                "/kristine/api/access-presence",
                timeout=12,
            )

            people = data.get("people") or {}

            for person in ("bettina", "dunja"):
                present = bool(
                    (people.get(person) or {}).get("present")
                )

                if (
                    applied[person] is None
                    or applied[person] != present
                ):
                    set_presence(person, present)
                    applied[person] = present

            send_heartbeat()

        except Exception as exc:
            log.warning("Bridge-Zyklus: %s", exc)

        time.sleep(8)


if __name__ == "__main__":
    main()
