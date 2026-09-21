from pathlib import Path
from types import SimpleNamespace
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain_finance_source import FinanceStore, winworker_method


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, *_args):
        return self

    def fetchall(self):
        return self.rows


class _Connection:
    def __init__(self, rows):
        self._cursor = _Cursor(rows)

    def cursor(self):
        return self._cursor

    def close(self):
        pass


class FinanceOpenStateTests(unittest.TestCase):
    def test_winworker_lastschrift_label_is_recognized_as_direct_debit(self):
        self.assertEqual(winworker_method('', 'Lastschrift: Beglichen'), 'direct_debit')
        self.assertEqual(winworker_method('transfer', 'Lastschrift: Beglichen'), 'transfer')

    def test_sepa_submitted_winworker_invoice_remains_available_for_submitted_section(self):
        raw = SimpleNamespace(
            cID=7, sBelegnummer='R-7', dzBelegdatum='2026-09-18', dblBruttoBetrag=100,
            lVonAdrIndex=1, sZahlungsStatus='offen', sIban='', sSwift='',
            sBankkontoInhaber='', sDocID='', sFirma='Lieferant', sName='', sVorname='',
        )
        store = FinanceStore({
            'sql_connection': lambda _name: _Connection([raw]),
            '_payment_state': lambda _value: 'open',
            '_iso_date': lambda value: str(value)[:10],
        })
        store.legacy = lambda: {}
        store.meta = lambda: {('WinWorker', 'ww:7'): {
            'paymentMethod': 'transfer', 'paymentStatus': 'sepa_submitted',
            'paymentId': 'KRI-7',
        }}
        store.status_overrides = lambda: {}
        rows = store.ww(False)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['paymentStatus'], 'sepa_submitted')

    def test_live_sepa_status_wins_over_stale_open_override(self):
        raw = SimpleNamespace(
            cID=8, sBelegnummer='R-8', dzBelegdatum='2026-09-18', dblBruttoBetrag=100,
            lVonAdrIndex=1, sZahlungsStatus='An SEPA übergeben', sIban='', sSwift='',
            sBankkontoInhaber='', sDocID='', sFirma='Lieferant', sName='', sVorname='',
        )
        store = FinanceStore({
            'sql_connection': lambda _name: _Connection([raw]),
            '_payment_state': lambda _value: 'paid',
            '_iso_date': lambda value: str(value)[:10],
        })
        store.legacy = lambda: {}
        store.meta = lambda: {('WinWorker', 'ww:8'): {
            'paymentMethod': 'transfer', 'paymentStatus': 'sepa_submitted',
            'paymentId': 'KRI-8',
        }}
        store.status_overrides = lambda: {('WinWorker', 'ww:8'): 'open'}
        rows = store.ww(False)
        self.assertEqual(rows[0]['paymentStatus'], 'sepa_submitted')

    def test_operational_open_list_starts_on_26_november_2025_without_deleting_archive(self):
        rows = [
            {'id': 'old', 'invoiceDate': '2025-11-25', 'dueDate': '2025-11-25', 'source': 'WinWorker', 'amount': 1},
            {'id': 'cutoff', 'invoiceDate': '2025-11-26', 'dueDate': '2025-11-26', 'source': 'WinWorker', 'amount': 1},
            {'id': 'undated', 'invoiceDate': '', 'dueDate': '', 'source': 'KRISTINE', 'amount': 1},
        ]
        store = FinanceStore({})
        store.ww = lambda _include: [dict(row) for row in rows if row['source'] == 'WinWorker']
        store.kristine = lambda _include: [dict(row) for row in rows if row['source'] == 'KRISTINE']
        store.creditor_details = lambda: {}
        self.assertEqual([row['id'] for row in store.items(False)], ['undated', 'cutoff'])
        self.assertEqual({row['id'] for row in store.items(True)}, {'old', 'cutoff', 'undated'})


if __name__ == '__main__':
    unittest.main()
