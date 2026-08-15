from __future__ import annotations
import os,re,json
from pathlib import Path
from datetime import datetime
import pyodbc
DATA_HOME=Path(os.environ.get('KRISTINE_BRAIN_DATA',r'N:\OneDrive\Dokumente\Kristine\Daten'))
OUT=DATA_HOME/'winworker_document_discovery.json'
SERVER=os.environ.get('KRISTINE_SQL_SERVER',r'SRV-DB01\WINWORKER')
USER=os.environ.get('KRISTINE_SQL_USER','kristine_reader')
PASSWORD=os.environ.get('KRISTINE_SQL_PASSWORD','').strip()
TEXT_TYPES={'varchar','nvarchar','char','nchar','text','ntext'}
BINARY_TYPES={'varbinary','binary','image'}
NAME_RX=re.compile(r'(pdf|dokument|document|datei|file|archiv|blob|inhalt|content|pfad|path|filename|ablage|scan|anhang|attachment|beleg|rechnung|image|bild)',re.I)
PATH_RX=re.compile(r'(?i)(?:[A-Z]:\\[^<>:"|?*\r\n]+|\\\\[^\\/\r\n]+\\[^<>:"|?*\r\n]+)')
def driver_name():
    ds=pyodbc.drivers()
    for x in ('ODBC Driver 18 for SQL Server','ODBC Driver 17 for SQL Server','SQL Server Native Client 11.0','SQL Server'):
        if x in ds:return x
    raise RuntimeError(f'Kein SQL-Treiber gefunden: {ds}')
def connect(db='master'):
    if not PASSWORD: raise RuntimeError('KRISTINE_SQL_PASSWORD fehlt')
    return pyodbc.connect(f'DRIVER={{{driver_name()}}};SERVER={SERVER};DATABASE={db};UID={USER};PWD={PASSWORD};TrustServerCertificate=yes;',timeout=8)
def qn(x): return '['+str(x).replace(']',']]')+']'
def main():
    print('\nKRISTINE · WINWORKER DOCUMENT DISCOVERY\n---------------------------------------')
    print('Server:',SERVER,'\nDriver:',driver_name())
    m=connect('master'); dbs=[str(r.name) for r in m.cursor().execute("SELECT name FROM sys.databases WHERE state_desc='ONLINE' AND name LIKE 'WinWorker[_]%' ORDER BY name").fetchall()]; m.close()
    result={'ok':True,'generatedAt':datetime.now().isoformat(timespec='seconds'),'server':SERVER,'databaseCount':len(dbs),'databases':[],'pathCandidates':[],'binaryCandidates':[],'errors':[]}
    seen=set()
    for i,db in enumerate(dbs,1):
        print(f'[{i}/{len(dbs)}] {db}')
        item={'name':db,'textCandidates':[],'binaryCandidates':[]}
        try:
            con=connect(db); cur=con.cursor()
            cols=cur.execute("""
            SELECT s.name schema_name,o.name object_name,o.type_desc,c.name column_name,t.name data_type
            FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
            JOIN sys.columns c ON c.object_id=o.object_id JOIN sys.types t ON t.user_type_id=c.user_type_id
            WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name,o.name,c.column_id
            """).fetchall()
            for c in cols:
                schema,obj,col,dtype=map(str,[c.schema_name,c.object_name,c.column_name,c.data_type]); dt=dtype.lower(); interesting=bool(NAME_RX.search(col) or NAME_RX.search(obj))
                if dt in BINARY_TYPES and interesting:
                    rec={'database':db,'schema':schema,'object':obj,'column':col,'dataType':dt}; item['binaryCandidates'].append(rec); result['binaryCandidates'].append(rec); continue
                if dt not in TEXT_TYPES or not interesting: continue
                rec={'database':db,'schema':schema,'object':obj,'column':col,'dataType':dt,'samples':[]}
                sql=f"SELECT TOP 30 {qn(col)} FROM {qn(schema)}.{qn(obj)} WHERE {qn(col)} IS NOT NULL AND LTRIM(RTRIM(CONVERT(nvarchar(max),{qn(col)})))<>''"
                try:
                    for r in cur.execute(sql).fetchall():
                        v=str(r[0]).replace('\x00','').strip()[:600]
                        if not v: continue
                        rec['samples'].append(v)
                        for m in PATH_RX.findall(v):
                            p=m.rstrip(' .;,)'); k=p.lower()
                            if k not in seen:
                                seen.add(k); result['pathCandidates'].append({'path':p,'database':db,'schema':schema,'object':obj,'column':col})
                except Exception as e: rec['sampleError']=str(e)
                if rec['samples'] or rec.get('sampleError'): item['textCandidates'].append(rec)
            con.close()
        except Exception as e:
            item['error']=str(e); result['errors'].append({'database':db,'error':str(e)})
        result['databases'].append(item)
    DATA_HOME.mkdir(parents=True,exist_ok=True); OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print('\nFERTIG\n------'); print('Pfad-Kandidaten :',len(result['pathCandidates'])); print('Binary-Kandidaten:',len(result['binaryCandidates'])); print('Fehler           :',len(result['errors'])); print('Datei            :',OUT)
if __name__=='__main__': main()
