import unittest
from brain_finance_runtime import _visible_transfer

class PendingVisibilityTests(unittest.TestCase):
    def test_glamora_without_approval_stays_visible_but_not_payable(self):
        row=dict(source='KRISTINE',id='kristine:37',amount=190.17,paymentAmount=0,approvalStatus='pending',paymentStatus='open')
        self.assertTrue(_visible_transfer(row))
        self.assertEqual(row['paymentAmount'],0)
        self.assertEqual(row['approvalStatus'],'pending')

    def test_blocked_invoice_is_visible(self):
        self.assertTrue(_visible_transfer(dict(amount=100,paymentAmount=0,approvalStatus='blocked',paymentStatus='open')))

    def test_paid_submitted_and_fully_reduced_invoices_do_not_reenter_open_selection(self):
        for state in ('paid','sepa_submitted'):
            self.assertFalse(_visible_transfer(dict(amount=100,paymentAmount=100,approvalStatus='pending',paymentStatus=state)))
        self.assertFalse(_visible_transfer(dict(amount=100,paymentAmount=0,approvalStatus='reduced',paymentStatus='open')))

    def test_approved_partial_balance_remains_visible(self):
        self.assertTrue(_visible_transfer(dict(amount=100,paymentAmount=40,approvalStatus='approved',paymentStatus='open')))
