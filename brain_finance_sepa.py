# coding: utf-8
"""SEPA credit-transfer XML for approved incoming invoices."""
from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from xml.etree import ElementTree as ET


NS = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"
ET.register_namespace("", NS)


def _tag(name):
    return f"{{{NS}}}{name}"


def _clean(value, length):
    return " ".join(str(value or "").split())[:length]


def _iban(value):
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def iban_valid(value):
    iban = _iban(value)
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{11,30}", iban):
        return False
    rearranged = iban[4:] + iban[:4]
    digits = "".join(str(ord(char) - 55) if char.isalpha() else char for char in rearranged)
    remainder = 0
    for char in digits:
        remainder = (remainder * 10 + int(char)) % 97
    return remainder == 1


def _bic(value):
    return re.sub(r"\s+", "", str(value or "").upper())


def _amount(value):
    try:
        result = Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"Ungültiger Überweisungsbetrag: {value}") from exc
    if result <= 0:
        raise ValueError("Der Überweisungsbetrag muss größer als 0,00 EUR sein.")
    return result


def _child(parent, name, text=None, **attributes):
    node = ET.SubElement(parent, _tag(name), attributes)
    if text is not None:
        node.text = str(text)
    return node


def build_sepa_xml(items, debtor_name, debtor_iban, debtor_bic="", created_at=None):
    """Return (xml bytes, filename) for a pain.001.001.03 payment batch."""
    debtor_name = _clean(debtor_name, 70)
    debtor_iban = _iban(debtor_iban)
    debtor_bic = _bic(debtor_bic)
    if not debtor_name:
        raise ValueError("Firmenname für die SEPA-Datei fehlt.")
    if not iban_valid(debtor_iban):
        raise ValueError("Die eigene Firmen-IBAN für SEPA ist ungültig.")
    if debtor_bic and not re.fullmatch(r"[A-Z0-9]{8}([A-Z0-9]{3})?", debtor_bic):
        raise ValueError("Die eigene Firmen-BIC für SEPA ist ungültig.")
    rows = []
    for index, raw in enumerate(items or [], 1):
        currency = str(raw.get("currency") or "EUR").upper()
        if currency != "EUR":
            raise ValueError(f"SEPA unterstützt hier nur EUR: {_clean(raw.get('supplier'), 70)}")
        creditor_iban = _iban(raw.get("iban"))
        if not iban_valid(creditor_iban):
            raise ValueError(f"IBAN fehlt oder ist ungültig: {_clean(raw.get('supplier'), 70)}")
        creditor_bic = _bic(raw.get("bic") or raw.get("swift"))
        if creditor_bic and not re.fullmatch(r"[A-Z0-9]{8}([A-Z0-9]{3})?", creditor_bic):
            raise ValueError(f"BIC ist ungültig: {_clean(raw.get('supplier'), 70)}")
        creditor = _clean(raw.get("accountHolder") or raw.get("supplier"), 70)
        if not creditor:
            raise ValueError(f"Kontoinhaber fehlt bei Rechnung {index}.")
        rows.append({
            "amount": _amount(raw.get("paymentAmount") if raw.get("paymentAmount") is not None else raw.get("amount")),
            "currency": currency,
            "creditor": creditor,
            "iban": creditor_iban,
            "bic": creditor_bic,
            "reference": _clean(raw.get("remittanceText") or raw.get("invoiceNumber") or raw.get("docId") or "Rechnung", 140),
            "end_to_end": _clean(raw.get("paymentId") or f"KRISTA-{index}", 35),
        })
    if not rows:
        raise ValueError("Keine Rechnungen für die SEPA-Datei ausgewählt.")

    now = created_at or datetime.now()
    stamp = now.strftime("%Y%m%d-%H%M%S")
    message_id = f"KRISTA-{stamp}"[:35]
    total = sum((row["amount"] for row in rows), Decimal("0.00"))
    root = ET.Element(_tag("Document"))
    init = _child(root, "CstmrCdtTrfInitn")
    header = _child(init, "GrpHdr")
    _child(header, "MsgId", message_id)
    _child(header, "CreDtTm", now.isoformat(timespec="seconds"))
    _child(header, "NbOfTxs", len(rows))
    _child(header, "CtrlSum", f"{total:.2f}")
    _child(_child(header, "InitgPty"), "Nm", debtor_name)

    payment = _child(init, "PmtInf")
    _child(payment, "PmtInfId", f"PMT-{stamp}"[:35])
    _child(payment, "PmtMtd", "TRF")
    _child(payment, "BtchBookg", "true")
    _child(payment, "NbOfTxs", len(rows))
    _child(payment, "CtrlSum", f"{total:.2f}")
    _child(_child(_child(payment, "PmtTpInf"), "SvcLvl"), "Cd", "SEPA")
    _child(payment, "ReqdExctnDt", now.date().isoformat())
    _child(_child(payment, "Dbtr"), "Nm", debtor_name)
    _child(_child(_child(payment, "DbtrAcct"), "Id"), "IBAN", debtor_iban)
    debtor_agent = _child(_child(payment, "DbtrAgt"), "FinInstnId")
    if debtor_bic:
        _child(debtor_agent, "BIC", debtor_bic)
    else:
        _child(_child(debtor_agent, "Othr"), "Id", "NOTPROVIDED")
    _child(payment, "ChrgBr", "SLEV")

    for row in rows:
        transaction = _child(payment, "CdtTrfTxInf")
        payment_id = _child(transaction, "PmtId")
        _child(payment_id, "EndToEndId", row["end_to_end"] or "NOTPROVIDED")
        amount = _child(transaction, "Amt")
        _child(amount, "InstdAmt", f"{row['amount']:.2f}", Ccy=row["currency"])
        if row["bic"]:
            _child(_child(_child(transaction, "CdtrAgt"), "FinInstnId"), "BIC", row["bic"])
        _child(_child(transaction, "Cdtr"), "Nm", row["creditor"])
        _child(_child(_child(transaction, "CdtrAcct"), "Id"), "IBAN", row["iban"])
        if row["reference"]:
            _child(_child(transaction, "RmtInf"), "Ustrd", row["reference"])

    xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    return xml, f"SEPA_{now.strftime('%Y-%m-%d_%H-%M-%S')}.xml"
