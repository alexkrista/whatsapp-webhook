import unittest

import brain_invoice_material_review as review


class InvoiceMaterialReviewTest(unittest.TestCase):
    def test_extracts_sku_quantity_unit_and_price(self):
        text = """
        Rechnung 4711
        1 00100874664 StoColor Opticryl Satinmatt 15 l 123,45 1.851,75
        Nettobetrag 1.851,75
        """
        rows = review.extract_material_lines(text)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sku"], "00100874664")
        self.assertEqual(rows[0]["quantity"], 15)
        self.assertEqual(rows[0]["unit"].lower(), "l")
        self.assertEqual(rows[0]["unitPrice"], 123.45)

    def test_compares_same_changed_and_new_only_with_supplier(self):
        supplier = {"addressId": "77", "name": "Muster GmbH"}
        materials = [
            {"materialId": "A01", "product": "Farbe Eins", "supplier": "Muster GmbH", "wwSupplierAddressId": "77", "supplierArticleNumber": "SKU-1", "purchasePrice": 10, "active": True},
            {"materialId": "A02", "product": "Farbe Zwei", "supplier": "Muster GmbH", "wwSupplierAddressId": "77", "supplierArticleNumber": "SKU-2", "purchasePrice": 20, "active": True},
            {"materialId": "F99", "product": "Fremd", "supplier": "Andere GmbH", "wwSupplierAddressId": "88", "supplierArticleNumber": "SKU-X", "purchasePrice": 5, "active": True},
        ]
        lines = [
            {"sku": "SKU-1", "description": "Farbe Eins", "quantity": 1, "unit": "Stk", "unitPrice": 10},
            {"sku": "SKU-2", "description": "Farbe Zwei", "quantity": 1, "unit": "Stk", "unitPrice": 22},
            {"sku": "SKU-X", "description": "Neues Material", "quantity": 1, "unit": "Stk", "unitPrice": 7},
        ]
        rows = review.compare_material_lines(lines, materials, supplier)
        self.assertEqual([row["status"] for row in rows], ["same", "changed", "new"])
        self.assertEqual(rows[0]["decision"], "confirm")
        self.assertEqual(rows[1]["difference"], 2)
        self.assertFalse(rows[2]["materialId"])

    def test_extracts_little_greene_invoice_line(self):
        rows = review.extract_material_lines(
            "00123456789 LG Absolute Matt Hi White 5L 2 74,80 149,60"
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sku"], "00123456789")
        self.assertEqual(rows[0]["quantity"], 2)
        self.assertEqual(rows[0]["containerSize"], 5)
        self.assertEqual(rows[0]["unit"].lower(), "l")
        self.assertEqual(rows[0]["unitPrice"], 74.8)

    def test_applies_only_validated_decisions_after_live_save(self):
        calls = []
        materials = [
            {"materialId": "A 01", "product": "Farbe Eins", "supplier": "Muster GmbH", "wwSupplierAddressId": "77", "supplierArticleNumber": "SKU-1", "purchasePrice": 10, "active": True},
            {"materialId": "A02", "product": "Farbe Zwei", "supplier": "Muster GmbH", "wwSupplierAddressId": "77", "supplierArticleNumber": "SKU-2", "purchasePrice": 20, "active": True},
        ]

        def request(path, method="GET", payload=None):
            calls.append((path, method, payload))
            if path.startswith("/admin/api/materials?"):
                return {"ok": True, "materials": materials}
            if path == "/admin/api/materials/auto":
                return {"ok": True, "material": {"materialId": "M03"}}
            return {"ok": True, "material": {}}

        result = review._apply_review({"kristine_api_request": request}, {
            "area": "live", "invoiceDate": "2026-09-10", "supplierInvoiceNumber": "R-17",
            "supplier": {"addressId": "77", "name": "Muster GmbH"},
            "materialReview": [
                {"sku": "SKU-1", "description": "Farbe Eins", "quantity": 1, "unit": "Stk", "unitPrice": 10, "decision": "confirm", "materialId": "A 01"},
                {"sku": "SKU-2", "description": "Farbe Zwei", "quantity": 1, "unit": "Stk", "unitPrice": 22, "decision": "update", "materialId": "A02"},
                {"sku": "NEW-3", "description": "Neuer Artikel", "quantity": 1, "unit": "kg", "containerSize": 30, "unitPrice": 7, "decision": "create"},
            ],
        })
        self.assertEqual(result["applied"], 3)
        self.assertTrue(any("A%2001/check-price" in call[0] for call in calls))
        update = next(call for call in calls if call[0].endswith("A02/check-price"))
        self.assertEqual(update[2]["purchasePrice"], 22)
        create = next(call for call in calls if call[0] == "/admin/api/materials/auto")
        self.assertTrue(create[2]["forceCreate"])
        self.assertEqual(create[2]["containerSize"], 30)

    def test_installs_review_card_before_accounting(self):
        marker = '<div class="card">\n          <div class="section-head">\n            <div><div class="project-title">4 · Kontierung</div>'
        namespace = {"MOBILE_PAGE": "<html><head></head><body>" + marker + "</body></html>"}
        review._install_ui(namespace)
        page = namespace["MOBILE_PAGE"]
        self.assertIn('id="captureMaterialReviewCard"', page)
        self.assertLess(page.index("4 · Materialstamm prüfen"), page.index("5 · Kontierung"))
        self.assertIn('id="kristaInvoiceMaterialReviewV1"', page)
        self.assertIn('id="kristaInvoiceMaterialReviewCss"', page)


if __name__ == "__main__":
    unittest.main()
