"""Local original statement archive, independent of browser sessions."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
from contextlib import closing
import tempfile
import threading
import time
from datetime import date, datetime, timezone
from urllib.parse import urlencode
import uuid
import zipfile
import xml.etree.ElementTree as ET
from flask import jsonify,request,send_file
from brain_konfipay import ConnectionError

def now():return datetime.now(timezone.utc).isoformat()
def valid_year(value):
    try:y=int(value)
    except (ValueError,TypeError):raise ConnectionError('Ungültiges Jahr.')
    if not 2000<=y<=date.today().year:raise ConnectionError('Ungültiges Jahr.')
    return y

def statement_period(data):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():raise ConnectionError('Unzulässige XML-Datei.')
    root=ET.fromstring(data)
    if not re.fullmatch(r'\{urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.\d{2}\}Document',root.tag):raise ConnectionError('Keine gebuchte CAMT.053-Datei.')
    ns={'n':root.tag.split('}')[0][1:]};ends=[];starts=[]
    for stmt in root.findall('.//n:Stmt',ns):
        end=stmt.findtext('n:FrToDt/n:ToDtTm',namespaces=ns)
        start=stmt.findtext('n:FrToDt/n:FrDtTm',namespaces=ns)
        if not end:
            for bal in stmt.findall('n:Bal',ns):
                if bal.findtext('n:Tp/n:CdOrPrtry/n:Cd',namespaces=ns)=='CLBD':
                    end=bal.findtext('n:Dt/n:Dt',namespaces=ns) or bal.findtext('n:Dt/n:DtTm',namespaces=ns)
        if not end:raise ConnectionError('Auszugsdatum fehlt im CAMT-Dokument.')
        ends.append(date.fromisoformat(end[:10]).isoformat())
        if start:starts.append(date.fromisoformat(start[:10]).isoformat())
    if not ends:raise ConnectionError('Kein Auszug im CAMT-Dokument.')
    end=max(ends);start=min(starts) if starts else min(ends)
    return end,'Auszugszeitraum '+start+' bis '+end+'; Ablage nach Ende'


class Archive:
    def __init__(self,client,root):
        self.client=client;self.root=Path(root).resolve();self.dbpath=client.store.folder/'statement-archive.sqlite'
        self.lock=threading.Lock();self.busy=False;self.last=None;self.error=None;self.added=0
    def db(self):
        db=sqlite3.connect(str(self.dbpath),timeout=20);db.row_factory=sqlite3.Row
        db.execute('CREATE TABLE IF NOT EXISTS files (rid TEXT PRIMARY KEY, account TEXT, iban TEXT, name TEXT, month TEXT, format TEXT, path TEXT, sha256 TEXT, size INTEGER, original TEXT, source_date TEXT, date_basis TEXT, archived TEXT, UNIQUE(account,format,sha256))')
        db.execute('CREATE TABLE IF NOT EXISTS sources (rid TEXT PRIMARY KEY, document TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, completed TEXT, error TEXT, added INTEGER)')
        return db
    def safe_path(self,relative):
        target=(self.root/relative).resolve()
        if not target.is_relative_to(self.root):raise ConnectionError('Ungültiger Archivpfad.')
        return target
    def save(self,item,fmt):
        rid=str(uuid.UUID(str(item['rId'])));account=item.get('bankAccount') or {};aid=str(uuid.UUID(str(account['rId'])))
        iban=re.sub('[^A-Z0-9]','',str(account.get('iban') or item.get('iban') or '').upper())
        with closing(self.db()) as db:
            row=db.execute('SELECT f.* FROM sources s JOIN files f ON f.rid=s.document WHERE s.rid=?',(rid,)).fetchone()
            if row:
                p=self.safe_path(row['path'])
                if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=row['sha256']:
                    raise ConnectionError('Eine archivierte Datei fehlt oder wurde verändert. Bitte Archiv prüfen.')
                return False
        data=self.client.authenticated('GET','/transaction-files/'+rid+'/content?base64-encoded=false',raw=True)
        original=str(item.get('fileName') or '')
        match=re.match(r'(\d{4}-\d{2}-\d{2})',original)
        source_date=date.fromisoformat(match[1] if match else str(item['timestamp'])[:10]).isoformat()
        basis='Dateiname' if match else 'Bereitstellung'
        if fmt=='Pdf':
            if not data.lstrip().startswith(b'%PDF-'):raise ConnectionError('Ein PDF-Auszug hat ein unerwartetes Format.')
            extension='pdf'
        else:
            if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():raise ConnectionError('Unzulässige XML-Datei.')
            root=ET.fromstring(data)
            if not re.fullmatch(r'\{urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.\d{2}\}Document',root.tag):raise ConnectionError('Keine gebuchte CAMT.053-Datei.')
            source_date,basis=statement_period(data)
            extension='xml'
        digest=hashlib.sha256(data).hexdigest();month=source_date[:7]
        with closing(self.db()) as db:
            row=db.execute('SELECT rid,path,sha256 FROM files WHERE account=? AND format=? AND sha256=?',(aid,fmt,digest)).fetchone()
            if row:
                p=self.safe_path(row['path'])
                if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=digest:raise ConnectionError('Archivdatei fehlt oder wurde verändert.')
                db.execute('INSERT OR IGNORE INTO sources VALUES (?,?)',(rid,row['rid']));db.commit();return False
            folder=Path((iban or 'Konto')+'_'+aid[:8])/month[:4]/month[5:7]/('PDF' if fmt=='Pdf' else 'CAMT053')
            filename=source_date+'_'+digest[:16]+'.'+extension;relative=(folder/filename).as_posix();target=self.safe_path(relative)
            target.parent.mkdir(parents=True,exist_ok=True)
            if target.exists():
                if hashlib.sha256(target.read_bytes()).hexdigest()!=digest:raise ConnectionError('Archivdateikonflikt.')
            else:
                with tempfile.NamedTemporaryFile(dir=target.parent,suffix='.tmp',delete=False) as tmp:
                    temp=Path(tmp.name);tmp.write(data);tmp.flush();os.fsync(tmp.fileno())
                os.replace(temp,target)
            db.execute('INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',(rid,aid,iban,str(account.get('description') or 'Bankkonto'),month,fmt,relative,digest,len(data),original,source_date,basis,now()))
            db.execute('INSERT INTO sources VALUES (?,?)',(rid,rid));db.commit()
        return True
    def correct_dates(self):
        with closing(self.db()) as db:
            rows=[dict(r) for r in db.execute("SELECT * FROM files WHERE format='53'")]
            backup=self.dbpath.with_name('statement-archive-before-date-correction.sqlite')
            if rows and not backup.exists():
                with closing(sqlite3.connect(str(backup))) as dest:db.backup(dest)
            for row in rows:
                old=self.safe_path(row['path']);data=old.read_bytes()
                if hashlib.sha256(data).hexdigest()!=row['sha256']:raise ConnectionError('Archivdatei verändert; Datumskorrektur abgebrochen.')
                day,basis=statement_period(data);month=day[:7]
                rel=(Path(row['path']).parts[0]+'/'+month[:4]+'/'+month[5:7]+'/CAMT053/'+day+'_'+row['sha256'][:16]+'.xml')
                new=self.safe_path(rel)
                if new!=old:
                    new.parent.mkdir(parents=True,exist_ok=True)
                    if new.exists():
                        if hashlib.sha256(new.read_bytes()).hexdigest()!=row['sha256']:raise ConnectionError('Zieldatei stimmt nicht überein.')
                    else:
                        with tempfile.NamedTemporaryFile(dir=new.parent,suffix='.tmp',delete=False) as tmp:
                            temp=Path(tmp.name);tmp.write(data);tmp.flush();os.fsync(tmp.fileno())
                        os.replace(temp,new)
                db.execute('UPDATE files SET month=?,path=?,source_date=?,date_basis=? WHERE rid=?',(month,rel,day,basis,row['rid']));db.commit()
                # Both absolute paths were checked against the fixed archive root.
                if new!=old:old.unlink()

    def run(self,year):
        added=0;errors=[]
        try:
            self.correct_dates()
            for fmt in ['Pdf','53']:
                try:
                    page=1
                    while True:
                        p={'min-date':f'{year}-01-01','max-date':min(f'{year}-12-31',date.today().isoformat()),'format':fmt,'page-number':page,'page-size':100}
                        data=self.client.authenticated('GET','/transaction-files?'+urlencode(p));pages=max(1,int(data.get('totalPages',1)))
                        if pages>200:raise ConnectionError('Zu viele Auszüge in diesem Jahr.')
                        for item in data.get('results') or []:
                            if self.save(item,'Pdf' if fmt=='Pdf' else '53'):added+=1
                        if page>=pages:break
                        page+=1
                except ConnectionError as exc:errors.append(str(exc))
                except Exception:errors.append('Ein Auszug konnte nicht archiviert werden. Bitte erneut versuchen.')
            self.last=now();self.added=added;self.error=' '.join(errors) or None
            with closing(self.db()) as db:
                db.execute('INSERT OR REPLACE INTO runs VALUES (1,?,?,?)',(self.last,self.error,added));db.commit()
        except Exception:self.error='Archiv nicht erreichbar. Ablage und Verbindung prüfen.'
        finally:
            with self.lock:self.busy=False
    def start(self,year):
        year=valid_year(year)
        if not self.client.store.exists():raise ConnectionError('Bitte zuerst die Bankverbindung einrichten.')
        with self.lock:
            if self.busy:return False
            self.busy=True;self.error=None
        threading.Thread(target=self.run,args=(year,),daemon=True,name='Brain statement archive').start();return True
    def status(self):
        if not self.client.store.exists():return {'busy':False,'months':[],'root':str(self.root),'error':'Bitte Bank verbinden.'}
        with closing(self.db()) as db:
            files=[dict(r) for r in db.execute('SELECT * FROM files ORDER BY month DESC,account,source_date,format')]
            last=db.execute('SELECT * FROM runs WHERE id=1').fetchone()
        grouped={}
        for f in files:
            key=(f['account'],f['month']);g=grouped.setdefault(key,{'account':f['account'],'iban':f['iban'],'name':f['name'],'month':f['month'],'pdf':0,'xml':0,'size':0,'files':[]})
            g['pdf' if f['format']=='Pdf' else 'xml']+=1;g['size']+=f['size'];g['files'].append({k:f[k] for k in ['rid','original','source_date','date_basis','format','size']})
        return {'busy':self.busy,'root':str(self.root),'months':list(grouped.values()),'last':self.last or (last['completed'] if last else None),'error':self.error or (last['error'] if last else None),'added':self.added if self.last else (last['added'] if last else 0)}
    def bundle(self,account,month):
        account=str(uuid.UUID(str(account)))
        if not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])',str(month)):raise ConnectionError('Ungültiger Monat.')
        with closing(self.db()) as db:rows=[dict(x) for x in db.execute('SELECT * FROM files WHERE account=? AND month=? ORDER BY source_date,format',(account,month))]
        if not rows:raise ConnectionError('Keine archivierten Auszüge für diesen Monat.')
        if sum(r['size'] for r in rows)>250_000_000:raise ConnectionError('Monatspaket ist zu groß. Bitte direkt aus der Archivablage übernehmen.')
        output=tempfile.SpooledTemporaryFile(max_size=8_000_000)
        manifest=io.StringIO();writer=csv.writer(manifest,delimiter=';');writer.writerow(['Datei','Originalname','Datum','Datumsquelle','Format','SHA256','Archiviert'])
        try:
            with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
                for row in rows:
                    path=self.safe_path(row['path']);data=path.read_bytes()
                    if hashlib.sha256(data).hexdigest()!=row['sha256']:raise ConnectionError('Eine Archivdatei wurde verändert; Übergabe abgebrochen.')
                    name=('PDF/' if row['format']=='Pdf' else 'CAMT053/')+path.name;z.writestr(name,data)
                    writer.writerow([name,row['original'],row['source_date'],row['date_basis'],row['format'],row['sha256'],row['archived']])
                z.writestr('Dateiuebersicht.csv',manifest.getvalue().encode('utf-8-sig'))
                z.writestr('Hinweise.txt','Originalauszüge und gebuchte Bankumsätze. Keine untertägigen Meldungen.\nKein Buchungsstapel; Zuordnungen, Skonti und Gutschriften sind nicht enthalten.\nCAMT-Monatsablage nach Ende des Auszugszeitraums im XML. PDF-Ablage nach Dateinamen, sonst Bereitstellung.\nBitte Vollständigkeit und DATEV-Importverfahren mit der Buchhaltung prüfen.\n')
            output.seek(0);return output
        except Exception:output.close();raise
    def automatic(self):
        while True:
            try:
                if self.client.store.exists():
                    state=self.status();last=state.get('last')
                    if not last or time.time()-datetime.fromisoformat(last).timestamp()>=21600:
                        self.start(date.today().year)
            except Exception:self.error='Automatischer Archivabruf derzeit nicht möglich.'
            time.sleep(60)

def install(ns,client,write_allowed):
    app=ns['app'];root=Path(ns['DB']).parent.parent/'Bankarchiv';archive=Archive(client,root)
    paths=['statement-archive-file','statement-archive','statement-archive-sync','statement-archive-zip']
    ns['MOBILE_ALLOWED_PATHS'].update('/konfipay/api/'+p for p in paths)
    @app.get('/konfipay/api/statement-archive')
    def archive_status():
        try:return jsonify({'ok':True,**archive.status()})
        except Exception:return jsonify({'ok':False,'error':'Archivstatus nicht verfügbar.'}),500
    @app.post('/konfipay/api/statement-archive-sync')
    def archive_sync():
        if not write_allowed():return jsonify({'ok':False,'error':'Bitte Seite neu laden.'}),403
        try:return jsonify({'ok':True,'started':archive.start((request.get_json(silent=True) or {}).get('year',date.today().year))})
        except ConnectionError as exc:return jsonify({'ok':False,'error':str(exc)}),400
    @app.get('/konfipay/api/statement-archive-file')
    def archive_file():
        try:
            rid=str(uuid.UUID(str(request.args.get('rid'))))
            with closing(archive.db()) as db:
                row=db.execute('SELECT * FROM files WHERE rid=?',(rid,)).fetchone()
            if row is None:raise ConnectionError('Auszug nicht im Archiv gefunden.')
            path=archive.safe_path(row['path']);data=path.read_bytes()
            if hashlib.sha256(data).hexdigest()!=row['sha256']:raise ConnectionError('Archivdatei wurde verändert. Bitte prüfen.')
            download=request.args.get('download')=='1'
            pdf=row['format']=='Pdf'
            response=send_file(io.BytesIO(data),mimetype=('application/octet-stream' if download else 'application/pdf' if pdf else 'text/plain; charset=utf-8'),as_attachment=download,download_name='Kontoauszug_'+row['source_date']+('.pdf' if pdf else '.xml'))
            response.headers['X-Content-Type-Options']='nosniff'
            response.headers['Cache-Control']='private, no-store'
            return response
        except ConnectionError as exc:return jsonify({'ok':False,'error':str(exc)}),400
        except Exception:return jsonify({'ok':False,'error':'Auszug konnte nicht geöffnet werden.'}),400

    @app.get('/konfipay/api/statement-archive-zip')
    def archive_zip():
        try:
            output=archive.bundle(request.args.get('account'),request.args.get('month'))
            response=send_file(output,mimetype='application/zip',as_attachment=True,download_name='Bankauszuege_'+request.args['month']+'.zip');response.call_on_close(output.close);return response
        except ConnectionError as exc:return jsonify({'ok':False,'error':str(exc)}),400
        except Exception:return jsonify({'ok':False,'error':'Monatspaket konnte nicht erstellt werden.'}),400
    threading.Thread(target=archive.automatic,daemon=True,name='Brain archive scheduler').start()
