from pathlib import Path
import unittest

from brain_finance_ui import payments_page


class BrainFinancePaymentUiTests(unittest.TestCase):
    def test_sepa_waiting_area_and_archive_are_visible(self):
        html = payments_page()
        self.assertIn("An SEPA übergeben", html)
        self.assertIn("SEPA-Archiv", html)
        self.assertIn("/incoming/payment-batches/xml", html)
        self.assertIn("XML erneut laden", html)

    def test_sepa_waiting_row_has_non_overlapping_responsive_columns(self):
        html = payments_page()
        self.assertIn("submitted-date", html)
        self.assertIn("submitted-supplier", html)
        self.assertIn("submitted-action", html)
        self.assertIn(".submitted-row>*{min-width:0}", html)
        self.assertIn("@media(max-width:900px){.submitted-row", html)

    def test_sepa_archive_has_its_own_responsive_columns(self):
        html = payments_page()
        self.assertIn("#sepaArchive .archive-row{grid-template-columns:110px", html)
        self.assertIn("#sepaArchive .archive-row>*{min-width:0}", html)
        self.assertIn("#sepaArchive .archive-row .amount,#sepaArchive .sepa-download{white-space:nowrap}", html)

    def test_direct_debit_period_can_be_switched(self):
        source = (Path(__file__).parents[1] / "brain_finance_direct_debit.py").read_text(encoding="utf-8")
        tools = (Path(__file__).parents[1] / "brain_finance_op_tools.py").read_text(encoding="utf-8")
        self.assertIn('id="directDebitRange"', source)
        self.assertIn('<option value="31" selected>1 Monat</option>', source)
        self.assertIn('<option value="7">7 Tage</option>', source)
        self.assertIn("range?.value||31", source)
        self.assertIn("filteredDebits()", tools)
        self.assertIn("directDebitRange')?.value||31", tools)
        self.assertIn("x?.paymentMethod==='direct_debit'?Number(x.amount||0)", tools)


if __name__ == "__main__":
    unittest.main()
