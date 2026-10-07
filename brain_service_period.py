"""First/last actual working day, combining WW and Kristine project times."""
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def local_now():
    try:
        return datetime.now(ZoneInfo("Europe/Vienna"))
    except ZoneInfoNotFoundError:
        # Windows Brain uses the computer timezone when IANA data is unavailable.
        return datetime.now().astimezone()


def project_service_period(project_number, ww_rows, bootstrap, today=None):
    today = today or local_now().date().isoformat()
    days = set()
    def add(day):
        day = str(day or '')[:10]
        try:
            date.fromisoformat(day)
        except ValueError:
            return
        if day <= today:
            days.add(day)
    def minute(value):
        try:
            h, m = str(value).split(':')[:2]
            return int(h)*60+int(m) if 0 <= int(h) < 24 and 0 <= int(m) < 60 else None
        except (ValueError, TypeError):
            return None
    for row in ww_rows or []:
        if float(row.get('netHours') or row.get('hours') or 0) > 0:
            add(row.get('date'))
    groups = {}
    for row in bootstrap.get('timeEvents', []):
        key = (str(row.get('employeeId') or ''), str(row.get('date') or '')[:10])
        if key[0] and minute(row.get('at')) is not None:
            groups.setdefault(key, []).append(row)
    live_keys = {key for key, rows in groups.items() if any(r.get('jobId') and not r.get('detachedFromProject') for r in rows)}
    for row in bootstrap.get('projectTimeArchive', []):
        key = (str(row.get('employeeId') or ''), str(row.get('date') or '')[:10])
        if key in live_keys:
            continue
        for seg in row.get('segments', []):
            start, end = minute(seg.get('from')), minute(seg.get('to'))
            if seg.get('type') == 'work' and str(seg.get('jobId')) == str(project_number) and start is not None and end is not None and 0 < end-start <= 18*60:
                add(key[1])
    for key, rows in groups.items():
        rows.sort(key=lambda r: (minute(r['at']), str(r.get('createdAt') or '')))
        for i, row in enumerate(rows):
            if row.get('detachedFromProject') or str(row.get('jobId')) != str(project_number) or row.get('type') not in ('start', 'weiter'):
                continue
            start = minute(row['at'])
            end = minute(rows[i+1]['at']) if i+1 < len(rows) else None
            if end is None and key[1] == today and bootstrap.get('states', {}).get(key[0], {}).get('mode') in ('working', 'pause', 'lunch'):
                now = local_now()
                end = now.hour*60+now.minute
            if end is not None and 0 < end-start <= 18*60:
                add(key[1])
    values = sorted(days)
    return {'serviceFrom': values[0] if values else '', 'serviceTo': values[-1] if values else '', 'workdays': len(values)}
