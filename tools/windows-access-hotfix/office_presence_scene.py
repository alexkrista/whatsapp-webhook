"""KRISTINE Büro-Anwesenheit -> EINE Homematic-IP-Gruppe 'Stiegenhaus'.

Wenn Alex ODER Bettina ODER Dunja anwesend sind, wird ausschließlich
die bestehende Stiegenhaus-Gruppe geschaltet. Licht/Little Greene/Musik
laufen wie bisher durch die bereits eingerichtete Homematic-Automatik.
Dieser Dienst greift niemals in die GANTNER-Türsteuerung ein.

Sicherheit: Standardmäßig disabled, exakte Gruppen- und Aktorprüfung vor
jedem Schalten, keine Umschaltung bei unvollständiger Anwesenheit.
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
from pathlib import Path
from logging.handlers import RotatingFileHandler

PEOPLE = ("alex", "bettina", "dunja")
LOG = logging.getLogger("kristine.stiegenhaus")
HCU_SCRIPT_DIR = Path(r"C:\Kristine\HomematicNFC")
DEFAULT_CONFIG = Path(r"C:\Kristine\PresenceScenes\config.json")
DEFAULT_STATE = Path(r"C:\Kristine\PresenceScenes\state.json")
UUID_PATTERN = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", re.I)
DEVICE_PATTERN = re.compile(r"[a-f0-9]{24}", re.I)


def people_present(status):
    """Missing or non-boolean presence is unknown, not 'away'."""
    if not isinstance(status, dict) or any(type(status.get(name)) is not bool for name in PEOPLE):
        raise ValueError("GANTNER-Anwesenheit unvollständig; keine Schaltung")
    return {name: status[name] for name in PEOPLE}


def next_scene_state(state, people, now, away_grace=120):
    """Calculate a desired transition; this function never switches devices."""
    if not isinstance(people, dict) or any(type(people.get(name)) is not bool for name in PEOPLE):
        raise ValueError("Unvollständige Anwesenheit")
    if not isinstance(now, (int, float)) or away_grace < 0:
        raise ValueError("Ungültige Zeitvorgabe")
    result = dict(state)
    was_active = bool(result.get("active", False))
    if any(people.values()):
        result["away_since"] = None
        desired = True
    else:
        since = result.get("away_since")
        if not isinstance(since, (int, float)) or since > now:
            since = now
        result["away_since"] = since
        desired = False if now - since >= away_grace else was_active
    result["last_people"] = dict(people)
    if desired != was_active:
        result["active"] = desired
        result["changed_at"] = now
        return result, ("on" if desired else "off")
    return result, None


def load_json(file, fallback=None):
    path = Path(file)
    if not path.is_file():
        return fallback
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def save_json(file, value):
    path = Path(file)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with temp.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    os.replace(temp, path)


def local_gantner_status(config):
    """Read ONLY: local GANTNER service status. Never write door state."""
    settings = load_json(config["access_config"])
    if not isinstance(settings, dict) or not settings.get("admin_token"):
        raise ValueError("GANTNER-Zugang nicht eingerichtet")
    port = int(settings.get("http_port", 8788))
    if not 1 <= port <= 65535:
        raise ValueError("Ungültiger lokaler GANTNER-Port")
    # Credentials never enter logs or remote GitHub.
    endpoint = "http://127.0.0.1:%d/api/status/%s" % (
        port, settings["admin_token"]
    )
    with urllib.request.urlopen(endpoint, timeout=5) as response:
        return json.load(response)


def validate_config(config):
    if not isinstance(config, dict) or config.get("enabled") is not True:
        raise ValueError("Stiegenhaus-Automatik ist deaktiviert")
    group = config.get("stiegenhaus") or {}
    group_id = str(group.get("group_id", "")).strip()
    group_label = str(group.get("expected_label", "")).strip()
    actuator_id = str(group.get("expected_actuator_id", "")).strip()
    actuator_label = str(group.get("expected_actuator_label", "")).strip()
    if not UUID_PATTERN.fullmatch(group_id):
        raise ValueError("Eindeutige Stiegenhaus-Gruppen-ID fehlt")
    if group_label.casefold() != "stiegenhaus":
        raise ValueError("Stiegenhaus-Gruppenbezeichnung stimmt nicht")
    if not DEVICE_PATTERN.fullmatch(actuator_id) or not actuator_label:
        raise ValueError("Zu Stiegenhaus gehörender Schaltaktor nicht bestätigt")
    if not 5 <= config.get("poll_seconds", 8) <= 120:
        raise ValueError("Abfrageintervall ungültig")
    if not 30 <= config.get("away_grace_seconds", 120) <= 3600:
        raise ValueError("Nachlaufzeit ungültig")
    return True


def hcu_module():
    if str(HCU_SCRIPT_DIR) not in sys.path:
        sys.path.insert(0, str(HCU_SCRIPT_DIR))
    import hcu_nfc_gate
    return hcu_nfc_gate


def verify_stiegenhaus(config, hcu_config, module=None):
    """Read-only verification of the exact user-created switching group."""
    validate_config(config)
    module = module or hcu_module()
    state = module.hcu_get_system_state(hcu_config)
    groups = state.get("groups") or {}
    devices = state.get("devices") or {}
    spec = config["stiegenhaus"]
    group = groups.get(spec["group_id"])
    if not isinstance(group, dict):
        raise ValueError("Konfigurierte Stiegenhaus-Gruppe nicht an HCU gefunden")
    if str(group.get("label", "")).strip().casefold() != "stiegenhaus":
        raise ValueError("Gruppenbezeichnung hat sich geändert")
    if group.get("type") != "EXTENDED_LINKED_SWITCHING":
        raise ValueError("Gruppe ist kein freigegebener Stiegenhaus-Schalter")
    # Guard against the OTHER Stiegenhaus groups (ACCESS_CONTROL, META, SWITCHING).
    if group.get("metaGroupId"):
        raise ValueError("Unerwartete Untergruppe – schalten verweigert")
    if group.get("unreach") is True or group.get("configPending") is True:
        raise RuntimeError("Stiegenhaus-Gruppe derzeit nicht bereit")
    member = {
        "deviceId": spec["expected_actuator_id"],
        "channelIndex": int(spec.get("expected_channel_index", 1)),
    }
    if member not in (group.get("channels") or []):
        raise ValueError("Bestätigter Schaltaktor fehlt in der Gruppe")
    device = devices.get(member["deviceId"])
    if not isinstance(device, dict):
        raise ValueError("Verknüpfter Lichtaktor nicht gefunden")
    label = str(device.get("label", "")).strip()
    if label.casefold() != str(spec["expected_actuator_label"]).strip().casefold():
        raise ValueError("Aktorname stimmt nicht mit geprüfter Zuordnung")
    if re.search(r"tor|garage|tür|tuer|door|schloss|latch", label, flags=re.I):
        raise ValueError("Tür- oder Toraktor ist kein erlaubter Lichtaktor")
    channel = (device.get("functionalChannels") or {}).get(str(member["channelIndex"]), {})
    if "SWITCH" not in str(channel.get("functionalChannelType", "")).upper():
        raise ValueError("Verknüpfter Kanal ist kein Schaltkanal")
    if type(group.get("on")) is not bool:
        raise ValueError("Stiegenhaus-Schaltzustand ist unbekannt")
    return group


def set_stiegenhaus(config, enabled, *, module=None):
    """Exactly ONE group switch command. No direct Little Greene or Sonos calls."""
    module = module or hcu_module()
    hcu_config = load_json(config["hcu_config"])
    if not isinstance(hcu_config, dict):
        raise ValueError("HCU-Konfiguration fehlt")
    group = verify_stiegenhaus(config, hcu_config, module)
    if group["on"] is bool(enabled):
        LOG.info("Stiegenhaus bereits %s – kein weiterer Befehl",
                 "EIN" if enabled else "AUS")
        return False
    msg = module.hcu_system_request(
        hcu_config,
        "/hmip/group/switching/setState",
        {"groupId": config["stiegenhaus"]["group_id"], "on": bool(enabled)},
        timeout=12,
    )
    if (msg.get("body") or {}).get("code") != 200:
        raise RuntimeError("HCU hat den Stiegenhaus-Gruppenbefehl nicht bestätigt")
    return True


def tick(config, state, *, now=None, dry_run=True,
         presence_reader=local_gantner_status, group_setter=set_stiegenhaus):
    now = time.time() if now is None else now
    present = people_present(presence_reader(config))
    updated, transition = next_scene_state(
        state, present, now, config.get("away_grace_seconds", 120)
    )
    if transition and not dry_run:
        validate_config(config)
        # State is returned (and persisted by main) ONLY after switch success.
        group_setter(config, transition == "on")
    return updated, transition, present


def main():
    parser = argparse.ArgumentParser(description="KRISTINE Stiegenhaus Anwesenheitsautomatik")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--watch", action="store_true",
                        help="Echte Automatik mit Schaltbefehlen")
    parser.add_argument("--dry-run", action="store_true",
                        help="Einmaliger Lese-/Simulationstest ohne Schaltbefehle")
    args = parser.parse_args()
    log_path = Path(args.config).with_name("presence_scene.log")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(),
                  RotatingFileHandler(log_path, maxBytes=2_000_000,
                                      backupCount=4, encoding="utf-8")])
    config = load_json(args.config)
    if not isinstance(config, dict):
        raise SystemExit("Konfiguration fehlt; Vorlage erstellen")
    if args.watch:
        validate_config(config)  # Fail before any loop/actuator call.
    while True:
        state = load_json(args.state, {}) or {}
        try:
            updated, transition, present = tick(
                config, state, dry_run=not args.watch
            )
            LOG.info("%s; Anwesenheit=%s; Aktion=%s",
                     "AKTIV" if args.watch else "TEST OHNE SCHALTUNG",
                     {k: bool(v) for k, v in present.items()},
                     transition or "keine")
            if args.watch:
                save_json(args.state, updated)
        except Exception as error:
            LOG.warning("Sicherheitsstopp; keine Zustandsbestätigung: %s", error)
        if not args.watch:
            break
        time.sleep(config.get("poll_seconds", 8))


if __name__ == "__main__":
    main()
