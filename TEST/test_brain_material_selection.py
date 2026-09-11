import tempfile
import unittest
from pathlib import Path

import pymupdf
from flask import Flask
import brain_material_selection as selection


class MaterialSelectionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "invoice.pdf"
        self.line = "1 SKU-17 Testfarbe 2 Stk 12,50 25,00"
        with pymupdf.open() as doc:
            page = doc.new_page()
            page.insert_text((40, 50), self.line)
            doc.new_page().insert_text((40, 50), "Andere Position")
            doc.save(self.path)
        self.calls = []
        self.materials = []
        def api(path, method="GET", payload=None):
            self.calls.append((path, method, payload))
            if method == "GET":
                return dict(ok=True, materials=self.materials)
            self.materials.append(dict(materialId="M1", **payload))
            return dict(ok=True, created=True, material=self.materials[-1])
        def validate(path):
            if str(path) != str(self.path):
                raise PermissionError("Nicht im Archiv")
            return self.path
        self.ns = dict(app=Flask(__name__), MOBILE_PAGE="<body></body>", pymupdf=pymupdf,
                       validate_indexed_pdf_path=validate, kristine_api_request=api,
                       _incoming_catalog=lambda: [dict(path=str(self.path), _raw_text=self.line,
                                                       _supplier=dict(name="Lieferant GmbH"), invoiceDate="2026-09-11")],
                       _extract_supplier_fingerprint=lambda _: dict(invoiceNumber="RE-77"))
        selection.install(self.ns)
        self.client = self.ns["app"].test_client()
        self.prefix = "/incoming/capture/material-selection"

    def preview(self, **extra):
        return self.client.post(self.prefix + "/preview", json=dict(path=str(self.path), selection=self.line, **extra))

    def test_text_coordinates_and_path_validation(self):
        data = self.client.get(self.prefix + "/text", query_string=dict(path=str(self.path), page=1)).json
        self.assertEqual(data["words"][1]["text"], "SKU-17")
        self.assertGreater(data["words"][0]["x1"], data["words"][0]["x0"])
        for path, page in [(str(self.path), 3), ("secret.pdf", 1)]:
            self.assertEqual(self.client.get(self.prefix + "/text", query_string=dict(path=path, page=page)).status_code, 400)

    def test_preview_is_readonly_save_retains_source_and_is_idempotent(self):
        draft = self.preview(page=1).json
        self.assertTrue(draft["recognized"])
        self.assertEqual(draft["fields"]["purchasePrice"], 12.5)
        self.assertEqual(self.calls, [])
        body = dict(token=draft["token"], fields={**draft["fields"], "product": "Geprüfte Farbe", "purchasePrice": "13,25"},
                    source=dict(path="forged.pdf", selection="forged"))
        for _ in range(2):
            result = self.client.post(self.prefix + "/save", json=body)
            self.assertEqual(result.status_code, 200)
            self.assertTrue(result.json["created"])
        writes = [call for call in self.calls if call[1] == "POST"]
        self.assertEqual(len(writes), 1)
        payload = writes[0][2]
        self.assertEqual(payload["purchasePrice"], 13.25)
        self.assertIn(str(self.path), payload["note"])
        self.assertIn(self.line, payload["note"])
        self.assertIn("RE-77", payload["note"])
        self.assertIn("Seite 1", payload["note"])
        self.assertNotIn("forged", payload["note"])
        self.assertNotIn("forceCreate", payload)

    def test_duplicate_article_does_not_write_or_change_price(self):
        self.materials.append(dict(materialId="OLD", product="Anderer Name", supplier="Lieferant GmbH", supplierArticleNumber="SKU-17", purchasePrice=99))
        draft = self.preview().json
        result = self.client.post(self.prefix + "/save", json=dict(token=draft["token"], fields=draft["fields"])).json
        self.assertFalse(result["created"])
        self.assertEqual(result["material"]["purchasePrice"], 99)
        self.assertTrue(all(call[1] == "GET" for call in self.calls))

    def test_invalid_price_and_stale_selection_cannot_write(self):
        self.assertEqual(self.preview(page=2).status_code, 400)
        draft = self.preview().json
        for price in ["", "NaN", "Infinity", "-5", "0"]:
            response = self.client.post(self.prefix + "/save", json=dict(token=draft["token"], fields={**draft["fields"], "purchasePrice": price}))
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.calls, [])

    def test_test_area_and_unknown_tokens_cannot_write(self):
        self.ns["CAPTURE_TEST_ROOT"] = self.path.parent
        self.assertEqual(self.preview().status_code, 400)
        self.assertEqual(self.client.post(self.prefix + "/save", json=dict(token="unknown", fields={})).status_code, 400)
        self.assertEqual(self.calls, [])

    def test_uncertain_line_has_no_invented_price(self):
        response = self.client.post(self.prefix + "/preview", json=dict(path=str(self.path), page=1, selection="Testfarbe"))
        self.assertFalse(response.json["recognized"])
        self.assertEqual(response.json["fields"]["purchasePrice"], "")


if __name__ == "__main__":
    unittest.main()
