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


def prepare_payroll_file(xml, category, period, instant=False, execution_date=None):
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
    reviewed = review_xml(xml,strict_ids=False,allow_past=True)
    if execution_date:
        execution_date=day(execution_date)
        if execution_date<date.today().isoformat():
            raise ConnectionError('Neuer Ausführungstermin muss heute oder später sein.')
    root = ET.fromstring(xml)
    init = child(root, 'CstmrCdtTrfInitn')
    header = child(init, 'GrpHdr')
    blocks = [x for x in init if localname(x) == 'PmtInf']
    for block in blocks:
        init.remove(block)
    original_dates=sorted(set(x['date'] for x in reviewed['items']))
    # The original details, including remittance information and EndToEndId, survive.
    # Each payment gets its own PmtInf with batch booking disabled.
    prefix = 'KR' + secrets.token_hex(5).upper()  # 12 characters
    child(header, 'MsgId').text = prefix + 'M'
    index = 0
    tax_indexes=[]
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
            tax = any(localname(x)=='Cd' and (x.text or '').strip()=='TAXS'
                      for parent in (transaction,) for x in parent.iter()) or any(
                          localname(code)=='Cd' and (code.text or '').strip()=='TAXS'
                          for payment_type in block if localname(payment_type)=='PmtTpInf'
                          for category_purpose in payment_type if localname(category_purpose)=='CtgyPurp'
                          for code in category_purpose)
            if tax:
                # Finanzamtszahlungen carry a bank-specific purpose and remittance
                # code. Copy both unchanged; never replace them with a generic note.
                remittance=[x for x in transaction if localname(x)=='RmtInf']
                if not remittance or not any((x.text or '').strip() for x in remittance[0].iter() if localname(x) in ('Ustrd','Ref')):
                    raise ConnectionError('Finanzamtszahlung ohne Zahlungsreferenz im Sammler.')
                tax_id=value(transaction,'PmtId/EndToEndId')
                if not re.fullmatch(r'\d{9}',tax_id):
                    raise ConnectionError('Finanzamtszahlung benötigt die neunstellige Steuernummer als EndToEndId.')
                tax_indexes.append(index-1)
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
            if execution_date:
                execution=child(one,'ReqdExctnDt')
                if len(execution):execution[0].text=execution_date
                else:execution.text=execution_date
            if instant:
                if tax:raise ConnectionError('Eilüberweisung für Finanzamtszahlungen ist hier nicht geprüft. Bitte Standard-SEPA auswählen.')
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
    for position in tax_indexes:checked['items'][position]['taxPayment']=True
    files=[]
    if tax_indexes:
        # Banks process tax instructions separately. Both files retain the original
        # creditor transactions; only group counts/identifiers are regenerated.
        for is_tax, suffix, filename in ((False,'A',label+' · Sonstige Abgaben.xml'),
                                         (True,'T',label+' · Finanzamt.xml')):
            selected=[i for i in range(index) if (i in tax_indexes)==is_tax]
            if not selected:continue
            document=copy.deepcopy(root)
            initiation=child(document,'CstmrCdtTrfInitn')
            group=child(initiation,'GrpHdr')
            child(group,'MsgId').text=prefix+suffix
            payment_blocks=[x for x in initiation if localname(x)=='PmtInf']
            for position, payment_block in enumerate(payment_blocks):
                if position not in selected:initiation.remove(payment_block)
            subtotal=sum((Decimal(checked['items'][i]['amount']) for i in selected),Decimal('0'))
            child(group,'NbOfTxs').text=str(len(selected))
            child(group,'CtrlSum').text=f'{subtotal:.2f}'
            payment_xml=ET.tostring(document,encoding='unicode',xml_declaration=True)
            review_xml(payment_xml)
            files.append({'name':filename,'xml':payment_xml})
    else:files=[{'name':label+(' · Eil-SEPA' if instant else '')+'.xml','xml':transformed}]
    return {'name': label + (' · Eil-SEPA' if instant else '') + '.xml', 'xml': transformed,
            'originalDates':original_dates, 'executionDate':execution_date or (original_dates[0] if len(original_dates)==1 else None),
            'taxCount':len(tax_indexes),'files':files,
            'label': label, 'items': checked['items'], 'total': checked['total'], 'count': len(checked['items'])}
