# coding: utf-8
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path

from flask import Flask

import brain_finance_reconciliation
from brain_outgoing_store import OutgoingStore


class OutgoingCamtTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.capture_db = root / "capture.db"
        self.outgoing = OutgoingStore(root / "outgoing.db", root / "pdf")
        run = self.outgoing.create_run({
            "projectIndex": 1, "projectNumber": "26001", "customerIndex": 2,
            "label": "Auftrag", "customerName": "Max Muster", "company": "Muster GmbH",
            "street": "Weg 1", "postalCode": "6820", "city": "Frastanz",
        })
        draft = self.outgoing.save_draft({
            "runId": run["id"], "kind": "RE", "issueDate": "2026-08-01", "dueDate": "2026-08-15",
            "serviceFrom": "2026-08-01", "serviceTo": "2026-08-01", "taxMode": "AT20",
            "lines": [{"description": "Arbeiten", "quantity": 1, "unit": "PA", "unitPrice": 100}],
        })
        self.invoice = self.outgoing.prepare_issue(draft["id"])

        def capture_connection(path=None):
            con = sqlite3.connect(path or self.capture_db)
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA foreign_keys=ON")
            return con

        app = Flask(__name__)
        app.config["TESTING"] = True
        app.extensions["kristine_outgoing_store"] = self.outgoing
        brain_finance_reconciliation.install({
            "app": app,
            "MOBILE_PAGE": "<html><body></body></html>",
            "_capture_connection": capture_connection,
            "CAPTURE_DB": self.capture_db,
            "MOBILE_ALLOWED_PATHS": set(),
        })
        self.client = app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_exact_invoice_number_in_camt_books_customer_receipt(self):
        number = self.invoice["invoice_number"]
        xml = f"""<?xml version="1.0" encoding="UTF-8"?>
        <Document><Stmt><Id>STMT-1</Id><Acct><Id><IBAN>AT825800010499323013</IBAN></Id></Acct>
        <FrToDt><FrDt>2026-09-01</FrDt><ToDt>2026-09-01</ToDt></FrToDt>
        <Ntry><Amt Ccy="EUR">120.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-01</Dt></BookgDt>
        <NtryDtls><TxDtls><Refs><TxId>TX-1</TxId></Refs><AmtDtls><TxAmt><Amt Ccy="EUR">120.00</Amt></TxAmt></AmtDtls>
        <RltdPties><Dbtr><Nm>Muster GmbH</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Rechnung {number}</Ustrd></RmtInf>
        </TxDtls></NtryDtls></Ntry></Stmt></Document>""".encode("utf-8")

        response = self.client.post(
            "/incoming/reconciliation/import-camt",
            data={"file": (io.BytesIO(xml), "statement.xml")},
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.outgoing.debtor_open_items("2026-09-01"), [])
        with self.outgoing.connect() as con:
            payment = con.execute("SELECT source,gross,invoice_id FROM outgoing_payments").fetchone()
        self.assertEqual((payment["source"], payment["gross"], payment["invoice_id"]), ("CAMT", "120.00", self.invoice["id"]))


if __name__ == "__main__":
    unittest.main()
