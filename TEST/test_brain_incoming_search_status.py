import unittest

from brain_incoming_search_status import reconcile_incoming_payment_status
from brain_finance_direct_debit import _manual_open_ww_ids


class FakeStore:
    def meta(self):
        return {
            ("WinWorker", "ww:7358"): {"paymentStatus": "open"},
            ("WinWorker", "ww:7516"): {"paymentStatus": "sepa_submitted"},
        }

    def status_overrides(self):
        return {
            ("WinWorker", "ww:7358"): "open",
            ("WinWorker", "ww:7516"): "open",
        }

    def legacy(self):
        return {}


class IncomingSearchStatusTests(unittest.TestCase):
    def test_manually_reopened_direct_debit_bypasses_history_cutoff(self):
        self.assertEqual(_manual_open_ww_ids({
            ("WinWorker", "ww:7358"): "open",
            ("WinWorker", "broken"): "open",
            ("KRISTINE", "kristine:7"): "open",
        }), [7358])

    def test_manual_reopen_and_bank_assignment_are_visible_in_search(self):
        def overlay(rows, include_resolved=False):
            self.assertTrue(include_resolved)
            out = []
            for row in rows:
                copy = dict(row)
                if copy["id"] == "kristine:7":
                    copy.update(paymentStatus="paid", paymentState="paid", bankPaid="224.51", amount=0.0)
                out.append(copy)
            return out

        rows = [
            {"invoiceId":"ww:7358", "amount":2960.64, "paymentState":"paid", "paymentStatus":"Lastschrift: Beglichen"},
            {"invoiceId":"ww:7516", "amount":454.74, "paymentState":"paid", "paymentStatus":"SEPA übergeben"},
            {"invoiceId":"kristine:7", "amount":224.51, "paymentState":"open", "paymentStatus":"Offen"},
        ]
        result = reconcile_incoming_payment_status(rows, {"bank_supplier_overlay":overlay}, FakeStore())
        self.assertEqual(result[0]["paymentState"], "open")
        self.assertEqual(result[0]["paymentStatus"], "Offen")
        self.assertEqual(result[1]["paymentState"], "sepa_submitted")
        self.assertEqual(result[1]["paymentStatus"], "An SEPA übergeben")
        self.assertEqual(result[2]["paymentState"], "paid")
        self.assertEqual(result[2]["paymentStatus"], "Bezahlt")
        self.assertEqual(result[2]["amount"], 224.51)
        self.assertEqual(result[2]["openAmount"], 0.0)


if __name__ == "__main__":
    unittest.main()
