# coding: utf-8
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from brain_outgoing_store import OutgoingStore, calculate_totals


class OutgoingCalculationTests(unittest.TestCase):
    def test_requested_retention_discount_vat_skonto_and_payments(self):
        result = calculate_totals(
            [{"description": "Arbeiten", "quantity": 1, "unit": "PA", "unitPrice": "10000"}],
            tax_mode="AT20", retention_percent="7", discount_percent="5", cash_discount_percent="3",
            payments={"net": "6250", "vat": "1250", "gross": "7500"},
        )
        expected = {
            "lineSubtotalNet": "10000.00", "retentionNet": "700.00", "netAfterRetention": "9300.00",
            "discountNet": "465.00", "cumulativeNet": "8835.00", "cumulativeVat": "1767.00",
            "cumulativeGross": "10602.00", "cashDiscountGross": "318.06",
            "cumulativeGrossDiscounted": "10283.94", "openWithDiscount": "2783.94",
            "openAfterDiscount": "3102.00",
        }
        for key, value in expected.items():
            self.assertEqual(result[key], Decimal(value), key)

    def test_second_partial_invoice_is_cumulative(self):
        result = calculate_totals(
            [{"description": "Gesamtleistung", "quantity": 1, "unitPrice": "20000"}],
            tax_mode="AT20", prior={"net": "10000", "vat": "2000", "gross": "12000"},
            payments={"net": "8333.33", "vat": "1666.67", "gross": "10000"},
        )
        self.assertEqual(result["incrementGross"], Decimal("12000.00"))
        self.assertEqual(result["openAfterDiscount"], Decimal("14000.00"))


class OutgoingStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = OutgoingStore(root / "outgoing.db", root / "pdf")
        self.run = self.store.create_run({
            "projectIndex": 2602119, "projectNumber": "26025", "customerIndex": 1,
            "label": "Fassade", "customerName": "Max Muster", "company": "",
            "street": "Musterweg 1", "postalCode": "6820", "city": "Frastanz", "country": "Österreich",
        })

    def tearDown(self):
        self.tmp.cleanup()

    def payload(self, amount="10000", kind="TR", issue_date="2026-08-31"):
        return {
            "runId": self.run["id"], "kind": kind, "issueDate": issue_date, "dueDate": "2026-09-14",
            "serviceFrom": "2026-08-01", "serviceTo": "2026-08-31", "taxMode": "AT20",
            "retentionPercent": "0", "discountPercent": "0", "cashDiscountPercent": "0",
            "lines": [{"description": "Arbeiten", "quantity": 1, "unit": "PA", "unitPrice": amount}],
        }

    def test_multiple_independent_runs_per_project(self):
        second = self.store.create_run({
            "projectIndex": 2602119, "projectNumber": "26025", "label": "Zusatzauftrag",
            "customerName": "Max Muster", "street": "Musterweg 1", "postalCode": "6820", "city": "Frastanz",
        })
        self.assertNotEqual(self.run["id"], second["id"])
        self.assertEqual(len(self.store.runs(2602119)), 2)

    def test_number_circle_is_yymm_sequence(self):
        draft = self.store.save_draft(self.payload())
        issued = self.store.prepare_issue(draft["id"])
        self.assertEqual(issued["invoice_number"], "2608001")

    def test_zero_vat_requires_uid_and_note(self):
        payload = self.payload()
        payload["taxMode"] = "RC19"
        with self.assertRaisesRegex(ValueError, "UID"):
            self.store.save_draft(payload)
        payload["recipientUid"] = "ATU12345678"
        draft = self.store.save_draft(payload)
        self.assertIn("Steuerschuld", draft["tax_note"])

    def test_austrian_business_invoice_over_10000_requires_customer_uid(self):
        business = self.store.create_run({
            "projectIndex": 2602120, "projectNumber": "26026", "customerIndex": 2,
            "label": "Büro", "customerName": "Eva Muster", "company": "Muster GmbH",
            "street": "Büroweg 2", "postalCode": "6820", "city": "Frastanz", "country": "Österreich",
        })
        payload = self.payload(amount="10000.01")
        payload["runId"] = business["id"]
        with self.assertRaisesRegex(ValueError, "Kunden-UID"):
            self.store.save_draft(payload)
        payload["recipientUid"] = "ATU12345678"
        self.assertEqual(self.store.save_draft(payload)["recipient_uid"], "ATU12345678")

    def test_issued_invoice_can_be_revised_before_month_close(self):
        draft = self.store.save_draft(self.payload())
        issued = self.store.prepare_issue(draft["id"])
        revision = self.store.begin_revision(issued["id"])
        self.assertEqual(revision["status"], "draft")
        payload = self.payload(issue_date="2026-08-30")
        revised = self.store.save_draft(payload, issued["id"])
        issued_again = self.store.prepare_issue(revised["id"])
        self.assertEqual(issued_again["invoice_number"], "2608001")
        self.assertEqual(issued_again["revisionNo"], 1)

    def test_date_change_to_new_month_uses_new_number(self):
        draft = self.store.save_draft(self.payload())
        issued = self.store.prepare_issue(draft["id"])
        revision = self.store.begin_revision(issued["id"])
        payload = self.payload(issue_date="2026-09-01")
        payload["dueDate"] = "2026-09-15"
        revised = self.store.save_draft(payload, revision["id"])
        issued_again = self.store.prepare_issue(revised["id"])
        self.assertEqual(issued_again["invoice_number"], "2609001")

    def test_closed_month_allows_credit_but_not_storno(self):
        draft = self.store.save_draft(self.payload())
        issued = self.store.prepare_issue(draft["id"])
        self.store.close_period("202608")
        with self.assertRaisesRegex(ValueError, "Gutschrift"):
            self.store.create_correction_draft(issued["id"], {"kind": "ST", "reason": "falsch"})
        credit = self.store.create_correction_draft(issued["id"], {
            "kind": "GS", "reason": "Kundenabzug", "gross": "120", "issueDate": "2026-09-01",
        })
        credit = self.store.prepare_issue(credit["id"])
        self.assertEqual(credit["invoice_number"], "2609001")
        self.assertEqual(credit["increment_gross"], -120.0)

    def test_ww_open_item_import_is_idempotent_and_uses_opening_balance(self):
        row = {
            "sourceId": "9451deed-8d89-4a9c-bc96-f3bc92154ce1", "invoiceNumber": "202608004",
            "projectIndex": 2602119, "projectNumber": "26025", "customerIndex": 1,
            "customerName": "Max Muster", "street": "Musterweg 1", "postalCode": "6820", "city": "Frastanz",
            "projectTitle": "Fassade", "issueDate": "2026-08-20", "dueDate": "2026-09-03",
            "serviceFrom": "2026-08-01", "serviceTo": "2026-08-20", "vatRate": "20",
            "originalNet": "10000", "originalGross": "12000", "openGross": "3500",
            "isPartial": False, "isFinal": False,
        }
        first = self.store.sync_ww_open_items([row])
        second = self.store.sync_ww_open_items([row])
        self.assertEqual(first["imported"], 1)
        self.assertEqual(second["skipped"], 1)
        imported_run = self.store.run(first["runIds"][0])
        self.assertEqual(imported_run["currentOpen"], 3500.0)


if __name__ == "__main__":
    unittest.main()
