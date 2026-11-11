# coding: utf-8
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"/"windows-access-hotfix"))
from alex_scene_worker import execute

def job(action="arrive", expired=False):
    deadline=datetime.now(timezone.utc)+(timedelta(seconds=-3) if expired else timedelta(seconds=90))
    return {"id":"alexscene_"+"a"*24,"action":action,"expiresAt":deadline.isoformat()}

CFG={"http_port":8788,"admin_token":"TEST_ADMIN","alex_arrive_token":"TEST_COME","alex_away_token":"TEST_GO"}

class SafetyTests(unittest.TestCase):
    def test_arrival_requires_nonce_and_post_confirmation(self):
        called=[]
        def get(url,timeout=8):
            called.append(("get",url))
            self.assertIn("/alex/arrive/",url)
            return '<form><input type="hidden" name="confirmation" value="verylonguniqueonetimeNONCE123456789"></form>',url
        def post(url,values,timeout=10):
            called.append(("post",values))
            return "success","http://127.0.0.1:8788/alex/arrive/done"
        status=lambda cfg,getter:{"alex":True,"bettina":False,"dunja":False,
              "doors":{"1":"OPEN","2":"OPEN","3":"OPEN"}}
        result=execute(job(),CFG,getter=get,form_post=post,status_reader=status,
                       light_on=lambda s:"switched_on")
        self.assertTrue(result["ok"])
        self.assertEqual(result["light"],"switched_on")
        self.assertEqual([x[0] for x in called],["get","post"])
    def test_arrival_never_opens_without_confirmed_nonce(self):
        with self.assertRaisesRegex(RuntimeError,"Ankunftsbestätigung"):
            execute(job(),CFG,getter=lambda u:("no form",u))
    def test_leave_respects_existing_gantner_staff_state(self):
        calls=[]
        def getter(url,timeout=8):
            calls.append(url)
            return "Alex GEHT - bleibt OFFEN, solange Bettina da ist.",url
        status=lambda cfg,getter:{"alex":False,"bettina":True,"dunja":False,
              "doors":{"1":"OPEN","2":"OPEN","3":"OPEN"}}
        result=execute(job("away"),CFG,getter=getter,status_reader=status,
                       light_on=lambda s: self.fail("no direct off action allowed"))
        self.assertTrue(result["ok"])
        self.assertTrue(result["bettina"])
        self.assertEqual(result["light"],"existing_automatic")
        self.assertEqual(len(calls),1)
        self.assertIn("/alex/away/",calls[0])
    def test_stale_job_cannot_touch_hardware(self):
        with self.assertRaisesRegex(ValueError,"abgelaufen"):
            execute(job(expired=True),CFG,
                    getter=lambda u: self.fail("no network on expired message"))
    def test_doors_not_confirmed_after_safety_cutoff(self):
        def get(url,timeout=8):
            return '<input type="hidden" name="confirmation" value="verylonguniqueonetimeNONCE123456789">',url
        def post(url,values,timeout=10):
            return "", "http://127.0.0.1:8788/alex/arrive/done"
        status=lambda cfg,getter:{"alex":False,"bettina":False,"dunja":False,
                 "doors":{"1":"NORMAL","2":"NORMAL","3":"NORMAL"}}
        result=execute(job(),CFG,getter=get,form_post=post,status_reader=status,
                       light_on=lambda s: self.fail("no light action after 18:00"))
        self.assertFalse(result["ok"])
    def test_invalid_job_cannot_touch_hardware(self):
        with self.assertRaisesRegex(ValueError,"Unzulässiger"):
            execute({"id":"bad","action":"arrive","expiresAt":job()["expiresAt"]},CFG,
                    getter=lambda u: self.fail("no network"))
if __name__=="__main__":unittest.main()
