# coding: utf-8
"""Read the fixed KRISTINE payment template without executing workbook content."""
from __future__ import annotations

import io
import re
import secrets
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from brain_finance_sepa import build_sepa_xml, iban_valid

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
HEADERS = ('Name', 'IBAN', 'Betrag EUR', 'Verwendungszweck', 'EndToEndId (optional)', 'Paket (0, 1 … oder x)')


def _cells(raw):
    if len(raw) > 2_000_000:
        raise ValueError('Excel-Datei zu groß (höchstens 2 MB).')
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
        names = archive.namelist()
        if len(names)>100 or sum(x.file_size for x in archive.infolist())>8_000_000:
            raise ValueError('Excel-Datei enthält zu viele oder zu große Bestandteile.')
        shared=[]
        if 'xl/sharedStrings.xml' in names:
            strings=ET.fromstring(archive.read('xl/sharedStrings.xml'))
            shared=[''.join(x.itertext()) for x in strings.findall(NS+'si')]
        sheet=ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    except (zipfile.BadZipFile,KeyError,ET.ParseError) as exc:
        raise ValueError('Bitte die KRISTINE-Excel-Vorlage (.xlsx) verwenden.') from exc
    data={}
    for row in sheet.findall('.//'+NS+'sheetData/'+NS+'row'):
        index=int(row.attrib['r'])
        if index>505:raise ValueError('Höchstens 500 Zahlungszeilen möglich.')
        for cell in row.findall(NS+'c'):
            if cell.find(NS+'f') is not None:raise ValueError('Formeln sind in Zahlungsfeldern nicht erlaubt.')
            match=re.fullmatch(r'([A-Z]+)(\d+)',cell.attrib.get('r',''))
            if not match or len(match.group(1))!=1 or match.group(1) not in 'ABCDEF':continue
            node=cell.find(NS+'v')
            if cell.attrib.get('t')=='inlineStr':
                inline=cell.find(NS+'is');text=''.join(inline.itertext()) if inline is not None else ''
            else:text=node.text if node is not None and node.text else ''
            if cell.attrib.get('t')=='s' and text:text=shared[int(text)]
            data[(index,match.group(1))]=str(text).strip()
    return data


def convert(raw):
    cells=_cells(raw)
    if tuple(cells.get((5,chr(65+i)), '') for i in range(6))!=HEADERS:
        raise ValueError('Spalten der KRISTINE-Vorlage wurden geändert. Bitte eine neue Vorlage laden.')
    debtor=re.sub(r'\s+','',cells.get((2,'B'),'')).upper()
    if not iban_valid(debtor):raise ValueError('Gültige Auftraggeber-IBAN in B2 eingeben.')
    execution=cells.get((3,'B'),'')
    if re.fullmatch(r'\d+(?:\.0)?',execution):
        execution=(date(1899,12,30)+timedelta(days=int(float(execution)))).isoformat()
    try:planned=date.fromisoformat(execution)
    except ValueError:raise ValueError('Ausführung in B3 als JJJJ-MM-TT eingeben.') from None
    if planned<date.today():raise ValueError('Ausführungstermin liegt in der Vergangenheit.')
    rows=[];assignments=[];seen=set()
    for n in range(6,506):
        values=[cells.get((n,col),'') for col in 'ABCDEF']
        if not any(values):continue
        name,iban,amount,purpose,e2e,assignment=values
        iban=re.sub(r'\s+','',iban).upper()
        if not name or not iban_valid(iban) or not purpose:
            raise ValueError(f'Zeile {n}: Name, gültige IBAN und Verwendungszweck eingeben.')
        if not re.fullmatch(r'\d+(?:[,.]\d{1,2})?',amount):
            raise ValueError(f'Zeile {n}: ungültiger Betrag.')
        try:money=Decimal(amount.replace(',','.')).quantize(Decimal('.01'))
        except (InvalidOperation,ValueError):raise ValueError(f'Zeile {n}: ungültiger Betrag.') from None
        if money<=0 or money>Decimal('9999999.99'):
            raise ValueError(f'Zeile {n}: Betrag muss größer 0 EUR sein.')
        assignment=assignment.strip().lower() or '0'
        if assignment!='x' and not re.fullmatch(r'\d{1,6}',assignment):
            raise ValueError(f'Zeile {n}: Paket muss 0, eine Nummer oder x sein.')
        key=(name.casefold(),iban,str(money),purpose.casefold(),e2e)
        if key in seen:raise ValueError(f'Zeile {n}: doppelte Zahlung erkannt.')
        seen.add(key)
        rows.append({'supplier':name,'iban':iban,'amount':str(money),'remittanceText':purpose,
                     'paymentId':e2e or 'KRISTA-XLS-'+secrets.token_hex(10).upper()})
        assignments.append(assignment)
    if not rows:raise ValueError('Keine Überweisungen ab Zeile 6 gefunden.')
    xml,filename=build_sepa_xml(rows,'Farben Krista GmbH & Co KG',debtor)
    root=ET.fromstring(xml)
    execution_node=next(x for x in root.iter() if x.tag.endswith('}ReqdExctnDt'))
    execution_node.text=planned.isoformat()
    xml=ET.tostring(root,encoding='unicode',xml_declaration=True)
    return {'xml':xml,'filename':filename,'assignments':assignments}
