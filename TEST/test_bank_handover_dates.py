import unittest, tempfile, types, uuid
from pathlib import Path
from unittest.mock import patch
from datetime import datetime, timedelta, timezone, date
from xml.etree import ElementTree as ET
from brain_finance_sepa import build_sepa_xml
from brain_konfipay_banking import refresh_handover_dates, review_xml, Payments
from brain_konfipay import ConnectionError

class HandoverDates(unittest.TestCase):
    def xml(self, instant=False, created=None):
        return build_sepa_xml([{'supplier':'Test','iban':'DE89370400440532013000','amount':'120.50','paymentId':'END-1','remittanceText':'Invoice A'}], 'Krista','AT611904300234573201',created_at=created or datetime(2026,9,22,8,0),instant=instant)[0].decode()
    def test_old_batch_only_changes_dates(self):
        original=self.xml(True);now=datetime(2026,10,8,10,0,tzinfo=timezone(timedelta(hours=2)))
        outgoing=refresh_handover_dates(original,now);before=review_xml(original,allow_past=True);after=review_xml(outgoing,allow_past=True)
        self.assertEqual(after['ids'],before['ids']);self.assertEqual(after['total'],before['total'])
        self.assertEqual(after['items'][0],{**before['items'][0],'date':'2026-10-08'})
        self.assertIn('2026-10-08T10:00:00+02:00',outgoing)
    def test_future_normal_payment_preserved_but_instant_today(self):
        now=datetime(2026,10,8,10,0);future=datetime(2026,10,20,8,0)
        self.assertEqual(review_xml(refresh_handover_dates(self.xml(created=future),now),allow_past=True)['items'][0]['date'],'2026-10-20')
        self.assertEqual(review_xml(refresh_handover_dates(self.xml(True,future),now),allow_past=True)['items'][0]['date'],'2026-10-08')
    def test_actual_bank_payload_and_archive_are_fresh_and_duplicate_is_blocked(self):
        with tempfile.TemporaryDirectory() as directory,patch('brain_konfipay_banking.protect',side_effect=lambda data,decrypt=False:data):
            payloads=[];rid=str(uuid.uuid4())
            def request(method,path,**kwargs):
                if 'body' in kwargs:payloads.append(kwargs['body'].decode())
                return {'paymentInfo':{'rId':rid,'status':{'statusValue':'ACCEPTED'}}}
            client=types.SimpleNamespace(store=types.SimpleNamespace(folder=Path(directory),exists=lambda:True),auth_token=lambda:'test',accounts=lambda _: [{'iban':'AT611904300234573201'}],authenticated=request)
            payments=Payments(client);old=self.xml(True);draft=payments.prepare([{'name':'old.xml','xml':old}]);result=payments.submit(draft['draft'],True)
            self.assertEqual(result['results'][0]['state'],'submitted');self.assertEqual(review_xml(payloads[0])['items'][0]['date'],date.today().isoformat());self.assertIn(date.today().isoformat(),payloads[0])
            self.assertEqual(payments.content(result['results'][0]['id'])['xml'],payloads[0])
            with self.assertRaises(ConnectionError):payments.prepare([{'name':'old.xml','xml':old}])
if __name__=='__main__':unittest.main()
