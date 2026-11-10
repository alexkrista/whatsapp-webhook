# coding: utf-8
"""ISO 20022 cross-border CHF draft generator. Never submits or debits an account."""
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from decimal import Decimal, InvalidOperation
import re
import secrets
import xml.etree.ElementTree as ET

NAMESPACE = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"
ET.register_namespace("", NAMESPACE)

def _tag(name):
    return "{"+NAMESPACE+"}"+name

def _element(parent,name,value=None,attrs=None):
    item=ET.SubElement(parent,_tag(name),attrs or {})
    if value is not None:
        item.text=str(value)
    return item

def _iban(value):
    iban=re.sub(r"\s+","",str(value or "")).upper()
    if not re.fullmatch(r"[A-Z]{2}[0-9A-Z]{13,32}",iban):
        raise ValueError("Ungültige IBAN.")
    rearranged=iban[4:]+iban[:4]
    digits="".join(str(ord(c)-55) if c.isalpha() else c for c in rearranged)
    if int(digits)%97!=1:
        raise ValueError("IBAN-Prüfziffer stimmt nicht.")
    return iban

def _bic(value):
    bic=re.sub(r"\s+","",str(value or "")).upper()
    if not re.fullmatch(r"[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?",bic):
        raise ValueError("BIC/SWIFT mit 8 oder 11 Stellen erforderlich.")
    return bic

def _clean(value,limit=70):
    text=" ".join(str(value or "").split())
    if not text or len(text)>limit or any(ord(ch)<32 for ch in text):
        raise ValueError("Zahlungsfeld fehlt oder ist zu lang.")
    return text

def create_chf_crossborder_xml(*,debtor_name,debtor_iban,debtor_bic,recipient,iban,bic,amount,purpose,reference=""):
    src=_iban(debtor_iban)
    dst=_iban(iban)
    if not dst.startswith("CH") or len(dst)!=21:
        raise ValueError("Für CHF muss eine gültige Schweizer CH-IBAN verwendet werden.")
    if src==dst:
        raise ValueError("Ausgangs- und Empfängerkonto müssen verschieden sein.")
    source_bic=_bic(debtor_bic);target_bic=_bic(bic)
    try:
        gross=Decimal(str(amount)).quantize(Decimal("0.01"))
    except (InvalidOperation,ValueError,TypeError):
        raise ValueError("CHF-Betrag ungültig.") from None
    if not gross.is_finite() or gross<=0 or gross>Decimal("9999999.99"):
        raise ValueError("CHF-Betrag außerhalb des zulässigen Bereichs.")
    payer=_clean(debtor_name);payee=_clean(recipient)
    purpose=_clean(purpose,140)
    reference="".join(str(reference or "").split())
    qr_iban=30000<=int(dst[4:9])<=31999
    if qr_iban:
        if not re.fullmatch(r"[0-9]{27}",reference):
            raise ValueError("Schweizer QR-IBAN erfordert eine 27-stellige QR-Referenz.")
        mod10_table=(0,9,4,6,8,2,7,1,3,5)
        carry=0
        for digit in reference:
            carry=mod10_table[(carry+int(digit))%10]
        if carry!=0:
            raise ValueError("Prüfziffer der Schweizer QR-Referenz ist ungültig.")
    elif reference and len(reference)>35:
        raise ValueError("Referenz ist zu lang.")
    uid="KCHF"+secrets.token_hex(10).upper()
    try:
        now=datetime.now(ZoneInfo("Europe/Vienna"))
    except ZoneInfoNotFoundError:
        now=datetime.now().astimezone()
    root=ET.Element(_tag("Document"))
    init=_element(root,"CstmrCdtTrfInitn")
    group=_element(init,"GrpHdr")
    _element(group,"MsgId",uid)
    _element(group,"CreDtTm",now.isoformat(timespec="seconds"))
    _element(group,"NbOfTxs","1")
    _element(group,"CtrlSum",format(gross,".2f"))
    _element(_element(group,"InitgPty"),"Nm",payer)
    info=_element(init,"PmtInf")
    _element(info,"PmtInfId",uid+"P")
    _element(info,"PmtMtd","TRF")
    _element(info,"BtchBookg","false")
    _element(info,"NbOfTxs","1")
    _element(info,"CtrlSum",format(gross,".2f"))
    _element(info,"ReqdExctnDt",now.date().isoformat())
    _element(_element(info,"Dbtr"),"Nm",payer)
    _element(_element(_element(info,"DbtrAcct"),"Id"),"IBAN",src)
    _element(_element(_element(info,"DbtrAgt"),"FinInstnId"),"BIC",source_bic)
    _element(info,"ChrgBr","SHAR")
    tx=_element(info,"CdtTrfTxInf")
    _element(_element(tx,"PmtId"),"EndToEndId",uid+"E")
    _element(_element(tx,"Amt"),"InstdAmt",format(gross,".2f"),{"Ccy":"CHF"})
    _element(_element(_element(tx,"CdtrAgt"),"FinInstnId"),"BIC",target_bic)
    _element(_element(tx,"Cdtr"),"Nm",payee)
    _element(_element(_element(tx,"CdtrAcct"),"Id"),"IBAN",dst)
    rmt=_element(tx,"RmtInf")
    if qr_iban:
        ref=_element(_element(_element(_element(rmt,"Strd"),"CdtrRefInf"),"Tp"),"CdOrPrtry")
        _element(ref,"Cd","QRR")
        _element(rmt.find(_tag("Strd")).find(_tag("CdtrRefInf")),"Ref",reference)
    else:
        _element(rmt,"Ustrd",purpose if not reference else purpose+" "+reference)
    xml=ET.tostring(root,encoding="utf-8",xml_declaration=True)
    return {"xml":xml.decode("utf-8"),"filename":uid+".xml","amount":format(gross,".2f"),"currency":"CHF",
            "debtorIban":src,"creditorIban":dst,"creditorBic":target_bic,"reference":reference,"id":uid}
