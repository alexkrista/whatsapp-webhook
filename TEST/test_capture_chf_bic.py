# coding: utf-8
import unittest
from brain_currency_payment_v2 import validate_invoice_bic


class ChfBicTests(unittest.TestCase):
    def test_chf_requires_bic(self):
        with self.assertRaisesRegex(ValueError, "BIC/SWIFT Pflicht"):
            validate_invoice_bic({"currency": "CHF", "swift": ""})

    def test_valid_chf_bic_normalizes_case_and_spaces(self):
        self.assertEqual(
            validate_invoice_bic({"currency": "CHF", "swift": " test ch zz xxx "}),
            "TESTCHZZXXX",
        )
        self.assertEqual(
            validate_invoice_bic({"currency": "CHF", "swift": "ABCDCHZZ"}),
            "ABCDCHZZ",
        )

    def test_malformed_bic_rejected(self):
        for value in ("12345678", "ABC123", "TOO-LONG-FOR-SWIFT", "abcdch"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "ungültig"):
                validate_invoice_bic({"currency": "CHF", "swift": value})

    def test_euro_invoices_unchanged(self):
        self.assertEqual(validate_invoice_bic({"currency": "EUR", "swift": ""}), "")


if __name__ == "__main__":
    unittest.main()
