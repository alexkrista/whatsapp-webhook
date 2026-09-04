import unittest

from brain_outgoing_pdf import _epc_payment_payload, _payment_qr_drawing


SETTINGS = {
    "company_name": "Farben Krista GmbH & Co KG",
    "bank_iban": "AT82 5800 0104 9932 3013",
    "bank_bic": "HYPVAT2B",
}


class OutgoingPaymentQrTests(unittest.TestCase):
    def test_skonto_qr_uses_discounted_open_amount(self):
        payload = _epc_payment_payload({
            "invoice_number": "202609005",
            "cash_discount_percent": "2",
            "open_with_discount": "519.83",
            "open_after_discount": "530.44",
        }, SETTINGS)
        lines = payload.splitlines()
        self.assertEqual(lines[:4], ["BCD", "002", "1", "SCT"])
        self.assertEqual(lines[5], "Farben Krista GmbH & Co KG")
        self.assertEqual(lines[6], "AT825800010499323013")
        self.assertEqual(lines[7], "EUR519.83")
        self.assertEqual(lines[10], "Rechnung 202609005")

    def test_regular_qr_uses_full_open_amount(self):
        payload = _epc_payment_payload({
            "invoice_number": "202609006",
            "cash_discount_percent": "0",
            "open_with_discount": "500.00",
            "open_after_discount": "612.34",
        }, SETTINGS)
        self.assertEqual(payload.splitlines()[7], "EUR612.34")

    def test_explicit_amount_creates_second_full_amount_qr(self):
        invoice = {
            "invoice_number": "202609006",
            "cash_discount_percent": "2",
            "open_with_discount": "600.09",
            "open_after_discount": "612.34",
        }
        discounted = _epc_payment_payload(invoice, SETTINGS, invoice["open_with_discount"])
        full = _epc_payment_payload(invoice, SETTINGS, invoice["open_after_discount"])
        self.assertEqual(discounted.splitlines()[7], "EUR600.09")
        self.assertEqual(full.splitlines()[7], "EUR612.34")

    def test_draft_without_invoice_number_has_no_payment_qr(self):
        self.assertEqual(_epc_payment_payload({
            "cash_discount_percent": "2",
            "open_with_discount": "100.00",
        }, SETTINGS), "")

    def test_qr_has_centered_krista_mark(self):
        drawing = _payment_qr_drawing("BCD\n002\n1\nSCT", 100)
        labels = [getattr(item, "text", "") for item in drawing.contents]
        self.assertIn("K", labels)


if __name__ == "__main__":
    unittest.main()
