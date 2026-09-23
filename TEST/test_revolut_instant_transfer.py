from datetime import datetime
import unittest
from xml.etree import ElementTree as ET

from brain_finance_sepa import build_sepa_xml


class RevolutInstantTransferTests(unittest.TestCase):
    def test_marks_file_as_sepa_instant_and_high_priority(self):
        xml, filename = build_sepa_xml([{
            'supplier': 'Farben Krista',
            'iban': 'AT611904300234573201',
            'amount': '100.00',
            'currency': 'EUR',
            'paymentId': 'KRISTA-REV-260923-ABC',
            'remittanceText': 'Interne Umbuchung Bank an Revolut',
        }], 'Farben Krista', 'AT825800010499323013', 'HYPVAT2B',
           datetime(2026, 9, 23, 9, 30), instant=True)
        names = [node.tag.rsplit('}', 1)[-1] for node in ET.fromstring(xml).iter()]
        values = {node.tag.rsplit('}', 1)[-1]: node.text for node in ET.fromstring(xml).iter()}
        self.assertEqual(values['InstrPrty'], 'HIGH')
        self.assertEqual(values['Cd'], 'INST')
        self.assertLess(names.index('InstrPrty'), names.index('SvcLvl'))
        self.assertLess(names.index('SvcLvl'), names.index('LclInstrm'))
        self.assertTrue(filename.startswith('SEPA_INSTANT_'))

    def test_standard_files_stay_standard(self):
        xml, filename = build_sepa_xml([{
            'supplier': 'Lieferant', 'iban': 'AT611904300234573201',
            'amount': '10.00', 'currency': 'EUR',
        }], 'Farben Krista', 'AT825800010499323013')
        text = xml.decode('utf-8')
        self.assertNotIn('<InstrPrty>', text)
        self.assertNotIn('<LclInstrm>', text)
        self.assertTrue(filename.startswith('SEPA_'))


if __name__ == '__main__':
    unittest.main()
