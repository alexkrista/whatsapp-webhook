import unittest,tempfile,sqlite3,time
from pathlib import Path
from flask import Flask
from brain_finance_source import FinanceStore
import brain_finance_reconciliation
class SupplierSkontoTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=Path(self.tmp.name)/'db.sqlite'
  def connection(path=None):
   c=sqlite3.connect(self.db,timeout=.15);c.row_factory=sqlite3.Row;return c
  self.connect=connection;self.ns={'app':Flask(__name__),'MOBILE_PAGE':'<html><body></body></html>','_capture_connection':connection,'CAPTURE_DB':self.db,'MOBILE_ALLOWED_PATHS':set()}
  c=FinanceStore(self.ns).con();c.execute('CREATE TABLE incoming_invoices(id INTEGER PRIMARY KEY,gross_amount REAL,currency TEXT)');c.execute("INSERT INTO incoming_invoices VALUES(49,100,'EUR')");c.commit();c.close();brain_finance_reconciliation.install(self.ns);self.client=self.ns['app'].test_client();self.client.get('/incoming/reconciliation/statements')
  c=connection();c.execute("INSERT INTO brain_statement_imports(source,external_id,imported_at) VALUES('REVOLUT','s','now')");c.execute("INSERT INTO brain_statement_movements(statement_id,source,external_id,direction,amount,currency,created_at) VALUES(1,'REVOLUT','m','out',97,'EUR','now')");c.commit();c.close()
 def tearDown(self):self.tmp.cleanup()
 def body(self,**changes):
  line={'category':'supplier_payment','amount':97,'targetSource':'KRISTINE','targetId':'kristine:49','skontoAmount':3,'confirmSkonto':True};line.update(changes);return {'allocations':[line]}
 def test_discount_and_payment_saved_together_without_second_connection_lock(self):
  start=time.monotonic();r=self.client.post('/incoming/reconciliation/movements/1/allocate',json=self.body());self.assertEqual(r.status_code,200,r.json);self.assertLess(time.monotonic()-start,1);c=self.connect();self.assertEqual(c.execute('SELECT skonto_amount FROM brain_statement_allocations').fetchone()[0],3);self.assertEqual(c.execute('SELECT amount FROM brain_statement_allocations').fetchone()[0],97);c.close()
  row=FinanceStore(self.ns).allocation_overlay([{'source':'KRISTINE','id':'kristine:49','amount':100}])[0];self.assertEqual(row['amount'],0)
 def test_unconfirmed_skonto_not_written(self):
  r=self.client.post('/incoming/reconciliation/movements/1/allocate',json=self.body(confirmSkonto=False));self.assertEqual(r.status_code,400);c=self.connect();self.assertEqual(c.execute('SELECT COUNT(*) FROM brain_statement_allocations').fetchone()[0],0);c.close()
 def test_discount_over_three_percent_rejected(self):
  r=self.client.post('/incoming/reconciliation/movements/1/allocate',json=self.body(amount=96,skontoAmount=4));self.assertEqual(r.status_code,400)
if __name__=='__main__':unittest.main()
