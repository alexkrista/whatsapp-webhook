from datetime import date
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
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

from brain_finance_direct_pay import DirectPay, fingerprint


class _Payments:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.drafts = {'draft': {'expires': time.time() + 60}}

    def db(self):
        return sqlite3.connect(self.path)

    def submit(self, _token, _confirmed):
        return {'results': [{'state': 'submitted'}]}


class _Store:
    def __init__(self):
        self.saved = []

    def set_meta(self, source, ident, **values):
        self.saved.append((source, ident, values))

    def set_status_override(self, source, ident, status):
        self.saved.append((source, ident, {'override': status}))

    def record_pending_supplier_payment(self, source, ident, batch, amount, currency):
        self.saved.append((source, ident, {'pending': amount, 'batch': batch, 'currency': currency}))

    def save_sepa_batch(self, *_args):
        raise RuntimeError('Archiv vorübergehend nicht verfügbar')


class DirectPayTests(unittest.TestCase):
    def test_submitted_status_is_saved_even_when_xml_archive_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            payments = _Payments(str(Path(tmp) / 'pay.db'))
            store = _Store()
            item = {'source': 'KRISTINE', 'id': 'kristine:1', 'remittanceText': 'R-1',
                    'paymentAmount': 100.0, 'availablePaymentAmount': 100.0, 'currency': 'EUR'}
            select = lambda _refs: ([dict(item)], 100.0)
            direct = DirectPay({'brain_bank_payments': {
                'payments': payments, 'client': object(), 'write_allowed': lambda: True,
            }}, select, lambda _items: {}, store)
            direct.drafts['draft'] = {
                'refs': [{'source': 'KRISTINE', 'id': 'kristine:1'}],
                'items': [dict(item)], 'hash': fingerprint([item]), 'xml': '<xml/>',
                'name': 'SEPA.xml', 'expires': time.time() + 60,
                'day': date.today().isoformat(), 'total': 100.0,
            }
            result = direct.submit('draft', True)
        self.assertEqual(store.saved[0][2]['pending'], 100.0)
        self.assertEqual(store.saved[1][2]['override'], 'sepa_submitted')
        self.assertEqual(store.saved[2][2]['status'], 'sepa_submitted')
        self.assertIn('XML-Sicherung', result['warning'])

    def test_partial_submission_stays_open_and_records_only_partial_amount(self):
        with tempfile.TemporaryDirectory() as tmp:
            payments = _Payments(str(Path(tmp) / 'pay.db'))
            store = _Store()
            item = {'source': 'WinWorker', 'id': 'ww:1', 'remittanceText': 'R-1',
                    'paymentAmount': 2500.0, 'availablePaymentAmount': 3000.0, 'currency': 'EUR'}
            direct = DirectPay({'brain_bank_payments': {
                'payments': payments, 'client': object(), 'write_allowed': lambda: True,
            }}, lambda _refs: ([dict(item)], 2500.0), lambda _items: {}, store)
            direct.drafts['draft'] = {
                'refs': [{'source': 'WinWorker', 'id': 'ww:1', 'paymentAmount': 2500.0}],
                'items': [dict(item)], 'hash': fingerprint([item]), 'xml': '<xml/>',
                'name': 'SEPA.xml', 'expires': time.time() + 60,
                'day': date.today().isoformat(), 'total': 2500.0,
            }
            direct.submit('draft', True)
        self.assertEqual(store.saved[0][2]['pending'], 2500.0)
        self.assertEqual(store.saved[1][2]['override'], 'open')
        self.assertEqual(store.saved[2][2]['status'], 'open')


if __name__ == '__main__':
    unittest.main()
