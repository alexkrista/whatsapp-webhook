# coding: utf-8
"""Mahnstatus im Rechnungsbuch: isolierter Flask- und SQLite-Test, keine Produktivdaten."""
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

from flask import Flask
from brain_invoice_book import InvoiceBook, install


class BookDunningIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "capture.sqlite")
        c = self.con()
        c.execute("""CREATE TABLE incoming_invoices (
            id INTEGER PRIMARY KEY, doc_id TEXT, supplier_name TEXT,
            supplier_invoice_number TEXT, invoice_date TEXT, gross_amount REAL,
            currency TEXT, iban TEXT, swift TEXT, account_holder TEXT,
            payment_state TEXT, payment_status TEXT, payment_method TEXT, pdf_path TEXT
        )""")
        c.execute("""INSERT INTO incoming_invoices VALUES (
            135, '11502600508', 'Zentrale Inkassostelle Schweiz', '26.1034',
            '2026-08-24', 164.75, 'CHF', '', '', '', 'open', 'Offen', 'transfer', ''
        )""")
        c.commit()
        c.close()
        self.app = Flask(__name__)
        ns = dict(app=self.app, MOBILE_ALLOWED_PATHS=set(),
                  _capture_connection=self.con, CAPTURE_DB=self.path)
        install(ns)
        self.book = ns["invoice_book"]
        self.book.apply_legacy_paid_cutoff = lambda: {"applied": False}
        self.client = self.app.test_client()
        response = self.client.get("/incoming/invoice-book")
        self.assertEqual(response.status_code, 200)
        self.html = response.get_data(as_text=True)
        match = re.search(r"const token='([^']+)'", self.html)
        self.assertIsNotNone(match, "Invoice book CSRF token missing")
        self.headers = {
            "Origin": "http://localhost",
            "X-Invoice-Book": match.group(1),
        }

    def con(self, _ignored=None):
        con = sqlite3.connect(self.path)
        con.row_factory = sqlite3.Row
        return con

    def test_show_existing_dunning_and_actual_actor_in_book(self):
        body = dict(source="KRISTINE", id="kristine:135",
                    dunningLevel=2, feesAmount=15.80,
                    note="2. Mahnung laut Schreiben",
                    updatedBy="Dunja")
        denied = self.client.post("/incoming/invoice-book/dunning", json=body)
        self.assertEqual(denied.status_code, 403, denied.json)

        saved = self.client.post("/incoming/invoice-book/dunning",
                                 json=body, headers=self.headers)
        self.assertEqual(saved.status_code, 200, saved.json)
        self.assertEqual(saved.json["details"]["creditorUpdatedBy"], "Dunja")
        self.assertEqual(saved.json["invoice"]["dunningLevel"], 2)
        listing = self.client.get("/incoming/invoice-book/items?year=2026")
        self.assertEqual(listing.status_code, 200, listing.json)
        matches = [x for x in listing.json["items"] if x["id"] == "kristine:135"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["dunningLevel"], 2)
        self.assertEqual(matches[0]["feesAmount"], 15.8)
        self.assertEqual(matches[0]["creditorNote"], "2. Mahnung laut Schreiben")
        self.assertEqual(matches[0]["creditorUpdatedBy"], "Dunja")
        self.assertEqual(matches[0]["currency"], "CHF")
        self.assertEqual(matches[0]["amount"], 164.75,
                         "Mahnstatus must not alter invoice amount")

        with self.con() as con:
            record = con.execute(
                "SELECT updated_by,dunning_level,fees_amount FROM brain_creditor_details"
                " WHERE source='KRISTINE' AND source_id='kristine:135'"
            ).fetchone()
            self.assertEqual((record["updated_by"], record["dunning_level"],
                              record["fees_amount"]), ("Dunja", 2, 15.8))

    def test_editor_required_and_paid_invoice_locked(self):
        body = dict(source="KRISTINE", id="kristine:135", dunningLevel=3,
                    feesAmount=5, updatedBy="")
        r = self.client.post("/incoming/invoice-book/dunning",
                             json=body, headers=self.headers)
        self.assertEqual(r.status_code, 400)
        self.assertIn("Bearbeiter", r.json["error"])

        with self.con() as con:
            con.execute("UPDATE incoming_invoices SET payment_state='paid',"
                        " payment_status='Bezahlt' WHERE id=135")
        body["updatedBy"] = "Bettina"
        denied = self.client.post("/incoming/invoice-book/dunning",
                                  json=body, headers=self.headers)
        self.assertEqual(denied.status_code, 400, denied.json)
        with self.con() as con:
            count = con.execute("SELECT count(*) FROM brain_creditor_details").fetchone()[0]
        self.assertEqual(count, 0)

    def test_html_has_accessible_dunning_dialog_and_person_selection(self):
        self.assertIn('id="dunningDialog"', self.html)
        self.assertIn('data-dunning=', self.html)
        self.assertIn('id="dunningEditor"', self.html)
        self.assertIn('id="dunningSave"', self.html)
        self.assertIn("Mahnstufe", self.html)
        self.assertIn('updatedBy:actor', self.html)

    def test_winworker_and_local_lookups_use_same_dunning_overlay(self):
        book = InvoiceBook.__new__(InvoiceBook)
        class Store:
            def creditor_details(self):
                return {("WinWorker", "ww:7"): {"dunningLevel": 1,
                       "feesAmount": 4.20, "creditorNote": "Erste Erinnerung",
                       "creditorUpdatedBy": "Bettina", "creditorUpdatedAt": "2026-11-02"}}
        book.store = Store()
        rows = [
            {"source": "WinWorker", "id": "ww:7", "amount": 123.45},
            {"source": "KRISTINE", "id": "kristine:135", "amount": 164.75},
        ]
        got = book._with_creditor_details(rows)
        self.assertEqual(got[0]["dunningLevel"], 1)
        self.assertEqual(got[0]["creditorUpdatedBy"], "Bettina")
        self.assertEqual(got[1]["dunningLevel"], 0)
        self.assertEqual(got[1]["feesAmount"], 0)


if __name__ == "__main__":
    unittest.main()
