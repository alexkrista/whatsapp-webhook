import os,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from flask import Flask,jsonify
import brain_lg_sync,brain_windows_env,brain_konfipay_banking
from brain_own_transfer_targets import transfer_targets

class Updates(unittest.TestCase):
    def test_sql_password_restore_is_narrow_and_non_overwriting(self):
        key=Mock();key.__enter__=Mock(return_value=key);key.__exit__=Mock(return_value=False)
        registry=types.SimpleNamespace(HKEY_CURRENT_USER=1,REG_SZ=1,REG_EXPAND_SZ=2,OpenKey=Mock(return_value=key),QueryValueEx=Mock(return_value=('test-secret',1)))
        with patch.dict(os.environ,{},clear=True),patch.object(brain_windows_env.os,'name','nt'),patch.dict(sys.modules,{'winreg':registry}):
            brain_windows_env.restore_sql_password()
            self.assertEqual(os.environ['KRISTINE_SQL_PASSWORD'],'test-secret')
            registry.QueryValueEx.assert_called_once_with(key,'KRISTINE_SQL_PASSWORD')
            os.environ['KRISTINE_SQL_PASSWORD']='existing'
            brain_windows_env.restore_sql_password()
            self.assertEqual(os.environ['KRISTINE_SQL_PASSWORD'],'existing')
            self.assertEqual(registry.QueryValueEx.call_count,1)

    def test_invoice_save_queues_receipt_and_review_preserves_turnover(self):
        app=Flask(__name__);calls=[]
        invoice={'id':1,'supplierName':'Little Greene','invoiceNumber':'TEST','invoiceDate':'2026-09-23','netAmount':10,'pdfText':'test'}
        app.add_url_rule('/save','incoming_capture_save',lambda:jsonify(ok=True,invoice=invoice),methods=['POST'])
        app.add_url_rule('/status','incoming_capture_status',lambda:jsonify(ok=True,invoice=invoice),methods=['POST'])
        ns={'app':app,'kristine_api_request':lambda url,**kw:calls.append(url) or {'ok':True}}
        with patch.object(brain_lg_sync,'_INSTALLED',False),patch.object(brain_lg_sync.threading,'Thread'):
            brain_lg_sync.install(ns)
        c=app.test_client()
        self.assertEqual(c.post('/save',json={'area':'live'}).status_code,200)
        self.assertEqual(calls,['/admin/api/paint/lg-incoming-sync'])
        calls.clear();c.post('/save',json={'area':'test'});self.assertEqual(calls,[])
        c.post('/status',json={'workflowStatus':'geprueft'})
        self.assertEqual(calls,['/admin/api/paint/lg-purchase','/admin/api/paint/lg-incoming-sync'])

    def test_two_targets_and_business_outage(self):
        business=Mock();business.transfer_accounts.return_value=[{'id':'business','currency':'EUR','name':'EUR','iban':'DE89370400440532013000','beneficiary':'Test company'}]
        targets,warnings=transfer_targets(business)
        self.assertEqual([t['name'] for t in targets],['Revolut','Revolut Business · EUR'])
        self.assertEqual(warnings,[])
        business.transfer_accounts.side_effect=RuntimeError('must not leak credentials')
        targets,warnings=transfer_targets(business)
        self.assertEqual(len(targets),1);self.assertNotIn('credentials',str(warnings))

    def test_configured_business_target_survives_api_outage(self):
        with patch.dict(os.environ,{'KRISTINE_REVOLUT_BUSINESS_OWN_IBAN':'DE89370400440532013000'}):
            targets,_=transfer_targets()
            self.assertEqual([t['name'] for t in targets],['Revolut','Revolut Business'])
            business=Mock();business.transfer_accounts.return_value=[{'id':'business','iban':'DE89370400440532013000','name':'EUR'}]
            targets,_=transfer_targets(business)
            self.assertEqual(len(targets),2,'API account and configured IBAN must not duplicate')

    def test_prepare_only_resolves_server_targets_and_never_submits(self):
        app=Flask(__name__);client=Mock();client.store.folder=Path(tempfile.gettempdir());client.accounts.return_value=[{'id':'hypo','name':'Hypo','iban':'AT825800010499323013','currency':'EUR'}]
        assignments=Mock();business=Mock();business.transfer_accounts.return_value=[{'id':'business','currency':'EUR','name':'EUR','iban':'DE89370400440532013000','beneficiary':'Test company'}]
        allowed=Mock(return_value=True)
        with patch('brain_konfipay_archive.install'),patch('brain_bank_assignment.install',return_value=assignments):
            brain_konfipay_banking.install({'app':app,'MOBILE_ALLOWED_PATHS':set(),'revolut_connection':business},client,allowed,'test')
        c=app.test_client();url='/konfipay/api/revolut-transfer-prepare'
        for target in ['own-revolut-2881','business']:
            r=c.post(url,json={'sourceAccountId':'hypo','revolutAccountId':target,'amount':'12.34'})
            self.assertEqual(r.status_code,200,r.get_json());self.assertIn('INST',r.get_json()['xml'])
        self.assertEqual(assignments.register_internal_revolut.call_count,2)
        client.authenticated.assert_not_called()
        for amount in ['NaN','Infinity','-1','0']:
            self.assertEqual(c.post(url,json={'sourceAccountId':'hypo','revolutAccountId':'business','amount':amount}).status_code,400)
        self.assertEqual(c.post(url,json={'sourceAccountId':'hypo','revolutAccountId':'attacker','amount':'1','iban':'DE89370400440532013000'}).status_code,400)
        allowed.return_value=False
        self.assertEqual(c.post(url,json={'sourceAccountId':'hypo','revolutAccountId':'business','amount':'1'}).status_code,400)

if __name__=='__main__':unittest.main()
