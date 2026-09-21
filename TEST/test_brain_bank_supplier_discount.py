from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import flask  # noqa: F401
except ModuleNotFoundError:
    stub = types.ModuleType('flask')
    stub.jsonify = lambda *args, **kwargs: (args, kwargs)
    stub.request = types.SimpleNamespace()
    sys.modules['flask'] = stub

from brain_bank_assignment import Assignments
from brain_outgoing_store import OutgoingStore


class SupplierDiscountTests(unittest.TestCase):
    def test_supplier_discount_settles_full_invoice(self):
        with tempfile.TemporaryDirectory() as tmp:
            outgoing = OutgoingStore(Path(tmp) / 'outgoing.db', Path(tmp) / 'pdf')
            service = Assignments({'app': SimpleNamespace(extensions={'kristine_outgoing_store': outgoing})})
            tx = dict(rId='tx-skonto', amount='98.00', currency='EUR',
                      creditDebitIndicator='DBIT', bookingDate='2026-09-18',
                      bankReference='SKONTO', bankAccount={'iban': 'AT00'}, purpose='R-1')
            service.observe([tx])
            candidate = dict(source='KRISTINE', target='kristine:1', label='Lieferant · R-1',
                             open='100.00', currency='EUR', number='R-1', e2e='KRI-1')
            service.candidates = lambda _tx: [candidate]
            result = service.assign({'rid': 'tx-skonto', 'lines': [dict(
                category='invoice', source='KRISTINE', target='kristine:1',
                amount='98.00', mode='discount', reason='',
            )]})
            original = dict(source='KRISTINE', id='kristine:1', supplier='Lieferant',
                            amount=100, currency='EUR', paymentStatus='sepa_submitted')
            self.assertEqual(result['lines'][0]['decision'], 'accepted')
            self.assertEqual(result['lines'][0]['difference'], '2.00')
            self.assertEqual(service.supplier_overlay([original]), [])


if __name__ == '__main__':
    unittest.main()
