"""Offisy cash movements: preview, immutable imports, explicit document links."""
import io,json,hashlib,re,secrets,zipfile,threading
from pathlib import Path
from datetime import datetime,date
from decimal import Decimal
from xml.etree import ElementTree as ET
from flask import request,jsonify,Response

LOCK=threading.RLock()
PREFIX='/incoming/kassa/book'
def stamp():return datetime.now().isoformat(timespec='seconds')
def cents(value):
    text=str(value).replace('€','').replace(' ','').strip()
    if ',' in text:text=text.replace('.','').replace(',','.')
    d=Decimal(text)
    if not d.is_finite() or d!=d.quantize(Decimal('.01')):raise ValueError('Betrag muss auf Cent genau sein.')
    return int(d*100)
def parse(raw):
    if len(raw)>8_000_000:raise ValueError('Excel-Datei ist zu groß.')
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if sum(x.file_size for x in z.infolist())>40_000_000:raise ValueError('Excel-Datei ist zu groß.')
        def xml(name):
            data=z.read(name)
            if b'<!DOCTYPE' in data or b'<!ENTITY' in data:raise ValueError('Unzulässiger XML-Inhalt.')
            return ET.fromstring(data)
        strings=[]
        if 'xl/sharedStrings.xml' in z.namelist():strings=[''.join(n.itertext()) for n in xml('xl/sharedStrings.xml').findall('{*}si')]
        sheets=[x for x in z.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml',x)]
        if len(sheets)!=1:raise ValueError('Bitte den offisy-Export mit genau einem Tabellenblatt verwenden.')
        rows=[]
        for row in xml(sheets[0]).findall('.//{*}sheetData/{*}row'):
            cells={}
            for c in row.findall('{*}c'):
                col=re.sub(r'\d','',c.get('r',''))
                if c.find('{*}f') is not None:raise ValueError('Bitte einen unveränderten Export ohne Formeln verwenden.')
                value=c.findtext('{*}v') or ''
                if c.get('t')=='s':value=strings[int(value)]
                elif c.get('t')=='inlineStr':value=''.join(c.find('{*}is').itertext())
                cells[col]=value
            values=[cells.get(x,'') for x in 'ABCDEF']
            if any(values):rows.append(values)
    if not rows or rows[0]!=['Nr.','Verwendung','Referenz-Nr.','Datum','Ein/Ausgang','Betrag']:raise ValueError('Die Spalten passen nicht zum offisy-Kassenexport.')
    result=[];seen=set()
    for r in rows[1:]:
        if not re.fullmatch(r'\d+',r[0]):raise ValueError('Ungültige Bewegungsnummer.')
        nr=int(r[0]);day=datetime.strptime(r[3],'%d.%m.%Y %H:%M').isoformat(timespec='minutes');amount=cents(r[5])
        if nr in seen:raise ValueError('Bewegungsnummer ist in der Datei doppelt: '+str(nr))
        if r[4] not in {'Eingang','Ausgang'} or (r[4]=='Eingang' and amount<0) or (r[4]=='Ausgang' and amount>0):raise ValueError('Richtung und Betrag passen nicht zusammen.')
        seen.add(nr);result.append(dict(nr=nr,usage=r[1],reference=r[2],date=day,direction=r[4],cents=amount))
    if not result:raise ValueError('Die Datei enthält keine Bewegungen.')
    return result

class Book:
    def __init__(self,ns):self.ns=ns
    def db(self,area):
        if area not in {'live','test'}:raise ValueError('Test oder Echt auswählen.')
        c=self.ns['_capture_area_connection'](area)
        c.executescript('''CREATE TABLE IF NOT EXISTS offisy_cash(nr INTEGER PRIMARY KEY,payload TEXT NOT NULL,amount INTEGER NOT NULL,day TEXT NOT NULL,imported TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS offisy_imports(hash TEXT PRIMARY KEY,name TEXT NOT NULL,created TEXT NOT NULL,count INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS offisy_opening(year INTEGER PRIMARY KEY,amount INTEGER NOT NULL,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS offisy_documents(id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,content BLOB NOT NULL,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS offisy_links(nr INTEGER PRIMARY KEY,document_id TEXT,invoice_id INTEGER,note TEXT NOT NULL,created TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS offisy_invoice_once ON offisy_links(invoice_id) WHERE invoice_id IS NOT NULL;
        ''');c.commit();return c
    def check(self,c,rows):
        fresh=[];duplicates=0
        for row in rows:
            prior=c.execute('SELECT payload FROM offisy_cash WHERE nr=?',(row['nr'],)).fetchone()
            if prior:
                if json.loads(prior[0])!=row:raise ValueError('Bewegung '+str(row['nr'])+' wurde im Export geändert. Import angehalten; bestehende Zuordnung bleibt erhalten.')
                duplicates+=1
            else:fresh.append(row)
        return fresh,duplicates
    def load(self,area,year):
        with LOCK:
            c=self.db(area)
            try:
                rows=[]
                for r in c.execute('SELECT m.*,l.document_id,l.invoice_id,l.note,l.created linked FROM offisy_cash m LEFT JOIN offisy_links l USING(nr) WHERE substr(m.day,1,4)=? ORDER BY m.day DESC,m.nr DESC',(str(year),)):
                    x=json.loads(r['payload']);x.update(document=r['document_id'],invoice=r['invoice_id'],note=r['note'],assigned=bool(r['linked']));rows.append(x)
                opening=c.execute('SELECT amount FROM offisy_opening WHERE year=?',(year,)).fetchone()
                last=c.execute('SELECT MAX(imported) FROM offisy_cash WHERE substr(day,1,4)=?',(str(year),)).fetchone()[0]
                net=sum(x['cents'] for x in rows)
                return dict(items=rows,opening=opening[0] if opening else None,balance=opening[0]+net if opening else None,net=net,lastImport=last,lastMovement=max((x['date'] for x in rows),default=None))
            finally:c.close()
    def commit(self,area,rows,name,digest,opening=None):
        with LOCK:
            c=self.db(area)
            try:
                c.execute('BEGIN IMMEDIATE');fresh,dupes=self.check(c,rows)
                if opening is not None:
                    years={int(r['date'][:4]) for r in rows}
                    if len(years)!=1:raise ValueError('Anfangsbestand nur bei genau einem Exportjahr angeben.')
                    year=years.pop();old=c.execute('SELECT amount FROM offisy_opening WHERE year=?',(year,)).fetchone()
                    if old and old[0]!=opening:raise ValueError('Der Anfangsbestand ist bereits anders gespeichert.')
                    c.execute('INSERT OR IGNORE INTO offisy_opening VALUES(?,?,?)',(year,opening,stamp()))
                for row in fresh:c.execute('INSERT INTO offisy_cash VALUES(?,?,?,?,?)',(row['nr'],json.dumps(row,ensure_ascii=False),row['cents'],row['date'],stamp()))
                c.execute('INSERT OR IGNORE INTO offisy_imports VALUES(?,?,?,?)',(digest,name,stamp(),len(fresh)));c.commit()
                return dict(added=len(fresh),duplicates=dupes)
            except Exception:c.rollback();raise
            finally:c.close()
    def manual_incoming(self,area,day,amount,usage,reference=""):
        usage=str(usage or "").strip()
        reference=str(reference or "").strip()
        if len(usage)<3:raise ValueError('Bitte den Grund des Kassaeingangs angeben.')
        if len(usage)>300 or len(reference)>120:raise ValueError('Text oder Referenz ist zu lang.')
        try:parsed=datetime.strptime(str(day or ""),'%Y-%m-%d')
        except ValueError:raise ValueError('Bitte ein gültiges Buchungsdatum angeben.') from None
        if parsed.date()>date.today():raise ValueError('Kassaeingänge können nicht in der Zukunft gebucht werden.')
        value=cents(amount)
        if value<=0:raise ValueError('Der Kassaeingang muss größer als 0,00 EUR sein.')
        if value>10_000_000:raise ValueError('Der Kassaeingang ist zu hoch; bitte Betrag prüfen.')
        booked=parsed.replace(hour=datetime.now().hour,minute=datetime.now().minute).isoformat(timespec='minutes')
        with LOCK:
            c=self.db(area)
            try:
                c.execute('BEGIN IMMEDIATE')
                minimum=c.execute('SELECT MIN(nr) FROM offisy_cash').fetchone()[0]
                nr=min(int(minimum or 0),0)-1
                row=dict(nr=nr,usage=usage,reference=reference,date=booked,direction='Eingang',cents=value,manual=True)
                c.execute('INSERT INTO offisy_cash VALUES(?,?,?,?,?)',(nr,json.dumps(row,ensure_ascii=False),value,booked,stamp()))
                c.commit();return row
            except Exception:c.rollback();raise
            finally:c.close()

def install(ns):
    if ns.get('cash_book'):return
    app=ns['app'];book=Book(ns);ns['cash_book']=book;csrf=secrets.token_urlsafe(32);drafts={}
    paths=[PREFIX+'/'+x for x in ('list','preview','import','manual-incoming','documents','attach','link','file','script','balance')]
    ns['MOBILE_ALLOWED_PATHS'].update(paths)
    @app.before_request
    def cash_book_guard():
        if request.path not in paths:return
        if request.method=='POST':
            from urllib.parse import urlsplit
            if urlsplit(request.headers.get('Origin','')).netloc!=request.host or not secrets.compare_digest(request.headers.get('X-Cash-Token',''),csrf):return jsonify(ok=False,error='Bitte Seite neu laden.'),403
            if not request.content_length or request.content_length>13_000_000:return jsonify(ok=False,error='Datei ist leer oder zu groß.'),400
    @app.after_request
    def cash_book_page(response):
        if request.path in paths:response.headers['Cache-Control']='no-store'
        if request.path=='/incoming/kassa' and response.status_code==200:
            html=response.get_data(as_text=True)
            if 'cashBookMount' not in html:
                html=html.replace('</main>','<section class="card" id="cashBookMount" data-token="'+csrf+'"></section></main>')
                html=html.replace('</body>','<script src="'+PREFIX+'/script"></script></body>');response.set_data(html)
        return response
    def safe(fn):
        try:return jsonify(ok=True,**fn())
        except (ValueError,zipfile.BadZipFile,KeyError) as exc:return jsonify(ok=False,error=str(exc)),400
        except Exception:return jsonify(ok=False,error='Kassa-Vorgang fehlgeschlagen. Es wurde keine Zuordnung bestätigt.'),500
    def area():return request.args.get('area','live')
    @app.get(PREFIX+'/list')
    def cash_list():return safe(lambda:book.load(area(),int(request.args.get('year',date.today().year))))
    @app.get(PREFIX+'/balance')
    def cash_balance():return safe(lambda:book.load('live',date.today().year))
    @app.post(PREFIX+'/preview')
    def cash_preview():
        def run():
            upload=request.files.get('file')
            if upload is None:raise ValueError('Bitte Excel-Datei wählen.')
            raw=upload.read(8_000_001);rows=parse(raw);a=area();c=book.db(a)
            try:fresh,dupes=book.check(c,rows)
            finally:c.close()
            import time
            with LOCK:
                for key in list(drafts):
                    if drafts[key]['expires']<time.time():del drafts[key]
                token=secrets.token_urlsafe(32);drafts[token]=dict(rows=rows,area=a,name=Path(upload.filename or 'offisy.xlsx').name,digest=hashlib.sha256(raw).hexdigest(),expires=time.time()+900)
            return dict(token=token,items=rows,new=len(fresh),duplicates=dupes,incoming=sum(x['cents'] for x in rows if x['cents']>0),outgoing=-sum(x['cents'] for x in rows if x['cents']<0))
        return safe(run)
    @app.post(PREFIX+'/import')
    def cash_import():
        def run():
            import time
            body=request.get_json() or {}
            with LOCK:
                d=drafts.get(body.get('token'))
                if not d or d['expires']<time.time() or d['area']!=area():raise ValueError('Vorschau abgelaufen. Datei erneut auswählen.')
                opening=cents(body['opening']) if str(body.get('opening','')).strip() else None
                result=book.commit(area(),d['rows'],d['name'],d['digest'],opening);drafts.pop(body['token'],None);return result
        return safe(run)
    @app.post(PREFIX+'/manual-incoming')
    def cash_manual_incoming():
        def run():
            body=request.get_json(silent=True) or {}
            row=book.manual_incoming(area(),body.get('date'),body.get('amount'),body.get('usage'),body.get('reference'))
            return dict(item=row,message='Kassaeingang gebucht. Einnahmenbeleg jetzt anhängen.')
        return safe(run)
    @app.get(PREFIX+'/documents')
    def cash_documents():
        def run():
            c=book.db(area())
            try:
                q='%'+request.args.get('q','').strip()+'%'
                rows=c.execute('SELECT id,supplier_name,supplier_invoice_number,gross_amount,currency FROM incoming_invoices WHERE supplier_name LIKE ? OR supplier_invoice_number LIKE ? ORDER BY id DESC LIMIT 100',(q,q)).fetchall()
                return dict(items=[dict(r) for r in rows])
            finally:c.close()
        return safe(run)
    @app.post(PREFIX+'/attach')
    def cash_attach():
        def run():
            upload=request.files.get('file');nr=int(request.args['nr'])
            if not upload:raise ValueError('Beleg fehlt.')
            raw=upload.read(12_000_001)
            if len(raw)>12_000_000:raise ValueError('Beleg ist größer als 12 MB.')
            mime='application/pdf' if raw.startswith(b'%PDF-') else 'image/png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else 'image/jpeg' if raw.startswith(b'\xff\xd8\xff') else None
            if not mime:raise ValueError('Bitte PDF, PNG oder JPG verwenden.')
            ident=hashlib.sha256(raw).hexdigest();c=book.db(area())
            try:
                c.execute('BEGIN IMMEDIATE')
                if not c.execute('SELECT 1 FROM offisy_cash WHERE nr=?',(nr,)).fetchone():raise ValueError('Bewegung fehlt.')
                if c.execute('SELECT 1 FROM offisy_links WHERE nr=?',(nr,)).fetchone():raise ValueError('Bereits zugeordnet. Bestehende Zuordnung bleibt erhalten.')
                c.execute('INSERT OR IGNORE INTO offisy_documents VALUES(?,?,?,?,?)',(ident,Path(upload.filename or 'Beleg').name,mime,raw,stamp()))
                c.execute('INSERT INTO offisy_links VALUES(?,?,NULL,?,?)',(nr,ident,'Beleg angehängt; Erfassung separat prüfen',stamp()));c.commit();return {}
            except Exception:c.rollback();raise
            finally:c.close()
        return safe(run)
    @app.post(PREFIX+'/link')
    def cash_link():
        def run():
            body=request.get_json() or {};nr=int(body['nr']);invoice=int(body['invoice'])
            if area()=='live':
                from brain_finance_source_v2 import FinanceStore
                store=FinanceStore(ns);rows=store.kristine(True)
                overlay=ns.get('bank_supplier_overlay')
                if callable(overlay):rows=overlay(rows,True)
                existing=next((x for x in rows if x['id']=='kristine:'+str(invoice)),None)
                if not existing or existing.get('paymentStatus') in {'paid','sepa_submitted'} or cents(existing.get('bankPaid',0))>0:
                    raise ValueError('Rechnung ist bereits bezahlt, teilweise ausgeglichen oder zur Zahlung übergeben. Bitte bestehende Zahlung prüfen.')
            c=book.db(area())
            try:
                c.execute('BEGIN IMMEDIATE')
                movement=c.execute('SELECT * FROM offisy_cash WHERE nr=?',(nr,)).fetchone();doc=c.execute('SELECT * FROM incoming_invoices WHERE id=?',(invoice,)).fetchone()
                if not movement or not doc:raise ValueError('Bewegung oder Beleg fehlt.')
                if movement['amount']>=0:raise ValueError('Eingänge bitte mit einem eigenen Einnahmenbeleg verknüpfen: PDF oder Foto anhängen.')
                if (doc['currency'] or 'EUR')!='EUR' or cents(doc['gross_amount'])!=-movement['amount']:raise ValueError('Rechnungsbetrag und Kassenausgang müssen für diesen vollständigen Ausgleich übereinstimmen.')
                if c.execute('SELECT 1 FROM offisy_links WHERE nr=? OR invoice_id=?',(nr,invoice)).fetchone():raise ValueError('Bewegung oder Rechnung ist bereits zugeordnet.')
                if str(doc['payment_state'] or '').lower() in {'paid','bezahlt','closed','geschlossen'}:raise ValueError('Rechnung ist bereits als bezahlt erfasst. Bitte bestehende Zahlung prüfen.')
                c.execute('INSERT INTO offisy_links VALUES(?,NULL,?,?,?)',(nr,invoice,'Kassa · vollständig bar bezahlt',stamp()))
                c.execute("UPDATE incoming_invoices SET payment_state='paid',payment_status='Bezahlt',payment_method='cash',updated_at=? WHERE id=?",(stamp(),invoice));c.commit();return {}
            except Exception:c.rollback();raise
            finally:c.close()
        return safe(run)
    @app.get(PREFIX+'/file')
    def cash_file():
        c=book.db(area())
        try:
            row=c.execute('SELECT d.* FROM offisy_links l JOIN offisy_documents d ON d.id=l.document_id WHERE l.nr=?',(request.args.get('nr'),)).fetchone()
            if row:return Response(row['content'],content_type=row['mime'],headers={'Content-Disposition':'inline; filename="Kassabeleg"','X-Content-Type-Options':'nosniff'})
            r=c.execute('SELECT i.pdf_path FROM offisy_links l JOIN incoming_invoices i ON i.id=l.invoice_id WHERE l.nr=?',(request.args.get('nr'),)).fetchone()
            if r and r[0]:
                from flask import send_file
                return send_file(r[0],mimetype='application/pdf')
            return 'Kein Beleg vorhanden.',404
        finally:c.close()
    @app.get(PREFIX+'/script')
    def cash_script():return Response((Path(__file__).parent/'public'/'cash-book.js').read_text(encoding='utf-8'),content_type='text/javascript')
