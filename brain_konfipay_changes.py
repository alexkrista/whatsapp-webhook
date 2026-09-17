"""Persist when complete observed banking data last changed, not each poll."""
import hashlib
import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone

def remember(folder,accounts,transactions):
    if any(a.get('error') for a in accounts):return {'changeTracking':'incomplete'}
    canonical=lambda x:json.dumps(x,sort_keys=True,ensure_ascii=False,default=str,separators=(',',':'))
    payload={'accounts':sorted((canonical(a) for a in accounts)), 'transactions':sorted(canonical(t) for t in transactions)}
    digest=hashlib.sha256(canonical(payload).encode()).hexdigest()
    now=datetime.now(timezone.utc).isoformat()
    with closing(sqlite3.connect(str(folder/'change-state.sqlite'),timeout=15)) as db:
        db.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, digest TEXT, first_seen TEXT, changed TEXT)')
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('SELECT digest,first_seen,changed FROM state WHERE id=1').fetchone()
        if row is None:
            first=now;changed=None
            db.execute('INSERT INTO state VALUES (1,?,?,?)',(digest,first,changed))
        else:
            old,first,changed=row
            if old!=digest:
                changed=now
                db.execute('UPDATE state SET digest=?,changed=? WHERE id=1',(digest,changed))
        db.commit()
    return {'changeTracking':'ok','firstObservedAt':first,'lastChangedAt':changed}
