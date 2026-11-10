# coding: utf-8
import unittest
import xml.etree.ElementTree as ET
from brain_chf_iso import create_chf_crossborder_xml, NAMESPACE
def iban(country,bban):
    candidate=country+'00'+bban
    rear=candidate[4:]+candidate[:4]
    value=int(''.join(str(ord(c)-55) if c.isalpha() else c for c in rear))
    check=98-value%97
    return country+str(check).zfill(2)+bban
class ChfDraftTests(unittest.TestCase):
    def setUp(self):
        self.params=dict(debtor_name="Farben Krista GmbH Co KG",
                         debtor_iban=iban("AT","1904300234573201"),debtor_bic="BKAUATWW",
                         recipient="Schweizer Empfaenger",iban=iban("CH","00230000001234567"),
                         bic="POFICHBEXXX",amount="234.50",purpose="Rechnung 2026-100")
    def test_crossborder_chf_xml(self):
        draft=create_chf_crossborder_xml(**self.params)
        root=ET.fromstring(draft["xml"]);tag=lambda s:'{'+NAMESPACE+'}'+s
        self.assertEqual(root.tag,tag("Document"))
        amount=root.find(".//"+tag("InstdAmt"))
        self.assertEqual(amount.text,"234.50")
        self.assertEqual(amount.attrib["Ccy"],"CHF")
        self.assertEqual(root.find(".//"+tag("ChrgBr")).text,"SHAR")
        self.assertEqual(root.find(".//"+tag("CdtrAgt")+"/"+tag("FinInstnId")+"/"+tag("BIC")).text,"POFICHBEXXX")
        self.assertNotIn("SEPA",draft["xml"])
    def test_invalid_transfer_rejected(self):
        for changes in ({"amount":"-1"},{"amount":"0"},{"amount":"nan"},
                        {"bic":"WRONG"},{"debtor_bic":""},{"iban":"CH0000000000000000000"}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                create_chf_crossborder_xml(**(self.params|changes))
    def test_qr_reference_mandatory_and_validated(self):
        qr_iban=iban("CH","30000000001234567")
        with self.assertRaisesRegex(ValueError,"QR-Referenz"):
            create_chf_crossborder_xml(**(self.params|{"iban":qr_iban}))
        table=(0,9,4,6,8,2,7,1,3,5)
        ref="0"*26
        carry=0
        for c in ref:
            carry=table[(carry+int(c))%10]
        check=next(i for i in range(10) if table[(carry+i)%10]==0)
        valid=ref+str(check)
        draft=create_chf_crossborder_xml(**(self.params|{"iban":qr_iban,"reference":valid}))
        root=ET.fromstring(draft["xml"])
        self.assertIn(valid,draft["xml"])
        with self.assertRaisesRegex(ValueError,"Prüfziffer"):
            create_chf_crossborder_xml(**(self.params|{"iban":qr_iban,"reference":valid[:-1]+str((check+1)%10)}))
if __name__=="__main__":unittest.main()
