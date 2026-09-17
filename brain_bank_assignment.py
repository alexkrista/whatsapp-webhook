"""Explicit allocation of booked bank movements. Journal and debtor posting are atomic."""
from contextlib import contextmanager
from datetime import datetime, date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import json
import threading
from flask import request, jsonify

LOCK = threading.RLock()
CATEGORIES = {
    'invoice':'Rechnung', 'electricity':'Strom', 'municipality':'Wasser / Kanal / Müll Gemeinde',
    'heating':'Heizung', 'rent':'Miete', 'vehicle_insurance':'KFZ Versicherung',
    'vehicle_leasing':'KFZ Leasing', 'bike_leasing':'Bike Leasing', 'software':'Software',
    'liability_insurance':'Haftpflicht Versicherung', 'bank_fee':'Bankgebühren',
    'interest':'Zinsen', 'wage':'Löhne', 'telephone':'Telefon',
    'renovation_installment':'Rate Sanierung', 'internal_revolut':'Umbuchung · Revolut',
    'internal_revolut_old':'Umbuchung · Revolut alt', 'internal_aircash':'Umbuchung · Aircash',
    'internal_cash':'Umbuchung · Kassa', 'alex_private':'Alex Privat',
    'tax':'Steuer', 'other':'Neue Kostenart',
}
FREQUENCIES = {'none':'Einmalig', 'monthly':'Monatlich', 'quarterly':'Vierteljährlich',
               'semiannual':'Halbjährlich', 'annual':'Jährlich', 'fixed':'Fixer Zahlungsplan'}
RENOVATION_DATES = ['2026-08-31', '2027-08-26', '2027-08-31', '2028-02-26']

def cents(value):
    try:
        d = Decimal(str(value))
        if not d.is_finite() or d != d.quantize(Decimal('.01')):
            raise ValueError()
        return int(d * 100)
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError('Bitte einen gültigen Betrag mit höchstens zwei Nachkommastellen eingeben.') from None

def amount(value):
    return format(Decimal(value) / 100, '.2f')

def now():
    return datetime.now().isoformat(timespec='seconds')

class Assignments:
    def __init__(self, ns):
        self.ns = ns
        self.ready = False

    @property
    def outgoing(self):
        store = self.ns['app'].extensions.get('kristine_outgoing_store')
        if store is None:
            raise ValueError('Die Rechnungsverwaltung ist noch nicht bereit.')
        return store

    @contextmanager
    def db(self):
        with self.outgoing.connect() as c:
            if not self.ready:
                c.executescript('''
            CREATE TABLE IF NOT EXISTS bank_assignment_transactions(
                rid TEXT PRIMARY KEY, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, observed TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS bank_assignments(
                rid TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
                note TEXT NOT NULL, recurring INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS bank_assignments_fingerprint ON bank_assignments(fingerprint);
            CREATE TABLE IF NOT EXISTS bank_assignment_lines(
                id INTEGER PRIMARY KEY, rid TEXT NOT NULL REFERENCES bank_assignments(rid),
                category TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
                label TEXT NOT NULL, paid INTEGER NOT NULL, difference INTEGER NOT NULL,
                mode TEXT NOT NULL, reason TEXT NOT NULL, decision TEXT NOT NULL,
                task_id TEXT, task_error TEXT, correction_id INTEGER, decided TEXT);
                ''')
                columns={row['name'] for row in c.execute('PRAGMA table_info(bank_assignments)')}
                if 'frequency' not in columns:
                    c.execute("ALTER TABLE bank_assignments ADD COLUMN frequency TEXT NOT NULL DEFAULT 'none'")
                if 'schedule_json' not in columns:
                    c.execute("ALTER TABLE bank_assignments ADD COLUMN schedule_json TEXT NOT NULL DEFAULT '[]'")
                c.commit()
                self.ready = True
            yield c

    def fingerprint(self, x):
        # A bank reference is used only as a duplicate warning, never to silently merge rows.
        ref = str(x.get('bankReference') or '').strip()
        if not ref or ref.upper() in {'NOTPROVIDED','NONREF','N/A'}:
            return 'rid:' + str(x['rId'])
        bank = x.get('bankAccount') or {}
        return hashlib.sha256(json.dumps([bank.get('iban') or bank.get('rId'), ref,
            x.get('bookingDate'), x.get('creditDebitIndicator'), cents(x['amount']),
            x.get('currency')], ensure_ascii=False).encode()).hexdigest()

    def observe(self, items):
        with LOCK, self.db() as c:
            for x in items:
                if not x.get('rId'): continue
                payload = json.dumps(x, ensure_ascii=False, default=str)
                c.execute('INSERT INTO bank_assignment_transactions VALUES(?,?,?,?) '
                    'ON CONFLICT(rid) DO UPDATE SET payload=excluded.payload,fingerprint=excluded.fingerprint,observed=excluded.observed',
                    (x['rId'], payload, self.fingerprint(x), now()))
            c.commit()

    def supplier_overlay(self, rows, include_resolved=False):
        with self.db() as c:
            totals = {(r['source'], r['target']): r['paid'] for r in c.execute(
                "SELECT source,target,SUM(paid) paid FROM bank_assignment_lines WHERE source IN ('WinWorker','KRISTINE') GROUP BY source,target")}
        result = []
        for item in rows:
            row = dict(item)
            paid = totals.get((row.get('source'),str(row.get('id'))), 0)
            if paid:
                original = cents(row['amount'])
                row.update(invoiceGross=amount(original), bankPaid=amount(paid), amount=float(amount(max(0,original-paid))))
                if paid >= original:
                    row.update(paymentStatus='paid', paymentState='paid')
                elif row.get('paymentStatus') == 'sepa_submitted':
                    # The posted partial amount releases only the remaining invoice balance.
                    row.update(paymentStatus='open', paymentState='open')
            if include_resolved or row.get('paymentStatus') != 'paid': result.append(row)
        return result

    def candidates(self, tx):
        if tx['creditDebitIndicator'] == 'CRDT':
            rows = [dict(source='OUTGOING', target=str(x['invoiceId']), label=x['customer']+' · '+str(x['invoiceNumber']),
                    open=amount(cents(x['openGross'])), currency=x['currency'], number=x['invoiceNumber'], run=x['runId'])
                    for x in self.outgoing.debtor_open_items()]
        else:
            from brain_finance_source import FinanceStore
            source_rows = self.supplier_overlay(FinanceStore(self.ns).items(True), True)
            source_rows = [x for x in source_rows if float(x.get('amount') or 0) > .005 and
                           (x.get('paymentStatus') != 'paid' or x.get('paymentMethod') == 'direct_debit')]
            rows = [dict(source=x['source'], target=str(x['id']),
                    label=x['supplier']+' · '+str(x.get('invoiceNumber') or '')+(' · Einzug aus WW' if x.get('source')=='WinWorker' and x.get('paymentMethod')=='direct_debit' else ''),
                    open=amount(cents(x['amount'])), currency=x['currency'], number=x.get('invoiceNumber'), e2e=x.get('paymentId'))
                    for x in source_rows]
        purpose = str(tx.get('purpose') or '').casefold()
        for x in rows:
            x['suggested'] = bool((x.get('number') and str(x['number']).casefold() in purpose) or
                                 (x.get('e2e') and x['e2e']==tx.get('endToEndId')))
        return sorted([x for x in rows if x['currency']==tx['currency']], key=lambda x:(not x['suggested'],x['label']))

    def detail(self, rid):
        with self.db() as c:
            t = c.execute('SELECT * FROM bank_assignment_transactions WHERE rid=?',(rid,)).fetchone()
            a = c.execute('SELECT * FROM bank_assignments WHERE rid=?',(rid,)).fetchone()
            if not t: raise ValueError('Bitte die gebuchten Umsätze zuerst neu laden.')
            tx = json.loads(t['payload'])
            lines = [dict(x) for x in c.execute('SELECT * FROM bank_assignment_lines WHERE rid=? ORDER BY id',(rid,))]
        if a:
            current = {(x['source'],x['target']):x for x in self.candidates(tx)}
            for line in lines:
                line['open'] = current.get((line['source'],line['target']),{}).get('open','0.00')
                line['paid'] = amount(line['paid']); line['difference'] = amount(line['difference'])
            frequency=str(a['frequency'] or ('monthly' if a['recurring'] else 'none'))
            try:schedule=json.loads(a['schedule_json'] or '[]')
            except Exception:schedule=[]
            return dict(transaction=tx, assigned=True, lines=lines, note=a['note'], recurring=bool(a['recurring']),
                        frequency=frequency, frequencyLabel=FREQUENCIES.get(frequency,frequency), scheduleDates=schedule)
        recurring = False
        if tx.get('iban'):
            with self.db() as c:
                for prior in c.execute('SELECT payload FROM bank_assignments WHERE recurring=1'):
                    other=json.loads(prior['payload'])
                    if other.get('iban')==tx.get('iban') and other.get('creditDebitIndicator')==tx.get('creditDebitIndicator'):
                        recurring=True; break
        return dict(transaction=tx, assigned=False, candidates=self.candidates(tx), recurringSuggestion=recurring)

    def statuses(self, rids):
        with self.db() as c:
            return {rid:bool(c.execute('SELECT 1 FROM bank_assignments WHERE rid=?',(rid,)).fetchone()) for rid in rids}

    def legacy_check(self, tx):
        """Do not post an already reconciled imported CAMT movement a second time."""
        f = self.ns.get('_capture_connection')
        if not f: return
        c = f(self.ns['CAPTURE_DB'])
        try:
            if not c.execute("SELECT 1 FROM sqlite_master WHERE name='brain_statement_movements'").fetchone(): return
            e2e = str(tx.get('endToEndId') or '')
            if not e2e or e2e.upper()=='NOTPROVIDED': return
            hit = c.execute("SELECT 1 FROM brain_statement_movements m JOIN brain_statement_imports s ON s.id=m.statement_id "
                "WHERE m.status IN ('reconciled','partial') AND m.end_to_end_id=? AND m.booking_date=? AND s.account_iban=? AND ABS(m.amount-?)<0.005 LIMIT 1",
                (e2e,str(tx['bookingDate'])[:10],(tx.get('bankAccount') or {}).get('iban'),float(tx['amount']))).fetchone()
            if hit: raise ValueError('Dieser Umsatz hat bereits eine CAMT-Zuordnung. Bitte diese im bisherigen Abgleich prüfen; es wird keine zweite Zahlung gebucht.')
        finally: c.close()

    def assign(self, body):
        rid = str(body.get('rid') or '')
        with LOCK:
            with self.db() as c:
                existing = c.execute('SELECT 1 FROM bank_assignments WHERE rid=?',(rid,)).fetchone()
                if existing: return self.detail(rid)
                row = c.execute('SELECT * FROM bank_assignment_transactions WHERE rid=?',(rid,)).fetchone()
                if not row: raise ValueError('Nur geladene, gebuchte Umsätze können zugeordnet werden.')
                tx = json.loads(row['payload'])
                if c.execute('SELECT 1 FROM bank_assignments WHERE fingerprint=?',(row['fingerprint'],)).fetchone():
                    raise ValueError('Eine Zahlung mit derselben Bankreferenz wurde bereits zugeordnet. Bitte den Doppelabruf prüfen.')
            self.legacy_check(tx)
            pool = {(x['source'],x['target']): x for x in self.candidates(tx)}
            clean=[]; seen=set()
            frequency=str(body.get('frequency') or ('monthly' if body.get('recurring') is True else 'none')).strip().lower()
            if frequency not in FREQUENCIES: raise ValueError('Wiederholung ist ungültig.')
            raw = body.get('lines')
            if not isinstance(raw,list) or not 1<=len(raw)<=100: raise ValueError('Bitte mindestens eine Zuordnung auswählen.')
            for x in raw:
                cat=x.get('category','invoice'); paid=cents(x.get('amount')); mode=x.get('mode','partial')
                if cat not in CATEGORIES or paid<=0: raise ValueError('Ungültige Zuordnung.')
                source=str(x.get('source') or ''); target=str(x.get('target') or '')
                reason=str(x.get('reason') or '').strip()[:1000]
                difference=0; label=CATEGORIES[cat]
                if cat=='invoice':
                    item=pool.get((source,target))
                    if not item or (source,target) in seen: raise ValueError('Rechnung nicht mehr offen oder doppelt ausgewählt. Bitte die Maske neu öffnen.')
                    seen.add((source,target)); difference=cents(item['open'])-paid; label=item['label']
                    if difference<0: raise ValueError('Der zugeordnete Betrag ist größer als der offene Rechnungsbetrag.')
                    if mode not in {'partial','discount','deduction'}: raise ValueError('Bitte die Differenz erläutern.')
                    if difference and mode!='partial' and not reason: raise ValueError('Bitte Skonto / Abzug begründen.')
                    if source!='OUTGOING' and difference and mode!='partial':
                        raise ValueError('Lieferanten-Abzüge bitte zunächst als Teilzahlung erfassen. Der Rest bleibt offen, bis die Lieferantengutschrift vorliegt.')
                else:
                    source=target=''; mode='partial'
                    if cat=='other' and not reason: raise ValueError('Bitte die neue Kostenart eintragen.')
                    if cat=='other': label='Neue Kostenart · '+reason[:120]
                clean.append(dict(category=cat,source=source,target=target,label=label,paid=paid,difference=difference,
                                  mode=mode,reason=reason,decision='pending' if difference and mode!='partial' else 'none'))
            schedule=RENOVATION_DATES if any(x['category']=='renovation_installment' for x in clean) else []
            if schedule:frequency='fixed'
            if sum(x['paid'] for x in clean)!=abs(cents(tx['amount'])):
                raise ValueError('Die Teilbeträge müssen zusammen genau dem Bankumsatz entsprechen.')
            with self.db() as c:
                c.execute('BEGIN IMMEDIATE')
                # Recheck invoice availability after obtaining the database write lock.
                current={(x['source'],x['target']):x for x in self.candidates(tx)}
                for x in clean:
                    if x['category']=='invoice':
                        old=pool[(x['source'],x['target'])]; new=current.get((x['source'],x['target']))
                        if not new or new['open']!=old['open']: raise ValueError('Der offene Betrag hat sich geändert. Bitte neu laden.')
                c.execute('INSERT INTO bank_assignments(rid,fingerprint,payload,note,recurring,created,frequency,schedule_json) VALUES(?,?,?,?,?,?,?,?)',
                    (rid,row['fingerprint'],row['payload'],str(body.get('note') or '')[:1000],int(frequency!='none'),now(),frequency,json.dumps(schedule)))
                for x in clean:
                    c.execute('INSERT INTO bank_assignment_lines(rid,category,source,target,label,paid,difference,mode,reason,decision) VALUES(?,?,?,?,?,?,?,?,?,?)',
                        (rid,x['category'],x['source'],x['target'],x['label'],x['paid'],x['difference'],x['mode'],x['reason'],x['decision']))
                    if x['source']=='OUTGOING':
                        invoice=c.execute('SELECT * FROM outgoing_invoices WHERE id=?',(int(x['target']),)).fetchone()
                        if not invoice or invoice['status']!='issued': raise ValueError('Rechnung nicht buchbar.')
                        gross=Decimal(amount(x['paid'])); rate=Decimal(invoice['vat_rate'])
                        net=(gross/(1+rate/100)).quantize(Decimal('.01'),rounding=ROUND_HALF_UP); vat=gross-net
                        c.execute('INSERT INTO outgoing_payments(run_id,invoice_id,payment_date,net,vat,gross,reference,source,source_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                            (invoice['run_id'],invoice['id'],str(tx['bookingDate'])[:10],str(net),str(vat),str(gross),str(tx.get('purpose') or '')[:1000],
                             'KONFIPAY',rid+':'+x['target'],now()))
                self.outgoing._audit(c,'bank_assignment',rid,'assign',{'lines':clean,'frequency':frequency,'scheduleDates':schedule})
                c.commit()
            self.sync_tasks(rid)
            return self.detail(rid)

    def sync_tasks(self, rid):
        with self.db() as c:
            lines=[dict(x) for x in c.execute("SELECT * FROM bank_assignment_lines WHERE rid=? AND decision='pending' AND task_id IS NULL",(rid,))]
        for line in lines:
            tid='bank-deduction-'+str(line['id'])
            try:
                api=self.ns.get('kristine_api_request')
                if not callable(api): raise ValueError('Aufgabenverbindung nicht verfügbar')
                boot=api('/kristine/api/bootstrap') or {}; tasks=list(boot.get('tasks') or [])
                employees=boot.get('employees') or []
                employee=next((e for e in employees if 'alex' in ' '.join(str(e.get(k) or '') for k in ('nickname','name','employeeName')).lower()),None)
                if not employee: raise ValueError('Alex wurde in den Mitarbeitern nicht gefunden')
                if not any(str(t.get('id'))==tid for t in tasks):
                    tasks.append(dict(id=tid,title='Abzug gerechtfertigt? · '+line['label'],
                        assigneeId=str(employee.get('id') or employee.get('employeeId')),assigneeName=employee.get('nickname') or employee.get('name') or 'Alex',
                        taskType='Sonstiges',priority='heute',creatorId='brain-bank',creatorName='The Brain',
                        dueDate=date.today().isoformat(),status='open',createdAt=now(),completedAt=None,
                        reminder=f"Zahlung {amount(line['paid'])} EUR · Differenz {amount(line['difference'])} EUR · {line['reason']}\nIn Brain → Bank → Abzüge prüfen. Vorgang {line['id']}."))
                    api('/kristine/api/tasks',method='PUT',payload={'tasks':tasks})
                with self.db() as c:
                    c.execute('UPDATE bank_assignment_lines SET task_id=?,task_error=NULL WHERE id=?',(tid,line['id'])); c.commit()
            except Exception:
                with self.db() as c:
                    c.execute('UPDATE bank_assignment_lines SET task_error=? WHERE id=?',('Aufgabe noch nicht an Alex übermittelt. Bitte erneut versuchen.',line['id'])); c.commit()

    def decide(self, ident, approved):
        with LOCK:
            with self.db() as c:
                row=c.execute('SELECT * FROM bank_assignment_lines WHERE id=?',(ident,)).fetchone()
                if not row or row['decision'] not in {'pending','issuing','approved','rejected'}: raise ValueError('Keine offene Abzugsprüfung.')
                row=dict(row)
                if row['decision'] in {'approved','rejected'}: return self.detail(row['rid'])
                if row['decision']=='issuing' and not approved: raise ValueError('Die Gutschrifterstellung läuft bereits. Bitte abschließen.')
                if approved and not row['correction_id']:
                    current=next((x for x in self.outgoing.debtor_open_items() if str(x['invoiceId'])==row['target']),None)
                    if not current or cents(current['openGross']) < row['difference']:
                        raise ValueError('Der offene Rechnungsbetrag hat sich inzwischen geändert. Bitte den Abzug vor der Gutschrift erneut prüfen.')
                c.execute('UPDATE bank_assignment_lines SET decision=? WHERE id=?',('issuing' if approved else 'rejected',ident));c.commit()
            if approved:
                correction_id=self.outgoing.create_correction_draft(int(row['target']),
                    {'kind':'GS','gross':amount(row['difference']),'reason':row['reason'],
                     'description':'Genehmigter '+('Skonto' if row['mode']=='discount' else 'Abzug')+' zu '+row['label']},assignment_line=ident)['id']
                with self.db() as c:
                    c.execute('UPDATE bank_assignment_lines SET correction_id=? WHERE id=?',(correction_id,ident));c.commit()
                # Reuse numbering, original invoice link and PDF production from outgoing invoices.
                app=self.ns['app']; response=app.make_response(app.view_functions['outgoing_invoice_issue'](correction_id))
                data=response.get_json(silent=True) or {}
                if response.status_code>=400 or not data.get('ok'):
                    raise ValueError('Die Gutschrift wurde vorbereitet, konnte aber noch nicht fertiggestellt werden. Bitte „Gutschrift fertigstellen“ erneut wählen.')
                with self.db() as c:
                    c.execute("UPDATE bank_assignment_lines SET decision='approved',decided=? WHERE id=?",(now(),ident));c.commit()
            else:
                with self.db() as c:
                    c.execute('UPDATE bank_assignment_lines SET decided=? WHERE id=?',(now(),ident));c.commit()
            with self.db() as c:
                c.execute('UPDATE bank_assignment_lines SET task_error=NULL WHERE id=?',(ident,))
                self.outgoing._audit(c,'bank_deduction',ident,'approved' if approved else 'rejected',{});c.commit()
            self.finish_task(row)
            return self.detail(row['rid'])

    def finish_task(self, row):
        if not row.get('task_id'): return
        try:
            api=self.ns['kristine_api_request']; boot=api('/kristine/api/bootstrap') or {};tasks=boot.get('tasks') or []
            task=next((x for x in tasks if x.get('id')==row['task_id']),None)
            if task and task.get('status')!='done':
                task.update(status='done',completedAt=now())
                api('/kristine/api/tasks',method='PUT',payload={'tasks':tasks})
        except Exception:
            with self.db() as c:
                c.execute('UPDATE bank_assignment_lines SET task_error=? WHERE id=?',('Entscheidung gespeichert. Die Aufgabe bitte in KRISTINE manuell als erledigt markieren.',row['id']));c.commit()

def install(ns, write_allowed):
    app=ns['app']; service=Assignments(ns)
    ns['bank_assignments']=service
    ns['bank_supplier_overlay']=service.supplier_overlay
    paths=['assignment-status','assignment','assignment-save','assignment-review','assignment-decide','assignment-tasks']
    ns['MOBILE_ALLOWED_PATHS'].update('/konfipay/api/'+p for p in paths)
    def endpoint(fn):
        from functools import wraps
        @wraps(fn)
        def wrapped():
            if request.method=='POST' and not write_allowed(): return jsonify(ok=False,error='Bitte die Bankseite neu laden.'),403
            if request.content_length and request.content_length>100000: return jsonify(ok=False,error='Anfrage zu groß.'),413
            try: return jsonify(ok=True,**fn())
            except ValueError as exc: return jsonify(ok=False,error=str(exc)),400
            except Exception:
                app.logger.exception('Bankzuordnung fehlgeschlagen')
                return jsonify(ok=False,error='Die Zuordnung konnte nicht abgeschlossen werden. Bitte neu öffnen und den gespeicherten Stand prüfen.'),500
        return wrapped
    @app.post('/konfipay/api/assignment-status')
    @endpoint
    def bank_assignment_status():
        ids=(request.get_json() or {}).get('ids',[])
        if not isinstance(ids,list) or len(ids)>100: raise ValueError('Zu viele Umsätze.')
        return {'statuses':service.statuses(ids)}
    @app.get('/konfipay/api/assignment')
    @endpoint
    def bank_assignment_detail(): return service.detail(request.args.get('rid',''))
    @app.post('/konfipay/api/assignment-save')
    @endpoint
    def bank_assignment_save(): return service.assign(request.get_json() or {})
    @app.get('/konfipay/api/assignment-review')
    @endpoint
    def bank_assignment_review():
        with service.db() as c:
            return {'items':[dict(x) for x in c.execute("SELECT id,rid,label,paid,difference,reason,mode,decision,task_error FROM bank_assignment_lines WHERE decision IN ('pending','issuing') ORDER BY id")]}
    @app.post('/konfipay/api/assignment-decide')
    @endpoint
    def bank_assignment_decide():
        data=request.get_json() or {}
        if not isinstance(data.get('approved'),bool): raise ValueError('Bitte Ja oder Nein auswählen.')
        return service.decide(int(data.get('id')),data['approved'])
    @app.post('/konfipay/api/assignment-tasks')
    @endpoint
    def bank_assignment_tasks():
        rid=str((request.get_json() or {}).get('rid') or ''); service.sync_tasks(rid);return service.detail(rid)
    return service
