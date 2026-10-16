import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfoNotFoundError
from brain_service_period import project_service_period

class ServicePeriodTests(unittest.TestCase):
    def test_windows_without_iana_timezone_data(self):
        with patch("brain_service_period.ZoneInfo", side_effect=ZoneInfoNotFoundError("missing")):
            self.assertEqual(project_service_period("1", [{"date":"2020-01-01","hours":1}], {})["serviceFrom"], "2020-01-01")

    def test_merges_old_ww_days_with_archived_and_live_kristine(self):
        bootstrap={'projectTimeArchive':[{'employeeId':'1','date':'2026-09-30','segments':[{'type':'work','jobId':'24138','from':'07:00','to':'12:00'}]}],
        'timeEvents':[{'employeeId':'1','date':'2026-10-06','type':'start','jobId':'24138','at':'07:00'},{'employeeId':'1','date':'2026-10-06','type':'ende','jobId':'24138','at':'17:00'}]}
        self.assertEqual(project_service_period('24138',[{'date':'2026-06-17','netHours':5}],bootstrap,'2026-10-07'),{'serviceFrom':'2026-06-17','serviceTo':'2026-10-06','workdays':3})
    def test_ignores_other_jobs_empty_hours_invalid_future_and_detached_events(self):
        rows=[{'date':'bad','netHours':8},{'date':'2026-10-09','netHours':8},{'date':'2026-08-01','netHours':0}]
        bootstrap={'projectTimeArchive':[{'employeeId':'1','date':'2026-08-02','segments':[{'type':'work','jobId':'other','from':'07:00','to':'12:00'}]}],'timeEvents':[{'employeeId':'2','date':'2026-08-03','type':'start','jobId':'24138','at':'07:00','detachedFromProject':True},{'employeeId':'2','date':'2026-08-03','type':'ende','at':'12:00'}]}
        self.assertEqual(project_service_period('24138',rows,bootstrap,'2026-10-07')['workdays'],0)
    def test_live_correction_replaces_archived_job_assignment(self):
        bootstrap={'projectTimeArchive':[{'employeeId':'1','date':'2026-08-02','segments':[{'type':'work','jobId':'24138','from':'07:00','to':'12:00'}]}],'timeEvents':[{'employeeId':'1','date':'2026-08-02','type':'start','jobId':'other','at':'07:00'},{'employeeId':'1','date':'2026-08-02','type':'ende','at':'12:00'}]}
        self.assertEqual(project_service_period('24138',[],bootstrap,'2026-10-07')['workdays'],0)
