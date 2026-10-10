import tempfile, types, unittest, uuid
from pathlib import Path
from unittest.mock import patch
from brain_finance_sepa import build_sepa_xml
from brain_konfipay_banking import Payments
from brain_konfipay import ConnectionError

SOURCE='AT611904300234573201'
TARGET='DE89370400440532013000'

class DirectPath(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.calls=[]
        def request(method,path,**kwargs):
            self.calls.append((method,path))
            return {'paymentInfo':{'rId':str(uuid.uuid4()),'status':{'statusValue':'FIN_ACCEPTED'}}}
        self.client=types.SimpleNamespace(store=types.SimpleNamespace(folder=Path(self.tmp.name),exists=lambda:True),auth_token=lambda:'test',accounts=lambda _: [{'iban':SOURCE}],authenticated=request)
        self.payments=Payments(self.client)
        self.xml=build_sepa_xml([{'supplier':'Own Revolut','iban':TARGET,'amount':'100.00','paymentId':'DIRECT-TEST','remittanceText':'Own transfer'}],'Krista',SOURCE,instant=True)[0].decode()
        self.protection=patch('brain_konfipay_banking.protect',side_effect=lambda data,decrypt=False:data)
        self.protection.start()
    def tearDown(self):
        self.protection.stop();self.tmp.cleanup()
    def test_generic_upload_cannot_select_opt_out(self):
        draft=self.payments.prepare([{'name':'test.xml','xml':self.xml,'ownRevolutOptOut':True,'directOwnTransfer':True}])
        self.assertEqual(self.calls,[])
        self.payments.submit(draft['draft'],True)
        posts=[path for method,path in self.calls if method=='POST']
        self.assertEqual(len(posts),2)
        self.assertTrue(all('verification-of-payee=true' in path for path in posts))
    def test_only_validated_own_path_uses_opt_out_and_archives_it(self):
        draft=self.payments.prepare_own_revolut(self.xml,'test.xml',SOURCE,TARGET,'100.00')
        self.assertEqual(self.calls,[])
        with self.assertRaises(ConnectionError):self.payments.submit(draft['draft'],False)
        result=self.payments.submit(draft['draft'],True)
        self.assertTrue(all('verification-of-payee=false' in path for method,path in self.calls if method=='POST'))
        self.assertTrue(self.payments.content(result['results'][0]['id'])['ownRevolutOptOut'])
        with self.assertRaises(ConnectionError):self.payments.submit(draft['draft'],True)
    def test_mismatched_target_amount_and_batch_blocked(self):
        for source,target,amount in [(TARGET,SOURCE,'100.00'),(SOURCE,TARGET,'99.00'),(SOURCE,SOURCE,'100.00')]:
            with self.assertRaises(ConnectionError):self.payments.prepare_own_revolut(self.xml,'test.xml',source,target,amount)
        self.assertEqual(self.calls,[])

if __name__=='__main__':unittest.main()
