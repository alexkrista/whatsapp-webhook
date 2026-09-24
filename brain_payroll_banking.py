# coding: utf-8
"""Split a payroll-office pain.001 batch into separately booked transfers."""
from __future__ import annotations

import copy
import re
import secrets
import xml.etree.ElementTree as ET
from datetime import date
from decimal import Decimal

from brain_konfipay import ConnectionError
from brain_konfipay_banking import child, day, localname, review_xml, value


def prepare_payroll_file(xml, category, period, instant=False):
    if category not in ('wages', 'contributions'):
        raise ConnectionError('Bitte Löhne oder Abgaben auswählen.')
    if not isinstance(instant, bool):
        raise ConnectionError('Ungültige Überweisungsart.')
    if category == 'wages':
        if not isinstance(period, str) or not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', period):
            raise ConnectionError('Bitte den Lohnmonat im Format JJJJ-MM auswählen.')
        label = 'Löhne ' + period[5:] + '/' + period[:4]
    else:
        period = day(period)
        label = 'Abgaben ' + period[8:] + '.' + period[5:7] + '.' + period[:4]
    reviewed = review_xml(xml)
    root = ET.fromstring(xml)
    init = child(root, 'CstmrCdtTrfInitn')
    header = child(init, 'GrpHdr')
    blocks = [x for x in init if localname(x) == 'PmtInf']
    for block in blocks:
        init.remove(block)
    # The original details, including remittance information and EndToEndId, survive.
    # Each payment gets its own PmtInf with batch booking disabled.
    prefix = 'KR' + secrets.token_hex(5).upper()  # 12 characters
    child(header, 'MsgId').text = prefix + 'M'
    index = 0
    for block in blocks:
        transactions = [x for x in block if localname(x) == 'CdtTrfTxInf']
        for transaction in transactions:
            index += 1
            if index > 500:
                raise ConnectionError('Höchstens 500 Einzelzahlungen pro Sammler möglich.')
            one = copy.deepcopy(block)
            for tx in [x for x in one if localname(x) == 'CdtTrfTxInf']:
                one.remove(tx)
            one.append(copy.deepcopy(transaction))
            child(one, 'PmtInfId').text = prefix + format(index, '04X')
            booking = [x for x in one if localname(x) == 'BtchBookg']
            if booking:
                booking[0].text = 'false'
            else:
                marker = ET.Element(block.tag.replace('PmtInf', 'BtchBookg'))
                marker.text = 'false'
                one.insert(2, marker)  # after PmtInfId and PmtMtd
            for tag, content in (('NbOfTxs', '1'), ('CtrlSum', value(transaction, 'Amt/InstdAmt'))):
                found = [x for x in one if localname(x) == tag]
                if found:
                    found[0].text = content
            if instant:
                execution = child(one, 'ReqdExctnDt')
                current = (execution.text or '').strip() if not len(execution) else (execution[0].text or '').strip()
                if current != date.today().isoformat():
                    raise ConnectionError('Eilüberweisung nur bei Ausführung heute möglich. Bitte den Termin im Lohnbüro-Sammler prüfen.')
                payment_type = [x for x in one if localname(x) == 'PmtTpInf']
                if len(payment_type) != 1:
                    raise ConnectionError('Eilüberweisung benötigt eine eindeutige Zahlungsart im Sammler.')
                pt = payment_type[0]
                priority = [x for x in pt if localname(x) == 'InstrPrty']
                if priority:
                    priority[0].text = 'HIGH'
                else:
                    node = ET.Element(pt.tag.replace('PmtTpInf', 'InstrPrty'))
                    node.text = 'HIGH'
                    pt.insert(0, node)
                service = child(pt, 'SvcLvl')
                if value(service, 'Cd') != 'SEPA':
                    raise ConnectionError('Eilüberweisung ist nur für SEPA-Zahlungen verfügbar.')
                local = [x for x in pt if localname(x) == 'LclInstrm']
                if local:
                    child(local[0], 'Cd').text = 'INST'
                else:
                    node = ET.SubElement(pt, pt.tag.replace('PmtTpInf', 'LclInstrm'))
                    ET.SubElement(node, pt.tag.replace('PmtTpInf', 'Cd')).text = 'INST'
            init.append(one)
    transformed = ET.tostring(root, encoding='unicode', xml_declaration=True)
    checked = review_xml(transformed)
    if checked['total'] != reviewed['total'] or len(checked['items']) != len(reviewed['items']):
        raise ConnectionError('Die Kontrollsumme des Sammlers hat sich geändert.')
    return {'name': label + (' · Eil-SEPA' if instant else '') + '.xml', 'xml': transformed,
            'label': label, 'items': checked['items'], 'total': checked['total'], 'count': len(checked['items'])}
