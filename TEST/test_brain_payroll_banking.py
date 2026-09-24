import unittest
import sys
import types
from xml.etree import ElementTree as ET
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

    def test_expired_source_requires_explicit_new_date(self):
        xml=self.xml.decode().replace(date.today().isoformat(),'2020-01-01')
        with self.assertRaisesRegex(ConnectionError,'Vergangenheit'):
            prepare_payroll_file(xml,'wages','2026-09')
        result=prepare_payroll_file(xml,'wages','2026-09',execution_date=date.today().isoformat())
        self.assertEqual(result['originalDates'],['2020-01-01'])
        self.assertEqual(review_xml(result['xml'])['items'][0]['date'],date.today().isoformat())

    def test_finanzamt_marker_and_reference_survive_as_one_payment(self):
        root=ET.fromstring(self.xml)
        first=next(x for x in root.iter() if x.tag.endswith('}CdtTrfTxInf'))
        purpose=ET.Element(first.tag.replace('CdtTrfTxInf','Purp'))
        ET.SubElement(purpose,first.tag.replace('CdtTrfTxInf','Cd')).text='TAXS'
        first.insert(-1,purpose)
        next(x for x in first.iter() if x.tag.endswith('}EndToEndId')).text='123456789'
        source=ET.tostring(root,encoding='unicode')
        result=prepare_payroll_file(source,'contributions',date.today().isoformat())
        self.assertEqual(result['taxCount'],1)
        self.assertEqual(len(result['files']),2)
        self.assertEqual([len(review_xml(f['xml'])['items']) for f in result['files']],[1,1])
        self.assertTrue(result['items'][0]['taxPayment'])
        self.assertFalse(result['items'][1].get('taxPayment',False))
        outgoing=ET.fromstring(result['files'][1]['xml'])
        actual=next(x for x in outgoing.iter() if x.tag.endswith('}CdtTrfTxInf'))
        self.assertEqual(ET.tostring(first),ET.tostring(actual))
        with self.assertRaisesRegex(ConnectionError,'Finanzamtszahlungen'):
            prepare_payroll_file(source,'contributions',date.today().isoformat(),True)


if __name__ == '__main__':
    unittest.main()
