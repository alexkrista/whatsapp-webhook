import unittest

from brain_finance_runtime import _finance_tasks_payload, _pick_finance_approver


class BrainFinanceApproverTests(unittest.TestCase):
    def test_exact_environment_id_is_verified_against_bootstrap(self):
        boot = {"employees": [{"id": "ak-1", "nickname": "Alex"}]}
        self.assertEqual(("ak-1", "Alex"), _pick_finance_approver(boot, {"KRISTINE_FINANCE_APPROVER_ID": "ak-1"}))

    def test_stale_environment_id_falls_back_to_unique_bootstrap_name(self):
        boot = {"employees": [{"id": "ak-2", "name": "Alexander Krista"}]}
        env = {"KRISTINE_FINANCE_APPROVER_ID": "old-id", "KRISTINE_FINANCE_APPROVER_NAME": "Alexander"}
        self.assertEqual(("ak-2", "Alexander Krista"), _pick_finance_approver(boot, env))

    def test_missing_or_ambiguous_person_fails_clearly(self):
        with self.assertRaisesRegex(RuntimeError, "Keine Mitarbeiter"):
            _pick_finance_approver({"employees": []}, {})
        boot = {"employees": [{"id": "1", "name": "Alex A"}, {"id": "2", "name": "Alex B"}]}
        with self.assertRaisesRegex(RuntimeError, "nicht eindeutig"):
            _pick_finance_approver(boot, {"KRISTINE_FINANCE_APPROVER_NAME": "Alex"})

    def test_task_payload_carries_verified_actor_id(self):
        tasks = [{"id": "one"}]
        self.assertEqual({"tasks": tasks, "actorId": "ak-1"}, _finance_tasks_payload(tasks, "ak-1"))
        with self.assertRaisesRegex(RuntimeError, "Freigabe-Person fehlt"):
            _finance_tasks_payload(tasks, "")


if __name__ == "__main__":
    unittest.main()
