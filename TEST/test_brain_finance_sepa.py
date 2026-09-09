from datetime import datetime
from pathlib import Path
import sqlite3
import tempfile
import unittest
from xml.etree import ElementTree as ET

from brain_finance_source import FinanceStore
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
        self.assertEqual(filename, "SEPA_2026-09-07_11-30-00_Beispiel-Lieferant-GmbH.xml")

    def test_multiple_recipients_are_named_concisely(self):
        common = {"iban": "AT61 1904 3002 3457 3201", "amount": 10, "currency": "EUR"}
        _xml, filename = build_sepa_xml(
            [
                {**common, "supplier": "Synthesa Chemie GmbH"},
                {**common, "supplier": "Würth Handelsgesellschaft"},
                {**common, "supplier": "Dritter Lieferant"},
                {**common, "supplier": "Vierter Lieferant"},
            ],
            "Farben Krista GmbH & Co KG",
            "AT82 5800 0104 9932 3013",
            "HYPVAT2B",
            datetime(2026, 9, 9, 12, 5, 0),
        )
        self.assertEqual(filename, "SEPA_2026-09-09_12-05-00_Synthesa-Chemie-GmbH_Würth-Handelsgesellschaft_plus-2.xml")

    def test_sepa_archive_keeps_original_xml_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "finance.db"

            def connect(_path):
                con = sqlite3.connect(db)
                con.row_factory = sqlite3.Row
                return con

            store = FinanceStore({"_capture_connection": connect, "CAPTURE_DB": db})
            saved = store.save_sepa_batch(
                "SEPA_Synthesa.xml", "<xml>original</xml>",
                [{"source": "KRISTINE", "id": "kristine:1", "supplier": "Synthesa", "invoiceNumber": "R-1", "paymentAmount": 500, "currency": "EUR"}],
                500,
                "2026-09-09T12:00:00",
            )
            self.assertEqual(saved["filename"], "SEPA_Synthesa.xml")
            self.assertEqual(saved["xml"], "<xml>original</xml>")
            self.assertEqual(saved["summary"], "Synthesa 500.00 EUR")
            listed = store.sepa_batches()
            self.assertEqual(len(listed), 1)
            self.assertNotIn("xml", listed[0])
            self.assertEqual(listed[0]["items"][0]["invoiceNumber"], "R-1")

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
