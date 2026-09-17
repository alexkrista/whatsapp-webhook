# coding: utf-8
"""Banking views and journaled, explicitly confirmed SEPA transfers."""
from __future__ import annotations
import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time
import urllib.parse
import uuid
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from flask import request, jsonify, Response
from brain_konfipay import ConnectionError, protect


def uid(value):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise ConnectionError('Ungültige Dateikennung.') from None


def day(value):
    try:
        return date.fromisoformat(value).isoformat()
    except (ValueError, TypeError):
        raise ConnectionError('Bitte einen gültigen Zeitraum auswählen.') from None


def normalized(value):
    if isinstance(value, Decimal): return format(value, 'f')
    if isinstance(value, list): return [normalized(x) for x in value]
    if isinstance(value, dict): return {k: normalized(v) for k,v in value.items()}
    return value


def localname(node): return node.tag.rsplit('}',1)[-1]
def child(node,name):
    matches=[x for x in node if localname(x)==name]
    if len(matches)!=1: raise ConnectionError('SEPA-Struktur ungültig: '+name)
    return matches[0]
def value(node,path):
    for name in path.split('/'):
        node=child(node,name)
    return (node.text or '').strip()


def review_xml(xml):
    if not isinstance(xml,str) or len(xml)>8_000_000 or '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper():
        raise ConnectionError('Ungültige oder zu große SEPA-Datei.')
    try: root=ET.fromstring(xml)
    except ET.ParseError: raise ConnectionError('SEPA-XML konnte nicht gelesen werden.') from None
    if not re.fullmatch(r'\{urn:iso:std:iso:20022:tech:xsd:pain\.001\.001\.\d{2}\}Document',root.tag):
        raise ConnectionError('Nur SEPA-Überweisungen pain.001 werden unterstützt.')
    if any(localname(x)=='Signature' for x in root.iter()): raise ConnectionError('Signierte Dateien werden nicht unterstützt.')
    init=child(root,'CstmrCdtTrfInitn');header=child(init,'GrpHdr')
    ids=[value(header,'MsgId')];entries=[];keys=[]
    def verify(node,items):
        for tag,expected in [('NbOfTxs',str(len(items))),('CtrlSum',format(sum((Decimal(x['amount']) for x in items),Decimal(0)),'f'))]:
            elements=[x for x in node if localname(x)==tag]
            if len(elements)>1:raise ConnectionError('Doppelte SEPA-Kontrollangabe.')
            if elements:
                try: correct=Decimal(elements[0].text)==Decimal(expected)
                except Exception:correct=False
                if not correct:raise ConnectionError('Anzahl oder Kontrollsumme der SEPA-Datei stimmt nicht.')
    for block in [x for x in init if localname(x)=='PmtInf']:
        if value(block,'PmtMtd')!='TRF':raise ConnectionError('Nur Überweisungen werden unterstützt.')
        ids.append(value(block,'PmtInfId'));debtor=value(block,'DbtrAcct/Id/IBAN');execution=child(block,'ReqdExctnDt')
        execution=(execution.text or '').strip() if not len(execution) else (execution[0].text or '').strip()
        if day(execution)<date.today().isoformat():raise ConnectionError('Ein Ausführungstermin liegt in der Vergangenheit. Bitte die Quelldatei mit gültigem Termin neu erstellen.')
        items=[]
        for tx in [x for x in block if localname(x)=='CdtTrfTxInf']:
            amount=child(child(tx,'Amt'),'InstdAmt');raw=(amount.text or '').strip()
            if amount.get('Ccy')!='EUR' or not re.fullmatch(r'\d+(?:\.\d{1,2})?',raw) or Decimal(raw)<=0:
                raise ConnectionError('Nur positive EUR-Überweisungsbeträge sind zulässig.')
            item={'name':value(tx,'Cdtr/Nm'),'iban':value(tx,'CdtrAcct/Id/IBAN'),'debtorIban':debtor,'date':execution,
                  'amount':format(Decimal(raw),'.2f'),'endToEndId':value(tx,'PmtId/EndToEndId'),
                  'purpose':' · '.join((x.text or '') for x in tx.iter() if localname(x) in {'Ustrd','Ref'})}
            key=hashlib.sha256(json.dumps(item,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
            keys.append(key);items.append(item)
        if not items:raise ConnectionError('Leerer Zahlungsblock.')
        verify(block,items);entries.extend(items)
    if not entries:raise ConnectionError('Keine Zahlungen gefunden.')
    verify(header,entries)
    if any(not x or len(x)>35 for x in ids) or len(set(x[:16] for x in ids))!=len(ids):
        raise ConnectionError('MsgId und PmtInfId müssen innerhalb der ersten 16 Zeichen eindeutig sein. Bitte die Dateien mit dem aktuellen Brain-Aufteiler erstellen.')
    return {'items':entries,'keys':keys,'ids':ids,'total':format(sum((Decimal(x['amount']) for x in entries),Decimal(0)),'.2f')}


class Payments:
    def __init__(self,client):
        self.client=client;self.lock=threading.RLock();self.drafts={}
        self.path=client.store.folder/'payments.sqlite'

    def db(self):
        # This directory is created and ACL protected when the API key is saved.
        if not self.client.store.exists():raise ConnectionError('Bitte zuerst konfipay verbinden.')
        db=sqlite3.connect(str(self.path),timeout=15)
        db.row_factory=sqlite3.Row
        db.execute('CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, digest TEXT UNIQUE, name TEXT, total TEXT, count INTEGER, created TEXT, state TEXT, rid TEXT, status TEXT, error TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS payment_keys (fingerprint TEXT PRIMARY KEY, transfer_id TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS contents (transfer_id TEXT PRIMARY KEY, payload BLOB NOT NULL)')
        return db

    def prepare(self,files):
        if not isinstance(files,list) or not 1<=len(files)<=50:raise ConnectionError('Bitte 1 bis 50 Dateien pro Übergabe auswählen.')
        if sum(len(str(x.get('xml',''))) for x in files if isinstance(x,dict))>8_000_000:raise ConnectionError('Zusammenstellung zu groß (höchstens 8 MB).')
        with self.lock:
            reviewed=[];allkeys=set();allids=set()
            accounts=self.client.accounts(self.client.auth_token())
            debtors={a['iban'].replace(' ','').upper() for a in accounts}
            db=self.db()
            try:
                for f in files:
                    if not isinstance(f,dict):raise ConnectionError('Ungültige Dateiliste.')
                    r=review_xml(f.get('xml'));r.update({'xml':f['xml'],'name':str(f.get('name') or 'SEPA.xml')[:150]})
                    for item in r['items']:
                        if item['debtorIban'].replace(' ','').upper() not in debtors:raise ConnectionError('Ein Auftraggeberkonto ist nicht als aktives Konto in konfipay eingerichtet.')
                    for key in r['keys']:
                        if key in allkeys or db.execute('SELECT 1 FROM payment_keys WHERE fingerprint=?',(key,)).fetchone():
                            raise ConnectionError('Eine Zahlung ist doppelt oder wurde bereits über Brain übergeben. Bitte den Zahlungsstatus prüfen.')
                        allkeys.add(key)
                    for ident in r['ids']:
                        if ident[:16] in allids:raise ConnectionError('Doppelte Dateikennung in der Zusammenstellung.')
                        allids.add(ident[:16])
                    r['digest']=hashlib.sha256(f['xml'].encode()).hexdigest();reviewed.append(r)
            finally:db.close()
            self.drafts={k:v for k,v in self.drafts.items() if v['expires']>time.time()}
            if len(self.drafts)>=10:raise ConnectionError('Zu viele offene Vorschauen. Bitte in 15 Minuten erneut versuchen.')
            token=secrets.token_urlsafe(32)
            summary={'files':[{'name':r['name'],'total':r['total'],'items':r['items']} for r in reviewed],
                     'count':sum(len(r['items']) for r in reviewed),'total':format(sum((Decimal(r['total']) for r in reviewed),Decimal(0)),'.2f')}
            self.drafts[token]={'expires':time.time()+900,'files':reviewed,'summary':summary}
            return {'draft':token,**summary}

    def submit(self,token,confirmed):
        if confirmed is not True:raise ConnectionError('Die verbindliche Freigabe fehlt.')
        with self.lock:
            draft=self.drafts.pop(str(token),None)
            if not draft or draft['expires']<time.time():raise ConnectionError('Vorschau abgelaufen oder bereits verwendet. Bitte neu prüfen.')
            results=[]
            for f in draft['files']:
                transfer=str(uuid.uuid4());db=self.db()
                try:
                    db.execute('BEGIN IMMEDIATE')
                    db.execute('INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?,?,?)',(transfer,f['digest'],f['name'],f['total'],len(f['items']),datetime.now(timezone.utc).isoformat(),'creating',None,None,None))
                    content=protect(json.dumps({'xml':f['xml'],'items':f['items']},ensure_ascii=False).encode())
                    db.execute('INSERT INTO contents VALUES (?,?)',(transfer,content))
                    for key in f['keys']:db.execute('INSERT INTO payment_keys VALUES (?,?)',(key,transfer))
                    db.commit()
                except sqlite3.IntegrityError:
                    db.rollback();db.close();raise ConnectionError('Doppelte Übergabe blockiert. Bitte die Historie prüfen.') from None
                finally:
                    db.close()
                rid=None;state='unknown';status=None;error=None
                try:
                    created=self.client.authenticated('POST','/payment-files?submit=false&scope=Sepa&verification-of-payee=true',body=f['xml'].encode('utf-8'))
                    info=created.get('paymentInfo') or {};rid=uid(info.get('rId'));status=(info.get('status') or {}).get('statusValue')
                    self.record(transfer,'created',rid,status,None)
                    if status=='KON_REJECTED':
                        state='rejected';error='konfipay hat die Datei abgelehnt. Details bitte im Portal prüfen.'
                    else:
                        self.record(transfer,'submitting',rid,status,None)
                        self.client.authenticated('POST','/payment-files/'+rid+'/submit?force=false&verification-of-payee=true')
                        state='submitted';self.record(transfer,state,rid,status,None)
                        current=self.client.authenticated('GET','/payment-files/'+rid)
                        status=((current.get('paymentInfo') or {}).get('status') or {}).get('statusValue')
                except ConnectionError as exc:
                    error=str(exc)
                except Exception:
                    error='Ergebnis der Übergabe unklar. Bitte in konfipay prüfen; nicht erneut einreichen.'
                self.record(transfer,state,rid,status,error)
                results.append({'id':transfer,'name':f['name'],'state':state,'rid':rid,'status':status,'error':error})
                if error or state=='rejected':break
            return {'results':results,'remaining':len(draft['files'])-len(results)}

    def record(self,ident,state,rid,status,error):
        db=self.db()
        try:db.execute('UPDATE transfers SET state=?,rid=?,status=?,error=? WHERE id=?',(state,rid,status,error,ident));db.commit()
        finally:db.close()

    def history(self):
        if not self.client.store.exists():return []
        db=self.db()
        try:return [dict(x) for x in db.execute('SELECT id,name,total,count,created,state,rid,status,error FROM transfers ORDER BY created DESC LIMIT 100')]
        finally:db.close()

    def content(self,ident):
        db=self.db()
        try:
            row=db.execute('SELECT payload FROM contents WHERE transfer_id=?',(uid(ident),)).fetchone()
            if not row:raise ConnectionError('Archivinhalt nicht gefunden.')
            return json.loads(protect(row['payload'],decrypt=True).decode())
        finally:db.close()


def install(ns,client,write_allowed,csrf):
    app=ns['app'];payments=Payments(client)
    client.brain_payments=payments
    ns['brain_bank_payments']={'payments':payments,'client':client,'write_allowed':write_allowed}
    import brain_konfipay_archive
    brain_konfipay_archive.install(ns,client,write_allowed)
    import brain_bank_assignment
    assignments=brain_bank_assignment.install(ns,write_allowed)
    paths=['expected-balances','context','transactions','statements','statement-download','payment-prepare','payment-submit','payment-history','payment-status','payment-content','payment-xml','payment-archive','payment-archive-content']
    ns['MOBILE_ALLOWED_PATHS'].update('/konfipay/api/'+p for p in paths)

    def guard():
        if not write_allowed():raise ConnectionError('Bitte die Seite neu laden und erneut versuchen.')
    def params(kind):
        start=day(request.args.get('from'));end=day(request.args.get('to'))
        if start>end:raise ConnectionError('Das Startdatum liegt nach dem Enddatum.')
        try:page=int(request.args.get('page','1'))
        except ValueError:raise ConnectionError('Ungültige Seitennummer.') from None
        if not 1<=page<=10000:raise ConnectionError('Ungültige Seitennummer.')
        p={'page-number':page,'page-size':100}
        p.update({'min-booking-date':start,'max-booking-date':end} if kind=='transactions' else {'min-date':start,'max-date':end})
        if request.args.get('account'):p['bank-account-rid']=uid(request.args['account'])
        return p
    def safe(fn):
        from functools import wraps
        @wraps(fn)
        def wrapped(*a,**k):
            try:return fn(*a,**k)
            except ConnectionError as exc:return jsonify({'ok':False,'error':str(exc)}),400
            except Exception:return jsonify({'ok':False,'error':'Der Vorgang konnte nicht abgeschlossen werden. Bitte den Status prüfen.'}),500
        return wrapped

    @app.get('/konfipay/api/expected-balances')
    @safe
    def expected():
        from brain_konfipay_expected import expected_balances
        return jsonify({'ok':True,**expected_balances(client)})

    @app.get('/konfipay/api/context')
    def context():return jsonify({'ok':True,'csrf':csrf,'configured':client.store.exists()})

    @app.get('/konfipay/api/transactions')
    @safe
    def transactions():
        p=params('transactions');booking=request.args.get('booking','booked');direction=request.args.get('direction','')
        if booking not in {'booked','pending'} or direction not in {'','CRDT','DBIT'}:raise ConnectionError('Ungültiger Umsatzfilter.')
        p['booking-status']=booking
        if direction:p['credit-or-debit-indicator']=direction
        if booking=='pending':
            from brain_konfipay_pending import pending_transactions
            items=pending_transactions(client,p);page=p['page-number']
            data={'results':{'transactions':items[(page-1)*100:page*100]},'pageNumber':page,'totalPages':max(1,(len(items)+99)//100),'totalItems':len(items)}
        else:
            data=client.authenticated('GET','/transactions?'+urllib.parse.urlencode(p))
        container=data.get('results') or {};items=container.get('transactions',[]) if isinstance(container,dict) else []
        result=[{k:x.get(k) for k in ['rId','amount','currency','creditDebitIndicator','name','iban','bookingDate','valueDate','purpose','bookingText','endToEndId','bankAccount','bankReference','paymentIdentificationId','customerReference','timestamp','transactionFile']} for x in items]
        if booking=='booked': assignments.observe(normalized(result))
        return jsonify(normalized({'ok':True,'items':result,'page':data.get('pageNumber',1),'pages':data.get('totalPages',1),'total':data.get('totalItems',len(result)),'booking':booking}))

    @app.get('/konfipay/api/statements')
    @safe
    def statements():
        p=params('statements');fmt=request.args.get('format','Pdf')
        if fmt not in {'Pdf','53','52','54','940','942'}:raise ConnectionError('Ungültiges Auszugsformat.')
        p['format']=fmt;data=client.authenticated('GET','/transaction-files?'+urllib.parse.urlencode(p))
        result=[{k:x.get(k) for k in ['rId','timestamp','format','fileName','bankAccount']} for x in (data.get('results') or [])]
        return jsonify(normalized({'ok':True,'items':result,'page':data.get('pageNumber',1),'pages':data.get('totalPages',1),'total':data.get('totalItems',len(result))}))

    @app.get('/konfipay/api/statement-download')
    @safe
    def download():
        rid=uid(request.args.get('rid'));data=client.authenticated('GET','/transaction-files/'+rid+'/content?base64-encoded=false',raw=True)
        pdf=data.lstrip().startswith(b'%PDF-');xml=data.lstrip().startswith(b'<');extension='pdf' if pdf else 'xml' if xml else 'txt'
        return Response(data,content_type='application/octet-stream',headers={'Content-Disposition':'attachment; filename="Kontoauszug_'+rid+'.'+extension+'"'})

    @app.post('/konfipay/api/payment-prepare')
    @safe
    def prepare():
        guard()
        if not request.content_length or request.content_length>9_000_000:raise ConnectionError('Dateigröße überschritten.')
        body=request.get_json(silent=True) or {}
        return jsonify({'ok':True,**payments.prepare(body.get('files'))})

    @app.post('/konfipay/api/payment-submit')
    @safe
    def submit():
        guard();body=request.get_json(silent=True) or {}
        return jsonify({'ok':True,**payments.submit(body.get('draft'),body.get('confirmed'))})

    @app.get('/konfipay/api/payment-history')
    @safe
    def history():return jsonify({'ok':True,'items':payments.history()})

    @app.get('/konfipay/api/payment-content')
    @safe
    def payment_content():return jsonify({'ok':True,'items':payments.content(request.args.get('id'))['items']})

    @app.get('/konfipay/api/payment-xml')
    @safe
    def payment_xml():
        ident=uid(request.args.get('id'));content=payments.content(ident)
        return Response(content['xml'].encode('utf-8'),content_type='application/octet-stream',headers={'Content-Disposition':'attachment; filename="SEPA_'+ident+'.xml"'})

    @app.get('/konfipay/api/payment-archive')
    @safe
    def archive():
        data=client.authenticated('GET','/payment-files?'+urllib.parse.urlencode(params('statements')))
        return jsonify(normalized({'ok':True,'items':[x.get('paymentInfo') or {} for x in (data.get('results') or [])],'page':data.get('pageNumber',1),'pages':data.get('totalPages',1),'total':data.get('totalItems',0)}))

    @app.get('/konfipay/api/payment-archive-content')
    @safe
    def archive_content():
        rid=uid(request.args.get('rid'));page=int(request.args.get('page','1'))
        if not 1<=page<=10000:raise ConnectionError('Ungültige Seitennummer.')
        data=client.authenticated('GET','/payments?'+urllib.parse.urlencode({'payment-file-rid':rid,'page-number':page,'page-size':100}))
        return jsonify(normalized({'ok':True,'items':data.get('results') or [],'page':data.get('pageNumber',1),'pages':data.get('totalPages',1),'total':data.get('totalItems',0)}))

    @app.post('/konfipay/api/payment-status')
    @safe
    def payment_status():
        guard();body=request.get_json(silent=True) or {};rid=uid(body.get('rid'))
        row=next((r for r in payments.history() if r['rid']==rid),None)
        if not row:raise ConnectionError('Zahlungsdatei nicht in der Brain-Historie gefunden.')
        data=client.authenticated('GET','/payment-files/'+rid);info=data.get('paymentInfo') or {};status=(info.get('status') or {}).get('statusValue')
        payments.record(row['id'],row['state'],rid,status,row['error'])
        return jsonify({'ok':True,'status':status})
