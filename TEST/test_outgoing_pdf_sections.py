import tempfile
import unittest
from pathlib import Path

import pdfplumber

from brain_outgoing_pdf import render_invoice_pdf


class OutgoingPdfSectionTests(unittest.TestCase):
    def test_mixed_order_and_regie_invoice_has_category_totals_and_breakdown(self):
        invoice = {
            "kind": "RE",
            "issue_date": "2026-09-09",
            "due_date": "2026-09-23",
            "service_from": "2026-09-01",
            "service_to": "2026-09-09",
            "subject": "Malerarbeiten und Zusatzarbeiten",
            "worker": "Ing. Alexander Krista",
            "run": {
                "project_number": "26080",
                "customer_name": "Kugelfink",
                "customer_street": "Millennium Park 24",
                "customer_postal_code": "6890",
                "customer_city": "Lustenau",
                "customer_country": "Österreich",
            },
            "lines": [
                {"description": "Wandflächen streichen", "quantity": 20, "unit": "m²", "unit_price": 10, "net": 200},
                {"description": "1. Bericht - 9.9.2026", "quantity": 0, "unit": "TAG", "unit_price": 0, "net": 0},
                {"description": "Arbeit", "quantity": 0, "unit": "ARBEIT", "unit_price": 0, "net": 0},
                {"description": "Zusatzarbeit", "quantity": 2, "unit": "Std.", "unit_price": 75, "net": 150},
                {"description": "Summe 1", "quantity": 0, "unit": "SUMME", "unit_price": 0, "net": 0},
            ],
            "line_subtotal_net": 350,
            "cumulative_net": 350,
            "vat_rate": 20,
            "cumulative_vat": 70,
            "cumulative_gross": 420,
            "open_after_discount": 420,
        }
        settings = {
            "company_name": "Farben Krista GmbH & Co KG",
            "company_street": "Feldkircherstraße 45",
            "company_postal_city": "A 6820 Frastanz",
            "company_phone": "+43 5522 53940",
            "company_email": "office@krista.at",
            "company_web": "www.krista.at",
            "company_fn": "FN 15539b",
            "company_uid": "ATU36511805",
            "company_eori": "ATEOS1000017548",
            "company_dg": "401425536",
            "bank_iban": "AT82 5800 0104 9932 3013",
            "bank_bic": "HYPVAT2B",
        }
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "mixed.pdf"
            render_invoice_pdf(invoice, settings, target)
            with pdfplumber.open(target) as pdf:
                text = "\n".join(page.extract_text() or "" for page in pdf.pages)

        self.assertLess(text.index("Summe Arbeiten nach m²"), text.index("1. Bericht - 9.9.2026"))
        self.assertGreater(text.index("Summe Zusatzarbeiten in Regie"), text.index("Summe 1"))
        self.assertIn("Aufstellung der Rechnungssumme Netto:", text)
        self.assertGreaterEqual(text.count("1. Arbeiten nach m²"), 1)
        self.assertGreaterEqual(text.count("2. Zusatzarbeiten in Regie"), 1)
        self.assertIn("200,00", text)
        self.assertIn("150,00", text)


if __name__ == "__main__":
    unittest.main()
