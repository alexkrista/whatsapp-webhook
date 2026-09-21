import sqlite3
import tempfile
import unittest
from pathlib import Path

from brain_finance_source import FinanceStore


class SupplierPartialPaymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "capture.db")

        def connect(_path):
            con = sqlite3.connect(self.path)
            con.row_factory = sqlite3.Row
            return con

        self.store = FinanceStore({"_capture_connection": connect, "CAPTURE_DB": self.path})

    def tearDown(self):
        self.tmp.cleanup()

    def test_submitted_parts_reduce_available_amount_and_are_consumed_fifo(self):
        self.store.record_pending_supplier_payment("WinWorker", "ww:1", "batch-1", 2500, "EUR")
        self.store.record_pending_supplier_payment("WinWorker", "ww:1", "batch-2", 300, "EUR")
        self.assertEqual(self.store.pending_supplier_totals()[("WinWorker", "ww:1")], 2800.0)

        result = self.store.settle_pending_supplier_payment("WinWorker", "ww:1", 2600)
        self.assertEqual(result, {"settled": 2600.0, "unmatched": 0.0})
        self.assertEqual(self.store.pending_supplier_totals()[("WinWorker", "ww:1")], 200.0)

        self.store.settle_pending_supplier_payment("WinWorker", "ww:1", 200)
        self.assertNotIn(("WinWorker", "ww:1"), self.store.pending_supplier_totals())


if __name__ == "__main__":
    unittest.main()
