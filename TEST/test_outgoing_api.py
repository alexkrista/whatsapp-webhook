# coding: utf-8
import os
import tempfile
import unittest
from pathlib import Path

try:
    from flask import Flask
    HAS_FLASK = True
except ImportError:
    Flask = None
    HAS_FLASK = False

import brain_outgoing_invoices


@unittest.skipUnless(HAS_FLASK, "Flask ist in der gebündelten Test-Python-Laufzeit nicht installiert")
class OutgoingApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        os.environ["KRISTINE_OUTGOING_DB"] = str(root / "api.db")
        os.environ["KRISTINE_OUTGOING_DIR"] = str(root / "pdf")
        brain_outgoing_invoices._INSTALLED = False
        app = Flask(__name__)
        app.config["TESTING"] = True
        brain_outgoing_invoices.install({
            "app": app,
            "DB": root / "index.db",
            "_terms": lambda q: q.split(),
            "search_projects": lambda terms, include_metrics=False, limit=40: [{
                "projectIndex": 1, "projectNumber": "26001", "customerIndex": 2,
                "company": "Muster GmbH", "customer": "Max Muster", "street": "Weg 1",
                "postalCode": "6820", "city": "Frastanz", "address": "Weg 1 6820 Frastanz",
                "title": "Musterprojekt",
            }],
        })
        cls.app = app
        cls.client = app.test_client()

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("KRISTINE_OUTGOING_DB", None)
        os.environ.pop("KRISTINE_OUTGOING_DIR", None)
        cls.tmp.cleanup()

    def test_full_invoice_flow_creates_pdf(self):
        self.assertEqual(self.client.get("/outgoing/invoices").status_code, 200)
        self.assertEqual(self.client.get("/api/outgoing/settings").status_code, 200)
        run_response = self.client.post("/api/outgoing/runs", json={
            "projectIndex": 1, "projectNumber": "26001", "customerIndex": 2, "label": "Auftrag A",
            "customerName": "Max Muster", "company": "Muster GmbH", "street": "Weg 1",
            "postalCode": "6820", "city": "Frastanz", "country": "Österreich",
        })
        self.assertEqual(run_response.status_code, 200, run_response.get_data(as_text=True))
        run_id = run_response.get_json()["run"]["id"]
        invoice_response = self.client.post("/api/outgoing/invoices", json={
            "runId": run_id, "kind": "TR", "issueDate": "2026-08-31", "dueDate": "2026-09-20",
            "serviceFrom": "2026-08-01", "serviceTo": "2026-08-31", "taxMode": "AT20",
            "recipientUid": "ATU12345678",
            "retentionPercent": 7, "discountPercent": 5, "cashDiscountPercent": 3,
            "cashDiscountUntil": "2026-09-05",
            "lines": [{"description": "Malerarbeiten", "quantity": 1, "unit": "PA", "unitPrice": 10000}],
        })
        self.assertEqual(invoice_response.status_code, 200, invoice_response.get_data(as_text=True))
        invoice_id = invoice_response.get_json()["invoice"]["id"]
        issue = self.client.post(f"/api/outgoing/invoices/{invoice_id}/issue", json={})
        self.assertEqual(issue.status_code, 200, issue.get_data(as_text=True))
        self.assertEqual(issue.get_json()["invoice"]["invoice_number"], "2608001")
        pdf = self.client.get(f"/api/outgoing/invoices/{invoice_id}/pdf")
        self.assertEqual(pdf.status_code, 200)
        self.assertTrue(pdf.data.startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
