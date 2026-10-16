import base64
import sqlite3
import tempfile
import unittest
from pathlib import Path
from flask import Flask, jsonify
from brain_revolut_receipts import cache_receipts, install


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = str(Path(self.tmp.name)/'receipts.db')
        self.app = Flask(__name__)
        def connect(path):
            c=sqlite3.connect(path);c.row_factory=sqlite3.Row;return c
        self.connect=connect
        c=connect(self.db)
        c.execute('CREATE TABLE brain_statement_movements(id INTEGER,source TEXT,external_id TEXT)')
        c.executemany('INSERT INTO brain_statement_movements VALUES(?,?,?)',
                      [(1,'REVOLUT_BUSINESS','tx1'),(2,'REVOLUT','tx1'),(3,'REVOLUT_BUSINESS','tx2')])
        c.commit();c.close()
        self.app.add_url_rule('/statements','brain_reconciliation_statements',lambda:jsonify(ok=True,statements=[{'movements':[{'id':i} for i in (1,2,3)]}]))
        install({'app':self.app,'CAPTURE_DB':self.db,'_capture_connection':connect,'MOBILE_ALLOWED_PATHS':set()})
        self.client=self.app.test_client()

    def cache(self,tx,source='REVOLUT_BUSINESS'):
        c=self.connect(self.db)
        try:
            count=cache_receipts(c,source,tx);c.commit();return count
        finally:c.close()

    def test_exact_transaction_and_channel_link_without_intake(self):
        raw=b'%PDF-1.4 original'
        tx=[{'id':'tx1','attachments':[{'name':'photo.pdf','data':base64.b64encode(raw).decode()}]}]
        self.assertEqual(self.cache(tx),1)
        self.assertEqual(self.cache(tx),0)
        rows=self.client.get('/statements').json['statements'][0]['movements']
        self.assertEqual(len(rows[0]['receipts']),1)
        self.assertEqual(rows[1]['receipts'],[])
        self.assertEqual(rows[2]['receipts'],[])
        response=self.client.get(rows[0]['receipts'][0]['url'])
        self.assertEqual(response.data,raw)
        self.assertEqual(response.mimetype,'application/pdf')
        self.assertEqual(self.client.get('/incoming/revolut/receipt?id=999').status_code,404)

    def test_photo_signatures_and_multiple_receipts(self):
        tx=[{'transactionId':'tx1','attachments':[{'data':base64.b64encode(raw).decode()} for raw in (b'\xff\xd8\xffphoto',b'\x89PNG\r\n\x1a\nphoto')]}]
        self.assertEqual(self.cache(tx),2)
        rows=self.client.get('/statements').json['statements'][0]['movements']
        self.assertEqual(len(rows[0]['receipts']),2)

    def test_bad_files_and_missing_id_are_never_linked(self):
        self.assertEqual(self.cache([{'id':'tx1','attachments':[{'data':'invalid!'},{'data':base64.b64encode(b'<script>unsafe</script>').decode()}]},
                                    {'attachments':[{'data':base64.b64encode(b'%PDF-1.4').decode()}]}]),0)


if __name__=='__main__':unittest.main()
