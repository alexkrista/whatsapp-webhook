"""Manual, throttled GAT-610 reading with a durable local handoff.

This module NEVER polls the hardware on its own and NEVER changes GAT door modes.
Only an explicit, cloud-queued 'bookings-read' job triggers the injected reader.
"""
from contextlib import contextmanager
import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path

BATCH_SIZE = 3  # Local GAT API currently allows at most three records per call.
BATCHES_PER_TERMINAL = 8  # At most 24 records per terminal per manual click.


class ManualChipBookings:
    def __init__(self, database_path, read_fn, post_fn, log, pause_fn=time.sleep):
        self.path = Path(database_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.reader = read_fn
        self.post = post_fn
        self.log = log
        self.pause = pause_fn
        self.lock = threading.RLock()
        with self.db() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS events ("
                "id INTEGER PRIMARY KEY, event_key TEXT UNIQUE NOT NULL,"
                "payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS jobs ("
                "id TEXT PRIMARY KEY, state TEXT NOT NULL, result TEXT NOT NULL)"
            )

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=15)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def event_key(item):
        required = ["hardwareId", "terminalId", "at"]
        if not all(str(item.get(k) or "").strip() for k in required):
            raise ValueError("GAT-Buchung ohne vollständige Chip-ID, Leser und Zeit")
        keys = [str(item.get(k) or "") for k in (*required, "code")]
        return hashlib.sha256(json.dumps(keys, separators=(",", ":")).encode()).hexdigest()

    def save_event(self, item):
        key = self.event_key(item)
        with self.lock, self.db() as connection:
            result = connection.execute(
                "INSERT OR IGNORE INTO events(event_key,payload,sent) VALUES(?,?,0)",
                (key, json.dumps(item, ensure_ascii=False, separators=(",", ":"))),
            )
        return bool(result.rowcount)

    def pending(self):
        with self.lock, self.db() as connection:
            return connection.execute(
                "SELECT id,payload FROM events WHERE sent=0 ORDER BY id LIMIT 250"
            ).fetchall()

    def pending_count(self):
        with self.lock, self.db() as connection:
            return connection.execute("SELECT COUNT(*) FROM events WHERE sent=0").fetchone()[0]

    def flush(self):
        """Retry only disk-backed uploads; never ask GAT for a new record."""
        transferred = 0
        for row_id, encoded in self.pending():
            self.post("/admin/api/access/chip-read", json.loads(encoded))
            with self.lock, self.db() as connection:
                connection.execute("UPDATE events SET sent=1 WHERE id=?", (row_id,))
            transferred += 1
        return transferred

    def _job(self, job_id):
        with self.lock, self.db() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO jobs(id,state,result) VALUES(?,?,?)",
                (job_id, "reading", "{}"),
            )
            return connection.execute("SELECT state,result FROM jobs WHERE id=?", (job_id,)).fetchone()

    def _finish(self, job_id, state, result):
        with self.lock, self.db() as connection:
            connection.execute(
                "UPDATE jobs SET state=?,result=? WHERE id=?",
                (state, json.dumps(result, ensure_ascii=False), job_id),
            )

    def read_manual(self):
        """Read a bounded batch from each terminal; persist each batch before continuing."""
        result = {"count": 0, "stored": 0, "byTerminal": {}, "limitedTerminals": []}
        for terminal_id in (1, 2, 3):
            total = 0
            for batch_index in range(BATCHES_PER_TERMINAL):
                response = self.reader(terminal_id, BATCH_SIZE)
                rows = response.get("bookings") if isinstance(response, dict) else None
                if not isinstance(rows, list) or len(rows) > BATCH_SIZE:
                    raise RuntimeError(f"GAT-Leser {terminal_id}: unplausible Antwort")
                for item in rows:
                    if self.save_event(item):
                        result["stored"] += 1
                total += len(rows)
                result["count"] += len(rows)
                result["byTerminal"][str(terminal_id)] = total
                if len(rows) < BATCH_SIZE:
                    break
                if batch_index + 1 == BATCHES_PER_TERMINAL:
                    result["limitedTerminals"].append(str(terminal_id))
                else:
                    self.pause(0.4)
        return result

    def handle(self, job):
        """Never re-read GAT if a queued cloud job is retried after upload/ACK failure."""
        job_id = str((job or {}).get("id") or "")
        if (job or {}).get("type") != "bookings-read" or not job_id.startswith("read_"):
            raise ValueError("Kein manueller GAT-Leseauftrag")
        state, serialized = self._job(job_id)
        result = json.loads(serialized)
        if state == "reading":
            # An interrupted job is not automatically replayed: #610 consumes entries.
            result = {"count": 0, "stored": 0, "limitedTerminals": [],
                      "error": "Leselauf unterbrochen. Lokal gesicherte Buchungen werden übertragen; danach erneut auslesen."}
            self._finish(job_id, "error", result)
            state = "error"
        if state == "done" or state == "error":
            pass
        else:
            raise RuntimeError("Unbekannter manueller Lesezustand")
        return self._upload_and_ack(job_id, state, result)

    def execute(self, job):
        """The only entry point that calls the actual GAT reader."""
        job_id = str((job or {}).get("id") or "")
        if (job or {}).get("type") != "bookings-read" or not job_id.startswith("read_"):
            raise ValueError("Kein manueller GAT-Leseauftrag")
        with self.lock, self.db() as connection:
            found = connection.execute("SELECT state,result FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not found:
                connection.execute(
                    "INSERT INTO jobs(id,state,result) VALUES(?,?,?)", (job_id, "reading", "{}")
                )
        if found:
            return self.handle(job)
        # Hardware reading happens only here, and each returned batch is already
        # committed locally before the next batch begins.
        result = {"count": 0, "stored": 0, "limitedTerminals": []}
        try:
            result = self.read_manual()
            state = "done"
        except Exception as exc:
            state = "error"
            result = {"count": 0, "stored": 0, "limitedTerminals": [],
                      "error": f"Auslesen fehlgeschlagen: {exc}. Gesicherte Einträge werden übertragen. Danach erneut starten."}
            self.log.warning("GAT manuell: %s", exc)
        self._finish(job_id, state, result)
        return self._upload_and_ack(job_id, state, result)

    def _upload_and_ack(self, job_id, state, result):
        try:
            transferred = self.flush()
        except Exception as exc:
            self.log.warning("GAT-Lokalspeicher: Cloud noch nicht erreichbar, erneuter Versuch ohne GAT-Lesen: %s", exc)
            return {"state": "waiting", "pending": self.pending_count()}
        pending = self.pending_count()
        if pending:
            return {"state": "waiting", "pending": pending}
        outcome = dict(result, uploaded=transferred, pending=0)
        try:
            self.post("/admin/api/access/local-job/ack", {
                "id": job_id, "type": "bookings-read", "ok": state == "done",
                "result": outcome, "error": result.get("error"),
            })
        except Exception as exc:
            self.log.warning("GAT-Leseauftrag: Cloud-Bestaetigung ausstehend, sicher gespeichert: %s", exc)
            return {"state": "waiting", "pending": 0}
        return {"state": state, **outcome}
