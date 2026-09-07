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


class OfferOrderPositionTests(unittest.TestCase):
    def test_prices_discounts_and_alternatives_are_normalized(self):
        positions, order_number = brain_outgoing_invoices._offer_order_positions({"draft": {
            "offerNumber": "2608001",
            "financials": {"discountPercent": 5},
            "groupDiscounts": {"Stiegenhaus": 10},
            "positions": [
                {"text": "Wände beschichten", "quantity": 12.5, "unit": "m²", "unitPrice": 20,
                 "groupName": "Stiegenhaus"},
                {"text": "Alternative Ausführung", "quantity": 1, "unit": "PA", "unitPrice": 500,
                 "groupName": "Stiegenhaus", "isAlternative": True},
            ],
        }})
        self.assertEqual(order_number, "2608001")
        self.assertEqual(len(positions), 1)
        self.assertEqual(positions[0]["description"], "Wände beschichten")
        self.assertEqual(positions[0]["quantity"], 12.5)
        self.assertEqual(positions[0]["unit"], "m²")
        self.assertEqual(positions[0]["unitPrice"], 20)
        self.assertAlmostEqual(positions[0]["discountPercent"], 14.5)


@unittest.skipUnless(HAS_FLASK, "Flask ist in der gebündelten Test-Python-Laufzeit nicht installiert")
class OutgoingOrderPositionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["KRISTINE_OUTGOING_DB"] = str(root / "api.db")
        os.environ["KRISTINE_OUTGOING_DIR"] = str(root / "pdf")
        brain_outgoing_invoices._INSTALLED = False

        def kristine(path, method="GET", payload=None):
            if path == "/admin/api/employees":
                return {"employees": [], "currentBillingRate": 75}
            if path.startswith("/admin/api/materials"):
                return {"materials": []}
            if path == "/admin/api/job/26080/offer-draft":
                return {"draft": {
                    "offerNumber": "2608001",
                    "financials": {"discountPercent": 5},
                    "groupDiscounts": {"Stiegenhaus": 10},
                    "positions": [
                        {"text": "Wände beschichten", "quantity": 12.5, "unit": "m²", "unitPrice": 20,
                         "groupName": "Stiegenhaus"},
                        {"text": "Alternative Ausführung", "quantity": 1, "unit": "PA", "unitPrice": 500,
                         "groupName": "Stiegenhaus", "isAlternative": True},
                    ],
                }}
            return {}

        app = Flask(__name__)
        app.config["TESTING"] = True
        brain_outgoing_invoices.install({
            "app": app,
            "DB": root / "index.db",
            "kristine_api_request": kristine,
        })
        self.client = app.test_client()

    def tearDown(self):
        os.environ.pop("KRISTINE_OUTGOING_DB", None)
        os.environ.pop("KRISTINE_OUTGOING_DIR", None)
        self.tmp.cleanup()

    def test_order_positions_include_prices_discounts_and_skip_alternatives(self):
        response = self.client.get("/api/outgoing/line-catalog?project=26080")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()
        self.assertEqual(payload["orderNumber"], "2608001")
        self.assertEqual(len(payload["orderPositions"]), 1)
        position = payload["orderPositions"][0]
        self.assertEqual(position["description"], "Wände beschichten")
        self.assertEqual(position["quantity"], 12.5)
        self.assertEqual(position["unit"], "m²")
        self.assertEqual(position["unitPrice"], 20)
        self.assertAlmostEqual(position["discountPercent"], 14.5)


if __name__ == "__main__":
    unittest.main()
