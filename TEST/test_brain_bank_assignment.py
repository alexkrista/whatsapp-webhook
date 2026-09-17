import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

import tempfile, unittest
from unittest.mock import patch
from flask import Flask, jsonify
from brain_outgoing_store import OutgoingStore
from brain_bank_assignment import install, cents

class AssignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); root=Path(self.temp.name)
        self.store=OutgoingStore(root/'outgoing.db',root/'pdf')
        self.app=Flask(__name__);self.app.extensions['kristine_outgoing_store']=self.store
        self.ns={'app':self.app,'MOBILE_ALLOWED_PATHS':set()}
        self.s=install(self.ns,lambda:True)
        self.invoice=self.new_invoice()
        self.tx=dict(rId='tx-1',amount='100.00',currency='EUR',creditDebitIndicator='CRDT',
            bookingDate='2026-09-11',bankReference='REF1',bankAccount={'iban':'TEST'},name='Muster',purpose='Test')
        self.s.observe([self.tx])
        def issue(ident): return jsonify(ok=True,invoice=self.store.prepare_issue(ident))
        self.app.view_functions['outgoing_invoice_issue']=issue

    def new_invoice(self):
        run=self.store.create_run(dict(label='Test',customerName='Muster',street='Straße 1',postalCode='1234',city='Test'))
        draft=self.store.save_draft(dict(runId=run['id'],kind='RE',issueDate='2026-09-01',dueDate='2026-09-11',
            serviceFrom='2026-09-01',serviceTo='2026-09-01',taxMode='AT20',lines=[dict(description='Test',quantity=1,unitPrice='100')]))
        return self.store.prepare_issue(draft['id'])

    def body(self, **changes):
        line=dict(category='invoice',source='OUTGOING',target=str(self.invoice['id']),amount='100.00',mode='partial',reason='')
        line.update(changes);return dict(rid='tx-1',lines=[line])

    def tearDown(self): self.temp.cleanup()

    def test_partial_green_op_open_and_retry_idempotent(self):
        data=self.s.assign(self.body());self.assertTrue(data['assigned']);self.assertEqual(data['lines'][0]['open'],'20.00')
        self.s.assign(self.body())
        with self.s.db() as c:self.assertEqual(c.execute("SELECT COUNT(*) FROM outgoing_payments WHERE source='KONFIPAY'").fetchone()[0],1)

    def test_deduction_task_failure_retains_assignment_and_balance(self):
        data=self.s.assign(self.body(mode='deduction',reason='Abzug prüfen'))
        self.assertTrue(data['assigned']);self.assertEqual(data['lines'][0]['decision'],'pending')
        self.assertTrue(data['lines'][0]['task_error']);self.assertEqual(data['lines'][0]['open'],'20.00')

    def test_approved_credit_is_linked_and_retry_safe(self):
        data=self.s.assign(self.body(mode='deduction',reason='Mangel anerkannt'));ident=data['lines'][0]['id']
        with self.app.test_request_context():
            out=self.s.decide(ident,True);self.s.decide(ident,True)
        self.assertEqual(out['lines'][0]['open'],'0.00');self.assertEqual(out['lines'][0]['decision'],'approved')
        with self.s.db() as c:
            rows=c.execute("SELECT * FROM outgoing_invoices WHERE kind='GS'").fetchall()
            self.assertEqual(len(rows),1);self.assertEqual(rows[0]['corrects_invoice_id'],self.invoice['id'])

    def test_rejected_keeps_op(self):
        data=self.s.assign(self.body(mode='discount',reason='Frist überschritten'))
        out=self.s.decide(data['lines'][0]['id'],False)
        self.assertEqual(out['lines'][0]['open'],'20.00');self.assertEqual(out['lines'][0]['decision'],'rejected')

    def test_failed_pdf_retry_keeps_single_credit(self):
        data=self.s.assign(self.body(mode='deduction',reason='Mangel'));ident=data['lines'][0]['id']
        original=self.app.view_functions['outgoing_invoice_issue']
        self.app.view_functions['outgoing_invoice_issue']=lambda ident:(jsonify(ok=False),500)
        with self.app.test_request_context():
            with self.assertRaises(ValueError):self.s.decide(ident,True)
            self.app.view_functions['outgoing_invoice_issue']=original
            out=self.s.decide(ident,True)
        self.assertEqual(out['lines'][0]['decision'],'approved')
        with self.s.db() as c:self.assertEqual(c.execute("SELECT count(*) FROM outgoing_invoices WHERE kind='GS'").fetchone()[0],1)

    def test_changed_remainder_blocks_credit(self):
        data=self.s.assign(self.body(mode='deduction',reason='Prüfen'))
        self.store.add_payment(self.invoice['run_id'],dict(invoiceId=self.invoice['id'],gross='20',paymentDate='2026-09-11'))
        with self.assertRaisesRegex(ValueError,'geändert'):self.s.decide(data['lines'][0]['id'],True)

    def test_task_creation_and_completion(self):
        tasks=[]
        def api(path,method='GET',payload=None):
            if method=='PUT': tasks[:]=payload['tasks'];return {'ok':True}
            return {'tasks':tasks.copy(),'employees':[{'id':'alex','name':'Alexander Krista'}]}
        self.ns['kristine_api_request']=api
        data=self.s.assign(self.body(mode='deduction',reason='Prüfen'))
        self.s.sync_tasks('tx-1');self.assertEqual(len(tasks),1);self.assertEqual(tasks[0]['assigneeId'],'alex')
        self.s.decide(data['lines'][0]['id'],False);self.assertEqual(tasks[0]['status'],'done')

    def test_split_and_mismatch_rollback(self):
        second=self.new_invoice();body=self.body(amount='50.00')
        body['lines'].append(dict(body['lines'][0],target=str(second['id']),amount='49.99'))
        with self.assertRaises(ValueError):self.s.assign(body)
        with self.s.db() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM outgoing_payments').fetchone()[0],0)
        body['lines'][1]['amount']='50.00';data=self.s.assign(body)
        self.assertEqual(len(data['lines']),2)

    def test_overpay_and_invalid_decimals(self):
        self.tx['amount']='130.00';self.s.observe([self.tx])
        with self.assertRaises(ValueError):self.s.assign(self.body(amount='130.00'))
        for v in ('NaN','Infinity','1.001'):
            with self.assertRaises(ValueError):cents(v)

    def test_duplicate_bank_reference_blocked(self):
        self.s.assign(self.body());self.s.observe([dict(self.tx,rId='tx-2')])
        body=self.body();body['rid']='tx-2'
        with self.assertRaisesRegex(ValueError,'Bankreferenz'):self.s.assign(body)

    def test_pending_unobserved_and_csrf(self):
        body=self.body();body['rid']='pending-only'
        with self.assertRaises(ValueError):self.s.assign(body)
        app=Flask('guard');app.extensions['kristine_outgoing_store']=self.store
        install({'app':app,'MOBILE_ALLOWED_PATHS':set()},lambda:False)
        self.assertEqual(app.test_client().post('/konfipay/api/assignment-save',json=self.body()).status_code,403)

    def test_supplier_partial_overlay_and_full(self):
        original=dict(source='KRISTINE',id='kristine:1',supplier='Test',amount=120,currency='EUR',paymentStatus='sepa_submitted')
        with self.s.db() as c:
            c.execute("INSERT INTO bank_assignments(rid,fingerprint,payload,note,recurring,created) VALUES('s','s','{}','',0,'now')")
            c.execute("INSERT INTO bank_assignment_lines(rid,category,source,target,label,paid,difference,mode,reason,decision) VALUES('s','invoice','KRISTINE','kristine:1','Test',10000,2000,'partial','','none')");c.commit()
        row=self.s.supplier_overlay([original])[0]
        self.assertEqual(row['amount'],20);self.assertEqual(row['paymentStatus'],'open')
        with self.s.db() as c:c.execute('UPDATE bank_assignment_lines SET paid=12000');c.commit()
        self.assertEqual(self.s.supplier_overlay([original]),[])

    def test_cost_category_and_frequency_are_saved_without_invoice(self):
        data=self.s.assign({'rid':'tx-1','frequency':'quarterly','lines':[
            {'category':'electricity','amount':'100.00','reason':''}
        ]})
        self.assertEqual(data['lines'][0]['label'],'Strom')
        self.assertEqual(data['frequency'],'quarterly')
        self.assertEqual(data['frequencyLabel'],'Vierteljährlich')

    def test_renovation_installment_uses_fixed_schedule(self):
        data=self.s.assign({'rid':'tx-1','frequency':'monthly','lines':[
            {'category':'renovation_installment','amount':'100.00','reason':''}
        ]})
        self.assertEqual(data['frequency'],'fixed')
        self.assertEqual(data['scheduleDates'],['2026-08-31','2027-08-26','2027-08-31','2028-02-26'])

if __name__=='__main__':unittest.main()

