import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pdfplumber
from brain_document_layout import DEFAULTS, clean_layout
from brain_outgoing_pdf import render_invoice_pdf


class DocumentLayoutTests(unittest.TestCase):
    def test_invoice_reference_geometry_and_shared_changes(self):
        invoice = {"kind": "RE", "invoice_number": "MUSTER", "issue_date": "2026-09-19", "run": {"customer_name": "Erika Muster", "project_number": "MUSTER"}, "lines": [{"description": "Musterposition", "quantity": 20, "unit": "m²", "unit_price": 15, "net": 300}], "cumulative_net": 300, "cumulative_gross": 360, "line_subtotal_net": 300, "cumulative_vat": 60, "vat_rate": 20}
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            original, changed = Path(folder)/"original.pdf", Path(folder)/"changed.pdf"
            render_invoice_pdf(invoice, {}, original)
            layout = copy.deepcopy(DEFAULTS)
            layout["firstPage"].update(leftMm=20, bodyTopMm=105)
            render_invoice_pdf(invoice, {"document_layout": layout}, changed)
            with pdfplumber.open(original) as a, pdfplumber.open(changed) as b:
                first = next(w for w in a.pages[0].extract_words() if w["text"] == "Rechnung")
                updated = next(w for w in b.pages[0].extract_words() if w["text"] == "Rechnung")
                self.assertAlmostEqual(first["x0"], 48.189, places=2)
                self.assertAlmostEqual(first["top"], 286.07, places=1)
                self.assertAlmostEqual(updated["x0"]-first["x0"], 3*72/25.4, places=2)
                self.assertAlmostEqual(updated["top"]-first["top"], 5*72/25.4, places=2)
                self.assertEqual(a.pages[0].extract_text(), b.pages[0].extract_text())

    def test_all_invoice_kinds_use_the_same_reference(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            for kind, title in [("TR", "Abschlagsrechnung"), ("RE", "Rechnung"), ("SR", "Schlussrechnung"), ("GS", "Gutschrift")]:
                target = Path(folder)/(kind+".pdf")
                render_invoice_pdf({"kind": kind, "lines": [], "run": {}}, {}, target)
                with pdfplumber.open(target) as pdf:
                    self.assertIn(title, pdf.pages[0].extract_text())
                    word = next(w for w in pdf.pages[0].extract_words() if w["text"] == ("1." if kind == "TR" else title))
                    self.assertAlmostEqual(word["x0"], 48.189, places=2)
                    self.assertAlmostEqual(word["top"], 286.07, places=1)

    def test_payment_references_wrap_inside_their_column(self):
        invoice = {"kind": "TR", "run": {"project_number": "24138"}, "lines": [],
                   "payments": [{"reference": "Projekt 24138                                             RE 2026 09008", "paymentDate": "2026-09-25", "net": 10000, "vat": 2000, "gross": 12000} for _ in range(2)],
                   "paid_net_snapshot": 20000, "paid_vat_snapshot": 4000, "paid_gross_snapshot": 24000}
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "payments.pdf"
            render_invoice_pdf(invoice, {}, target)
            with pdfplumber.open(target) as pdf:
                words = [w for page in pdf.pages for w in page.extract_words()]
                dates = [w for w in words if w["text"] == "25.09.2026"]
                references = [w for w in words if w["text"] == "RE"]
                self.assertEqual(len(dates), 2)
                self.assertEqual(len(references), 2)
                boundary = min(w["x0"] for w in dates)
                for word in references:
                    self.assertLess(word["x1"], boundary, "Reference must not overlap payment date")
                for page in pdf.pages:
                    self.assertNotIn("2255..0099", page.extract_text())

    def test_invalid_central_settings_do_not_enter_the_renderer(self):
        with self.assertRaises(ValueError):
            clean_layout({"fontSizePt": float("nan")})
        with self.assertRaises(ValueError):
            clean_layout({"firstPage": {"bodyTopMm": 60}})


if __name__ == "__main__":
    unittest.main()
