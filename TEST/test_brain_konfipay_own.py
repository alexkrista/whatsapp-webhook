import sys,tempfile,sqlite3,unittest
from pathlib import Path
from datetime import date,timedelta
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from brain_konfipay_own import reconcile,outstanding
from brain_konfipay_expected import expected_balances
from brain_konfipay import ConnectionError

TODAY=date.today().isoformat()
ACCOUNT={'id':'a','iban':'AT1','currency':'EUR','amount':'1000.00','date':(date.today()-timedelta(days=1)).isoformat()}
def local(amount='100.00',ident='one'):
    return {'transfer':ident,'index':0,'uncertain':False,'item':{'debtorIban':'AT1','iban':'AT2','amount':amount,'endToEndId':ident,'date':TODAY}}
def tx(amount='100.00',ident='one',booking='pending'):
    return {'rId':'bank-'+ident,'iban':'AT2','bankAccount':{'rId':'a'},'currency':'EUR','creditDebitIndicator':'DBIT',
        'amount':amount,'endToEndId':ident,'bookingDate':TODAY,'_booking':booking}

class Payments:
    def __init__(self,path):self.path=path
    def db(self):
        db=sqlite3.connect(self.path);db.row_factory=sqlite3.Row
        db.executescript('CREATE TABLE IF NOT EXISTS bank_seen_payments(transfer_id TEXT,item_index INTEGER,bank_rid TEXT,PRIMARY KEY(transfer_id,item_index));CREATE TABLE IF NOT EXISTS transfers(id TEXT,count INTEGER,state TEXT,status TEXT,rid TEXT,created TEXT,error TEXT);')
        return db
    def content(self,ident):return {'items':[local(ident=ident)['item']]}
    def record(self,*args):pass
class Client:
    def __init__(self,payments):self.brain_payments=payments;self.status='FIN_UPLOAD_SUCCEEDED';self.booked=[]
    def auth_token(self):return 'fake'
    def accounts(self,token):return [ACCOUNT.copy()]
    def authenticated(self,method,path):
        assert method=='GET'
        if path.startswith('/transactions?'):return {'results':{'transactions':self.booked},'totalPages':1}
        return {'paymentInfo':{'status':{'statusValue':self.status}}}

class Tests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.p=Payments(Path(self.temp.name)/'test.db');self.c=Client(self.p)
    def tearDown(self):self.temp.cleanup()
    def test_unseen_reserved(self):self.assertEqual(reconcile(self.c,ACCOUNT,[local()],[])['ownOutgoing'],'100.00')
    def test_pending_not_reserved_and_not_permanently_retired(self):
        self.assertEqual(reconcile(self.c,ACCOUNT,[local()],[tx()])['ownOutgoing'],'0.00')
        self.assertEqual(reconcile(self.c,ACCOUNT,[local()],[])['ownOutgoing'],'100.00')
    def test_partial_batch(self):self.assertEqual(reconcile(self.c,ACCOUNT,[local(),local('40','two')],[tx()])['ownOutgoing'],'40.00')
    def test_booked_retired(self):
        reconcile(self.c,ACCOUNT,[local()],[tx(booking='booked')])
        db=self.p.db();self.assertEqual(db.execute('SELECT count(*) FROM bank_seen_payments').fetchone()[0],1);db.close()
    def test_missing_reference_ambiguous(self):
        with self.assertRaises(ConnectionError):reconcile(self.c,ACCOUNT,[local()],[dict(tx(),endToEndId='NOTPROVIDED')])
    def test_anonymous_pending_debit_still_shows_reported_balance(self):
        pending=dict(tx(),endToEndId=None,iban=None)
        with patch('brain_konfipay_own.outstanding',return_value=[local()]),patch('brain_konfipay_changes.remember',return_value={}),patch('brain_konfipay_pending.pending_transactions',return_value=[pending]):
            result=expected_balances(self.c)['accounts'][0]
        self.assertEqual(result['reportedBalance'],'900.00')
        self.assertEqual(result['pendingCount'],1)
        self.assertIsNone(result['expected'])
        self.assertIn('ohne Zahlungsreferenz',result['error'])
    def test_grouped_booking_ambiguous(self):
        second=local('40','two');second.update(transfer='one',index=1)
        with self.assertRaises(ConnectionError):reconcile(self.c,ACCOUNT,[local(),second],[tx('140','batch')])
    def test_unrelated_equal_amount_not_matched(self):self.assertEqual(reconcile(self.c,ACCOUNT,[local()],[tx(ident='other')])['ownOutgoing'],'100.00')
    def test_unknown_status_blocks(self):
        with self.assertRaises(ConnectionError):reconcile(self.c,ACCOUNT,[dict(local(),uncertain=True)],[])
    def test_rejected_and_future_excluded(self):
        db=self.p.db();db.execute("INSERT INTO transfers VALUES('one',1,'submitted','FIN_UPLOAD_SUCCEEDED','rid','now',NULL)");db.commit();db.close()
        self.c.status='FIN_REJECTED';self.assertEqual(outstanding(self.c),[])
        self.c.status='FIN_UPLOAD_SUCCEEDED'
        with patch.object(self.p,'content',return_value={'items':[dict(local()['item'],date=(date.today()+timedelta(days=1)).isoformat())]}):self.assertEqual(outstanding(self.c),[])
    def test_full_balance_no_double_after_bank_appears(self):
        with patch('brain_konfipay_own.outstanding',return_value=[local()]),patch('brain_konfipay_changes.remember',return_value={}),patch('brain_konfipay_pending.pending_transactions',return_value=[]):
            self.assertEqual(expected_balances(self.c)['accounts'][0]['expected'],'900.00')
            self.c.booked=[tx(booking='booked')]
            result=expected_balances(self.c)['accounts'][0]
            self.assertEqual(result['expected'],'900.00');self.assertEqual(result['ownOutgoing'],'0.00')
    def test_booking_in_base_not_subtracted_again(self):
        item=local();item['item']['date']=ACCOUNT['date']
        self.c.booked=[dict(tx(booking='booked'),bookingDate=ACCOUNT['date'])]
        with patch('brain_konfipay_own.outstanding',return_value=[item]),patch('brain_konfipay_changes.remember',return_value={}),patch('brain_konfipay_pending.pending_transactions',return_value=[]):
            result=expected_balances(self.c)['accounts'][0];self.assertEqual(result['expected'],'1000.00');self.assertEqual(result['ownOutgoing'],'0.00')
    def test_missing_historical_booking_not_double_reserved(self):
        item=local();item['item']['date']=ACCOUNT['date']
        with self.assertRaises(ConnectionError):reconcile(self.c,ACCOUNT,[item],[])

if __name__=='__main__':unittest.main()
