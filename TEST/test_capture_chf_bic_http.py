# coding: utf-8
"""Ensure CHF validation runs before any save or edit handler."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from flask import Flask, jsonify, request
from brain_currency_payment_v2 import install


class CaptureChfBicHTTP(unittest.TestCase):
    def test_save_edit_and_persist(self):
        with tempfile.TemporaryDirectory() as temp:
            db = Path(temp) / "test.db"
            def connect(_area):
                c=sqlite3.connect(db)
                c.row_factory=sqlite3.Row
                return c
            with connect("test") as c:
                c.execute("CREATE TABLE incoming_invoices(id INTEGER PRIMARY KEY,currency TEXT,swift TEXT,gross_amount REAL,updated_at TEXT)")
            app=Flask(__name__)
            @app.post("/incoming/capture/save")
            def incoming_capture_save():
                d=json.loads(request.form.get("payload") or "{}")
                with connect("test") as c:
                    r=c.execute("INSERT INTO incoming_invoices(currency,swift) VALUES(?,?)",(d["currency"],""))
                    id=r.lastrowid
                return jsonify(ok=True,invoice={"id":id})
            @app.put("/incoming/capture/<int:invoice_id>/edit")
            def brain_capture_edit_save(invoice_id):
                return jsonify(ok=True,invoice={"id":invoice_id})
            params = {
                "app": app,
                "MOBILE_PAGE": (
                    '<html><style></style><body>'
                    '<div class="full"><input id="captureInvoiceIban"></div>'
                    '<div id="captureBankWarning" class="full"></div></body></html>'
                ),
                "_capture_area": lambda x: x,
                "_capture_area_connection": connect,
            }
            install(params)
            html = params["MOBILE_PAGE"]
            self.assertIn('id="captureBic"', html)
            self.assertIn('id="captureBicWrap"', html)
            self.assertLess(html.index('id="captureInvoiceIban"'),
                            html.index('id="captureBic"'))
            self.assertLess(html.index('id="captureBic"'),
                            html.index('id="captureBankWarning"'))
            self.assertNotIn('id="captureBicWrap" hidden', html)
            self.assertNotIn('bicWrap.hidden=', html)
            cl=app.test_client()
            def save(p):
                return cl.post("/incoming/capture/save",data={"payload":json.dumps(p)})
            def update(id,p):
                return cl.put("/incoming/capture/"+str(id)+"/edit",json=p)
            p={"area":"test","currency":"CHF","grossAmount":164.75}
            self.assertEqual(save(p).status_code,400)
            with connect("test") as c:
                self.assertEqual(c.execute("SELECT COUNT(*) FROM incoming_invoices").fetchone()[0],0)
            r=save({**p,"swift":"TESTCHZZXXX"})
            self.assertEqual(r.status_code,200,r.json)
            id=r.json["invoice"]["id"]
            self.assertEqual(update(id,p).status_code,400)
            self.assertEqual(update(id,{**p,"swift":"ABCDCHZZ"}).status_code,200)
            with connect("test") as c:
                self.assertEqual(c.execute("SELECT swift FROM incoming_invoices WHERE id=?",(id,)).fetchone()[0],"ABCDCHZZ")
            self.assertEqual(save({"area":"test","currency":"EUR"}).status_code,200)


if __name__=="__main__":
    unittest.main()
