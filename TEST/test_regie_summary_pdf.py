# coding: utf-8
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader

from brain_regie_summary_pdf import render_regie_summary_pdf


class RegieSummaryPdfTests(unittest.TestCase):
    def test_summary_appendix_contains_project_days_and_total(self):
        invoice = {
            "invoice_number": "202609009", "service_from": "2026-09-20", "service_to": "2026-09-21",
            "run": {"project_number": "26097", "project_title": "Malerarbeiten Zangerle"},
            "progressBilling": {"regieBillingMode": "summary", "regieSummary": {"days": [
                {"date": "2026-09-20", "reportNumber": "8", "component": "Wohnzimmer",
                 "hours": 4, "labor": 320, "material": 45.2, "total": 365.2,
                 "employees": [{"name": "Max Muster", "hours": 4, "cost": 320}], "materials": []},
                {"date": "2026-09-21", "reportNumber": "9", "component": "Stiegenhaus",
                 "hours": 3.5, "labor": 280, "material": 22, "total": 302,
                 "employees": [{"name": "Anna Beispiel", "hours": 3.5, "cost": 280}], "materials": []},
            ]}},
        }
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "regie-summary.pdf"
            render_regie_summary_pdf(invoice, target)
            self.assertTrue(target.is_file())
            text = "\n".join(page.extract_text() or "" for page in PdfReader(target).pages)
        for value in ("Zusammenfassung Regieleistungen", "202609009", "26097", "Wohnzimmer", "Stiegenhaus", "EUR 667,20"):
            self.assertIn(value, text)


if __name__ == "__main__":
    unittest.main()
