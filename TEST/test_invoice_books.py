import tempfile
import unittest
from pathlib import Path
from brain_book_filters import filter_rows, monthly_totals
from brain_outgoing_book import OutgoingBook
from brain_outgoing_store import OutgoingStore


class BookTests(unittest.TestCase):
    def test_month_date_and_payment_filters(self):
        rows=[dict(invoiceDate='2026-08-01',paymentMethod='transfer'),
              dict(invoiceDate='2026-08-31',paymentMethod='direct_debit'),
              dict(invoiceDate='2026-09-01',paymentMethod='revolut'),
              dict(invoiceDate='2026-08-20',paymentMethod='cash')]
        self.assertEqual(len(filter_rows(rows,dict(month='2026-08',paymentChannel='bank'))),2)
        self.assertEqual(filter_rows(rows,dict(from_='unused',**{'from':'2026-08-31','to':'2026-09-01'})),rows[1:3])
        with self.assertRaises(ValueError):filter_rows(rows,{'from':'2026-09-01','to':'2026-08-31'})

    def test_month_totals_separate_currency_and_exclude_drafts(self):
        base=dict(invoiceDate='2026-08-01',status='issued',net=100,vat=20,gross=120,paid=60,open=60)
        totals=monthly_totals([dict(base,currency='EUR'),dict(base,currency='CHF'),
                               dict(base,currency='EUR',net=-20,vat=-4,gross=-24,paid=-24,open=0),
                               dict(base,currency='EUR',status='draft')])
        euro=next(x for x in totals if x['currency']=='EUR')
        self.assertEqual((euro['net'],euro['vat'],euro['gross'],euro['paid'],euro['open']),(80,16,96,36,60))
        self.assertEqual(euro['count'],2)

    def test_outgoing_partial_final_payments_and_drafts(self):
        with tempfile.TemporaryDirectory() as root:
            store=OutgoingStore(Path(root)/'book.db',Path(root)/'pdf')
            run=store.create_run(dict(label='Testlauf',projectNumber='26001',customerName='Test',street='Test 1',postalCode='6820',city='Frastanz'))
            def payload(amount,kind,day):
                return dict(runId=run['id'],kind=kind,issueDate=day,dueDate=day,serviceFrom=day,serviceTo=day,taxMode='AT20',
                            lines=[dict(description='Arbeit',quantity=1,unitPrice=amount)])
            first=store.prepare_issue(store.save_draft(payload(100,'TR','2026-08-01'))['id'])
            store.prepare_issue(store.save_draft(payload(250,'SR','2026-08-31'))['id'])
            store.add_payment(run['id'],dict(invoiceId=first['id'],paymentDate='2026-08-02',gross=60,source='MANUAL'))
            second_run=store.create_run(dict(label='Entwürfe',projectNumber='26002',customerName='Test',street='Test 1',postalCode='6820',city='Frastanz'))
            store.save_draft({**payload(20,'RE','2026-09-01'),'runId':second_run['id']})
            book=OutgoingBook(store,{})
            book.ww_rows=lambda year:[]
            rows=book.items(2026,{})
            self.assertEqual(len(rows),2)
            totals=monthly_totals(rows)[0]
            self.assertEqual((totals['net'],totals['vat'],totals['gross'],totals['paid'],totals['open']),(250,50,300,60,240))
            self.assertEqual(len(book.items(2026,{'state':'draft'})),1)
            self.assertEqual(monthly_totals(book.items(2026,{'state':'draft'})),[])
            mirror=dict(rows[0],source='WW',invoiceNumber=first['invoice_number'])
            book.ww_rows=lambda year:[mirror]
            self.assertEqual(len(book.items(2026,{})),2)  # Native invoice wins over duplicate WW number.


if __name__=='__main__':unittest.main()
