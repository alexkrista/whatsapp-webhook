import io
import json
import unittest
from flask import Flask, jsonify
from brain_capture_iban import install


class CaptureIbanTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.writes = 0
        self.master = ""
        def write(**kwargs):
            self.writes += 1
            return jsonify(ok=True)
        self.app.add_url_rule('/incoming/capture/save', view_func=write, methods=['POST'])
        self.app.add_url_rule('/incoming/capture/<int:invoice_id>/edit', 'edit', write, methods=['PUT'])
        install({'app':self.app, 'MOBILE_PAGE':'</body>', '_capture_area':lambda x:x,
                 '_capture_truthy':lambda x:str(x).lower() in ('true','1','yes'),
                 '_norm_iban':lambda x:str(x or '').replace(' ','').upper(),
                 '_iban_valid':lambda x:x == 'DE57763510400000200600',
                 '_capture_supplier_context':lambda *args:{'latestIban':self.master}})
        self.client = self.app.test_client()

    def send(self, payload, edit=False):
        if edit:
            return self.client.put('/incoming/capture/79/edit', json=payload)
        return self.client.post('/incoming/capture/save', data={'payload':json.dumps(payload),'file':(io.BytesIO(b'pdf'),'invoice.pdf')})

    def test_sepa_missing_and_invalid_block_before_write(self):
        for edit in (False,True):
            for iban in ('','invalid'):
                self.assertEqual(self.send({'paymentMethod':'transfer','masterIban':iban}, edit).status_code,400)
        self.assertEqual(self.writes,0)

    def test_unconfirmed_invoice_does_not_satisfy_sepa(self):
        self.assertEqual(self.send({'paymentMethod':'sepa','invoiceIban':'DE57763510400000200600'}).status_code,400)
        self.assertEqual(self.writes,0)

    def test_master_and_confirmed_invoice_allow_both_writes(self):
        for edit in (False,True):
            for bank in ({'masterIban':'DE57 7635 1040 0000 2006 00'},
                         {'invoiceIban':'DE57763510400000200600','acceptNewIban':True}):
                self.assertEqual(self.send({'paymentMethod':'transfer',**bank},edit).status_code,200)
        self.assertEqual(self.writes,4)

    def test_context_fallback_and_test_area(self):
        self.master='DE57763510400000200600'
        self.assertEqual(self.send({'paymentMethod':'transfer','area':'test'}).status_code,200)

    def test_other_methods_do_not_require_iban(self):
        for method in ('cash','revolut','revolut_business','direct_debit','unknown'):
            self.assertEqual(self.send({'paymentMethod':method}).status_code,200)


if __name__ == '__main__':
    unittest.main()
