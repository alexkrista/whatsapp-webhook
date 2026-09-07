from datetime import datetime
import unittest
from xml.etree import ElementTree as ET

from brain_finance_sepa import NS, build_sepa_xml, iban_valid


class BrainFinanceSepaTests(unittest.TestCase):
    def test_builds_bank_import_xml_with_exact_total_and_reference(self):
        xml, filename = build_sepa_xml(
            [{
                "supplier": "Beispiel Lieferant GmbH",
                "accountHolder": "Beispiel Lieferant GmbH",
                "iban": "AT61 1904 3002 3457 3201",
                "bic": "BKAUATWW",
                "paymentAmount": 422.51,
                "currency": "EUR",
                "paymentId": "KRI-ABC123",
                "remittanceText": "Rechnung 2150926636",
            }],
            "Farben Krista GmbH & Co KG",
            "AT82 5800 0104 9932 3013",
            "HYPVAT2B",
            datetime(2026, 9, 7, 11, 30, 0),
        )
        root = ET.fromstring(xml)
        values = {node.tag.rsplit("}", 1)[-1]: node.text for node in root.iter()}
        self.assertEqual(root.tag, f"{{{NS}}}Document")
        self.assertEqual(values["CtrlSum"], "422.51")
        self.assertEqual(values["InstdAmt"], "422.51")
        self.assertEqual(values["Ustrd"], "Rechnung 2150926636")
        self.assertEqual(filename, "SEPA_2026-09-07_11-30-00.xml")

    def test_rejects_missing_or_invalid_creditor_iban(self):
        with self.assertRaisesRegex(ValueError, "IBAN fehlt oder ist ungültig"):
            build_sepa_xml(
                [{"supplier": "Ohne Bank", "amount": 10, "currency": "EUR"}],
                "Farben Krista GmbH & Co KG",
                "AT82 5800 0104 9932 3013",
                "HYPVAT2B",
            )


    def test_company_iban_is_valid(self):
        self.assertTrue(iban_valid("AT82 5800 0104 9932 3013"))


if __name__ == "__main__":
    unittest.main()
