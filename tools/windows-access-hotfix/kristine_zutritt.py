#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import contextlib
import csv
import html
import ipaddress
import json
import logging
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import zlib
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

APP = Path(r"C:\Kristine\Zutritt")
APP.mkdir(parents=True, exist_ok=True)

CONFIG_FILE = APP / "config.json"
LOG_FILE = APP / "zutritt.log"
EVENTS_CSV = APP / "events.csv"

GANTNER_HOST = "192.168.10.247"
GANTNER_TCP_PORT = 1001
TIBBO_UDP_PORT = 65535
HTTP_PORT = 8788

DOORS = {1: "Haupteingang", 2: "Lager", 3: "Büro 1.OG"}

CMD_GENERAL_OPEN = "E"  # 2103
CMD_AUTONOMOUS = "A"    # 2101
CMD_SHORT_OPEN = "O"

TIBBO_SETUP = [b"Ldamo", b"SBR4", b"SBB0", b"SPR1", b"SFC0", b"SSE0"]

WEEKEND_OPEN_MINUTES = 15
HARD_CLOSE_HOUR = 18
TIME_SYNC_HOUR = 3
TIME_SYNC_MINUTE = 15
TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")

ACCESS_SYNC_VERSION = "GAT600-ON-DEMAND-610-V3"
GAT_PROFILE_IDS = {"01", "02", "03", "04", "06"}
GAT_GERMAN_MAP = str.maketrans({
    "Ä": "[", "Ö": "\\", "Ü": "]",
    "ä": "{", "ö": "|", "ü": "}", "ß": "~",
})

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("kristine-zutritt")


def load_config():
    try:
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        cfg = {}
    changed = False
    for key in ("admin_token", "alex_arrive_token", "alex_away_token", "presence_token", "failsafe_token"):
        if not cfg.get(key):
            cfg[key] = secrets.token_urlsafe(32)
            changed = True
    if not cfg.get("http_port"):
        cfg["http_port"] = HTTP_PORT
        changed = True
    if changed or not CONFIG_FILE.exists():
        CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


CFG = load_config()


def journal(event, actor="", detail="", mode=""):
    new_file = not EVENTS_CSV.exists()
    with EVENTS_CSV.open("a", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        if new_file:
            w.writerow(["Zeit", "Ereignis", "Wer", "Detail", "Modus"])
        w.writerow([
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            event,
            actor,
            detail,
            mode,
        ])


def clockwork_running():
    try:
        r = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq cw_zt.exe"],
            capture_output=True,
            text=True,
            encoding="cp1252",
            errors="ignore",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return "cw_zt.exe" in (r.stdout or "").lower()
    except Exception:
        return False


def checksum(body):
    return f"{sum(ord(c) for c in body) & 0xFF:02X}"


def packet(term, command):
    body = f"830{term:02d}{command}"
    return f"#{body}{checksum(body)}\r".encode("ascii")


def time_packet(term):
    now = datetime.now()
    body = f"030{term:02d}{now:%y%m%d}{now.isoweekday()}{now:%H%M%S}"
    return f"#{body}{checksum(body)}\r".encode("ascii")


def framed_packet(body):
    body = str(body)
    return f"#{body}{checksum(body)}\r".encode("ascii")


def gat_name(value):
    text = str(value or "").strip().translate(GAT_GERMAN_MAP)
    text = unicodedata.normalize("NFKD", text).encode("ascii", errors="ignore").decode("ascii")
    text = " ".join(text.split())[:16]
    return text.ljust(16)


def gantner_person_no(chip):
    raw = re.sub(r"\D", "", str(chip.get("legacyEmployeeNo") or ""))
    if raw:
        return raw[-8:].zfill(8)
    card = str(chip.get("hardwareId") or "")
    # Neue Chips bekommen stabil eine eigene 8-stellige GAT-Personennummer.
    # Der Bereich 90xxxxxx kollidiert nicht mit den alten clockWORK-Nummern.
    number = 90000000 + (zlib.crc32(card.encode("ascii", errors="ignore")) % 10000000)
    return str(number)[-8:]


def access_record_packet(term, chip, profile):
    term = int(term)
    card = re.sub(r"\D", "", str(chip.get("hardwareId") or ""))
    if len(card) != 11:
        raise ValueError(f"Hardware-ID muss 11-stellig sein: {card!r}")
    profile = str(profile or "01").zfill(2)
    if profile not in GAT_PROFILE_IDS:
        profile = "01"
    name = gat_name(chip.get("name") or chip.get("employeeName") or chip.get("legacyName") or "Chip")
    body = (
        f"810{term:02d}"
        f"{gantner_person_no(chip)}"
        f"{card}"
        "00"
        f"{name}"
        "0"
        "        "
        f"{profile}"
        "000000000000000000000"
    )
    if len(body) != 74:
        raise AssertionError(f"GAT 810 Satzlaenge falsch: {len(body)}")
    return framed_packet(body)


def parse_booking_response(term, raw):
    if not raw:
        return None
    if isinstance(raw, bytes):
        text = raw.decode("ascii", errors="replace")
    else:
        text = str(raw)
    line = text.split("\r", 1)[0]
    prefix = f"!610{int(term):02d}"
    if not line.startswith(prefix) or len(line) < 10:
        return None
    # Antwort ohne weiteren Buchungssatz: !610019667 (bzw. Terminal 02/03).
    if line.startswith(prefix + "96"):
        return {"empty": True}
    if len(line) < 56:
        return None
    body, got_checksum = line[1:-2], line[-2:]
    if checksum(body) != got_checksum.upper():
        log.warning("GAT 610 Checksumme unplausibel: %r", line)
    if len(body) < 53:
        return None
    date_raw = body[20:26]
    time_raw = body[26:32]
    code = body[32:33]
    person = body[33:41].strip()
    card12 = body[41:53]
    card = card12[-11:] if card12.isdigit() else ""
    if not card or card == "00000000000":
        return {"empty": False, "card": "", "code": code, "person": person}
    try:
        at = datetime.strptime(date_raw + time_raw, "%y%m%d%H%M%S").isoformat(timespec="seconds")
    except Exception:
        at = datetime.now().isoformat(timespec="seconds")
    return {
        "empty": False,
        "hardwareId": card,
        "terminalId": str(int(term)),
        "terminalName": DOORS.get(int(term), str(term)),
        "personNo": person,
        "code": code,
        "at": at,
        "raw": line[:120],
    }


# Gegen den echten clockWORK-Mitschnitt vom 27.08.2026 validiert.
assert access_record_packet(1, {
    "legacyEmployeeNo": "37", "hardwareId": "00100968590", "legacyName": "Gruber Gerald neu"
}, "03") == b"#81001000000370010096859000Gruber Gerald ne0        0300000000000000000000066\r"
assert parse_booking_response(1, b"!610012000000000000002608270749181        000068544820D6\r")["hardwareId"] == "00068544820"


assert packet(1, "O") == b"#83001O4B\r"
assert packet(2, "O") == b"#83002O4C\r"
assert packet(3, "O") == b"#83003O4D\r"


class GantnerBus:
    def __init__(self):
        self.lock = threading.RLock()
        self.sock = None

    def _close(self):
        if self.sock:
            with contextlib.suppress(Exception):
                self.sock.close()
        self.sock = None

    def start(self):
        with self.lock:
            self._close()
            u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            u.settimeout(1.5)
            try:
                for cmd in TIBBO_SETUP:
                    u.sendto(cmd, (GANTNER_HOST, TIBBO_UDP_PORT))
                    data, _ = u.recvfrom(256)
                    if not data.startswith(b"A"):
                        raise RuntimeError("Gateway-Initialisierung fehlgeschlagen")
                u.sendto(b"E", (GANTNER_HOST, TIBBO_UDP_PORT))
            finally:
                u.close()

            deadline = time.time() + 15
            last = None
            while time.time() < deadline:
                try:
                    s = socket.create_connection((GANTNER_HOST, GANTNER_TCP_PORT), timeout=1)
                    s.settimeout(0.8)
                    self.sock = s
                    log.info("Gantner TCP 1001 verbunden.")
                    return
                except OSError as exc:
                    last = exc
                    time.sleep(0.35)
            raise RuntimeError(f"Gantner TCP nicht erreichbar: {last}")

    def _reconnect(self):
        self._close()
        deadline = time.time() + 6
        last = None
        while time.time() < deadline:
            try:
                s = socket.create_connection((GANTNER_HOST, GANTNER_TCP_PORT), timeout=1)
                s.settimeout(0.8)
                self.sock = s
                return
            except OSError as exc:
                last = exc
                time.sleep(0.3)
        raise RuntimeError(f"Gantner Reconnect fehlgeschlagen: {last}")

    def send_command(self, term, command):
        with self.lock:
            for attempt in (1, 2):
                try:
                    if self.sock is None:
                        self._reconnect()
                    raw = packet(term, command)
                    t0 = time.perf_counter()
                    self.sock.sendall(raw)
                    try:
                        answer = self.sock.recv(4096)
                    except socket.timeout:
                        answer = b""
                    elapsed = time.perf_counter() - t0
                    log.info(
                        "GAT %s %s | %r -> %r | %.3fs",
                        term, DOORS[term], raw, answer, elapsed
                    )
                    return answer, elapsed
                except OSError:
                    self._close()
                    if attempt == 2:
                        raise

    def exchange_body(self, body, timeout=1.2):
        raw = framed_packet(body)
        with self.lock:
            for attempt in (1, 2):
                try:
                    if self.sock is None:
                        self._reconnect()
                    previous_timeout = self.sock.gettimeout()
                    self.sock.settimeout(timeout)
                    try:
                        self.sock.sendall(raw)
                        answer = self.sock.recv(4096)
                    finally:
                        with contextlib.suppress(Exception):
                            self.sock.settimeout(previous_timeout)
                    log.info("GAT RAW | %r -> %r", raw, answer[:180])
                    return answer
                except (OSError, socket.timeout):
                    self._close()
                    if attempt == 2:
                        raise
                    self._reconnect()
        return b""

    def read_bookings(self, term, max_records=50):
        result = []
        for _ in range(max(1, int(max_records))):
            answer = self.exchange_body(f"610{int(term):02d}", timeout=1.0)
            booking = parse_booking_response(term, answer)
            if not booking:
                break
            if booking.get("empty"):
                break
            if booking.get("hardwareId"):
                result.append(booking)
            # Ein GAT-610-Aufruf liefert genau einen Satz.
            time.sleep(0.015)
        return result

    def write_access_chip(self, chip, group):
        rules = (group or {}).get("rules") or {}
        terminals = rules.get("terminals") or (group or {}).get("legacyTimeplans") or {}
        enabled = str(chip.get("status") or "inactive") == "active" and not bool(chip.get("blockedByEmployee"))
        written = []
        for term in DOORS:
            profile = str(terminals.get(str(term)) or "1").zfill(2) if enabled else "01"
            raw = access_record_packet(term, chip, profile)
            body = raw[1:-3].decode("ascii")
            answer = self.exchange_body(body, timeout=1.2)
            expected = f"!810{term:02d}00".encode("ascii")
            if expected not in answer:
                raise RuntimeError(f"GAT {term} bestaetigt Chip {chip.get('hardwareId')} nicht: {answer!r}")
            written.append({"terminalId": str(term), "profile": profile})
            time.sleep(0.04)
        return written

    def sync_time_all(self):
        with self.lock:
            for term in DOORS:
                raw = time_packet(term)
                for attempt in (1, 2):
                    try:
                        if self.sock is None:
                            self._reconnect()
                        self.sock.sendall(raw)
                        try:
                            answer = self.sock.recv(4096)
                        except socket.timeout:
                            answer = b""
                        log.info("ZEITSYNC %s | %r -> %r", term, raw, answer)
                        break
                    except OSError as exc:
                        log.warning(
                            "ZEITSYNC %s Verbindung weg (Versuch %s/2): %s",
                            term, attempt, exc
                        )
                        self._close()
                        if attempt == 2:
                            raise
                        self._reconnect()
                time.sleep(0.05)

    def stop(self):
        self._close()


class AccessLogic:
    def __init__(self, bus):
        self.bus = bus
        self.lock = threading.RLock()
        # Stammdaten-Sync darf nur einmal gleichzeitig laufen, blockiert aber nicht mehr
        # Status/Logik fuer die gesamte Dauer.
        self.access_sync_lock = threading.Lock()

        self.alex_present = False
        self.bettina_present = False
        self.dunja_present = False

        # Master-Latch werktags:
        # OPEN nach Alex KOMMT, NORMAL nach Alex GEHT.
        # Ein späterer echter Bettina/Dunja-Zustandswechsel hebt sie auf.
        self.master_latch = None

        self.weekend_until = None
        self.manual_until = None
        self.manual_label = None

        self.door_overrides = {door: None for door in DOORS}
        self.door_modes = {door: "NORMAL" for door in DOORS}
        self.door_reasons = {door: "Start" for door in DOORS}

        self.stop_event = threading.Event()
        self.last_hard_close_date = None
        self.last_sync_date = datetime.now().date()
        self.next_sync_retry_at = None
        self.last_scheduler_error_log_at = 0.0
        self.next_sync_retry_at = None
        self.last_scheduler_error_log_at = 0.0
        self.last_chip_read = None
        self.recent_chip_reads = []
        self.last_access_sync = None

    @staticmethod
    def weekday(now=None):
        return (now or datetime.now()).weekday() < 5

    @staticmethod
    def before_18(now=None):
        return (now or datetime.now()).hour < HARD_CLOSE_HOUR

    def _expire(self, now):
        if self.manual_until and now >= self.manual_until:
            self.manual_until = None
            self.manual_label = None
        if self.weekend_until and now >= self.weekend_until:
            self.weekend_until = None

    def _base_target(self, now):
        if now.hour >= HARD_CLOSE_HOUR:
            return "NORMAL", "18:00 Sicherheitsgrenze"

        if self.master_latch:
            return self.master_latch, "Alex Master"

        reasons = []

        if self.manual_until and now < self.manual_until:
            reasons.append(self.manual_label or "manuell")

        if self.weekday(now):
            if self.alex_present:
                reasons.append("Alex")
            if self.bettina_present:
                reasons.append("Bettina")
            if self.dunja_present:
                reasons.append("Dunja")
        elif self.weekend_until and now < self.weekend_until:
            reasons.append("Alex Wochenende 15 min")

        return ("OPEN", " + ".join(reasons)) if reasons else ("NORMAL", "kein Offen-Grund")

    def _door_target(self, door, now):
        self._expire(now)

        if now.hour >= HARD_CLOSE_HOUR:
            return "NORMAL", "18:00 Sicherheitsgrenze"

        if self.master_latch:
            return self.master_latch, "Alex Master"

        override = self.door_overrides.get(door)
        if override:
            return override, f"manueller Override {DOORS[door]}"

        return self._base_target(now)

    def _set_door(self, door, target, reason, force=False):
        if not force and self.door_modes[door] == target:
            self.door_reasons[door] = reason
            return False

        self.bus.send_command(
            door,
            CMD_GENERAL_OPEN if target == "OPEN" else CMD_AUTONOMOUS,
        )
        self.door_modes[door] = target
        self.door_reasons[door] = reason
        return True

    def evaluate(self, force=False, actor="Logik"):
        with self.lock:
            now = datetime.now()
            changed = []
            targets = {}

            for door in DOORS:
                target, reason = self._door_target(door, now)
                targets[door] = (target, reason)
                if self._set_door(door, target, reason, force=force):
                    changed.append(door)

            if not changed:
                return

            if len(changed) == 3 and len({self.door_modes[d] for d in changed}) == 1:
                mode = self.door_modes[changed[0]]
                journal(
                    "ALLE_OFFEN" if mode == "OPEN" else "ALLE_NORMAL",
                    actor,
                    targets[changed[0]][1],
                    mode,
                )
            else:
                for door in changed:
                    journal(
                        "TUER_MODUS",
                        actor,
                        f"{door}|{DOORS[door]}|{self.door_modes[door]}|{self.door_reasons[door]}",
                        self.door_modes[door],
                    )

    def force_normal(self, reason, clear_presence=False):
        with self.lock:
            if clear_presence:
                self.alex_present = False
                self.bettina_present = False
                self.dunja_present = False

            self.master_latch = None
            self.weekend_until = None
            self.manual_until = None
            self.manual_label = None
            self.door_overrides = {door: None for door in DOORS}

            for door in DOORS:
                self._set_door(door, "NORMAL", reason, force=True)

            journal("FORCE_NORMAL", "System", reason, "NORMAL")

    def alex_arrive(self):
        with self.lock:
            now = datetime.now()

            self.door_overrides = {door: None for door in DOORS}
            self.manual_until = None
            self.manual_label = None
            self.master_latch = None

            if not self.before_18(now):
                return "Nach 18:00: Generalöffnung gesperrt."

            self.alex_present = True

            if self.weekday(now):
                self.master_latch = "OPEN"
                detail = "Master KOMMT"
            else:
                # Wochenendregel bleibt bewusst 15 Minuten.
                self.weekend_until = now + timedelta(minutes=WEEKEND_OPEN_MINUTES)
                detail = "Wochenende 15 min"

            journal("ALEX_NFC", "Alex", detail, "")

        self.evaluate(force=True, actor="Alex")
        return "Alex KOMMT."

    def alex_away(self):
        with self.lock:
            self.alex_present = False
            self.door_overrides = {door: None for door in DOORS}
            self.manual_until = None
            self.manual_label = None
            self.weekend_until = None

            now = datetime.now()

            # Bettina/Dunja duerfen Alex GEHT ueberstimmen.
            # Solange mindestens eine von beiden noch da ist, bleibt
            # werktags vor 18:00 offen. Erst die letzte Person schliesst.
            office_present = bool(self.bettina_present or self.dunja_present)

            if self.weekday(now) and self.before_18(now) and office_present:
                self.master_latch = None
                names = []
                if self.bettina_present:
                    names.append("Bettina")
                if self.dunja_present:
                    names.append("Dunja")
                who = " + ".join(names)
                journal("ALEX_WEG", "Alex", "GEHT, bleibt OFFEN wegen " + who, "")
                result = "Alex GEHT - bleibt OFFEN, solange " + who + " da ist."
            else:
                self.master_latch = "NORMAL"
                journal("ALEX_WEG", "Alex", "Master GEHT", "")
                result = "Alex GEHT - Master NORMAL."

        self.evaluate(force=True, actor="Alex")
        return result
    def presence(self, person, present):
        with self.lock:
            present = bool(present)

            if person == "bettina":
                old = self.bettina_present
                self.bettina_present = present
            elif person == "dunja":
                old = self.dunja_present
                self.dunja_present = present
            else:
                raise ValueError("Unbekannte Person")

            # Wichtig: nur ein echter Zustandswechsel hebt die Alex-Master-Latch auf.
            if old != present:
                self.master_latch = None
                journal(
                    "STEMPEL_IN" if present else "STEMPEL_OUT",
                    person.capitalize(),
                    "Stempel-Bridge",
                    "",
                )

        self.evaluate(actor=person.capitalize())
        return f"{person.capitalize()} {'IN' if present else 'OUT'}."

    def toggle_door(self, door):
        door = int(door)
        if door not in DOORS:
            raise ValueError("Unbekannte Tür")

        with self.lock:
            if datetime.now().hour >= HARD_CLOSE_HOUR:
                return self.status()

            target = "NORMAL" if self.door_modes[door] == "OPEN" else "OPEN"

            # Ein bewusster späterer manueller Klick darf die vorherige Alex-Latch übersteuern.
            self.master_latch = None
            self.door_overrides[door] = target

            self._set_door(
                door,
                target,
                f"manueller Header-Override {target}",
                force=True,
            )

            journal(
                "TUER_MODUS",
                "Header",
                f"{door}|{DOORS[door]}|{target}|manueller Header-Override",
                target,
            )

            return self.status()

    def manual_open(self, minutes=None, until18=False):
        with self.lock:
            now = datetime.now()
            if not self.before_18(now):
                return "Nach 18:00 gesperrt."

            self.master_latch = None

            if until18:
                self.manual_until = now.replace(
                    hour=HARD_CLOSE_HOUR,
                    minute=0,
                    second=0,
                    microsecond=0,
                )
                self.manual_label = "manuell bis 18:00"
            else:
                minutes = int(minutes)
                if minutes not in (15, 30, 60, 120, 240):
                    raise ValueError("Ungültige Dauer")
                self.manual_until = now + timedelta(minutes=minutes)
                self.manual_label = f"manuell {minutes} min"

        self.evaluate()
        return self.manual_label

    def short_open(self, door):
        door = int(door)
        if door not in DOORS:
            raise ValueError("Unbekannte Tür")
        self.bus.send_command(door, CMD_SHORT_OPEN)
        journal("TUER_KURZ", "Dashboard", DOORS[door], "")
        return f"{DOORS[door]} öffnet."

    def status(self):
        with self.lock:
            return {
                "now": datetime.now().isoformat(timespec="seconds"),
                "alex": self.alex_present,
                "bettina": self.bettina_present,
                "dunja": self.dunja_present,
                "masterLatch": self.master_latch,
                "syncVersion": ACCESS_SYNC_VERSION,
                "lastChipRead": self.last_chip_read,
                "recentChipReads": list(self.recent_chip_reads[-20:]),
                "lastAccessSync": self.last_access_sync,
                "doors": {
                    str(door): {
                        "name": DOORS[door],
                        "mode": self.door_modes[door],
                        "override": self.door_overrides[door],
                        "reason": self.door_reasons[door],
                    }
                    for door in DOORS
                },
            }

    def sync_access(self, payload):
        chips = list((payload or {}).get("chips") or [])
        groups = list((payload or {}).get("groups") or [])
        group_map = {str(g.get("id")): g for g in groups}
        written = []

        # Wichtig: kein self.lock um den kompletten GAT-Schreibvorgang.
        # Ein Vollsync kann > 2 Minuten dauern; Status und Tuerschaltung muessen
        # waehrenddessen weiter reagieren. Gleichzeitig darf nur EIN Vollsync laufen.
        if not self.access_sync_lock.acquire(blocking=False):
            raise RuntimeError("GAT-Stammdaten-Sync laeuft bereits")
        try:
            for chip in chips:
                hardware_id = str(chip.get("hardwareId") or "")
                group = group_map.get(str(chip.get("groupId") or "")) or {"rules": {"terminals": {"1": "1", "2": "1", "3": "1"}}}
                detail = self.bus.write_access_chip(chip, group)
                written.append({"internalChipNo": str(chip.get("internalChipNo") or ""), "hardwareId": hardware_id, "terminals": detail})
            with self.lock:
                self.last_access_sync = {
                    "at": datetime.now().isoformat(timespec="seconds"),
                    "count": len(written),
                }
        finally:
            self.access_sync_lock.release()

        if written:
            journal("GAT_SYNC", "KRISTINE", f"{len(written)} Chip(s) auf 3 Terminals aktualisiert", "")
        return {"written": written, "count": len(written), "syncVersion": ACCESS_SYNC_VERSION}

    def read_bookings_on_demand(self, terminal_id=3, max_records=1):
        """Liest Buchungen nur auf ausdruecklichen Auftrag der Cloud-Bridge."""
        terminal_id = int(terminal_id)
        if terminal_id not in DOORS:
            raise ValueError("Unbekanntes Terminal")
        max_records = max(1, min(3, int(max_records)))
        if not self.access_sync_lock.acquire(blocking=False):
            raise RuntimeError("GAT-Stammdaten-Sync laeuft bereits")
        try:
            bookings = self.bus.read_bookings(terminal_id, max_records=max_records)
        finally:
            self.access_sync_lock.release()
        for booking in bookings:
            with self.lock:
                self.last_chip_read = booking
                self.recent_chip_reads.append(booking)
                self.recent_chip_reads = self.recent_chip_reads[-50:]
            journal("CHIP_READ", DOORS[terminal_id], booking.get("hardwareId", ""), booking.get("code", ""))
        return bookings

    def start(self):
        # Fail-safe: bei jedem Dienststart zuerst NORMAL.
        self.force_normal("Programmstart / Sicherheitsreset", clear_presence=True)

        with contextlib.suppress(Exception):
            self.bus.sync_time_all()

        threading.Thread(target=self._scheduler, daemon=True).start()

    def _scheduler(self):
        while not self.stop_event.wait(1):
            try:
                now = datetime.now()

                if now.hour >= HARD_CLOSE_HOUR and self.last_hard_close_date != now.date():
                    self.last_hard_close_date = now.date()
                    self.force_normal("18:00 Sicherheitslauf", clear_presence=True)

                if (
                    (now.hour, now.minute) >= (TIME_SYNC_HOUR, TIME_SYNC_MINUTE)
                    and self.last_sync_date != now.date()
                    and (
                        self.next_sync_retry_at is None
                        or now >= self.next_sync_retry_at
                    )
                ):
                    try:
                        self.bus.sync_time_all()
                        self.last_sync_date = now.date()
                        self.next_sync_retry_at = None
                        journal("ZEITSYNC", "System", "03:15", "")
                    except Exception as exc:
                        self.next_sync_retry_at = now + timedelta(minutes=30)
                        log.error(
                            "ZEITSYNC fehlgeschlagen; neuer Versuch frühestens %s: %s",
                            self.next_sync_retry_at.strftime("%H:%M"),
                            exc,
                        )
                        journal(
                            "ZEITSYNC_FEHLER",
                            "System",
                            f"Nächster Versuch {self.next_sync_retry_at:%H:%M}: {exc}",
                            "",
                        )

                self.evaluate()

            except Exception:
                now_ts = time.time()
                if now_ts - self.last_scheduler_error_log_at >= 60:
                    self.last_scheduler_error_log_at = now_ts
                    log.exception("Scheduler-Fehler")


def allowed_client(ip_text):
    try:
        ip = ipaddress.ip_address(ip_text)
        return ip.is_private or ip.is_loopback or ip in TAILSCALE_NET
    except Exception:
        return False


def button(label, href, danger=False):
    bg = "#8B0000" if danger else "#222"
    return (
        f"<a href='{html.escape(href)}' "
        f"style='display:inline-block;margin:5px;padding:12px 15px;border-radius:10px;"
        f"background:{bg};color:white;text-decoration:none'>{html.escape(label)}</a>"
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "KristineZutritt/3.0"

    def log_message(self, *args):
        return

    def send_html(self, code, title, text, extra=""):
        body = (
            f"<!doctype html><meta charset=utf-8>"
            f"<meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<title>{html.escape(title)}</title>"
            f"<body style='font-family:system-ui;max-width:900px;margin:24px auto;padding:12px'>"
            f"<h2>{html.escape(title)}</h2><p>{html.escape(text)}</p>{extra}</body>"
        ).encode("utf-8")

        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, obj):
        body = json.dumps({"ok": True, **obj}, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def redirect_ui(self):
        self.send_response(302)
        self.send_header("Location", f"/ui/{CFG['admin_token']}")
        self.end_headers()

    def do_POST(self):
        if not allowed_client(self.client_address[0]):
            self.send_json(403, {"ok": False, "error": "Nur lokales Netz/Tailscale."})
            return
        path = urlparse(self.path).path.rstrip("/")
        try:
            if path == f"/api/access-sync/{CFG['admin_token']}":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8", errors="replace") or "{}")
                result = self.server.logic.sync_access(payload)
                self.send_json(200, result)
                return
            if path == f"/api/bookings-read/{CFG['admin_token']}":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8", errors="replace") or "{}")
                terminal_id = payload.get("terminalId", 3)
                max_records = payload.get("maxRecords", 1)
                bookings = self.server.logic.read_bookings_on_demand(terminal_id, max_records)
                self.send_json(200, {"bookings": bookings, "count": len(bookings)})
                return
            self.send_json(404, {"ok": False, "error": "Falsche Adresse."})
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return
        except Exception as exc:
            log.exception("HTTP-POST-Fehler")
            try:
                self.send_json(500, {"ok": False, "error": str(exc)})
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass

    def do_GET(self):
        if not allowed_client(self.client_address[0]):
            self.send_html(403, "Blockiert", "Nur lokales Netz/Tailscale.")
            return

        path = urlparse(self.path).path.rstrip("/")

        try:
            logic = self.server.logic

            if path == "/health":
                self.send_html(200, "Kristine Zutritt", "OK")
                return

            if path == f"/alex/arrive/{CFG['alex_arrive_token']}":
                self.send_html(200, "Firma", logic.alex_arrive())
                return

            if path == f"/alex/away/{CFG['alex_away_token']}":
                self.send_html(200, "Firma", logic.alex_away())
                return

            for person in ("bettina", "dunja"):
                for action, present in (("in", True), ("out", False)):
                    if path == f"/presence/{person}/{action}/{CFG['presence_token']}":
                        self.send_html(200, "Stempel", logic.presence(person, present))
                        return

            if path == f"/failsafe/normal/{CFG['failsafe_token']}":
                logic.force_normal("18:00 externer Failsafe", clear_presence=True)
                self.send_html(200, "Firma", "Alle 3 NORMAL.")
                return

            if path == f"/api/status/{CFG['admin_token']}":
                self.send_json(200, logic.status())
                return

            parts = path.split("/")
            # /api/door-toggle/1/<admin_token>
            if (
                len(parts) == 5
                and parts[1] == "api"
                and parts[2] == "door-toggle"
                and parts[3].isdigit()
                and parts[4] == CFG["admin_token"]
            ):
                door = int(parts[3])
                self.send_json(200, {"status": logic.toggle_door(door)})
                return

            admin = CFG["admin_token"]

            if path == f"/ui/{admin}":
                status = logic.status()
                doors = status["doors"]
                cards = " ".join(
                    f"{'🟢' if doors[str(d)]['mode'] == 'OPEN' else '🔴'} {DOORS[d]}"
                    for d in DOORS
                )
                base = f"/action/{admin}"

                extra = (
                    f"<h1>{cards}</h1>"
                    f"<p>Alex: {'DA' if status['alex'] else 'weg'} · "
                    f"Bettina: {'DA' if status['bettina'] else 'weg'} · "
                    f"Dunja: {'DA' if status['dunja'] else 'weg'} · "
                    f"Master: {html.escape(str(status['masterLatch'] or '-'))}</p>"
                    f"<h3>Alle</h3>"
                    f"{button('15 min', base + '/manual_15')}"
                    f"{button('30 min', base + '/manual_30')}"
                    f"{button('1 Stunde', base + '/manual_60')}"
                    f"{button('2 Stunden', base + '/manual_120')}"
                    f"{button('4 Stunden', base + '/manual_240')}"
                    f"{button('bis 18:00', base + '/manual_18')}"
                    f"<h3>Kurz öffnen</h3>"
                    f"{button('Haupteingang', base + '/door_1')}"
                    f"{button('Lager', base + '/door_2')}"
                    f"{button('Büro 1.OG', base + '/door_3')}"
                    f"<h3>Sicherheit</h3>"
                    f"{button('ALLE JETZT NORMAL', base + '/normal', True)}"
                )

                self.send_html(200, "Kristine Zutritt", "", extra)
                return

            if path.startswith(f"/action/{admin}/"):
                action = path.split("/")[-1]

                if action == "manual_18":
                    logic.manual_open(until18=True)
                elif action.startswith("manual_"):
                    logic.manual_open(minutes=int(action.split("_")[1]))
                elif action.startswith("door_"):
                    logic.short_open(int(action.split("_")[1]))
                elif action == "normal":
                    logic.force_normal("Dashboard SOFORT NORMAL", clear_presence=True)
                else:
                    raise ValueError("Unbekannte Aktion")

                self.redirect_ui()
                return

            self.send_html(404, "Nicht gefunden", "Falsche Adresse.")

        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return
        except Exception as exc:
            log.exception("HTTP-Fehler")
            try:
                self.send_html(500, "Fehler", str(exc))
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass


def main():
    if clockwork_running():
        log.error("clockWORK läuft – KRISTINE Zutritt startet nicht.")
        return

    bus = GantnerBus()
    bus.start()

    logic = AccessLogic(bus)
    logic.start()

    server = ThreadingHTTPServer(("0.0.0.0", int(CFG["http_port"])), Handler)
    server.logic = logic

    journal("PROGRAMM_START", "System", "Produktiv V3 Header/Systemstatus", "")

    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        with contextlib.suppress(Exception):
            logic.force_normal("Programm beendet", clear_presence=False)
        bus.stop()
        server.server_close()


if __name__ == "__main__":
    main()
