import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "windows-access-hotfix" / "office_presence_scene.py"
spec = importlib.util.spec_from_file_location("office_presence_scene", SCRIPT)
scene = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scene)


class SceneTests(unittest.TestCase):
    def test_or_rule_and_departure_grace(self):
        people = {"alex": False, "bettina": True, "dunja": False}
        state, action = scene.next_scene_state({}, people, 100, 120)
        self.assertEqual(action, "on")
        self.assertTrue(state["active"])
        state, action = scene.next_scene_state(state, {"alex": False, "bettina": False, "dunja": False}, 200, 120)
        self.assertIsNone(action)
        state, action = scene.next_scene_state(state, {"alex": False, "bettina": False, "dunja": False}, 321, 120)
        self.assertEqual(action, "off")
        self.assertFalse(state["active"])

    def test_unknown_is_not_absent(self):
        with self.assertRaises(ValueError):
            scene.people_present({"alex": False, "bettina": None, "dunja": False})
        with self.assertRaises(ValueError):
            scene.people_present({"alex": False, "bettina": False})

    def test_second_employee_prevents_switching_off(self):
        state, action = scene.next_scene_state({"active": True, "away_since": 100},
                                                 {"alex": False, "bettina": True, "dunja": False}, 230, 120)
        self.assertIsNone(action)
        self.assertIsNone(state["away_since"])

    def test_dry_run_never_calls_output(self):
        called = []
        config = {"away_grace_seconds": 120}
        result = scene.tick(config, {}, now=500, dry_run=True,
                            presence_reader=lambda _: {"alex": True, "bettina": False, "dunja": False},
                            scene_runner=lambda *_: called.append("called"))
        self.assertEqual(result[1], "on")
        self.assertEqual(called, [])

    def test_disabled_fails_closed(self):
        with self.assertRaises(ValueError):
            scene.validate_config({"enabled": False})

    def test_misidentified_actor_is_rejected(self):
        dev = "3014F711A0000BA0C9A5EE53"
        cfg = {"actors": {
            "stiegenhaus": {"device_id": dev, "channel_index": 1, "expected_label": "Stiegenhaus"},
            "little_greene": {"device_id": dev, "channel_index": 1, "expected_label": "Little Greene"}
        }}
        class Fake:
            @staticmethod
            def hcu_get_system_state(_):
                return {"devices": {dev: {
                    "label": "Garagentor",
                    "functionalChannels": {"1": {"functionalChannelType": "SWITCH_CHANNEL"}}
                }}}
        with self.assertRaises(ValueError):
            scene.verify_hcu_actors({}, cfg, Fake())

    def test_hcu_uses_persistent_switch_not_gate_pulse(self):
        captured = {}
        class Fake:
            @staticmethod
            def hcu_system_request(conf, path, body, timeout):
                captured.update(path=path, body=body)
                return {"body": {"code": 200}}
        scene.set_hcu_switch({}, {"device_id": "3014F711A0000BA0C9A5EE53",
                                 "channel_index": 1, "expected_label": "stiegenhaus"},
                             False, Fake())
        self.assertEqual(captured["path"], "/hmip/device/control/setSwitchState")
        self.assertIs(captured["body"]["on"], False)

    def test_retries_state_after_failed_switch(self):
        cfg = {
            "enabled": True, "poll_seconds": 8, "away_grace_seconds": 120,
            "actors": {name: {"device_id": "3014F711A0000BA0C9A5EE53",
                              "channel_index": 1, "expected_label": name}
                       for name in ("stiegenhaus", "little_greene")},
            "sonos": {"ip": "192.168.10.111"}
        }
        actions = []
        def failing(*_):
            actions.append("on")
            raise RuntimeError("hardware offline")
        with self.assertRaises(RuntimeError):
            scene.tick(cfg, {}, now=10, dry_run=False,
                       presence_reader=lambda _: {"alex": True, "bettina": False, "dunja": False},
                       scene_runner=failing)
        self.assertEqual(actions, ["on"])


if __name__ == "__main__":
    unittest.main()
