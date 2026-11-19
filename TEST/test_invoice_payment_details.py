import unittest,tempfile,sqlite3,json
from pathlib import Path
from contextlib import contextmanager
from brain_invoice_payment_details import signed_amount,payment_events,private_invoice_entries
from brain_invoice_book import InvoiceBook
from brain_finance_source import FinanceStore,norm_method
from brain_finance_source_v2 import FinanceStore as FinanceStoreV2
from brain_currency_payment_v2 import _payment_method

class InvoiceAdjustments(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=Path(self.tmp.name)/'capture.db'
  def connect(db):
   c=sqlite3.connect(db);c.row_factory=sqlite3.Row;return c
  self.connect=connect;self.ns={'_capture_connection':connect,'CAPTURE_DB':self.db}
  c=connect(self.db)
  c.execute("""CREATE TABLE incoming_invoices(id INTEGER PRIMARY KEY,doc_id TEXT,document_type TEXT,supplier_name TEXT,supplier_invoice_number TEXT,invoice_date TEXT,net_due_date TEXT,due_date TEXT,gross_amount REAL,currency TEXT,iban TEXT,swift TEXT,account_holder TEXT,payment_state TEXT,payment_status TEXT,payment_method TEXT,pdf_path TEXT,workflow_status TEXT,skonto_enabled INTEGER,skonto_percent REAL,skonto_due_date TEXT,updated_at TEXT)""")
  for ident,number,kind,amount in [(1,'56981','Rechnung',438.36),(2,'60088','Gutschrift',331.56)]:
   c.execute("INSERT INTO incoming_invoices VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(ident,str(ident),kind,'WERO',number,'2026-11-16','','',amount,'EUR','','','','open','Offen','unknown','','zu_pruefen',0,None,'','2026-11-19'))
  c.commit();c.close()
 def tearDown(self):self.tmp.cleanup()
 def test_credit_sign_in_book_and_operational_items(self):
  self.assertEqual(signed_amount(-331.56,'Gutschrift'),-331.56)
  book=InvoiceBook(self.ns);rows=book._local(query='WERO',year=2026)
  self.assertAlmostEqual(sum(x['amount'] for x in rows),106.80);self.assertEqual(rows[0]['documentType'],'Gutschrift')
  op=FinanceStoreV2(self.ns).kristine(True);self.assertAlmostEqual(sum(x['amount'] for x in op),106.80)
 def test_private_method_and_single_readonly_clearing_entry(self):
  self.assertEqual(norm_method('alex_private'),'alex_private');self.assertEqual(_payment_method('alex_private'),'alex_private')
  store=FinanceStore(self.ns);store.set_meta('KRISTINE','kristine:1',method='alex_private')
  self.assertEqual(store.meta()[('KRISTINE','kristine:1')]['paymentStatus'],'paid')
  a=private_invoice_entries(self.ns);b=private_invoice_entries(self.ns)
  self.assertEqual(a,b);self.assertEqual(len(a),1);self.assertEqual(a[0]['amount'],'438.36');self.assertTrue(a[0]['locked']);self.assertIn('Zahlungsdatum nicht erfasst',a[0]['purpose'])
  self.assertEqual(FinanceStoreV2(self.ns).kristine(False)[0]['id'],'kristine:2')
  store.set_meta('KRISTINE','kristine:1',method='transfer',status='open');self.assertEqual(private_invoice_entries(self.ns),[])
 def test_verified_payment_history_and_no_false_payment_date(self):
  c=self.connect(self.db);c.executescript("""CREATE TABLE brain_statement_movements(id INTEGER,booking_date TEXT,value_date TEXT,source TEXT,currency TEXT,reference TEXT,status TEXT);CREATE TABLE brain_statement_allocations(id INTEGER,movement_id INTEGER,amount REAL,target_source TEXT,target_id TEXT,category TEXT);INSERT INTO brain_statement_movements VALUES(1,'2026-11-04','2026-11-05','Bank','EUR','Ref','reconciled'),(2,'2026-11-06','','Bank','EUR','Duplicate','duplicate');INSERT INTO brain_statement_allocations VALUES(1,1,438.36,'KRISTINE','kristine:1','supplier_payment'),(2,2,438.36,'KRISTINE','kristine:1','supplier_payment');""");c.commit();c.close()
  rows=payment_events(self.ns,'KRISTINE','kristine:1');self.assertEqual(len(rows),1);self.assertEqual(rows[0]['payment_date'],'2026-11-04');self.assertEqual(rows[0]['value_date'],'2026-11-05')
  self.assertEqual(payment_events(self.ns,'KRISTINE','kristine:2'),[])
if __name__=='__main__':unittest.main()
