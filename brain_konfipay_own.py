"""Match locally submitted payments against bank movements before reserving them."""
from contextlib import closing
from datetime import date
from decimal import Decimal
from xml.etree import ElementTree as ET
from brain_konfipay import ConnectionError

REJECTED={'KON_REJECTED','FIN_REJECTED','FIN_VEU_CANCELED','FIN_UPLOAD_FAILED'}
KNOWN={'KON_ACCEPTED_AND_QUEUED','FIN_UPLOAD_SUCCEEDED','FIN_ACCEPTED','FIN_CONFIRMED','FIN_VEU_FORWARDED'}

def iban(value): return str(value or '').replace(' ','').upper()
def reference(value):
    text=str(value or '').strip()
    return text if text.upper() not in {'','NOTPROVIDED','NONREF','N/A'} else ''

def batch_metadata(content):
    """Use the original PmtInfId and full group total, never an amount-only guess."""
    if not content.get('xml'):return {}
    root=ET.fromstring(content['xml']);result={};index=0
    for group in root.findall('.//{*}PmtInf'):
        ident=reference(group.findtext('{*}PmtInfId'))
        children=group.findall('{*}CdtTrfTxInf')
        total=sum((Decimal(x.findtext('{*}Amt/{*}InstdAmt')) for x in children),Decimal(0))
        for child in children:
            item=content['items'][index]
            if (child.findtext('{*}PmtId/{*}EndToEndId')!=item['endToEndId'] or
                Decimal(child.findtext('{*}Amt/{*}InstdAmt'))!=Decimal(item['amount'])):
                raise ConnectionError('Zahlungsarchiv und Sammlerinhalt passen nicht zusammen.')
            result[index]={'batchRef':ident,'batchCount':len(children),'batchTotal':str(total)}
            index+=1
    if index!=len(content['items']):raise ConnectionError('Sammlerinhalt ist nicht vollständig zugeordnet.')
    return result

def outstanding(client):
    payments=getattr(client,'brain_payments',None)
    if payments is None:return []
    with closing(payments.db()) as db:
        db.execute('CREATE TABLE IF NOT EXISTS bank_seen_payments(transfer_id TEXT,item_index INTEGER,bank_rid TEXT,PRIMARY KEY(transfer_id,item_index))');db.commit()
        rows=[dict(x) for x in db.execute('SELECT * FROM transfers ORDER BY created,id')]
        seen={(x[0],x[1]) for x in db.execute('SELECT transfer_id,item_index FROM bank_seen_payments')}
    result=[]
    for row in rows:
        if all((row['id'],i) in seen for i in range(row['count'])):continue
        if row['state']=='rejected' or row['status'] in REJECTED:continue
        uncertain=False
        if row['rid']:
            try:
                info=client.authenticated('GET','/payment-files/'+row['rid'])
                status=((info.get('paymentInfo') or {}).get('status') or {}).get('statusValue')
                if not status:raise ValueError('missing status')
                row['status']=status
                payments.record(row['id'],row['state'],row['rid'],status,row['error'])
            except Exception:uncertain=True
        if row['status'] in REJECTED:continue
        uncertain=uncertain or row['state'] not in {'submitted'} or row['status'] not in KNOWN
        content=payments.content(row['id']);metadata=batch_metadata(content)
        for i,item in enumerate(content['items']):
            if (row['id'],i) in seen or item['date']>date.today().isoformat():continue
            result.append({'transfer':row['id'],'index':i,'item':item,'uncertain':uncertain,**metadata.get(i,{})})
    return result

def reconcile(client,account,local,bank):
    own=[x for x in local if iban(x['item']['debtorIban'])==iban(account['iban'])]
    if not own:return {'ownOutgoing':'0.00','ownCount':0,'ownTransfersChecked':getattr(client,'brain_payments',None) is not None}
    if account['currency']!='EUR':raise ConnectionError('Währung der eigenen Zahlung ist unklar.')
    bank=[x for x in bank if x['creditDebitIndicator']=='DBIT']
    used=set();retire=[];remaining=[]
    groups={};group_matched=set()
    for entry in own:
        if entry.get('batchRef'):groups.setdefault((entry['transfer'],entry['batchRef']),[]).append(entry)
    for key,entries in groups.items():
        first=entries[0]
        # Only the complete original group may match a bank batch movement.
        if len(entries)!=first['batchCount']:continue
        total=sum((Decimal(x['item']['amount']) for x in entries),Decimal(0))
        if total!=Decimal(first['batchTotal']):continue
        matches=[tx for tx in bank if reference(tx.get('paymentIdentificationId'))==key[1]
            and (tx.get('bankAccount') or {}).get('rId')==account['id'] and tx.get('currency')==account['currency']
            and abs(Decimal(str(tx['amount'])))==total
            and str(tx.get('bookingDate') or '')[:10]>=max(x['item']['date'] for x in entries)]
        if not matches:continue
        if sum(1 for other in groups if other[1]==key[1])>1:
            raise ConnectionError('Die Sammlerkennung wurde mehrfach verwendet. Bitte den Bankabgleich prüfen.')
        booked=[tx for tx in matches if tx['_booking']=='booked']
        if len(matches)>1 and len(booked)==1:matches=booked
        if len(matches)!=1 or matches[0]['rId'] in used:
            raise ConnectionError('Mehrere Bankumsätze passen zum Sammler. Bitte den Bankabgleich prüfen.')
        tx=matches[0];used.add(tx['rId'])
        for entry in entries:
            group_matched.add((entry['transfer'],entry['index']))
            if tx['_booking']=='booked':retire.append((entry['transfer'],entry['index'],tx['rId']))
    for entry in own:
        if (entry['transfer'],entry['index']) in group_matched:continue
        item=entry['item'];ref=reference(item['endToEndId'])
        matches=[tx for tx in bank if tx['rId'] not in used and ref and reference(tx.get('endToEndId'))==ref
            and iban(tx.get('iban'))==iban(item['iban']) and abs(Decimal(str(tx['amount'])))==Decimal(item['amount'])
            and str(tx.get('bookingDate') or '')[:10]>=item['date']]
        if len(matches)>1:
            booked=[tx for tx in matches if tx['_booking']=='booked']
            if len(booked)==1:matches=booked
            else:raise ConnectionError('Mehrere Bankumsätze passen zur eigenen Zahlung. Bitte den Abgleich prüfen.')
        if matches:
            tx=matches[0];used.add(tx['rId'])
            possible=[x for x in own if reference(x['item']['endToEndId'])==ref and
                iban(x['item']['iban'])==iban(tx.get('iban')) and Decimal(x['item']['amount'])==abs(Decimal(str(tx['amount']))) and
                x['item']['date']<=str(tx.get('bookingDate') or '')[:10]]
            if len(possible)>1:raise ConnectionError('Die Zahlungsreferenz wurde mehrfach verwendet. Ein eindeutiger Bankabgleich ist noch nicht möglich.')
            if tx['_booking']=='booked':retire.append((entry['transfer'],entry['index'],tx['rId']))
        else:remaining.append(entry)
    for entry in remaining:
        if entry['uncertain']:raise ConnectionError('Der Status einer eigenen Überweisung ist unklar. Bitte im Zahlungsarchiv prüfen.')
        item=entry['item']
        if item['date']<=str(account.get('date') or '')[:10]:
            raise ConnectionError('Eine eigene Zahlung könnte bereits im Ausgangssaldo enthalten sein. Der zugehörige Bankumsatz fehlt noch für den eindeutigen Abgleich.')
        # Same amount with no usable reference may be this payment; never blindly subtract twice.
        if any(tx['rId'] not in used and not reference(tx.get('endToEndId')) and
               abs(Decimal(str(tx['amount'])))==Decimal(item['amount']) and
               str(tx.get('bookingDate') or '')[:10]>=item['date'] for tx in bank):
            raise ConnectionError('Ein Bankabgang ohne Zahlungsreferenz könnte die eigene Überweisung enthalten. Der Kontostand wartet auf eindeutigen Abgleich.')
    # A bank may book the entire batch in one movement instead of exposing its individual payments.
    batches={}
    for entry in remaining:batches.setdefault(entry['transfer'],[]).append(entry)
    for entries in batches.values():
        total=sum((Decimal(x['item']['amount']) for x in entries),Decimal(0))
        if len(entries)>1 and any(tx['rId'] not in used and abs(Decimal(str(tx['amount'])))==total and
            str(tx.get('bookingDate') or '')[:10]>=min(x['item']['date'] for x in entries) for tx in bank):
            raise ConnectionError('Ein Bankabgang könnte den ganzen Sammler enthalten. Einzelzuordnung noch nicht eindeutig.')
    payments=getattr(client,'brain_payments',None)
    if retire and payments:
        with closing(payments.db()) as db:
            db.executemany('INSERT OR IGNORE INTO bank_seen_payments VALUES(?,?,?)',retire);db.commit()
    total=sum((Decimal(x['item']['amount']) for x in remaining),Decimal(0))
    return {'ownOutgoing':format(total,'.2f'),'ownCount':len(remaining),'ownTransfersChecked':True}
