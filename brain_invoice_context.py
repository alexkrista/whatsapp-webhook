"""Read-only invoice context: cumulative report values and internal fixed order value."""
import re
from datetime import date
from flask import request, jsonify


def install(app, store, cloud, find_project, read_reports, hours_source):
    @app.get("/api/outgoing/regie-billing-core.js")
    def regie_billing_core():
        from pathlib import Path
        return app.response_class((Path(__file__).parent / "public/ui/regie-billing-state.js").read_text(encoding="utf-8"), mimetype="application/javascript")

    @app.get("/api/outgoing/invoice-context")
    def invoice_context():
        try:
            run = store.run(int(request.args.get("run") or 0))
            number = str(run.get("project_number") or "")
            if not number.isdigit():
                raise ValueError("Dieser Rechnungslauf hat keine Baustelle.")
            if not callable(cloud):
                raise ValueError("Baustellenakte ist nicht erreichbar.")
            jobs = (cloud("/admin/api/jobs") or {}).get("jobs") or []
            job = next((j for j in jobs if str(j.get("jobId")) == number), None)
            if not job:
                raise ValueError("Baustelle in KRISTINE nicht gefunden.")
            payload = cloud(f"/admin/api/job/{number}/documentation") or {}
            if not isinstance(payload.get("items"), list):
                raise ValueError("Regieberichte konnten nicht vollständig geladen werden.")
            reports = [dict(r, projectNumber=number) for r in payload["items"] if r.get("type") == "regie_report"]
            project = find_project(number)
            if project:
                expected_index = int(run.get("project_index") or 0)
                if expected_index and expected_index != int(project.get("projectIndex") or 0):
                    raise ValueError("WinWorker-Projekt und Rechnungslauf stimmen nicht überein.")
                if not expected_index:
                    def words(v):
                        return set(re.findall(r"[a-zäöüß]{4,}", str(v or "").casefold()))
                    expected = words(run.get("project_title")) | words(run.get("customer_name")) | words(run.get("customer_company"))
                    actual = words(project.get("title")) | words(project.get("customerName")) | words(project.get("customer"))
                    if not expected.intersection(actual):
                        raise ValueError("WinWorker-Zuordnung bitte prüfen: Baustellennummer allein reicht nicht.")
                reports += [dict(r, type="regie_report") for r in read_reports(project)]
            calc = job.get("calculation") or {}
            fixed = calc.get("kristaAmount")
            return jsonify(ok=True, projectNumber=number, reports=reports, fixedOrderNet=fixed,
                           fixedOrderSource="Baustellenkalkulation · Fixauftrag ohne Regie", cumulative=True)
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400

    @app.get("/tower/month-worked-hours")
    def month_worked_hours():
        try:
            month = str(request.args.get("month") or "")
            if not re.fullmatch(r"20\d{2}-(0[1-9]|1[0-2])", month):
                raise ValueError("Ungültiger Monat.")
            start = date.fromisoformat(month + "-01")
            end = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
            if start > date.today():
                raise ValueError("Der Monat liegt in der Zukunft.")
            cutoff = min(end, date.today()).isoformat()
            jobs = (cloud("/admin/api/jobs") or {}).get("jobs") or []
            result = {}
            for job in jobs:
                number = str(job.get("jobId") or "")
                if not number.isdigit():
                    continue
                project = find_project(number)
                if not project:
                    continue
                grouped = {}
                for row in hours_source([int(project.get("projectIndex") or 0)]):
                    day = str(row.get("date") or "")[:10]
                    if start.isoformat() <= day < cutoff:
                        key = (day, str(row.get("finkNumber") or row.get("maIndex") or row.get("employeeName") or ""))
                        grouped[key] = grouped.get(key, 0) + float(row.get("netHours") or 0)
                total = sum(max(0, v) for v in grouped.values())
                if total > 0:
                    result[number] = round(total, 4)
            return jsonify(ok=True, month=month, hoursByProject=result, hoursThroughDate=cutoff)
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400
