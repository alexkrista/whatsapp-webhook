# coding: utf-8
"""Persisted Tower billing inputs, rebuilt nightly or on explicit request.

The browser deliberately reads this snapshot instead of querying WinWorker for
every Tower visit. The stored inputs come from the same helpers used by the
Baustelle billing view and stop before the current day.
"""
from __future__ import annotations

import copy
import json
import os
import threading
from datetime import datetime, timedelta
from pathlib import Path


_INSTALLED = False
_SCHEDULER_STARTED = False
_REBUILD_LOCK = threading.Lock()
_STATE_LOCK = threading.Lock()
_REBUILDING = False
_LAST_ERROR = ""

ACTIVE_BILLING_STATUSES = {"Auftrag", "Laufend", "Fertig – nicht abgerechnet"}


def _project_number(value):
    number = str(value or "").strip()
    return number if number.isdigit() and len(number) <= 12 else ""


def _selected_jobs(payload):
    payload = payload if isinstance(payload, dict) else {}
    closed_members = {
        str(job_id)
        for collection in payload.get("collections") or []
        if str((collection or {}).get("status") or "") == "Geschlossen"
        for job_id in ((collection or {}).get("collectionMemberJobIds") or [])
    }
    selected = {}
    for raw in payload.get("jobs") or []:
        job = raw if isinstance(raw, dict) else {}
        number = _project_number(job.get("jobId"))
        if (
            number
            and number not in closed_members
            and str(job.get("status") or "") in ACTIVE_BILLING_STATUSES
        ):
            selected[number] = copy.deepcopy(job)
    return selected


def _read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def _write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _snapshot_response(path):
    value = _read_json(path)
    with _STATE_LOCK:
        rebuilding = _REBUILDING
        last_error = _LAST_ERROR
    if not value:
        return {
            "ok": True,
            "ready": False,
            "rebuilding": rebuilding,
            "error": last_error,
            "generatedAt": "",
            "hoursThroughDate": "",
            "billingByProject": {},
            "reportsByProject": {},
            "jobsByProject": {},
        }
    return {"ok": True, "ready": True, "rebuilding": rebuilding, "lastError": last_error, **value}


def build_snapshot(ns, *, now=None, sync_invoices=True):
    now = now or datetime.now()
    cutoff_exclusive = now.date().isoformat()
    through_date = (now.date() - timedelta(days=1)).isoformat()
    kristine_api_request = ns.get("kristine_api_request")
    project_by_number = ns.get("kristine_outgoing_project_by_number")
    project_hours = ns.get("kristine_project_recorded_hours_net")
    project_reports = ns.get("kristine_project_regie_reports")
    sync_open_items = ns.get("kristine_sync_outgoing_ww")
    sync_project_history = ns.get("kristine_sync_outgoing_project_history")
    app = ns.get("app")

    if not callable(kristine_api_request):
        raise RuntimeError("KRISTINE-Baustellen sind nicht erreichbar.")
    if not callable(project_by_number) or not callable(project_hours) or not callable(project_reports):
        raise RuntimeError("WinWorker-Abrechnungsquellen sind nicht bereit.")
    store = getattr(app, "extensions", {}).get("kristine_outgoing_store") if app is not None else None
    if store is None or not hasattr(store, "billing_documents_by_project_numbers"):
        raise RuntimeError("Rechnungsdatenbank ist nicht bereit.")

    if sync_invoices and callable(sync_open_items):
        sync_open_items()

    jobs_by_project = _selected_jobs(kristine_api_request("/admin/api/jobs") or {})
    project_numbers = sorted(jobs_by_project, key=lambda value: int(value))
    projects = {}
    for number in project_numbers:
        project = project_by_number(number)
        projects[number] = project
        if project and sync_invoices and callable(sync_project_history):
            sync_project_history(project)

    billing_by_project = store.billing_documents_by_project_numbers(project_numbers)
    reports_by_project = {}
    for number in project_numbers:
        project = projects.get(number)
        billing = copy.deepcopy(billing_by_project.get(number) or {
            "found": bool(project),
            "projectNumber": number,
            "projectIndex": int((project or {}).get("projectIndex") or 0),
            "summary": {"invoiceCount": 0, "billedNet": 0},
            "invoices": [],
            "payments": [],
            "runs": [],
        })
        summary = billing.get("summary") if isinstance(billing.get("summary"), dict) else {}
        summary["recordedHoursNet"] = project_hours(
            number, before_date=cutoff_exclusive, project=project
        )
        billing["summary"] = summary
        billing_by_project[number] = billing

        reports = project_reports(project) if project else []
        reports_by_project[number] = [
            report for report in reports
            if not str((report or {}).get("reportDate") or "")[:10]
            or str((report or {}).get("reportDate") or "")[:10] < cutoff_exclusive
        ]

    return {
        "schemaVersion": 1,
        "generatedAt": now.isoformat(timespec="seconds"),
        "hoursThroughDate": through_date,
        "cutoffExclusive": cutoff_exclusive,
        "projectCount": len(project_numbers),
        "billingByProject": billing_by_project,
        "reportsByProject": reports_by_project,
        "jobsByProject": jobs_by_project,
    }


def install(ns):
    global _INSTALLED, _SCHEDULER_STARTED
    app = ns.get("app")
    if app is None or _INSTALLED or getattr(app, "_krista_tower_billing_snapshot", False):
        return

    from flask import jsonify, request

    base_db = Path(ns.get("DB") or r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db")
    snapshot_path = Path(os.environ.get(
        "KRISTINE_TOWER_BILLING_SNAPSHOT",
        str(base_db.parent / "tower_billing_snapshot.json"),
    ))

    def rebuild(*, sync_invoices=True):
        global _REBUILDING, _LAST_ERROR
        if not _REBUILD_LOCK.acquire(blocking=False):
            raise RuntimeError("Die Tower-Berechnung läuft bereits.")
        with _STATE_LOCK:
            _REBUILDING = True
            _LAST_ERROR = ""
        try:
            value = build_snapshot(ns, sync_invoices=sync_invoices)
            _write_json(snapshot_path, value)
            return value
        except Exception as exc:
            with _STATE_LOCK:
                _LAST_ERROR = str(exc)
            raise
        finally:
            with _STATE_LOCK:
                _REBUILDING = False
            _REBUILD_LOCK.release()

    @app.route("/tower/billing-snapshot", methods=["GET", "POST", "OPTIONS"])
    def tower_billing_snapshot_api():
        if request.method == "OPTIONS":
            return jsonify({"ok": True})
        if request.method == "GET":
            return jsonify(_snapshot_response(snapshot_path))
        try:
            value = rebuild(sync_invoices=True)
            return jsonify({"ok": True, "ready": True, "rebuilding": False, **value})
        except RuntimeError as exc:
            status = 409 if "bereits" in str(exc) else 500
            return jsonify({"ok": False, "error": str(exc), "rebuilding": status == 409}), status
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500

    ns["tower_billing_snapshot_rebuild"] = rebuild
    ns["tower_billing_snapshot_path"] = snapshot_path

    if not _SCHEDULER_STARTED:
        _SCHEDULER_STARTED = True

        def nightly_snapshot():
            if not _read_json(snapshot_path):
                threading.Event().wait(5)
                try:
                    rebuild(sync_invoices=True)
                    print("KRISTINE Tower billing snapshot: initial calculation complete")
                except Exception as exc:
                    print(f"KRISTINE Tower billing snapshot initial calculation failed: {exc}")
            while True:
                current = datetime.now()
                target = current.replace(hour=2, minute=30, second=0, microsecond=0)
                if target <= current:
                    target += timedelta(days=1)
                threading.Event().wait(max(60, (target - current).total_seconds()))
                try:
                    value = rebuild(sync_invoices=True)
                    print(f"KRISTINE Tower billing snapshot: {value['projectCount']} projects through {value['hoursThroughDate']}")
                except Exception as exc:
                    print(f"KRISTINE Tower billing snapshot failed: {exc}")

        threading.Thread(
            target=nightly_snapshot,
            name="kristine-tower-billing-snapshot",
            daemon=True,
        ).start()

    app._krista_tower_billing_snapshot = True
    _INSTALLED = True
    print("KRISTINE Tower billing snapshot: cached nightly at 02:30 + manual refresh")
