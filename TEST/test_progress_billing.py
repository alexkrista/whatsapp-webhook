import copy
import tempfile
import unittest
from pathlib import Path
from brain_outgoing_store import OutgoingStore
from brain_progress_billing import invoice_snapshot


class ProgressBillingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = OutgoingStore(Path(self.tmp.name) / "test.db", Path(self.tmp.name) / "pdf")
        self.run = self.store.create_run({"projectIndex": 1, "projectNumber": "26082",
            "label": "Test", "customerName": "Testkunde", "street": "Testweg 1",
            "postalCode": "6800", "city": "Testort"})
        self.first = self.store.prepare_issue(self.store.save_draft(self.payload(4000))["id"])
        self.proposal = {"jobId": "26082", "kind": "TR", "completionPercent": 60,
            "fixedToInvoice": 8700, "regieToInvoice": 1100, "amountToInvoice": 9800,
            "reason": "Stand vor Ort", "baseline": {"complete": True, "hasClosingInvoice": False,
                "fixedContractAmount": 20000, "fixedPartialInvoiceNet": 3300,
                "invoiceSnapshot": invoice_snapshot([self.first])}}

    def tearDown(self):
        self.tmp.cleanup()

    def payload(self, amount):
        return {"runId": self.run["id"], "kind": "TR", "issueDate": "2026-09-01",
                "dueDate": "2026-09-30", "serviceFrom": "2026-08-01", "serviceTo": "2026-08-31",
                "lines": [{"description": "Arbeiten", "quantity": 1, "unitPrice": amount}]}

    def test_preview_never_creates_a_draft_and_tr_is_deducted_once(self):
        preset = self.store.progress_preset(self.run["id"], self.proposal)
        self.assertEqual(preset["incrementNet"], 9800)
        self.assertEqual(preset["cumulativeNet"], 13800)
        self.assertEqual(len(self.store.run(self.run["id"])["invoices"]), 1)
        draft = self.store.save_draft({**self.payload(0), **preset})
        self.assertEqual(draft["increment_net"], 9800)
        self.assertEqual(draft["regieNet"], 1100)
        self.assertEqual(draft["progressBilling"]["reason"], "Stand vor Ort")
        self.assertEqual(draft["notes"], "")
        self.assertEqual(self.store.run(self.run["id"])["status"], "open")
        self.assertEqual(draft["lines"][2]["billing_component"], "regie")
        # Editing a report line changes the allocation; the internal audit survives reopening.
        data = {**self.payload(0), **preset}
        data["lines"] = copy.deepcopy(preset["lines"])
        data["lines"][2]["unitPrice"] = 900
        edited = self.store.save_draft(data, draft["id"])
        self.assertEqual(edited["increment_net"], 9600)
        self.assertEqual(edited["regieNet"], 900)
        issued = self.store.prepare_issue(edited["id"])
        self.assertEqual(issued["regieNet"], 900)
        facts = self.store.billing_documents_by_project_numbers(["26082"])["26082"]["invoices"]
        self.assertEqual(facts[-1]["regieNet"], 900)

    def test_sr_means_100_percent_and_closes_only_when_issued(self):
        p = copy.deepcopy(self.proposal)
        p.update(kind="SR", completionPercent=100, fixedToInvoice=16700, amountToInvoice=17800)
        preset = self.store.progress_preset(self.run["id"], p)
        draft = self.store.save_draft({**self.payload(0), **preset})
        self.assertEqual(draft["increment_net"], 17800)
        self.assertEqual(self.store.run(self.run["id"])["status"], "open")
        self.store.prepare_issue(draft["id"])
        self.assertEqual(self.store.run(self.run["id"])["status"], "closed")

    def test_zero_remaining_sr_can_finish_an_order_already_paid_by_tr(self):
        p = copy.deepcopy(self.proposal)
        p.update(kind="SR", completionPercent=100, fixedToInvoice=0, regieToInvoice=0, amountToInvoice=0)
        p["baseline"].update(fixedContractAmount=4000, fixedPartialInvoiceNet=4000)
        preset = self.store.progress_preset(self.run["id"], p)
        draft = self.store.save_draft({**self.payload(0), **preset})
        self.assertEqual(draft["increment_net"], 0)
        self.store.prepare_issue(draft["id"])
        self.assertEqual(self.store.run(self.run["id"])["status"], "closed")

    def test_stale_or_wrong_project_proposal_is_rejected(self):
        p = copy.deepcopy(self.proposal)
        p["jobId"] = "25018"
        with self.assertRaisesRegex(ValueError, "Baustelle"):
            self.store.progress_preset(self.run["id"], p)
        self.store.prepare_issue(self.store.save_draft(self.payload(5000))["id"])
        with self.assertRaisesRegex(ValueError, "Rechnungsstand"):
            self.store.progress_preset(self.run["id"], self.proposal)

    def test_existing_draft_is_not_overwritten(self):
        draft = self.store.save_draft(self.payload(5000))
        with self.assertRaisesRegex(ValueError, "Entwurf"):
            self.store.progress_preset(self.run["id"], self.proposal)
        self.assertEqual(self.store.invoice(draft["id"])["increment_net"], 1000)

    def test_new_invoice_after_saving_requires_a_fresh_proposal_before_issuing(self):
        preset = self.store.progress_preset(self.run["id"], self.proposal)
        draft = self.store.save_draft({**self.payload(0), **preset})
        another = self.store.save_draft(self.payload(4500))
        self.store.prepare_issue(another["id"])
        with self.assertRaisesRegex(ValueError, "Rechnungsstand"):
            self.store.prepare_issue(draft["id"])
        self.assertEqual(self.store.invoice(draft["id"])["status"], "draft")

    def test_schema_change_is_repeatable_and_keeps_old_invoices(self):
        with self.store.connect() as con:
            self.store.ensure_schema(con)
        self.assertEqual(self.store.invoice(self.first["id"])["increment_net"], 4000)

if __name__ == "__main__":
    unittest.main()
