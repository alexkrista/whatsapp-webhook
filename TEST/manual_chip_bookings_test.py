# coding: utf-8
"""Offline regression tests. Never contacts Tibbo, GAT, KRISTINE or Render."""
import importlib.util
import json
import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "tools" / "windows-access-hotfix" / "manual_chip_bookings.py"
spec = importlib.util.spec_from_file_location("manual_chip_bookings", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManualBookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="manual_gat_test_")
        self.db = Path(self.tmp.name) / "bookings.sqlite3"
        self.reader_calls = []
        self.posted = []
        self.fail_upload = False
        self.read_batches = {}
        self.reader = lambda term, limit: self._reader(term, limit)
        self.post = lambda path, payload: self._post(path, payload)
        self.spool = module.ManualChipBookings(
            self.db, self.reader, self.post, logging.getLogger("manual-test"),
            pause_fn=lambda _: None,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def _reader(self, term, limit):
        self.reader_calls.append((term, limit))
        return {"bookings":self.read_batches.get(term,[]).pop(0) if self.read_batches.get(term) else []}

    def _post(self, path, payload):
        if self.fail_upload and path == "/admin/api/access/chip-read":
            raise ConnectionError("simulated cloud outage")
        self.posted.append((path, payload))
        return {"ok": True}

    @staticmethod
    def e(n, term=1):
        return {
            "hardwareId": f"{n:011d}", "terminalId": str(term), "code": "1",
            "at": f"2026-09-09T08:{n%60:02d}:{n%55:02d}",
        }

    def test_only_manual_read_with_durable_cloud_retry(self):
        self.read_batches = {1:[[self.e(1), self.e(2), self.e(3)], [self.e(4)]], 2:[], 3:[]}
        self.assertEqual(self.spool.pending_count(),0)
        self.assertEqual(self.reader_calls, [],"Constructor must not touch hardware")
        job = {"type":"bookings-read", "id":"read_manual_a"}
        self.fail_upload=True
        result=self.spool.execute(job)
        self.assertEqual(result["state"],"waiting")
        self.assertEqual(result["pending"],4)
        self.assertEqual(len(self.reader_calls),4)
        with sqlite3.connect(self.db) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM events").fetchone()[0],4)
            self.assertEqual(connection.execute("SELECT state FROM jobs").fetchone()[0],"done")
        self.fail_upload=False
        second=self.spool.execute(job)
        self.assertEqual(second["state"],"done")
        self.assertEqual(second["count"],4)
        self.assertEqual(self.spool.pending_count(),0)
        self.assertEqual(len(self.reader_calls),4,"Cloud retry must never read #610 twice")
        self.assertEqual(len([x for x in self.posted if x[0].endswith("/chip-read")]),4)
        self.assertEqual(self.posted[-1][0],"/admin/api/access/local-job/ack")

    def test_limit_and_repeat_explicit_new_job(self):
        self.read_batches={
            term:[[self.e(term*100+batch*3+k,term) for k in range(3)]
                  for batch in range(module.BATCHES_PER_TERMINAL)] + [[]]
            for term in (1,2,3)
        }
        first=self.spool.execute({"id":"read_one","type":"bookings-read"})
        self.assertEqual(first["count"],3*module.BATCHES_PER_TERMINAL*3)
        self.assertEqual(first["limitedTerminals"],["1","2","3"])
        self.assertEqual(first["pending"],0)
        before=len(self.reader_calls)
        self.spool.execute({"id":"read_one","type":"bookings-read"})
        self.assertEqual(before,len(self.reader_calls),"Identical job must not re-read")
        next_run=self.spool.execute({"id":"read_two","type":"bookings-read"})
        self.assertEqual(next_run["count"],0,"New manual click can drain remaining queue")

    def test_interrupted_job_must_not_auto_read(self):
        self.spool.save_event(self.e(10))
        with sqlite3.connect(self.db) as connection:
            connection.execute("INSERT INTO jobs(id,state,result) VALUES(?,?,?)",
                               ("read_interrupted","reading","{}"))
        result=self.spool.execute({"id":"read_interrupted","type":"bookings-read"})
        self.assertEqual(result["state"],"error")
        self.assertEqual(self.reader_calls,[])
        self.assertEqual(self.spool.pending_count(),0)
        self.assertTrue(self.posted[-1][1]["error"])

    def test_duplicate_hardware_events_are_idempotent(self):
        self.assertTrue(self.spool.save_event(self.e(2)))
        self.assertFalse(self.spool.save_event(self.e(2)))
        self.assertEqual(self.spool.pending_count(),1)


if __name__ == "__main__":
    unittest.main()
