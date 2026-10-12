import unittest,tempfile,sqlite3
from pathlib import Path
from brain_outgoing_store import OutgoingStore
from brain_settlement_accounts import SettlementLedger
from brain_finance_source import FinanceStore

class PrivateAndCandidateTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name);self.capture=root/'capture.db'
  c=self.connection(None);c.executescript('''CREATE TABLE brain_statement_movements(id INTEGER PRIMARY KEY,source TEXT,external_id TEXT,booking_date TEXT,currency TEXT,counterparty_name TEXT,reference TEXT,raw_text TEXT);
  CREATE TABLE brain_statement_allocations(id INTEGER PRIMARY KEY,movement_id INTEGER,category TEXT,amount REAL,note TEXT,created_at TEXT,target_source TEXT,target_id TEXT);''');c.commit();c.close()
  self.ns={'_capture_connection':self.connection,'CAPTURE_DB':str(self.capture)}
  self.store=OutgoingStore(root/'out.db',root/'pdf')
 def connection(self,_):
  c=sqlite3.connect(self.capture);c.row_factory=sqlite3.Row;return c
 def tearDown(self):self.tmp.cleanup()
 def insert(self,amount=25,category='alex_withdrawal',currency='EUR'):
  c=self.connection(None);c.execute("INSERT INTO brain_statement_movements VALUES(1,'REVOLUT_BUSINESS','tx','2026-10-12',?,'Shop','ref','Tally.so')",(currency,));c.execute("INSERT INTO brain_statement_allocations VALUES(1,1,?,?, 'Dunja: Privat ohne Beleg','now','KRISTINE','invoice-1')",(category,amount));c.commit();c.close()
 def test_private_expense_appears_once_and_is_removed_after_reclassification(self):
  self.insert();ledger=SettlementLedger(self.store,self.ns)
  for _ in range(2):
   result=ledger.list('alex');self.assertEqual(result['balances']['private'],'-25.00');self.assertEqual(len(result['rows']),1);self.assertTrue(result['rows'][0]['locked']);self.assertEqual(result['rows'][0]['origin'],'Revolut Business')
  c=self.connection(None);c.execute("UPDATE brain_statement_allocations SET category='other_expense'");c.commit();c.close();self.assertEqual(ledger.list('alex')['count'],0)
 def test_foreign_currency_does_not_change_euro_balance(self):
  self.insert(currency='USD');result=SettlementLedger(self.store,self.ns).list('alex');self.assertEqual(result['balances']['private'],'0.00');self.assertEqual(result['foreignBalances']['USD']['private'],'-25.00')
 def test_partial_invoice_has_only_remaining_amount_and_paid_invoice_is_zero(self):
  self.insert(amount=60,category='supplier_payment');f=FinanceStore(self.ns)
  row={'source':'KRISTINE','id':'invoice-1','amount':100,'paymentStatus':'open'};result=f.allocation_overlay([row])[0]
  self.assertEqual(result['amount'],40);self.assertEqual(result['invoiceAmount'],100);self.assertEqual(result['allocatedAmount'],60)
  c=self.connection(None);c.execute('UPDATE brain_statement_allocations SET amount=100');c.commit();c.close()
  result=f.allocation_overlay([{'source':'KRISTINE','id':'invoice-1','amount':100,'paymentStatus':'open'}])[0];self.assertEqual(result['amount'],0);self.assertEqual(result['paymentStatus'],'paid')
 def test_private_incoming_increases_balance(self):
  self.insert(category='alex_contribution');self.assertEqual(SettlementLedger(self.store,self.ns).list('alex')['balances']['private'],'25.00')
if __name__=='__main__':unittest.main()
