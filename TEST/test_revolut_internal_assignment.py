import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.modules.setdefault('flask', SimpleNamespace(request=None, jsonify=None))
from brain_bank_assignment import Assignments


class Store:
    def __init__(self, path): self.path = path
    def connect(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection
    def _audit(self, *args, **kwargs): pass


class RevolutInternalAssignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / 'bank.sqlite')
        self.service = Assignments({'app': type('App', (), {'extensions': {'kristine_outgoing_store': self.store}})()})
        self.service.register_internal_revolut(end_to_end='KRISTA-REV-TEST-1', debtor_iban='AT11 1111',
            creditor_iban='LT22 2222', amount_cents=12345, purpose='Interne Umbuchung')

    def tearDown(self): self.temp.cleanup()

    def transaction(self, **changes):
        item = {'rId':'bank-1','bankReference':'ref-1','bookingDate':'2026-09-23','creditDebitIndicator':'DBIT',
            'amount':'123.45','currency':'EUR','endToEndId':'KRISTA-REV-TEST-1','iban':'LT222222',
            'bankAccount':{'iban':'AT111111'},'purpose':'Interne Umbuchung'}
        item.update(changes)
        return item

    def test_exact_match_is_assigned_as_neutral_revolut_transfer(self):
        self.service.observe([self.transaction()])
        with self.service.db() as connection:
            assignment = connection.execute('SELECT * FROM bank_assignments WHERE rid=?',('bank-1',)).fetchone()
            line = connection.execute('SELECT * FROM bank_assignment_lines WHERE rid=?',('bank-1',)).fetchone()
        self.assertIsNotNone(assignment)
        self.assertEqual(line['category'], 'internal_revolut')
        self.assertIn('Automatisch erkannt', assignment['note'])

    def test_amount_mismatch_is_not_auto_assigned(self):
        self.service.observe([self.transaction(rId='bank-2', amount='123.44')])
        with self.service.db() as connection:
            assignment = connection.execute('SELECT 1 FROM bank_assignments WHERE rid=?',('bank-2',)).fetchone()
        self.assertIsNone(assignment)


if __name__ == '__main__': unittest.main()
