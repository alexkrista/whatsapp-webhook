from datetime import date
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain_cash_book import Book


class CashBookManualIncomingTests(unittest.TestCase):
    def test_manual_incoming_is_positive_and_uses_collision_free_negative_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = str(Path(tmp) / "cash.sqlite")

            def connection(_area):
                db = sqlite3.connect(database)
                db.row_factory = sqlite3.Row
                return db

            book = Book({"_capture_area_connection": connection})
            first = book.manual_incoming("test", date.today().isoformat(), "125,50", "Barzahlung Kunde", "B-1")
            second = book.manual_incoming("test", date.today().isoformat(), "1.00", "Bareinnahme", "B-2")
            loaded = book.load("test", date.today().year)

        self.assertEqual(first["nr"], -1)
        self.assertEqual(second["nr"], -2)
        self.assertEqual(first["cents"], 12550)
        self.assertEqual(first["direction"], "Eingang")
        self.assertTrue(first["manual"])
        self.assertEqual(loaded["net"], 12650)

    def test_manual_incoming_rejects_zero_and_missing_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = str(Path(tmp) / "cash.sqlite")

            def connection(_area):
                db = sqlite3.connect(database)
                db.row_factory = sqlite3.Row
                return db

            book = Book({"_capture_area_connection": connection})
            with self.assertRaises(ValueError):
                book.manual_incoming("test", date.today().isoformat(), "0", "Bareinnahme")
            with self.assertRaises(ValueError):
                book.manual_incoming("test", date.today().isoformat(), "10", "")


if __name__ == "__main__":
    unittest.main()
