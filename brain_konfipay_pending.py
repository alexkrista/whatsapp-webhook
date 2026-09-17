"""Use the latest version of each numbered intraday bank report."""
from urllib.parse import urlencode
from brain_konfipay import ConnectionError

def latest_reports(items):
    def group(tx):
        f=tx.get('transactionFile') or {}
        if f.get('format')!='camt.052' or not f.get('legalSequenceNumber') or not f.get('rId') or not f.get('timestamp'):
            return None
        return ((tx.get('bankAccount') or {}).get('rId'),tx.get('currency'),f['format'],f['legalSequenceNumber'],f.get('electronicSequenceNumber'))
    newest={}
    for tx in items:
        key=group(tx)
        if key is not None:
            f=tx['transactionFile'];version=(f['timestamp'],f['rId'])
            newest[key]=max(newest.get(key,version),version)
    result=[];seen=set()
    for tx in items:
        key=group(tx);f=tx.get('transactionFile') or {}
        if key is not None and (f['timestamp'],f['rId'])!=newest[key]:continue
        if tx.get('rId') in seen:continue
        seen.add(tx.get('rId'));result.append(tx)
    return result

def pending_transactions(client,params):
    params={k:v for k,v in params.items() if k not in {'page-number','page-size'}}
    direction=params.pop('credit-or-debit-indicator',None)
    items=[];page=1
    while True:
        data=client.authenticated('GET','/transactions?'+urlencode({**params,'page-number':page,'page-size':100}))
        pages=max(1,int(data.get('totalPages',1)))
        if pages>200:raise ConnectionError('Bitte den Zeitraum verkleinern; zu viele untertägige Meldungen.')
        items.extend((data.get('results') or {}).get('transactions',[]))
        if page>=pages:break
        page+=1
    result=latest_reports(items)
    return [tx for tx in result if not direction or tx.get('creditDebitIndicator')==direction]
