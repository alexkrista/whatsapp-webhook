"""Read-only expected balances, keeping statement balances separate."""
from datetime import date, datetime, timedelta, timezone
from contextlib import closing
from decimal import Decimal
from urllib.parse import urlencode
from brain_konfipay import ConnectionError

def expected_balances(client):
    accounts=client.accounts(client.auth_token())
    from brain_konfipay_own import outstanding,reconcile,iban
    local=outstanding(client)
    duplicates={}
    payments=getattr(client,'brain_payments',None)
    if payments:
        with closing(payments.db()) as db:
            db.execute('CREATE TABLE IF NOT EXISTS bank_duplicate_pending (pending_rid TEXT PRIMARY KEY, booked_rid TEXT NOT NULL)')
            db.commit()
            duplicates=dict(db.execute('SELECT pending_rid,booked_rid FROM bank_duplicate_pending'))
    results=[];observed=[]
    for account in accounts:
        result={**account,'expected':None,'error':None}
        try:
            if account['amount'] is None or not account['date']:
                raise ConnectionError('Kein gebuchter Ausgangssaldo verfügbar.')
            base=Decimal(account['amount'])
            start=date.fromisoformat(account['date'][:10])+timedelta(days=1)
            if start>date.today()+timedelta(days=1):
                raise ConnectionError('Der Bankstand liegt in der Zukunft.')
            sums={'bookedIn':Decimal(0),'bookedOut':Decimal(0),'pendingIn':Decimal(0),'pendingOut':Decimal(0),'todayIn':Decimal(0),'todayOut':Decimal(0),'earlierNet':Decimal(0)}
            own=[x for x in local if iban(x['item']['debtorIban'])==iban(account['iban'])]
            result['ownPaymentCount']=len(own)
            result['ownPaymentTotal']=format(sum((Decimal(str(x['item']['amount'])) for x in own),Decimal(0)),'.2f')
            result['ownPayments']=[{'name':x['item'].get('name') or 'Empfänger unbekannt','amount':x['item']['amount'],'date':x['item']['date'],'transfer':x['transfer'],'index':x['index']} for x in own[-20:]]
            lookup_start=min([start]+[date.fromisoformat(x['item']['date']) for x in own])-timedelta(days=2)
            seen=set();count=0;bank=[];movements=[]
            for booking in ['booked','pending']:
                if booking=='booked' and lookup_start>date.today():continue
                params={'bank-account-rid':account['id'],'booking-status':booking,'page-size':100}
                if booking=='booked':params.update({'min-booking-date':lookup_start.isoformat(),'max-booking-date':date.today().isoformat()})
                else:params.update({'min-booking-date':date.today().isoformat(),'max-booking-date':date.today().isoformat()})
                page=1
                while True:
                    if booking=='pending':
                        from brain_konfipay_pending import pending_transactions
                        data={'results':{'transactions':pending_transactions(client,params)},'totalPages':1}
                    else:
                        data=client.authenticated('GET','/transactions?'+urlencode({**params,'page-number':page}))
                    pages=max(1,int(data.get('totalPages',1)))
                    if pages>200:raise ConnectionError('Zu viele Umsätze für eine vollständige Berechnung.')
                    for tx in (data.get('results') or {}).get('transactions',[]):
                        rid=tx.get('rId')
                        if not rid:raise ConnectionError('Eine Umsatzkennung fehlt; Berechnung nicht möglich.')
                        if rid in seen:continue
                        seen.add(rid)
                        if (tx.get('bankAccount') or {}).get('rId')!=account['id'] or tx.get('currency')!=account['currency']:
                            raise ConnectionError('Kontozuordnung oder Währung eines Umsatzes ist unklar.')
                        if booking=='pending' and rid in duplicates:
                            booked=next((x for x in bank if x['rId']==duplicates[rid] and x['_booking']=='booked'),None)
                            if (booked and booked.get('creditDebitIndicator')==tx.get('creditDebitIndicator')=='DBIT'
                                and booked.get('currency')==tx.get('currency')
                                and (booked.get('bankAccount') or {}).get('rId')==account['id']
                                and abs(Decimal(str(booked['amount'])))==abs(Decimal(str(tx['amount'])))):
                                movements.append({'booking':'pending','date':str(tx.get('bookingDate') or '')[:10],
                                    'name':'Bereits gebucht – doppelte Vormerkung','amount':format(abs(Decimal(str(tx['amount']))),'.2f'),
                                    'direction':'DBIT','excluded':True,'purpose':'Gleicher Umsatz ist im Bankstand enthalten.'})
                                continue
                        bank.append({**tx,'_booking':booking})
                        if booking=='booked' and str(tx.get('bookingDate') or '')[:10]<start.isoformat():continue
                        observed.append({'booking':booking,'account':account['id'],**{k:tx.get(k) for k in ['amount','currency','creditDebitIndicator','bookingDate','valueDate','name','iban','purpose','endToEndId','bankReference','paymentIdentificationId']}})
                        direction=tx.get('creditDebitIndicator')
                        if direction not in {'CRDT','DBIT'}:raise ConnectionError('Umsatzrichtung fehlt.')
                        amount=abs(Decimal(str(tx['amount'])))
                        if not amount.is_finite():raise ConnectionError('Ungültiger Umsatzbetrag.')
                        sums[booking+('In' if direction=='CRDT' else 'Out')]+=amount
                        booking_day=date.fromisoformat(str(tx.get('bookingDate',''))[:10])
                        if booking_day==date.today():sums['todayIn' if direction=='CRDT' else 'todayOut']+=amount
                        elif booking=='booked' and start<=booking_day<date.today():sums['earlierNet']+=amount if direction=='CRDT' else -amount
                        else:raise ConnectionError('Ein Umsatz liegt außerhalb des angeforderten Zeitraums.')
                        if booking=='pending':count+=1
                        movements.append({'booking':booking,'date':str(tx.get('bookingDate') or '')[:10],'name':tx.get('name') or 'Ohne Empfängerangabe','amount':format(amount,'.2f'),'direction':direction,'purpose':tx.get('purpose') or '', 'endToEndId':tx.get('endToEndId') or '', 'paymentIdentificationId':tx.get('paymentIdentificationId') or ''})
                    if page>=pages:break
                    page+=1
            expected=base+sums['bookedIn']-sums['bookedOut']+sums['pendingIn']-sums['pendingOut']
            # The bank movements are known even when an own payment cannot be
            # uniquely matched. Keep their subtotal separate from the estimate.
            result.update(reportedBalance=format(expected,'.2f'),pendingCount=count,bankMovements=movements[-50:],bankMovementCount=len(movements))
            result.update({k:format(v,'.2f') for k,v in sums.items()})
            own_state=reconcile(client,account,local,bank)
            result.update(own_state)
            expected-=Decimal(own_state['ownOutgoing'])
            result.update(expected=format(expected,'.2f'),pendingCount=count)
        except ConnectionError as exc:result['error']=str(exc)
        except Exception:result['error']='Die vollständige Berechnung ist derzeit nicht möglich.'
        results.append(result)
    from brain_konfipay_changes import remember
    try:tracking=remember(client.store.folder,results,observed)
    except Exception:tracking={'changeTracking':'unavailable'}
    return {'accounts':results,'date':date.today().isoformat(),'fetchedAt':datetime.now(timezone.utc).isoformat(),**tracking}
