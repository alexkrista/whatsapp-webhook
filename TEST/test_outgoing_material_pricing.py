import unittest

from brain_outgoing_invoices import (
    _combined_revenue_summary,
    _is_project_closing_invoice,
    _lg_retail_net_price,
    _project_owner_names,
    _ten_l_fallback_price,
)


class OutgoingMaterialPricingTests(unittest.TestCase):
    def test_combined_revenue_prefers_ww_for_duplicate_invoice_number(self):
        result = _combined_revenue_summary([
            {"invoiceNumber": "202609001", "issueDate": "2026-09-01", "netRevenue": 1200, "source": "WW"},
            {"invoiceNumber": "202609001", "issueDate": "2026-09-01", "netRevenue": 1100, "source": "KRISTINE"},
            {"invoiceNumber": "202609002", "issueDate": "2026-09-02", "netRevenue": 500, "source": "KRISTINE"},
            {"invoiceNumber": "202609003", "issueDate": "2026-09-03", "netRevenue": -100, "source": "KRISTINE"},
        ], 2026)
        september = result["monthlyRevenue"][8]
        self.assertEqual(september["netRevenue"], 1600.0)
        self.assertEqual(september["invoiceCount"], 3)
        self.assertEqual(september["wwInvoiceCount"], 1)
        self.assertEqual(september["kristineInvoiceCount"], 2)

    def test_little_greene_exact_five_litre_retail_net(self):
        self.assertEqual(_lg_retail_net_price("Absolute Matt", "5 L"), 155.83)

    def test_little_greene_ten_litre_uses_two_five_litre_minus_three_percent(self):
        self.assertEqual(_lg_retail_net_price("Absolute Matt", "10 L"), 302.32)
        self.assertEqual(_lg_retail_net_price("Intelligent Matt", "10 L"), 324.95)

    def test_generic_ten_litre_fallback(self):
        self.assertEqual(_ten_l_fallback_price(100), 194.00)

    def test_both_filled_project_owners_are_invoice_recipients(self):
        meta = {"projectContacts": {"owner": {
            "womanFirstName": "Theresa", "womanLastName": "Schwerzler",
            "manFirstName": "Martin", "manLastName": "Schwerzler",
        }}}
        self.assertEqual(_project_owner_names(meta), ["Theresa Schwerzler", "Martin Schwerzler"])

    def test_only_final_invoice_closes_project(self):
        self.assertFalse(_is_project_closing_invoice({"kind": "TR", "run": {}}))
        self.assertTrue(_is_project_closing_invoice({"kind": "SR", "run": {}}))
        self.assertTrue(_is_project_closing_invoice({
            "kind": "RE", "subject": "Rechnung · Malerarbeiten", "run": {"label": "Hauptauftrag"},
        }))
        self.assertFalse(_is_project_closing_invoice({
            "kind": "RE", "subject": "Regiearbeiten", "run": {"label": "Hauptauftrag · Extra-Rechnung"},
        }))


if __name__ == "__main__":
    unittest.main()
