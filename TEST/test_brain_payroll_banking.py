import unittest
import sys
import types
from datetime import date, datetime

# The test runner also works on workstations without the web server extras.
try:
    import flask
except ImportError:
    sys.modules['flask'] = types.SimpleNamespace(request=None, jsonify=None, Response=None)

from brain_finance_sepa import build_sepa_xml
from brain_konfipay import ConnectionError
from brain_konfipay_banking import review_xml
from brain_payroll_banking import prepare_payroll_file


class PayrollTests(unittest.TestCase):
    def setUp(self):
        self.xml, _ = build_sepa_xml([
            {'supplier': 'Person A', 'iban': 'AT611904300234573201', 'amount': '100.00', 'paymentId': 'WAGE-1', 'remittanceText': 'Gehalt A'},
            {'supplier': 'Person B', 'iban': 'DE89370400440532013000', 'amount': '200.50', 'paymentId': 'WAGE-2', 'remittanceText': 'Gehalt B'},
        ], 'Farben Krista GmbH & Co KG', 'AT611904300234573201', created_at=datetime.combine(date.today(), datetime.min.time()))

    def test_separate_blocks_keep_payment_content_and_total(self):
        source = review_xml(self.xml.decode())
        result = prepare_payroll_file(self.xml.decode(), 'wages', '2026-09')
        outgoing = review_xml(result['xml'])
        self.assertEqual(result['label'], 'Löhne 09/2026')
        self.assertEqual(outgoing['items'], source['items'])
        self.assertEqual(outgoing['total'], '300.50')
        self.assertEqual(len(outgoing['ids']), 3)
        self.assertIn('BtchBookg>false<', result['xml'])
        self.assertEqual(result['xml'].count('BtchBookg>false<'), 2)

    def test_contributions_and_instant_today(self):
        result = prepare_payroll_file(self.xml.decode(), 'contributions', date.today().isoformat(), True)
        self.assertIn('Abgaben ', result['label'])
        self.assertIn('>INST<', result['xml'])
        self.assertEqual(len(review_xml(result['xml'])['items']), 2)

    def test_invalid_period_rejected(self):
        with self.assertRaises(ConnectionError):
            prepare_payroll_file(self.xml.decode(), 'wages', '2026-13')

    def test_instant_rejects_future_execution(self):
        xml = self.xml.decode().replace(date.today().isoformat(), '2099-10-15')
        with self.assertRaisesRegex(ConnectionError, 'heute'):
            prepare_payroll_file(xml, 'wages', '2026-09', True)


if __name__ == '__main__':
    unittest.main()
