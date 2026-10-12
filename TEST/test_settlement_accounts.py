# coding: utf-8
import hashlib
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from datetime import date, timedelta

from flask import Flask
from brain_outgoing_store import OutgoingStore
from brain_settlement_accounts import SettlementLedger, install

TODAY=date.today().isoformat()


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        home=Path(self.temp.name)
        self.outgoing=OutgoingStore(home/"rechnung.db",home/"pdf")
        self.ledger=SettlementLedger(self.outgoing)
        with self.outgoing.connect() as c:
            c.execute("""INSERT INTO outgoing_runs(id,project_number,label,customer_name,customer_street,
                customer_postal_code,customer_city,created_at)
                VALUES(30,'24138','Auftrag','Testkunde','Teststraße 1','6820','Frastanz',?)""",(TODAY,))
            c.execute("""INSERT INTO outgoing_invoices(id,run_id,kind,status,invoice_number,issue_date,due_date,
                service_from,service_to,tax_mode,vat_rate,currency,increment_gross,increment_net,increment_vat,created_at,updated_at)
                VALUES(95,30,'RE','issued','202610003',?,?,?,?,?,'20','EUR','120.00','100.00','20.00',?,?)""",
                (TODAY,TODAY,TODAY,TODAY,'AT20',TODAY,TODAY))
            c.commit()
        self.next_id=0

    def book(self,account,kind,amount,**kw):
        self.next_id+=1
        row=dict(date=TODAY,kind=kind,amount=amount,counterparty="Test Kontakt",
            purpose="Verrechnung Beispiel",reference="Beleg "+str(self.next_id),
            requestId="request-id-%06d" % self.next_id)
        row.update(kw)
        return self.ledger.add(account,row)

    def test_alex_private_balance_is_not_salary_claim(self):
        self.book("alex","contribution","100.00")
        self.book("alex","private_expense","40.00")
        self.book("alex","withdrawal","25.00")
        self.book("alex","wage_due","3500.00")
        self.book("alex","wage_paid","700.00")
        result=self.ledger.list("alex")
        self.assertEqual(result["balances"]["private"],"115.00")
        self.assertEqual(result["balances"]["wage"],"2800.00")
        self.assertEqual(result["count"],5)
        self.assertEqual(result["rows"][0]["runningBalance"],"2800.00")
        with self.assertRaisesRegex(ValueError,"übersteigt"):
            self.book("alex","wage_paid","3000.00")
        self.assertEqual(self.ledger.list("alex")["balances"]["wage"],"2800.00")

    def test_dlz_posts_debtor_payment_atomically_without_duplicate_income(self):
        self.assertEqual(self.outgoing.debtor_open_items()[0]["openGross"],120.0)
        receipt=self.book("dlz","customer_receipt","60.00",invoiceId=95,externalRef="dlz-transfer-202610003")
        self.assertEqual(self.ledger.list("dlz")["balances"]["clearing"],"60.00")
        self.assertEqual(self.outgoing.debtor_open_items()[0]["openGross"],60.0)
        with self.outgoing.connect() as c:
            payment=c.execute("SELECT * FROM outgoing_payments WHERE source='DLZ'").fetchall()
            self.assertEqual(len(payment),1)
            self.assertEqual(payment[0]["source_id"],"DLZ:dlz-transfer-202610003")
            self.assertEqual(payment[0]["gross"],"60")
            self.assertEqual(c.execute("SELECT COUNT(*) FROM outgoing_invoices").fetchone()[0],1)
        repeat=self.ledger.add("dlz",dict(date=TODAY,kind="customer_receipt",amount="60.00",
            counterparty="Test Kontakt",purpose="Verrechnung Beispiel",reference="Beleg 1",
            invoiceId=95,externalRef="dlz-transfer-202610003",requestId="request-id-000001"))
        self.assertEqual(repeat["id"],receipt["id"])
        self.assertEqual(self.ledger.list("dlz")["count"],1)
        with self.assertRaisesRegex(ValueError,"Quellreferenz"):
            self.book("dlz","customer_receipt","30.00",invoiceId=95,externalRef="dlz-transfer-202610003")
        with self.assertRaisesRegex(ValueError,"übersteigt"):
            self.book("dlz","customer_receipt","80.00",invoiceId=95,externalRef="another-dlz-payment")
        self.assertEqual(self.outgoing.debtor_open_items()[0]["openGross"],60.0)

    def test_dlz_cannot_settle_more_than_actual_balance(self):
        with self.assertRaisesRegex(ValueError,"übersteigt"):
            self.book("dlz","liability_settlement","20.00")
        self.book("dlz","customer_receipt","100.00",invoiceId=95,externalRef="dlz-first")
        self.book("dlz","liability_settlement","35.50",reference="ÖGK Verrechnung 10/2026")
        self.assertEqual(self.ledger.list("dlz")["balances"]["clearing"],"64.50")
        self.assertEqual(self.outgoing.debtor_open_items()[0]["openGross"],20.0)
        with self.assertRaisesRegex(ValueError,"referenz"):
            self.book("dlz","liability_settlement","1.00",reference="")
        self.assertEqual(self.ledger.list("dlz")["balances"]["clearing"],"64.50")

    def test_dlz_customer_reversal_restores_original_open_item(self):
        source=self.book("dlz","customer_receipt","60.00",invoiceId=95,externalRef="dlz-to-reverse")
        row=self.ledger.reverse("dlz",source["id"],"Falsche Kundenzuordnung","request-reversal-0001")
        self.assertEqual(row["amount"],"-60.00")
        self.assertEqual(self.ledger.list("dlz")["balances"]["clearing"],"0.00")
        self.assertEqual(self.outgoing.debtor_open_items()[0]["openGross"],120.0)
        self.assertEqual(self.ledger.reverse("dlz",source["id"],"Falsche Kundenzuordnung","request-reversal-0001")["id"],row["id"])
        with self.assertRaisesRegex(ValueError,"bereits storniert"):
            self.ledger.reverse("dlz",source["id"],"Andere Storno","request-reversal-0002")
        with self.outgoing.connect() as c:
            self.assertIsNotNone(c.execute("SELECT reversed_at FROM outgoing_payments WHERE source='DLZ'").fetchone()[0])

    def test_spent_dlz_receipt_must_not_be_reversed_before_offset(self):
        incoming=self.book("dlz","customer_receipt","100.00",invoiceId=95,externalRef="dlz-spent-receipt")
        outgoing=self.book("dlz","liability_settlement","80.00",reference="ÖGK August 2026")
        with self.assertRaisesRegex(ValueError,"bereits teilweise verwendet"):
            self.ledger.reverse("dlz",incoming["id"],"Erst Verrechnung stornieren","reverse-spent-receipt")
        self.assertEqual(self.outgoing.debtor_open_items()[0]["openGross"],20.0)
        self.ledger.reverse("dlz",outgoing["id"],"Verrechnung zurücknehmen","reverse-dlz-offset")
        self.ledger.reverse("dlz",incoming["id"],"Eingang korrigieren","reverse-spent-receipt")
        self.assertEqual(self.outgoing.debtor_open_items()[0]["openGross"],120.0)
        self.assertEqual(self.ledger.list("dlz")["balances"]["clearing"],"0.00")

    def test_spent_wage_due_must_not_be_reversed_until_salary_payment_reversed(self):
        accrued=self.book("alex","wage_due","1500.00")
        paid=self.book("alex","wage_paid","1200.00")
        with self.assertRaisesRegex(ValueError,"bereits teilweise verwendet"):
            self.ledger.reverse("alex",accrued["id"],"Lohn korrigiert","reverse-original-salary")
        self.ledger.reverse("alex",paid["id"],"Lohnauszahlung korrigiert","reverse-payment-salary")
        self.ledger.reverse("alex",accrued["id"],"Lohn korrigiert","reverse-original-salary")
        self.assertEqual(self.ledger.list("alex")["balances"]["wage"],"0.00")

    def test_backdated_dlz_offset_cannot_spend_future_receipt(self):
        yesterday=(date.today()-timedelta(days=1)).isoformat()
        self.book("dlz","customer_receipt","60.00",invoiceId=95,externalRef="future-vs-old")
        with self.assertRaisesRegex(ValueError,"übersteigt"):
            self.book("dlz","liability_settlement","10.00",date=yesterday,reference="Abgaben gestern")

    def test_duplicate_bank_assigned_alex_movement_is_readonly_and_not_manual_duplicate(self):
        with self.outgoing.connect() as c:
            c.executescript("""
                CREATE TABLE bank_assignment_transactions(rid TEXT PRIMARY KEY,payload TEXT);
                CREATE TABLE bank_assignment_lines(id INTEGER PRIMARY KEY,rid TEXT,category TEXT,paid INTEGER,reason TEXT);
            """)
            c.execute("INSERT INTO bank_assignment_transactions VALUES(?,?)",
                      ("bank-1",json.dumps({"bookingDate":TODAY,"creditDebitIndicator":"CRDT","purpose":"Alex Einlage"})))
            c.execute("INSERT INTO bank_assignment_lines VALUES(1,'bank-1','alex_private',27500,'')")
            c.commit()
        view=self.ledger.list("alex")
        self.assertEqual(view["balances"]["private"],"275.00")
        self.assertEqual(len(view["rows"]),1)
        self.assertEqual(view["rows"][0]["origin"],"KONFIPAY")
        with self.assertRaisesRegex(ValueError,"KONFIPAY"):
            self.book("alex","contribution","275.00",externalRef="bank-1")

    def test_document_upload_is_immutable_and_deduplicated(self):
        item=self.book("alex","private_expense","99.00")
        pdf=b"%PDF-1.7\nnot an actual invoice just file attachment test\n%%EOF"
        saved=self.ledger.attach("alex",item["id"],"rechnung.pdf",pdf)
        again=self.ledger.attach("alex",item["id"],"rechnung.pdf",pdf)
        self.assertEqual(saved["id"],again["id"])
        self.assertEqual(self.ledger.file("alex",saved["id"])[2],pdf)
        self.assertEqual(len(self.ledger.files("alex",item["id"])),1)
        with self.assertRaisesRegex(ValueError,"PDF"):
            self.ledger.attach("alex",item["id"],"fake.pdf",b"not-pdf")
        with self.assertRaisesRegex(ValueError,"Bitte PDF"):
            self.ledger.attach("alex",item["id"],"malware.exe",b"MZ")
        with self.assertRaisesRegex(ValueError,"nicht gefunden"):
            self.ledger.file("dlz",saved["id"])

    def test_date_amount_account_and_idempotency_validation(self):
        with self.assertRaises(ValueError):
            self.book("alex","contribution","0.001")
        with self.assertRaises(ValueError):
            self.book("alex","contribution","-15")
        with self.assertRaises(ValueError):
            self.book("alex","contribution","30",date=(date.today()+timedelta(days=1)).isoformat())
        with self.assertRaises(ValueError):
            self.book("alex","liability_settlement","10")
        with self.assertRaises(ValueError):
            self.book("dlz","customer_receipt","10")
        first=self.book("alex","contribution","80.00")
        old_id="request-id-%06d" % self.next_id
        with self.assertRaisesRegex(ValueError,"bereits"):
            self.ledger.add("alex",dict(date=TODAY,kind="contribution",amount="150.00",
                counterparty="Test Kontakt",purpose="Neue Zahlung",reference="Beleg XY",requestId=old_id))
        self.assertEqual(self.ledger.list("alex")["balances"]["private"],"80.00")

    def test_simultaneous_same_external_reference_one_payment_only(self):
        errors=[]
        def job(i):
            try:
                return self.ledger.add("dlz",dict(
                    date=TODAY,kind="customer_receipt",amount="30.00",
                    counterparty="Paralleltest",purpose="Identische Bankzahlung",reference="Paralleltest",
                    externalRef="parallel-external-ref",invoiceId=95,requestId="parallel-request-%02d"%i,
                ))
            except ValueError as exc:
                errors.append(str(exc))
        threads=[threading.Thread(target=job,args=(i,)) for i in range(4)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(len(errors),3)
        self.assertEqual(self.ledger.list("dlz")["balances"]["clearing"],"30.00")
        self.assertEqual(self.outgoing.debtor_open_items()[0]["openGross"],90.0)


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        home=Path(self.temp.name)
        store=OutgoingStore(home/"outgoing.db",home/"pdf")
        self.app=Flask(__name__)
        self.app.extensions["kristine_outgoing_store"]=store
        ns={"app":self.app,"MOBILE_ALLOWED_PATHS":set()}
        install(ns)
        self.client=self.app.test_client()

    def test_page_and_csrf(self):
        r=self.client.get("/incoming/alex-privat")
        self.assertEqual(r.status_code,200)
        content=r.get_data(as_text=True)
        self.assertIn("Alex Privat",content)
        self.assertNotIn("__SETTLEMENT_CSRF__",content)
        import re
        token=re.search('data-csrf="([^"]+)"',content).group(1)
        body=dict(date=TODAY,kind="contribution",amount="50.00",
            counterparty="Alex",purpose="Einlage",requestId="csrf-example-123")
        r=self.client.post("/incoming/settlements/api?account=alex&action=add",json=body)
        self.assertEqual(r.status_code,403)
        r=self.client.post("/incoming/settlements/api?account=alex&action=add",json=body,
            headers={"Origin":"http://localhost","X-Settlement-Token":token})
        self.assertEqual(r.status_code,200,r.json)
        self.assertEqual(r.json["item"]["amount"],"50.00")
        self.assertEqual(self.client.get("/incoming/settlements/api?account=alex&action=list").json["balances"]["private"],"50.00")
        self.assertIn("DLZ",self.client.get("/incoming/dlz").get_data(as_text=True))


if __name__=="__main__":
    unittest.main()
