"""Physical-output-free regression tests for the GANTNER -> HCU Stiegenhaus scene."""
import importlib.util
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

FILE = Path(__file__).resolve().parents[1] / "tools" / "windows-access-hotfix" / "office_presence_scene.py"
spec = importlib.util.spec_from_file_location("office_presence_scene", FILE)
scene = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scene)

GROUP_ID = "e14bc1df-2aae-4ba1-9da4-5aa015d4ed12"
ACTOR_ID = "AAAAAAAAAAAAAAAAAAAAAAAA"  # synthetic identifier; no real hardware used

def cfg():
    return {
        "enabled": True,
        "poll_seconds": 8,
        "away_grace_seconds": 120,
        "hcu_config": "dummy-not-read-in-test",
        "stiegenhaus": {
            "group_id": GROUP_ID,
            "expected_label": "Stiegenhaus",
            "expected_actuator_id": ACTOR_ID,
            "expected_channel_index": 1,
            "expected_actuator_label": "licht gang",
        },
    }

def hcu_state(*, group_type="EXTENDED_LINKED_SWITCHING", label="Stiegenhaus",
              on=False, actuator=True, actor_label="licht gang"):
    group = {
        "label": label,
        "type": group_type,
        "metaGroupId": None,
        "unreach": False,
        "configPending": False,
        "on": on,
        "channels": ([{"deviceId": ACTOR_ID, "channelIndex": 1}] if actuator else []),
    }
    device = {
        "label": actor_label,
        "functionalChannels": {"1": {"functionalChannelType": "SWITCH_MEASURING_CHANNEL"}},
    }
    return {"groups": {GROUP_ID: group}, "devices": {ACTOR_ID: device}}

class FakeHcu:
    def __init__(self, state=None):
        self.state = state if state is not None else hcu_state()
        self.calls = []

    def hcu_get_system_state(self, _settings):
        return self.state

    def hcu_system_request(self, _settings, path, body, timeout):
        self.calls.append((path, body))
        return {"body": {"code": 200}}

class Tests(unittest.TestCase):
    def test_or_presence_all_three(self):
        for person in scene.PEOPLE:
            with self.subTest(person=person):
                people = {p: p == person for p in scene.PEOPLE}
                _, transition = scene.next_scene_state({}, people, 100)
                self.assertEqual(transition, "on")

    def test_switch_off_two_minutes_after_last_person_leaves(self):
        first, transition = scene.next_scene_state({}, {"alex": True, "bettina": False, "dunja": False}, 0)
        self.assertEqual(transition, "on")
        absent = {p: False for p in scene.PEOPLE}
        grace, transition = scene.next_scene_state(first, absent, 10)
        self.assertIsNone(transition)
        still_grace, transition = scene.next_scene_state(grace, absent, 129)
        self.assertIsNone(transition)
        off, transition = scene.next_scene_state(still_grace, absent, 131)
        self.assertEqual(transition, "off")
        self.assertFalse(off["active"])

    def test_second_employee_prevents_switch_off(self):
        state, action = scene.next_scene_state({"active": True, "away_since": 10}, {"alex": False, "bettina": True, "dunja": False}, 140)
        self.assertIsNone(action)
        self.assertTrue(state["active"])
        self.assertIsNone(state["away_since"])

    def test_unavailable_presence_does_not_mean_absence(self):
        with self.assertRaises(ValueError):
            scene.people_present({"alex": False, "bettina": None, "dunja": False})
        with self.assertRaises(ValueError):
            scene.people_present({"alex": False, "dunja": False})
        with self.assertRaises(ValueError):
            scene.people_present(None)

    def test_dry_run_reads_gantner_without_switching_group(self):
        commands = []
        state, transition, people = scene.tick(
            cfg(), {}, now=100,
            dry_run=True,
            presence_reader=lambda _: {"alex": False, "bettina": False, "dunja": True},
            group_setter=lambda *_: commands.append("group_called"))
        self.assertEqual(transition, "on")
        self.assertEqual(commands, [])

    def test_disabled_config_does_not_actuate(self):
        invalid = cfg()
        invalid["enabled"] = False
        with self.assertRaises(ValueError):
            scene.tick(invalid, {}, now=100, dry_run=False,
                       presence_reader=lambda _: {"alex": True, "bettina": False, "dunja": False},
                       group_setter=lambda *_: self.fail("Must not actuate"))

    def test_exact_group_not_meta_or_access_control(self):
        for group_type in ("ACCESS_CONTROL", "META", "SWITCHING"):
            with self.subTest(group_type=group_type):
                hcu = FakeHcu(hcu_state(group_type=group_type))
                with self.assertRaises(ValueError):
                    scene.verify_stiegenhaus(cfg(), {}, hcu)
                self.assertEqual(hcu.calls, [])

    def test_wrong_member_or_name_prevents_control(self):
        for fake in (hcu_state(actuator=False), hcu_state(actor_label="Garage")):
            hcu = FakeHcu(fake)
            with self.assertRaises(ValueError):
                scene.verify_stiegenhaus(cfg(), {}, hcu)
            self.assertEqual(hcu.calls, [])

    def test_one_group_command_not_three_device_commands(self):
        hcu = FakeHcu(hcu_state(on=False))
        with patch.object(scene, "load_json", return_value={}):
            command_sent = scene.set_stiegenhaus(cfg(), True, module=hcu)
        self.assertTrue(command_sent)
        self.assertEqual(hcu.calls, [(
            "/hmip/group/switching/setState",
            {"groupId": GROUP_ID, "on": True}
        )])

    def test_group_already_on_needs_no_second_command(self):
        hcu = FakeHcu(hcu_state(on=True))
        with patch.object(scene, "load_json", return_value={}):
            changed = scene.set_stiegenhaus(cfg(), True, module=hcu)
        self.assertFalse(changed)
        self.assertEqual(hcu.calls, [])

    def test_off_uses_same_group_and_no_door_control(self):
        hcu = FakeHcu(hcu_state(on=True))
        with patch.object(scene, "load_json", return_value={}):
            changed = scene.set_stiegenhaus(cfg(), False, module=hcu)
        self.assertTrue(changed)
        self.assertEqual(hcu.calls, [(
            "/hmip/group/switching/setState",
            {"groupId": GROUP_ID, "on": False}
        )])

    def test_failure_prevents_confirmation(self):
        calls = []
        def failing(*_):
            calls.append("attempted")
            raise RuntimeError("HCU offline")
        original = {}
        with self.assertRaises(RuntimeError):
            scene.tick(cfg(), original, now=200, dry_run=False,
                       presence_reader=lambda _: {"alex": True, "bettina": False, "dunja": False},
                       group_setter=failing)
        self.assertEqual(calls, ["attempted"])
        self.assertEqual(original, {})


    def test_weekday_screening_windows(self):
        monday = datetime(2026, 10, 19, 0, 0)
        scenarios = [
            (0, 0, 15), (6, 29, 15), (6, 30, 1), (8, 14, 1),
            (8, 15, 15), (11, 44, 15), (11, 45, 1),
            (12, 14, 1), (12, 15, 5), (17, 59, 5),
            (18, 0, 15), (23, 59, 15),
        ]
        for hour, minute, expected in scenarios:
            with self.subTest(hour=hour, minute=minute):
                self.assertEqual(scene.schedule_interval_minutes(
                    monday.replace(hour=hour, minute=minute)), expected)

    def test_exact_screening_slots(self):
        mon = datetime(2026, 10, 19)
        should_check = [(6, 15), (6, 30), (7, 21), (8, 14),
                        (8, 15), (8, 30), (11, 45),
                        (12, 14), (12, 15), (12, 20),
                        (17, 55), (18, 0), (23, 45)]
        should_not = [(6, 22), (8, 16), (8, 29), (11, 44),
                      (12, 16), (12, 19), (18, 1), (23, 59)]
        for hour, minute in should_check:
            with self.subTest(check=(hour, minute)):
                self.assertTrue(scene.is_scheduled_minute(mon.replace(hour=hour, minute=minute)))
        for hour, minute in should_not:
            with self.subTest(skip=(hour, minute)):
                self.assertFalse(scene.is_scheduled_minute(mon.replace(hour=hour, minute=minute)))

    def test_weekend_never_screens(self):
        sat = datetime(2026, 10, 24, 8, 0)
        sun = sat + timedelta(days=1)
        for moment in (sat, sun, sat.replace(hour=0), sun.replace(hour=23)):
            self.assertIsNone(scene.schedule_interval_minutes(moment))
            self.assertFalse(scene.is_scheduled_minute(moment))
        next_due = scene.next_regular_screening(
            datetime(2026, 10, 23, 23, 45, 1))
        self.assertEqual(next_due, datetime(2026, 10, 26, 0, 0))

    def test_critical_window_transition_times(self):
        monday = datetime(2026, 10, 19)
        pairs = [
            ((6, 29, 1), (6, 30, 0)),
            ((8, 14, 1), (8, 15, 0)),
            ((8, 15, 1), (8, 30, 0)),
            ((11, 44, 1), (11, 45, 0)),
            ((12, 14, 1), (12, 15, 0)),
            ((17, 59, 1), (18, 0, 0)),
        ]
        for start, expected in pairs:
            with self.subTest(start=start):
                src = monday.replace(hour=start[0], minute=start[1], second=start[2])
                due = scene.next_regular_screening(src)
                self.assertEqual(due, monday.replace(hour=expected[0], minute=expected[1], second=expected[2]))

    def test_two_minute_off_followup_despite_15_minute_interval(self):
        now = datetime(2026, 10, 19, 8, 16)
        state = {
            "active": True,
            "away_since": now.timestamp(),
            "last_people": {"alex": False, "bettina": False, "dunja": False},
        }
        self.assertEqual(scene.next_screening(now, state, 120),
                         datetime(2026, 10, 19, 8, 18))

    def test_no_off_followup_on_weekend(self):
        friday = datetime(2026, 10, 23, 23, 59)
        state = {"active": True, "away_since": friday.timestamp(),
                 "last_people": {name: False for name in scene.PEOPLE}}
        self.assertEqual(scene.next_screening(friday, state, 120),
                         datetime(2026, 10, 26, 0, 0))

    def test_only_one_transition_while_present(self):
        people = {"alex": True, "bettina": False, "dunja": False}
        a, first = scene.next_scene_state({}, people, 100)
        b, second = scene.next_scene_state(a, people, 105)
        self.assertEqual(first, "on")
        self.assertIsNone(second)
        self.assertTrue(b["active"])

if __name__ == "__main__":
    unittest.main()
