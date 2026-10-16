import unittest
from flask import Flask, jsonify
from brain_revolut_monthly import monthly_rows, html_sheet, csv_sheet, install

class MonthlyTests(unittest.TestCase):
    def fixture(self):
        def move(id, day, direction, amount, status='reconciled', currency='EUR'):
            return {'id':id,'bookingDate':day,'valueDate':day,'direction':direction,'amount':amount,'status':status,'currency':currency,'counterpartyName':'Test <supplier>','reference':'=unsafe','remaining':0}
        return [{'source':'REVOLUT','accountIban':'AT-personal','movements':[move(1,'2026-08-01','out',12),move(2,'2026-09-01','in',40)]},{'source':'REVOLUT_BUSINESS','accountIban':'AT-business','movements':[move(3,'2026-08-01','out',10),move(4,'2026-08-31','in',50,'open'),move(5,'2026-08-20','out',4,currency='GBP')]}]
    def test_month_account_and_closed_payments(self):
        statements=self.fixture();statements.append(statements[1]);rows=monthly_rows(statements,'business','2026-08')
        self.assertEqual([x['id'] for x in rows],[3,5,4]);self.assertEqual([x['id'] for x in monthly_rows(statements,'personal','2026-08')],[1])
        html=html_sheet(rows,'business','2026-08');self.assertIn('40,00',html);self.assertIn('GBP',html);self.assertIn('zugeordnet',html);self.assertIn('&lt;supplier&gt;',html);self.assertNotIn('Test <supplier>',html);self.assertIn("'=unsafe",csv_sheet(rows))
    def test_endpoint_print_and_csv(self):
        app=Flask(__name__);allowed=set()
        @app.get('/statements')
        def brain_reconciliation_statements():return jsonify(ok=True,statements=self.fixture())
        install({'app':app,'MOBILE_ALLOWED_PATHS':allowed});client=app.test_client()
        self.assertIn('/incoming/revolut/monthly-statement',allowed)
        response=client.get('/incoming/revolut/monthly-statement?account=business&month=2026-08');self.assertEqual(response.status_code,200);self.assertIn(b'Drucken',response.data)
        response=client.get('/incoming/revolut/monthly-statement?account=personal&month=2026-08&format=csv');self.assertEqual(response.status_code,200);self.assertIn('attachment',response.headers['Content-Disposition']);self.assertNotIn(b'AT-business',response.data)
        self.assertEqual(client.get('/incoming/revolut/monthly-statement?account=x&month=2026-08').status_code,400)
if __name__=='__main__':unittest.main()
