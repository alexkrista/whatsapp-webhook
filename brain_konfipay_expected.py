"""Read-only expected balances, keeping statement balances separate."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import urlencode
from brain_konfipay import ConnectionError

def expected_balances(client):
    accounts=client.accounts(client.auth_token())
    from brain_konfipay_own import outstanding,reconcile,iban
    local=outstanding(client)
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
            result['ownPayments']=[{'name':x['item']['name'],'amount':x['item']['amount'],'date':x['item']['date'],'transfer':x['transfer']} for x in own[-20:]]
            lookup_start=min([start]+[date.fromisoformat(x['item']['date']) for x in own])
            seen=set();count=0;bank=[]
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
                    if page>=pages:break
                    page+=1
            expected=base+sums['bookedIn']-sums['bookedOut']+sums['pendingIn']-sums['pendingOut']
            # The bank movements are known even when an own payment cannot be
            # uniquely matched. Keep their subtotal separate from the estimate.
            result.update(reportedBalance=format(expected,'.2f'),pendingCount=count)
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
