import unittest

from brain_invoice_book import InvoiceBook, _effective_ww_status


class InvoiceBookStatusTests(unittest.TestCase):
    def test_current_sepa_handoff_wins_over_stale_open_override(self):
        self.assertEqual(
            _effective_ww_status("paid", "sepa_submitted", "open", False),
            "sepa_submitted",
        )

    def test_book_uses_bank_assignment_but_keeps_invoice_amount(self):
        def overlay(rows, include_resolved=False):
            self.assertTrue(include_resolved)
            row = dict(rows[0])
            row.update(paymentStatus="paid", paymentState="paid", bankPaid="224.51", amount=0.0)
            return [row]

        book = InvoiceBook.__new__(InvoiceBook)
        book.ns = {"bank_supplier_overlay": overlay}
        rows = [{
            "source": "KRISTINE", "id": "kristine:7", "amount": 224.51,
            "paymentStatus": "sepa_submitted",
        }]
        result = book._with_bank_status(rows)[0]
        self.assertEqual(result["paymentStatus"], "paid")
        self.assertEqual(result["amount"], 224.51)
        self.assertEqual(result["openAmount"], 0.0)


if __name__ == "__main__":
    unittest.main()
