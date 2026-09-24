import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from brain_payment_excel import HEADERS, _cells, convert
from brain_konfipay_banking import review_xml


class ExcelPaymentTests(unittest.TestCase):
    def test_template_can_be_read_and_has_expected_headers(self):
        raw=(Path(__file__).resolve().parents[1]/'public'/'SEPA_Sammler_Vorlage.xlsx').read_bytes()
        cells=_cells(raw)
        self.assertEqual(tuple(cells.get((5,chr(65+i))) for i in range(6)),HEADERS)

    def test_valid_rows_produce_parseable_sepa_with_assignments(self):
        cells={(5,chr(65+i)):h for i,h in enumerate(HEADERS)}
        cells.update({(2,'B'):'AT611904300234573201',(3,'B'):date.today().isoformat(),
                      (6,'A'):'Test Empfänger',(6,'B'):'DE89370400440532013000',
                      (6,'C'):'123,45',(6,'D'):'Testzahlung',(6,'F'):'2'})
        with patch('brain_payment_excel._cells',return_value=cells):
            result=convert(b'irrelevant')
        self.assertEqual(result['assignments'],['2'])
        self.assertEqual(review_xml(result['xml'])['total'],'123.45')

    def test_duplicate_payment_is_rejected(self):
        cells={(5,chr(65+i)):h for i,h in enumerate(HEADERS)}
        cells.update({(2,'B'):'AT611904300234573201',(3,'B'):date.today().isoformat()})
        for n in (6,7):
            cells.update({(n,'A'):'Test',(n,'B'):'DE89370400440532013000',
                          (n,'C'):'123.45',(n,'D'):'Testzweck'})
        with patch('brain_payment_excel._cells',return_value=cells):
            with self.assertRaisesRegex(ValueError,'doppelte Zahlung'):convert(b'irrelevant')


if __name__=='__main__':unittest.main()
