from __future__ import annotations
import os,re,json,sqlite3,hashlib
from pathlib import Path
from datetime import datetime
import pyodbc, pymupdf

VERSION='0.1'
DATA_HOME=Path(os.environ.get('KRISTINE_BRAIN_DATA',r'N:\OneDrive\Dokumente\Kristine\Daten'))
INDEX_DB=DATA_HOME/'kristine_brain_night_index.db'
WW_SCHEMA_JSON=DATA_HOME/'winworker_sql_structure_index.json'
FINK_SCHEMA_JSON=DATA_HOME/'fink_sql_structure_index.json'
RUN_STATUS_JSON=DATA_HOME/'brain_night_index_status.json'
DEFAULT_ROOT=Path(os.environ.get('KRISTINE_ARCHIVE_ROOT',r'N:\OneDrive\Dokumente\Kristine'))
WW_SERVER=os.environ.get('KRISTINE_SQL_SERVER',r'SRV-DB01\WINWORKER')
WW_USER=os.environ.get('KRISTINE_SQL_USER','kristine_reader')
WW_PASS=os.environ.get('KRISTINE_SQL_PASSWORD','').strip()
FINK_SERVER=os.environ.get('FINK_SQL_SERVER',WW_SERVER)
FINK_USER=os.environ.get('FINK_SQL_USER',WW_USER)
FINK_PASS=os.environ.get('FINK_SQL_PASSWORD',WW_PASS).strip()
FINK_DBS=[x.strip() for x in os.environ.get('FINK_DATABASES','').split(',') if x.strip()]
TEXT_EXT={'.pdf','.txt','.csv','.json','.xml','.md','.dta','.dat','.log'}
MAX_CHARS=int(os.environ.get('KRISTINE_INDEX_MAX_TEXT_CHARS','250000'))
MAX_PAGES=int(os.environ.get('KRISTINE_INDEX_MAX_PDF_PAGES','500'))

def now(): return datetime.now().isoformat(timespec='seconds')

def driver():
    ds=pyodbc.drivers()
    for n in ('ODBC Driver 18 for SQL Server','ODBC Driver 17 for SQL Server','SQL Server Native Client 11.0','SQL Server'):
        if n in ds: return n
    raise RuntimeError('Kein SQL-Server-ODBC-Treiber gefunden')

def connect(server,user,password,database='master'):
    if not password: raise RuntimeError('SQL-Passwort fehlt')
    return pyodbc.connect(f'DRIVER={{{driver()}}};SERVER={server};DATABASE={database};UID={user};PWD={password};TrustServerCertificate=yes;',timeout=8)

def init_db():
    DATA_HOME.mkdir(parents=True,exist_ok=True)
    con=sqlite3.connect(INDEX_DB)
    con.execute('''CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,source TEXT,filename TEXT,extension TEXT,size INTEGER,modified REAL,sha1_head TEXT,text TEXT,indexed_at TEXT,error TEXT)''')
    con.execute('CREATE INDEX IF NOT EXISTS idx_files_source ON files(source)')
    con.execute('CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename)')
    con.commit(); return con

def headhash(p):
    try:
        with p.open('rb') as f: return hashlib.sha1(f.read(1024*1024)).hexdigest()
    except: return ''

def text_of(p):
    ext=p.suffix.lower()
    if ext=='.pdf':
        parts=[]; total=0
        with pymupdf.open(p) as doc:
            for i in range(min(len(doc),MAX_PAGES)):
                t=doc[i].get_text('text') or ''
                if t: parts.append(t); total+=len(t)
                if total>=MAX_CHARS: break
        return '\n'.join(parts)[:MAX_CHARS]
    raw=p.read_bytes()
    for enc in ('utf-8-sig','utf-8','cp1252','latin-1'):
        try: return raw.decode(enc)[:MAX_CHARS]
        except: pass
    return raw.decode('latin-1',errors='replace')[:MAX_CHARS]

def index_file(con,p,source):
    st=p.stat(); old=con.execute('SELECT size,modified,sha1_head FROM files WHERE path=?',(str(p),)).fetchone()
    if old and int(old[0] or -1)==st.st_size and float(old[1] or -1)==st.st_mtime: return 'skipped'
    h=headhash(p)
    if old and old[2]==h and int(old[0] or -1)==st.st_size:
        con.execute('UPDATE files SET modified=?,indexed_at=?,error=NULL WHERE path=?',(st.st_mtime,now(),str(p))); return 'skipped'
    try:
        txt=text_of(p)
        con.execute('''INSERT INTO files(path,source,filename,extension,size,modified,sha1_head,text,indexed_at,error) VALUES(?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(path) DO UPDATE SET source=excluded.source,filename=excluded.filename,extension=excluded.extension,size=excluded.size,modified=excluded.modified,sha1_head=excluded.sha1_head,text=excluded.text,indexed_at=excluded.indexed_at,error=NULL''',(str(p),source,p.name,p.suffix.lower(),st.st_size,st.st_mtime,h,txt,now()))
        return 'indexed'
    except Exception as e:
        con.execute('''INSERT INTO files(path,source,filename,extension,size,modified,sha1_head,text,indexed_at,error) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET error=excluded.error,indexed_at=excluded.indexed_at''',(str(p),source,p.name,p.suffix.lower(),st.st_size,st.st_mtime,h,'',now(),str(e)))
        return 'error'

def moser_roots():
    ex=[Path(x.strip()) for x in os.environ.get('MOSER_PROJECT_ROOTS','').split(';') if x.strip()]
    ex=[p for p in ex if p.exists()]
    if ex: return ex
    out=[]
    if not DEFAULT_ROOT.exists(): return out
    try:
        for p in DEFAULT_ROOT.iterdir():
            if p.is_dir() and 'moser' in p.name.lower(): out.append(p)
            if p.is_dir():
                try:
                    for c in p.iterdir():
                        if c.is_dir() and 'moser' in c.name.lower(): out.append(c)
                except: pass
    except: pass
    seen=set(); uniq=[]
    for p in out:
        k=str(p).lower()
        if k not in seen: seen.add(k); uniq.append(p)
    return uniq

def archive_roots():
    ex=[Path(x.strip()) for x in os.environ.get('KRISTINE_PDF_ROOTS','').split(';') if x.strip()]
    ex=[p for p in ex if p.exists()]
    return ex or ([DEFAULT_ROOT] if DEFAULT_ROOT.exists() else [])

def scan(con,root,source,stats):
    print(f'[{source}] {root}')
    for dp,dns,fns in os.walk(root):
        dns[:]=[d for d in dns if d.lower() not in {'.git','node_modules','__pycache__','.venv','releases','$recycle.bin'}]
        for fn in fns:
            p=Path(dp)/fn
            if p.suffix.lower() not in TEXT_EXT: continue
            stats['seen']+=1; r=index_file(con,p,source); stats[r]+=1
            done=stats['indexed']+stats['skipped']+stats['error']
            if done%100==0:
                con.commit(); print(f'  {done}: neu/geändert {stats["indexed"]} · unverändert {stats["skipped"]} · Fehler {stats["error"]}')

def safe(v):
    v=str(v or '')
    if not re.fullmatch(r'[A-Za-z0-9_]+',v): raise ValueError('Unsicherer SQL-Name: '+v)
    return v

def dbs(server,user,pw):
    con=connect(server,user,pw,'master'); rows=con.cursor().execute("SELECT name FROM sys.databases WHERE state_desc='ONLINE' ORDER BY name").fetchall(); con.close(); return [str(r.name) for r in rows]

def schema_db(server,user,pw,database):
    db=safe(database); con=connect(server,user,pw,db); cur=con.cursor()
    rows=cur.execute('''SELECT s.name,o.name,CASE o.type WHEN 'U' THEN 'TABLE' WHEN 'V' THEN 'VIEW' ELSE o.type_desc END,c.column_id,c.name,t.name,c.max_length,c.precision,c.scale,c.is_nullable FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.columns c ON c.object_id=o.object_id JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name,o.name,c.column_id''').fetchall()
    objs={}
    for r in rows:
        k=(str(r[0]),str(r[1]),str(r[2])); objs.setdefault(k,{'schema':k[0],'name':k[1],'type':k[2],'columns':[]})['columns'].append({'ordinal':int(r[3]),'name':str(r[4]),'dataType':str(r[5]),'maxLength':int(r[6]) if r[6] is not None else None,'precision':int(r[7]) if r[7] is not None else None,'scale':int(r[8]) if r[8] is not None else None,'nullable':bool(r[9])})
    needle=re.compile(r'(pdf|dokument|document|datei|file|archiv|blob|inhalt|content|pfad|path|filename)',re.I)
    docs=[]
    for o in objs.values():
        m=[c for c in o['columns'] if needle.search(c['name']) or c['dataType'].lower() in {'varbinary','image'}]
        if m: docs.append({'schema':o['schema'],'object':o['name'],'type':o['type'],'columns':m})
    con.close(); return {'name':db,'objectCount':len(objs),'columnCount':sum(len(o['columns']) for o in objs.values()),'objects':list(objs.values()),'documentCandidates':docs}

def build(kind,server,user,pw,predicate,outfile):
    result={'kind':kind,'generatedAt':now(),'server':server,'databases':[],'errors':[]}
    try: names=[x for x in dbs(server,user,pw) if predicate(x)]
    except Exception as e:
        result['errors'].append({'database':'master','error':str(e)}); outfile.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8'); return result
    for i,name in enumerate(names,1):
        print(f'[{kind} SQL] {i}/{len(names)} {name}')
        try: result['databases'].append(schema_db(server,user,pw,name))
        except Exception as e: result['databases'].append({'name':name,'error':str(e)}); result['errors'].append({'database':name,'error':str(e)})
    result['databaseCount']=len(names); outfile.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8'); return result

def main():
    stats={'startedAt':now(),'version':VERSION,'seen':0,'indexed':0,'skipped':0,'error':0,'errors':[]}
    print('\nKRISTINE · THE BRAIN · NIGHT INDEXER\n------------------------------------')
    con=init_db()
    mr=moser_roots(); stats['moserRoots']=[str(x) for x in mr]
    if not mr: print('[MOSER] Kein Ordner automatisch gefunden. Optional MOSER_PROJECT_ROOTS setzen.')
    for r in mr: scan(con,r,'MOSER',stats); con.commit()
    for r in archive_roots(): scan(con,r,'ARCHIV',stats); con.commit()
    ww=build('WINWORKER',WW_SERVER,WW_USER,WW_PASS,lambda n:n.lower().startswith('winworker_'),WW_SCHEMA_JSON)
    fset={x.lower() for x in FINK_DBS}
    fi=build('FINK',FINK_SERVER,FINK_USER,FINK_PASS,lambda n:(n.lower() in fset) if fset else ('fink' in n.lower()),FINK_SCHEMA_JSON)
    stats['wwDatabases']=len(ww.get('databases',[])); stats['finkDatabases']=len(fi.get('databases',[])); stats['finishedAt']=now();
    RUN_STATUS_JSON.write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf-8'); con.commit(); con.close()
    print('\nFERTIG'); print(json.dumps(stats,ensure_ascii=False,indent=2))

if __name__=='__main__': main()
