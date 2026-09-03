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
        os.environ["KRISTINE_ADMIN_TOKEN"] = "test-admin-token"
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
            "ww_hours_fusion_source": lambda project_indices: [
                {"projectIndex": 1, "date": "2026-07-30", "maIndex": 11, "finkNumber": "101", "employeeName": "Max Muster", "netHours": 7.75},
                {"projectIndex": 1, "date": "2026-07-31", "maIndex": 11, "finkNumber": "101", "employeeName": "Max Muster", "netHours": 6.25},
            ],
            "kristine_api_request": lambda path, method="GET", payload=None: {
                "ok": True,
                "meta": {
                    "contactEmail": "fallback@example.at",
                    "projectContacts": {
                        "owner": {"womanEmail": "bauherrin@example.at", "manEmail": "bauherr@example.at"},
                        "siteManager": {"email": "bauleitung@example.at"},
                        "architect": {"email": "architekt@example.at"},
                        "deliveryRecipients": {"invoice": {"owner": True, "siteManager": True, "architect": False}},
                    },
                },
            },
        })
        cls.app = app
        cls.client = app.test_client()

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("KRISTINE_OUTGOING_DB", None)
        os.environ.pop("KRISTINE_OUTGOING_DIR", None)
        os.environ.pop("KRISTINE_ADMIN_TOKEN", None)
        cls.tmp.cleanup()

    def test_full_invoice_flow_creates_pdf(self):
        self.assertEqual(self.client.get("/outgoing/invoices").status_code, 200)
        self.assertEqual(self.client.get("/outgoing/open-items").status_code, 200)
        self.assertEqual(self.client.get("/api/outgoing/settings").status_code, 200)
        run_response = self.client.post("/api/outgoing/runs", json={
            "projectIndex": 1, "projectNumber": "26001", "customerIndex": 2, "label": "Auftrag A",
            "customerName": "Max Muster", "company": "Muster GmbH", "street": "Weg 1",
            "postalCode": "6820", "city": "Frastanz", "country": "Österreich",
        })
        self.assertEqual(run_response.status_code, 200, run_response.get_data(as_text=True))
        run_id = run_response.get_json()["run"]["id"]
        invoice_response = self.client.post("/api/outgoing/invoices", json={
            "runId": run_id, "kind": "TR", "issueDate": "2026-08-31", "dueDate": "2026-08-31",
            "serviceFrom": "2026-08-01", "serviceTo": "2026-08-31", "taxMode": "AT20",
            "recipientUid": "ATU12345678",
            "retentionPercent": 7, "discountPercent": 5, "cashDiscountPercent": 3,
            "cashDiscountUntil": "2026-09-05",
            "lines": [{"description": "Malerarbeiten", "quantity": 1, "unit": "PA", "unitPrice": 10000}],
        })
        self.assertEqual(invoice_response.status_code, 200, invoice_response.get_data(as_text=True))
        invoice_id = invoice_response.get_json()["invoice"]["id"]
        preview_image = self.client.get(f"/api/outgoing/invoices/{invoice_id}/preview.png")
        self.assertEqual(preview_image.status_code, 200)
        self.assertTrue(preview_image.data.startswith(b"\x89PNG\r\n\x1a\n"))
        preview_image.close()
        issue = self.client.post(f"/api/outgoing/invoices/{invoice_id}/issue", json={})
        self.assertEqual(issue.status_code, 200, issue.get_data(as_text=True))
        self.assertEqual(issue.get_json()["invoice"]["invoice_number"], "202608001")
        source_pdf = self.client.get(f"/api/outgoing/invoices/{invoice_id}/source-pdf")
        self.assertEqual(source_pdf.status_code, 200)
        self.assertTrue(source_pdf.data.startswith(b"%PDF"))
        source_pdf.close()
        pdf = self.client.get(f"/api/outgoing/invoices/{invoice_id}/pdf")
        self.assertEqual(pdf.status_code, 200)
        self.assertTrue(pdf.data.startswith(b"%PDF"))
        pdf.close()
        open_items = self.client.get("/api/outgoing/open-items").get_json()
        self.assertEqual(len(open_items["items"]), 1)
        self.assertEqual(open_items["items"][0]["openGross"], 10602.0)
        dunning = self.client.post(f"/api/outgoing/invoices/{invoice_id}/dunnings", json={
            "dunningDate": "2026-09-01",
        })
        self.assertEqual(dunning.status_code, 200, dunning.get_data(as_text=True))
        self.assertEqual(dunning.get_json()["dunning"]["level"], 1)
        dunning_pdf = self.client.get(dunning.get_json()["pdfUrl"])
        self.assertEqual(dunning_pdf.status_code, 200)
        self.assertTrue(dunning_pdf.data.startswith(b"%PDF"))
        dunning_pdf.close()
        meta = self.client.put(f"/api/outgoing/invoices/{invoice_id}/debtor-meta", json={
            "note": "Kunde hat Rückruf zugesagt.", "dunningBlocked": True,
        })
        self.assertEqual(meta.status_code, 200, meta.get_data(as_text=True))
        self.assertTrue(meta.get_json()["item"]["dunningBlocked"])
        payment = self.client.post(f"/api/outgoing/runs/{run_id}/payments", json={
            "invoiceId": invoice_id, "paymentDate": "2026-09-01", "gross": 1000, "reference": "Bank",
        })
        self.assertEqual(payment.status_code, 200, payment.get_data(as_text=True))
        open_items = self.client.get("/api/outgoing/open-items").get_json()
        self.assertEqual(open_items["items"][0]["openGross"], 9602.0)
        billing = self.client.post(
            "/api/outgoing/project-billing",
            json={"projectNumber": "26001"},
            headers={
                "Origin": "https://protokoll.krista.at",
                "X-Krista-Token": "test-admin-token",
            },
        )
        self.assertEqual(billing.status_code, 200, billing.get_data(as_text=True))
        payload = billing.get_json()["billing"]
        self.assertEqual(payload["summary"]["invoiceCount"], 1)
        self.assertEqual(payload["summary"]["billedNet"], 8835.0)
        self.assertEqual(payload["summary"]["paidGross"], 1000.0)
        self.assertEqual(payload["summary"]["openGross"], 9602.0)
        self.assertEqual(billing.headers["Access-Control-Allow-Origin"], "https://protokoll.krista.at")
        ww_hours = self.client.post(
            "/api/outgoing/project-hours",
            json={"projectNumber": "26001"},
            headers={
                "Origin": "https://protokoll.krista.at",
                "X-Krista-Token": "test-admin-token",
            },
        )
        self.assertEqual(ww_hours.status_code, 200, ww_hours.get_data(as_text=True))
        self.assertEqual(ww_hours.get_json()["hours"]["totalHours"], 14.0)
        self.assertEqual(len(ww_hours.get_json()["hours"]["days"]), 2)
        self.assertEqual(ww_hours.get_json()["hours"]["rows"][0]["employeeName"], "Max Muster")
        self.assertEqual(ww_hours.get_json()["hours"]["rows"][0]["finkNumber"], "101")

    def test_invoice_mail_recipients_come_from_selected_master_data(self):
        response = self.client.get("/api/outgoing/project-mail-recipients?projectNumber=26001")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()
        self.assertEqual(payload["to"], ["bauherrin@example.at", "bauherr@example.at"])
        self.assertEqual(payload["cc"], ["bauleitung@example.at"])


if __name__ == "__main__":
    unittest.main()
