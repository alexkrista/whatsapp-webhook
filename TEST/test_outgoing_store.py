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

    def test_debtor_open_items_allocate_unassigned_payment_oldest_first(self):
        first = self.store.prepare_issue(self.store.save_draft(self.payload(amount="5000"))["id"])
        second = self.store.prepare_issue(self.store.save_draft(self.payload(amount="10000"))["id"])
        self.store.add_payment(self.run["id"], {
            "paymentDate": "2026-08-31", "gross": "7000", "reference": "Bankeingang",
        })
        items = self.store.debtor_open_items("2026-09-20")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["invoiceId"], second["id"])
        self.assertEqual(items[0]["openGross"], 5000.0)
        self.assertEqual(items[0]["overdueDays"], 6)

    def test_dunning_levels_block_and_notes_are_persistent(self):
        issued = self.store.prepare_issue(self.store.save_draft(self.payload(amount="5000"))["id"])
        first = self.store.prepare_dunning(issued["id"], "2026-09-20")
        self.assertEqual(first["level"], 1)
        pdf = self.store.output_root / "Mahnung_1.pdf"
        pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")
        self.store.attach_dunning_pdf(first["id"], pdf)
        item = self.store.debtor_open_items("2026-09-21")[0]
        self.assertEqual(item["dunningLevel"], 1)
        self.assertEqual(item["nextDunningLevel"], 2)
        self.store.update_debtor_meta(issued["id"], {
            "dunningBlocked": True, "note": "Kunde prüft die Schlussaufstellung.",
        })
        item = self.store.debtor_open_items("2026-09-21")[0]
        self.assertTrue(item["dunningBlocked"])
        self.assertEqual(item["opNote"], "Kunde prüft die Schlussaufstellung.")
        with self.assertRaisesRegex(ValueError, "Mahnsperre"):
            self.store.prepare_dunning(issued["id"], "2026-09-21")

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
        self.assertEqual(self.store.debtor_open_items("2026-09-20")[0]["openGross"], 11880.0)

    def test_ww_open_item_import_is_idempotent_and_uses_opening_balance(self):
        row = {
            "sourceId": "9451deed-8d89-4a9c-bc96-f3bc92154ce1", "invoiceNumber": "202608004",
            "projectIndex": 2602119, "projectNumber": "26025", "customerIndex": 1,
            "customerName": "Max Muster", "street": "Musterweg 1", "postalCode": "6820", "city": "Frastanz",
            "projectTitle": "Fassade", "issueDate": "2026-08-20", "dueDate": "2026-09-03",
            "serviceFrom": "2026-08-01", "serviceTo": "2026-08-20", "vatRate": "20",
            "originalNet": "10000", "originalGross": "12000", "openGross": "3500",
            "isPartial": False, "isFinal": False,
            "dunningLevel": 2, "lastDunning": "2026-08-30", "dunningBlockedUntil": "2026-09-30",
        }
        first = self.store.sync_ww_open_items([row])
        second = self.store.sync_ww_open_items([row])
        self.assertEqual(first["imported"], 1)
        self.assertEqual(second["skipped"], 1)
        self.assertTrue(self.store.last_ww_sync()["at"])
        imported_run = self.store.run(first["runIds"][0])
        self.assertEqual(imported_run["currentOpen"], 3500.0)
        item = self.store.debtor_open_items("2026-09-20")[0]
        self.assertEqual(item["dunningLevel"], 2)
        self.assertEqual(item["lastDunningDate"], "2026-08-30")
        self.assertTrue(item["dunningBlocked"])

    def test_paid_ww_partial_invoice_continues_as_second_partial_invoice(self):
        row = {
            "sourceId": "0034B49E-CE9F-4F58-88E0-60A4CA107A5C",
            "invoiceNumber": "202607011", "projectIndex": 2601105, "projectNumber": "26082",
            "customerIndex": 12026, "customerName": "Theresa Schwerzler",
            "street": "Hirschgraben 25/ Top 1", "postalCode": "6800", "city": "Feldkirch",
            "projectTitle": "Schwerzler-Halter", "issueDate": "2026-07-30",
            "dueDate": "2026-08-13", "paymentDate": "2026-08-31",
            "serviceFrom": "2026-07-01", "serviceTo": "2026-07-30", "vatRate": "20",
            "originalNet": "4850", "originalGross": "5820", "openGross": "0",
            "paidGross": "5820", "paidGrossAvailable": True,
            "isPartial": True, "isFinal": False,
        }
        first = self.store.sync_ww_project_history([row])
        second = self.store.sync_ww_project_history([row])
        self.assertEqual(first["imported"], 1)
        self.assertEqual(second["updated"], 1)
        run = self.store.run(first["runId"])
        self.assertEqual(run["currentGross"], 5820.0)
        self.assertEqual(run["paidGross"], 5820.0)
        self.assertEqual(run["currentOpen"], 0.0)
        self.assertEqual(len(run["payments"]), 1)
        self.assertEqual(run["invoices"][0]["source"], "WW")

        next_payload = self.payload(amount="10000")
        next_payload["runId"] = run["id"]
        next_invoice = self.store.save_draft(next_payload)
        self.assertEqual(len(next_invoice["previousInvoices"]), 1)
        self.assertEqual(next_invoice["previousInvoices"][0]["invoiceNumber"], "202607011")
        self.assertEqual(next_invoice["increment_net"], 5150.0)
        self.assertEqual(next_invoice["open_after_discount"], 6180.0)

    def test_ww_history_uses_booked_payment_instead_of_open_difference(self):
        row = {
            "sourceId": "PAYMENT-SOURCE-1", "invoiceNumber": "202607012",
            "projectIndex": 2601106, "projectNumber": "26083", "customerIndex": 12027,
            "customerName": "Beispiel Kunde", "street": "Testweg 1", "postalCode": "6800",
            "city": "Feldkirch", "projectTitle": "Zahlungsprüfung", "issueDate": "2026-07-31",
            "dueDate": "2026-08-14", "paymentDate": "2026-08-10",
            "serviceFrom": "2026-07-01", "serviceTo": "2026-07-31", "vatRate": "20",
            "originalNet": "10000", "originalGross": "12000", "openGross": "1000",
            "paidGross": "10500", "paidGrossAvailable": True,
            "isPartial": True, "isFinal": False,
        }
        result = self.store.sync_ww_project_history([row])
        run = self.store.run(result["runId"])
        self.assertEqual(run["paidGross"], 10500.0)
        self.assertEqual(run["currentOpen"], 1500.0)
        self.assertEqual(run["payments"][0]["paymentDate"], "2026-08-10")


if __name__ == "__main__":
    unittest.main()
