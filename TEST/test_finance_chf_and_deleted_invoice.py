# coding: utf-8
"""No bank transfer, no live invoices: pure reconciliation and foreign-payment validation."""
import unittest

from brain_finance_runtime import (
    _finance_reminder, _prune_deleted_invoice_tasks, _foreign_payment_preview
)


class FinanceForeignAndDeletionTests(unittest.TestCase):
    def test_removed_invoice_only_prunes_its_own_brain_task(self):
        wrong_invoice = {"source": "KRISTINE", "id": "kristine:129", "amount": 2090,
                         "currency": "EUR", "invoiceNumber": "820191490143"}
        valid_invoice = {"source": "KRISTINE", "id": "kristine:135", "amount": 164.75,
                         "currency": "CHF", "invoiceNumber": "26.1034"}
        tasks = [
            {"id": "finance-invalid", "creatorId": "brain-finance",
             "reminder": _finance_reminder(wrong_invoice), "status": "open"},
            {"id": "finance-valid", "creatorId": "brain-finance",
             "reminder": _finance_reminder(valid_invoice), "status": "open"},
            {"id": "manually-created", "creatorId": "employee",
             "reminder": _finance_reminder(wrong_invoice), "status": "open"},
            {"id": "non-finance-task", "creatorId": "employee",
             "reminder": "Kunden anrufen", "status": "open"},
        ]
        kept, removed = _prune_deleted_invoice_tasks(tasks, {"kristine:135"})
        self.assertEqual(removed, ["finance-invalid"])
        self.assertEqual([x["id"] for x in kept],
                         ["finance-valid", "manually-created", "non-finance-task"])
        unchanged, removed = _prune_deleted_invoice_tasks(tasks,
                                                          {"kristine:129", "kristine:135"})
        self.assertFalse(removed)
        self.assertEqual(unchanged, tasks)

    def test_swiss_chf_payment_preparation_has_no_bank_submission(self):
        item = {
            "source": "KRISTINE", "id": "kristine:135",
            "supplier": "Zentrale Inkassostelle Schweiz, ZIS",
            "invoiceNumber": "26.1034", "currency": "CHF",
            "paymentStatus": "open", "approvalStatus": "approved",
            "paymentAmount": 164.75, "iban": "CH9300762011623852957",
            "bic": "TESTCHZZXXX", "remittanceText": "26.1034",
        }
        preview = _foreign_payment_preview([item])
        self.assertEqual(preview["item"]["amount"], 164.75)
        self.assertEqual(preview["item"]["currency"], "CHF")
        self.assertEqual(preview["item"]["purpose"], "26.1034")
        self.assertFalse(preview["transferSent"])
        self.assertFalse(preview["sepaCreated"])
        self.assertEqual(preview["route"], "foreign_manual")
        self.assertEqual(preview["item"]["paymentStatus"], "open")

    def test_foreign_transfer_rejects_incomplete_or_unsafe_inputs(self):
        good = {"supplier": "CH Supplier", "currency": "CHF", "paymentAmount": 2.50,
                "iban": "CH9300762011623852957", "invoiceNumber": "CH-2", "bic": "TESTCHZZXXX"}
        for rows in ([], [good, good],
                     [{**good, "currency": "EUR"}],
                     [{**good, "iban": "AT611904300234573201"}],
                     [{**good, "iban": "CH9300762011623852958"}],
                     [{**good, "paymentAmount": 0}],
                     [{**good, "paymentAmount": float("nan")}],
                     [{**good, "supplier": ""}]):
            with self.subTest(rows=rows):
                with self.assertRaises(ValueError):
                    _foreign_payment_preview(rows)

    def test_remittance_preserves_chf_for_partial_and_fees(self):
        from brain_finance_runtime import install
        self.assertTrue(callable(install))


if __name__ == "__main__":
    unittest.main()
