# coding: utf-8
"""KRISTINE: explicit Alex kommt/geht from owner WhatsApp, via trusted local bridge.

This module has no time booking logic. Only existing, locally authenticated
GANTNER Alex arrival/departure rules are used. The WhatsApp command itself is
the user's deliberate confirmation; the NFC confirmation page remains intact.
"""
from __future__ import annotations
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen
import json
import logging
import re
import sys
import time

ROOT = Path(r"C:\Kristine\AccessBridge")
GANTNER_CFG = Path(r"C:\Kristine\Zutritt\config.json")
SCENE_PATH = Path(r"C:\Kristine\PresenceScenes")
LOG = logging.getLogger("kristine.alexscene")
VALID_ID = re.compile(r"alexscene_[0-9a-f]{24}")
NONCE = re.compile(r'name=["\']confirmation["\']\s+value=["\']([^"\']{20,100})["\']')
ACTIONS = {"arrive", "away"}


def get_url(url, timeout=8):
    with urlopen(url, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace"), response.geturl()


def post_form(url, values, timeout=10):
    payload = urlencode(values).encode("ascii")
    req = Request(url, data=payload,
                  headers={"Content-Type": "application/x-www-form-urlencoded"},
                  method="POST")
    with urlopen(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace"), response.geturl()


def read_gantner_status(cfg, getter=get_url):
    port=int(cfg.get("http_port") or 8788)
    if port != 8788:
        raise ValueError("Unerwarteter GANTNER-Port: keine Gebäudeschaltung")
    token=quote(str(cfg["admin_token"]), safe="")
    page, _ = getter(f"http://127.0.0.1:{port}/api/status/{token}")
    parsed=json.loads(page)
    if parsed.get("ok") is not True:
        raise RuntimeError("GANTNER-Status nicht bestätigt")
    doors=parsed.get("doors") or {}
    return {
        "alex":parsed.get("alex") is True,
        "bettina":parsed.get("bettina") is True,
        "dunja":parsed.get("dunja") is True,
        "doors":{str(n):str((doors.get(str(n)) or {}).get("mode") or "UNKNOWN")
                 for n in (1,2,3)},
    }


def light_arrival_if_safe(status, current=None):
    """Only existing verified Stiegenhaus HCU group; no garage or other lights.

    Weekend light control is left to the building system: its weekday scheduler
    will not automatically turn off a light switched on during the weekend.
    """
    current=current or datetime.now().astimezone()
    if current.weekday() >= 5:
        return "weekend_automatic_only"
    if not status.get("alex"):
        return "no_arrival"
    if not all(status.get("doors",{}).get(str(n))=="OPEN" for n in (1,2,3)):
        return "doors_not_fully_open"
    if str(SCENE_PATH) not in sys.path:
        sys.path.insert(0,str(SCENE_PATH))
    import office_presence_scene as scene
    config=scene.load_json(SCENE_PATH/"config.json")
    if not isinstance(config,dict) or config.get("enabled") is not True:
        return "scene_disabled"
    # set_stiegenhaus validates the exact linked-switching group and its
    # actuator BEFORE acting. It never controls a door.
    return "switched_on" if scene.set_stiegenhaus(config, True) else "already_on"


def execute(job, cfg, getter=get_url, form_post=post_form,
            status_reader=read_gantner_status, light_on=light_arrival_if_safe,
            current=None):
    current=current or datetime.now(timezone.utc)
    job_id=str(job.get("id") or "")
    action=str(job.get("action") or "")
    if not VALID_ID.fullmatch(job_id) or action not in ACTIONS:
        raise ValueError("Unzulässiger Szenenbefehl")
    try:
        deadline=datetime.fromisoformat(str(job.get("expiresAt") or "").replace("Z","+00:00"))
    except ValueError:
        raise ValueError("Ablaufzeit des Befehls fehlt") from None
    if deadline.tzinfo is None or current >= deadline:
        raise ValueError("WhatsApp-Befehl abgelaufen – keine Schaltung")
    if action=="arrive":
        token=quote(str(cfg["alex_arrive_token"]),safe="")
        dest=f"http://127.0.0.1:8788/alex/arrive/{token}"
        form, _=getter(dest)
        match=NONCE.search(unescape(form))
        if not match:
            raise RuntimeError("GANTNER-Ankunftsbestätigung fehlt – keine Schaltung")
        _, landed=form_post(dest, {"confirmation":match.group(1)})
        if urlparse(landed).path!="/alex/arrive/done":
            raise RuntimeError("GANTNER hat die Ankunft nicht bestätigt")
    else:
        token=quote(str(cfg["alex_away_token"]),safe="")
        page, landed=getter(f"http://127.0.0.1:8788/alex/away/{token}")
        if urlparse(landed).path!=f"/alex/away/{token}":
            raise RuntimeError("GANTNER-Abmeldung nicht bestätigt")
        if not page:
            raise RuntimeError("GANTNER-Abmeldung ohne Rückmeldung")
    status=status_reader(cfg,getter)
    door_modes=status["doors"]
    if action=="arrive":
        accepted=bool(status["alex"] and all(v=="OPEN" for v in door_modes.values()))
    else:
        accepted=not status["alex"]  # NORMAL or OPEN because Bettina/Dunja still present
    light="existing_automatic"
    if accepted and action=="arrive":
        try:
            light=light_on(status)
        except Exception as error:
            LOG.warning("Stiegenhauslicht: lokaler Sicherheitsstopp: %s",
                        type(error).__name__)
            light="failed_existing_automatic"
    if not accepted:
        message=("Ankunft nach Sicherheitszeit oder Türen nicht freigegeben"
                 if action=="arrive" else "Abmeldung nicht im Status bestätigt")
    else:
        message=("Türenstatus geprüft; Licht über vorhandene Automatik"
                 if action=="arrive" else "Alex abgemeldet; Licht mit Anwesenheits-Nachlauf")
    return {"id":job_id,"ok":accepted,"detail":message,"doors":door_modes,
            "alex":status["alex"],"bettina":status["bettina"],
            "dunja":status["dunja"],"light":light}


def run_loop(remote_json, cfg_reader, period_seconds=5):
    """Poll authenticated Cloud queue. Claimed jobs are never auto-retried."""
    ROOT.mkdir(parents=True,exist_ok=True)
    journal=ROOT/"alex_scene_execution.jsonl"
    heartbeat=ROOT/"alex_scene_worker_status.json"
    LOG.info("KRISTINE Alex-WhatsApp-Szenenworker gestartet (ohne Zeiterfassung)")
    while True:
        try:
            response=remote_json("/kristine/api/alex-scene/next",timeout=12)
            heartbeat.write_text(json.dumps({"version":"alex-wa-v1",
                "lastPollAt":datetime.now(timezone.utc).isoformat()}),encoding="utf-8")
            job=response.get("job")
            if job:
                result=None
                try:
                    result=execute(job,cfg_reader())
                except Exception as error:
                    result={"id":str(job.get("id") or ""),"ok":False,
                        "detail":"Keine sichere Bestätigung: "+str(error)[:180]}
                # Keep local evidence before acknowledging the result.
                with journal.open("a",encoding="utf-8") as fh:
                    fh.write(json.dumps({"at":datetime.now(timezone.utc).isoformat(),
                        "action":job.get("action"),**result},ensure_ascii=False)+"\n")
                try:
                    remote_json("/kristine/api/alex-scene/ack",method="POST",
                                payload=result,timeout=20)
                except Exception as error:
                    LOG.error("Cloud-Quittung unklar; NICHT erneut schalten: %s",
                              type(error).__name__)
        except Exception as error:
            LOG.warning("Cloud-Szenenabruf: %s", type(error).__name__)
        time.sleep(period_seconds)
