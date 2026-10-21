"""KRISTINE office presence scene. Separate from GANTNER door control.

OFF by default. Never run with --watch until the HCU actor IDs and Sonos zone
have been verified and config.enabled explicitly set true.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

PEOPLE = ("alex", "bettina", "dunja")
LOG = logging.getLogger("kristine.presence_scene")
HCU_SCRIPT_DIR = Path(r"C:\Kristine\HomematicNFC")
DEFAULT_CONFIG = Path(r"C:\Kristine\PresenceScenes\config.json")
DEFAULT_STATE = Path(r"C:\Kristine\PresenceScenes\state.json")


def people_present(status):
    """Only explicit boolean presence readings count. Missing = UNKNOWN, not away."""
    if not isinstance(status, dict) or any(type(status.get(name)) is not bool for name in PEOPLE):
        raise ValueError("GANTNER-Anwesenheit unvollständig; keine Schaltung.")
    return {name: status[name] for name in PEOPLE}


def next_scene_state(state, people, now, away_grace=120):
    """Pure decision; no device calls. Returns updated state and optional transition."""
    if not all(type(people.get(person)) is bool for person in PEOPLE):
        raise ValueError("Missing presence")
    if not isinstance(now, (int, float)) or away_grace < 0:
        raise ValueError("Invalid timing")
    result = dict(state)
    was_active = bool(result.get("active", False))
    if any(people.values()):
        result["away_since"] = None
        desired = True
    else:
        since = result.get("away_since")
        if since is None or since > now:
            since = now
        result["away_since"] = since
        desired = False if now - since >= away_grace else was_active
    result["last_people"] = dict(people)
    if desired != was_active:
        result["active"] = desired
        result["changed_at"] = now
        return result, ("on" if desired else "off")
    return result, None


def load_json(path, fallback=None):
    path = Path(path)
    if not path.is_file():
        return fallback
    with path.open(encoding="utf-8") as file:
        return json.load(file)


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with temp.open("w", encoding="utf-8") as file:
        json.dump(data, file, indent=2, ensure_ascii=False)
        file.write("\n")
    os.replace(temp, path)


def local_gantner_status(config):
    """Reads local GANTNER status; never writes to the door controller."""
    credentials = load_json(config["access_config"])
    if not isinstance(credentials, dict) or not credentials.get("admin_token"):
        raise ValueError("GANTNER-Konfiguration nicht verfügbar")
    port = int(credentials.get("http_port", 8788))
    if not 1 <= port <= 65535:
        raise ValueError("Invalid local port")
    # localhost only; no remote token leakage and no config credentials in logs.
    url = "http://127.0.0.1:%d/api/status/%s" % (
        port, credentials["admin_token"]
    )
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)


def validate_actor(actor, name):
    device_id = str(actor.get("device_id", "")).strip()
    channel = actor.get("channel_index")
    label = str(actor.get("expected_label", "")).strip()
    if not re.fullmatch(r"[A-Fa-f0-9]{24}", device_id):
        raise ValueError(name + ": HCU-Geräte-ID fehlt oder ist ungültig")
    if type(channel) is not int or channel < 1 or channel > 50:
        raise ValueError(name + ": schaltbarer HCU-Kanal fehlt")
    if len(label) < 3:
        raise ValueError(name + ": eindeutiger erwarteter Gerätename fehlt")
    return device_id, channel, label


def validate_config(config):
    if config.get("enabled") is not True:
        raise ValueError("Automatik ist deaktiviert (sicherer Ausgangszustand).")
    actors = config.get("actors") or {}
    for name in ("stiegenhaus", "little_greene"):
        validate_actor(actors.get(name) or {}, name)
    sonos_ip = str((config.get("sonos") or {}).get("ip", "")).strip()
    pieces = sonos_ip.split(".")
    if len(pieces) != 4 or not all(p.isdigit() and 0 <= int(p) <= 255 for p in pieces):
        raise ValueError("Sonos-IP fehlt; keine Anlage wird geraten.")
    poll = config.get("poll_seconds", 8)
    grace = config.get("away_grace_seconds", 120)
    if not 5 <= poll <= 120 or not 30 <= grace <= 3600:
        raise ValueError("Ungültige Zeitgrenzen")
    return True


def hcu_module():
    if str(HCU_SCRIPT_DIR) not in sys.path:
        sys.path.insert(0, str(HCU_SCRIPT_DIR))
    import hcu_nfc_gate
    return hcu_nfc_gate


def verify_hcu_actors(hcu_config, config, module=None):
    """Read-only fail-closed verification of every channel prior to changing state."""
    module = module or hcu_module()
    devices = module.hcu_get_system_state(hcu_config).get("devices", {})
    results = []
    for name in ("stiegenhaus", "little_greene"):
        device_id, channel, expected = validate_actor(config["actors"][name], name)
        device = devices.get(device_id)
        if not isinstance(device, dict):
            raise ValueError(name + ": Gerät nicht an dieser HCU gefunden")
        label = str(device.get("label", ""))
        if expected.casefold() not in label.casefold():
            raise ValueError(name + ": Gerätelabel stimmt nicht überein")
        if re.search(r"tor|garage|tür|tuer|door|latch|schloss", label, re.I):
            raise ValueError(name + ": Tür-/Torgerät darf nicht als Lichtaktor dienen")
        channels = device.get("functionalChannels") or {}
        info = channels.get(str(channel)) or channels.get(channel)
        if not isinstance(info, dict) or "SWITCH" not in str(info.get("functionalChannelType", "")).upper():
            raise ValueError(name + ": Kanal ist kein Schaltkanal")
        results.append((device_id, channel, label))
    return results


def set_hcu_switch(hcu_config, actor, on, module=None):
    module = module or hcu_module()
    device_id, channel, _ = validate_actor(actor, "aktor")
    msg = module.hcu_system_request(
        hcu_config,
        "/hmip/device/control/setSwitchState",
        {"deviceId": device_id, "channelIndex": channel, "on": bool(on)},
        timeout=12,
    )
    if (msg.get("body") or {}).get("code") != 200:
        raise RuntimeError("HCU Schaltbefehl nicht bestätigt")


def sonos_command(ip, command, timeout=4):
    """Local Sonos AVTransport, specific chosen IP only, no cloud permissions."""
    if command not in ("GetTransportInfo", "Play", "Pause"):
        raise ValueError("Invalid Sonos command")
    args = "<InstanceID>0</InstanceID>"
    if command == "Play":
        args += "<Speed>1</Speed>"
    body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
        '<s:Body><u:%s xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
        '%s</u:%s></s:Body></s:Envelope>' % (command, args, command)
    ).encode()
    request = urllib.request.Request(
        "http://%s:1400/MediaRenderer/AVTransport/Control" % ip,
        body,
        method="POST",
        headers={
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPACTION": '"urn:schemas-upnp-org:service:AVTransport:1#%s"' % command,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def sonos_state(ip):
    root = ET.fromstring(sonos_command(ip, "GetTransportInfo"))
    for el in root.iter():
        if el.tag.split("}")[-1] == "CurrentTransportState":
            return el.text or ""
    raise RuntimeError("Sonos status not received")


def apply_scene(config, active, state, *, hcu=None, sonos=None):
    """Only invoked on actual state transitions; never continuously force devices."""
    hcu = hcu or hcu_module()
    hcu_config = load_json(config["hcu_config"])
    if not isinstance(hcu_config, dict):
        raise ValueError("HCU-Konfiguration fehlt")
    verify_hcu_actors(hcu_config, config, hcu)
    seen = set()
    for name in ("stiegenhaus", "little_greene"):
        actor = config["actors"][name]
        key = (actor["device_id"], actor["channel_index"])
        if key not in seen:
            set_hcu_switch(hcu_config, actor, active, hcu)
            seen.add(key)
    ip = config["sonos"]["ip"]
    transport = sonos or sonos_state
    current = transport(ip)
    if active and current != "PLAYING":
        sonos_command(ip, "Play")
        state["sonos_started_by_scene"] = True
    elif not active and state.get("sonos_started_by_scene") and current == "PLAYING":
        sonos_command(ip, "Pause")
        state["sonos_started_by_scene"] = False
    return state


def tick(config, state, *, now=None, dry_run=True, presence_reader=local_gantner_status,
         scene_runner=apply_scene):
    now = time.time() if now is None else now
    people = people_present(presence_reader(config))
    new_state, transition = next_scene_state(
        state, people, now, config.get("away_grace_seconds", 120))
    if transition and not dry_run:
        validate_config(config)
        # Keep previous active state until all commands have succeeded.
        scene_runner(config, transition == "on", new_state)
    return new_state, transition, people


def main():
    parser = argparse.ArgumentParser(description="KRISTINE Büro-Anwesenheitsszene")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    config = load_json(args.config)
    if not isinstance(config, dict):
        raise SystemExit("Bitte zuerst config.json aus der Vorlage erstellen.")
    if args.watch and args.dry_run:
        raise SystemExit("--watch und --dry-run getrennt verwenden.")
    if args.watch:
        validate_config(config)
    while True:
        state = load_json(args.state, {}) or {}
        try:
            new_state, transition, people = tick(
                config, state, dry_run=(not args.watch))
            LOG.info("Anwesenheit %s; Aktion %s; %s",
                     {k: bool(v) for k, v in people.items()},
                     transition or "keine", "aktiv" if args.watch else "TEST, nichts geschaltet")
            if args.watch:
                save_json(args.state, new_state)
        except Exception as error:
            LOG.warning("Keine Schaltung; Quelle/Aktor prüfen: %s", type(error).__name__)
        if not args.watch:
            break
        time.sleep(config.get("poll_seconds", 8))


if __name__ == "__main__":
    main()
