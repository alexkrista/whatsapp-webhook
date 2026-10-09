import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from brain_issued_invoice_sync import sync_once, send_original


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, kind, value, tb):
        try:
            return super().__exit__(kind, value, tb)
        finally:
            self.close()


class Store:
    def __init__(self, root):
        self.db_path = root / "outgoing.db"
        self.output_root = root / "pdf"
        self.output_root.mkdir()
        con = sqlite3.connect(self.db_path)
        con.executescript("""
            CREATE TABLE outgoing_runs(id INTEGER PRIMARY KEY,project_number TEXT);
            CREATE TABLE outgoing_invoices(
              id INTEGER PRIMARY KEY,run_id INTEGER,invoice_number TEXT,kind TEXT,
              issue_date TEXT,status TEXT,source TEXT,pdf_path TEXT,pdf_sha256 TEXT
            );
            INSERT INTO outgoing_runs VALUES(30,'24138');
        """)
        con.close()
    def connect(self):
        con=sqlite3.connect(self.db_path,factory=ClosingConnection)
        con.row_factory=sqlite3.Row
        return con


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.store=Store(self.root)
        self.body=b"%PDF-1.4\nOriginal invoice for test only\n%%EOF"
        self.pdf=self.store.output_root / "202610003_SR.pdf"
        self.pdf.write_bytes(self.body)
        self.digest=hashlib.sha256(self.body).hexdigest()
        with self.store.connect() as con:
            con.execute("""INSERT INTO outgoing_invoices
              VALUES(95,30,'202610003','SR','2026-10-07','issued','KRISTINE',?,?)""",
              (str(self.pdf),self.digest))

    def test_once_then_skip_and_recheck_after_new_pdf(self):
        captured=[]
        class Reply:
            status=201
            def __enter__(self): return self
            def __exit__(self,*args): pass
        def deliver(request,timeout=20):
            captured.append(request)
            return Reply()
        x=sync_once(self.store,"https://protokoll.krista.at","fake-secret",post=deliver)
        self.assertEqual(x["synced"],1)
        self.assertEqual(x["pending"],0)
        self.assertEqual(captured[0].full_url,"https://protokoll.krista.at/admin/api/job/24138/documentation/issued-invoice")
        self.assertEqual(captured[0].data,self.body)
        self.assertEqual(captured[0].get_header("X-invoice-number"),"202610003")
        self.assertEqual(sync_once(self.store,"https://protokoll.krista.at","fake-secret",post=deliver)["synced"],0)
        self.assertEqual(len(captured),1)

    def test_failed_delivery_is_retried_without_marking_as_synced(self):
        errors=[]
        def failing(request,timeout=20):
            errors.append(request)
            raise OSError("network down")
        response=sync_once(self.store,"https://protokoll.krista.at","fake-secret",post=failing)
        self.assertEqual(response["status"],"partial")
        self.assertEqual(response["pending"],1)
        self.assertFalse((self.root/"invoice_project_sync_state.json").exists())
        class Reply:
            status=200
            def __enter__(self): return self
            def __exit__(self,*args): pass
        retried=sync_once(self.store,"https://protokoll.krista.at","fake-secret",post=lambda req,timeout=20: Reply())
        self.assertEqual(retried["synced"],1)
        self.assertTrue((self.root/"invoice_project_sync_state.json").exists())

    def test_denies_untrusted_destination(self):
        row={"project_number":"24138","invoice_number":"202610003","id":95,"kind":"SR","issue_date":"2026-10-07"}
        with self.assertRaises(ValueError):
            send_original("https://someone-else.example","fake-secret",row,self.body,self.digest,post=Mock())

    def test_missing_pdf_cannot_be_marked_successful(self):
        self.pdf.unlink()
        x=sync_once(self.store,"https://protokoll.krista.at","fake-secret",post=Mock())
        self.assertEqual(x["synced"],0)
        self.assertEqual(x["pending"],1)


if __name__=="__main__":
    unittest.main()
