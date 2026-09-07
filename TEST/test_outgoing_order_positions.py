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
    def test_position_text_normalizes_german_quantity_and_area_unit(self):
        self.assertEqual(brain_outgoing_invoices._position_quantity_unit("320,00 m² Gerüst"), (320.0, "m²"))
        self.assertEqual(brain_outgoing_invoices._position_quantity_unit("12.5 m2 Wand"), (12.5, "m²"))

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

    def test_winworker_order_positions_use_v2_quantity_and_skip_regie(self):
        positions, order_number = brain_outgoing_invoices._winworker_order_positions(
            {"calculation": {
                "orderNo": "AB-26080",
                "positions": [
                    {"number": "1.1", "shortText": "12,50 m² Wände beschichten", "amount": 250,
                     "kind": "auftrag"},
                    {"number": "2.1", "shortText": "Regiearbeiten", "amount": 500,
                     "kind": "regie"},
                    {"number": "3.1", "shortText": "Zusatz Sockel", "amount": 75,
                     "kind": "nachtrag_auftrag"},
                ],
            }},
            {"rows": [
                {"quantity": 12.5, "unit": "m", "unitPrice": 20, "calcIncluded": True},
                {"quantity": 5, "unit": "Std", "unitPrice": 75, "calcIncluded": True},
                {"quantity": 0, "unit": "", "unitPrice": 0, "calcIncluded": True},
            ]},
        )
        self.assertEqual(order_number, "AB-26080")
        self.assertEqual([row["description"] for row in positions], ["12,50 m² Wände beschichten", "Zusatz Sockel"])
        self.assertEqual(positions[0]["quantity"], 12.5)
        self.assertEqual(positions[0]["unit"], "m²")
        self.assertEqual(positions[0]["unitPrice"], 20)
        self.assertEqual(positions[1]["quantity"], 1)
        self.assertEqual(positions[1]["unit"], "PA")
        self.assertEqual(positions[1]["unitPrice"], 75)
        self.assertEqual(positions[1]["groupName"], "Nachtrag Auftrag")


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
