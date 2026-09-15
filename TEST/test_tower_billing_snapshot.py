import unittest
from datetime import datetime

from brain_tower_billing_snapshot import _selected_jobs, build_snapshot


class FakeStore:
    def billing_documents_by_project_numbers(self, project_numbers):
        return {
            number: {
                "found": True,
                "projectNumber": number,
                "summary": {"invoiceCount": 2, "billedNet": 34569},
                "invoices": [],
                "payments": [],
                "runs": [],
            }
            for number in project_numbers
        }


class FakeApp:
    extensions = {"kristine_outgoing_store": FakeStore()}


class TowerBillingSnapshotTests(unittest.TestCase):
    def test_only_active_billing_jobs_and_no_closed_collection_members(self):
        selected = _selected_jobs({
            "jobs": [
                {"jobId": "26082", "status": "Laufend"},
                {"jobId": "26083", "status": "Auftrag"},
                {"jobId": "26084", "status": "Angebot"},
            ],
            "collections": [{
                "status": "Geschlossen",
                "collectionMemberJobIds": ["26083"],
            }],
        })
        self.assertEqual(list(selected), ["26082"])

    def test_snapshot_uses_yesterday_hours_and_reports(self):
        calls = {"hours": [], "history": 0, "open": 0}

        def api(path):
            self.assertEqual(path, "/admin/api/jobs")
            return {"jobs": [{
                "jobId": "26082",
                "name": "BV EFH Schwerzler/Halter",
                "status": "Laufend",
                "calculation": {"kristaAmount": 51529.94, "fixedCalculatedHours": 571},
            }], "collections": []}

        project = {"projectNumber": "26082", "projectIndex": 82}

        def hours(number, before_date=None, project=None):
            calls["hours"].append((number, before_date, project))
            return 477.875

        def reports(_project):
            return [
                {"reportNumber": "19", "reportDate": "2026-09-14", "totalHours": 65.35},
                {"reportNumber": "20", "reportDate": "2026-09-15", "totalHours": 9.5},
            ]

        def sync_open():
            calls["open"] += 1

        def sync_history(_project):
            calls["history"] += 1

        value = build_snapshot({
            "app": FakeApp(),
            "kristine_api_request": api,
            "kristine_outgoing_project_by_number": lambda number: project if number == "26082" else None,
            "kristine_project_recorded_hours_net": hours,
            "kristine_project_regie_reports": reports,
            "kristine_sync_outgoing_ww": sync_open,
            "kristine_sync_outgoing_project_history": sync_history,
        }, now=datetime(2026, 9, 15, 2, 30), sync_invoices=True)

        self.assertEqual(value["hoursThroughDate"], "2026-09-14")
        self.assertEqual(value["billingByProject"]["26082"]["summary"]["recordedHoursNet"], 477.875)
        self.assertEqual([row["reportNumber"] for row in value["reportsByProject"]["26082"]], ["19"])
        self.assertEqual(calls["hours"], [("26082", "2026-09-15", project)])
        self.assertEqual(calls["open"], 1)
        self.assertEqual(calls["history"], 1)


if __name__ == "__main__":
    unittest.main()
