import unittest,tempfile,sqlite3,re,json
from pathlib import Path
from flask import Flask
import brain_capture_edit
from brain_finance_source import FinanceStore
class EditAndLockTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=Path(self.tmp.name)/'db.sqlite';self.calls=0
 def connect(self,_=None):
  self.calls+=1;c=sqlite3.connect(self.db,timeout=.1);c.row_factory=sqlite3.Row;return c
 def tearDown(self):self.tmp.cleanup()
 def test_meta_update_reuses_transaction_and_rolls_back_with_allocation(self):
  f=FinanceStore({'_capture_connection':self.connect,'CAPTURE_DB':str(self.db)});c=f.con();self.calls=0;c.execute('BEGIN IMMEDIATE');result=f.set_meta('KRISTINE','kristine:49',status='paid',connection=c);self.assertEqual(self.calls,0);self.assertEqual(result['paymentStatus'],'paid');c.rollback();c.close();self.assertEqual(f.meta(),{})
 def setup_edit(self,reviewed=False):
  source=Path('brain_capture_edit.py').read_text();columns=set(re.findall(r'\b([a-z_]+)=\?',source[source.index('UPDATE incoming_invoices SET'):source.index('WHERE id=?',source.index('UPDATE incoming_invoices SET'))]));columns.update(['workflow_status','doc_id']);c=self.connect();c.execute('CREATE TABLE incoming_invoices(id INTEGER PRIMARY KEY,'+','.join(k+' TEXT' for k in sorted(columns))+')');c.execute('CREATE TABLE incoming_allocations(invoice_id INTEGER,line_no INTEGER,account TEXT,cost_type TEXT,cost_center TEXT,project_id TEXT,description TEXT,net_amount REAL,vat_rate REAL)');c.execute("INSERT INTO incoming_invoices(id,workflow_status,doc_id,supplier_address_id,supplier_invoice_number_norm,gross_amount,net_amount,vat_amount,created_by) VALUES(49,?,'11502600422','kri:hornbach','2905','39.75','33.17','6.58','Dunja')",('geprueft' if reviewed else 'zu_pruefen',));c.execute("INSERT INTO incoming_allocations VALUES(49,1,'5000','Material','','','Handpad',33.17,20)");c.commit();c.close();app=Flask(__name__);brain_capture_edit.install({'app':app,'MOBILE_PAGE':'<html><style></style><body></body></html>','_capture_area':lambda x:x,'_capture_area_connection':self.connect,'_capture_truthy':bool,'_norm_iban':lambda x:x or '', '_capture_supplier_context':lambda *x:{},'_iban_valid':lambda x:True});return app.test_client()
 def payload(self):return {'supplier':{'addressId':'kri:hornbach','name':'Hornbach'},'supplierInvoiceNumber':'2905','invoiceDate':'2026-08-11','netAmount':33.17,'vatAmount':6.63,'grossAmount':39.8,'createdBy':'Dunja','allocations':[{'netAmount':33.17,'account':'5000','vatRate':20}]}
 def test_capture_amount_can_be_corrected_and_old_values_are_audited(self):
  client=self.setup_edit();r=client.put('/incoming/capture/49/edit',json=self.payload());self.assertEqual(r.status_code,200,r.json);self.assertEqual(r.json['invoice']['grossAmount'],39.8);c=self.connect();old=json.loads(c.execute('SELECT invoice_json FROM incoming_capture_edit_history').fetchone()[0]);self.assertEqual(old['gross_amount'],'39.75');c.close()
 def test_reviewed_capture_requires_confirmation_and_returns_to_review(self):
  client=self.setup_edit(True);self.assertEqual(client.put('/incoming/capture/49/edit',json=self.payload()).status_code,409);payload=self.payload();payload['confirmReopen']=True;r=client.put('/incoming/capture/49/edit',json=payload);self.assertEqual(r.status_code,200,r.json);self.assertEqual(r.json['invoice']['workflowStatus'],'zu_pruefen')
if __name__=='__main__':unittest.main()
