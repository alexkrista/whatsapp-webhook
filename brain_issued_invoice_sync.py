# coding: utf-8
"""Durable, idempotent outbound original-PDF sync into the matching KRISTINE project.

Runs from the office Brain and only uploads issued KRISTINE invoices to the
firm's exact production origin. No project creation, no invoice modification.
Failures remain eligible for retry. The cloud archive checks the PDF SHA.
"""
from __future__ import annotations
import hashlib
import json
import os
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

_LOCK=threading.Lock()

def candidate_rows(store,limit=10000):
    with store.connect() as con:
        rows=con.execute("""
          SELECT i.id,i.invoice_number,i.kind,i.issue_date,i.pdf_path,
                 i.pdf_sha256,i.source,r.project_number
          FROM outgoing_invoices i JOIN outgoing_runs r ON r.id=i.run_id
          WHERE i.status='issued' AND i.source='KRISTINE'
            AND i.pdf_path IS NOT NULL AND i.pdf_path<>''
            AND r.project_number<>''
          ORDER BY i.id
          LIMIT ?
        """,(int(limit),)).fetchall()
    return [dict(row) for row in rows]

def uploaded_index(filepath):
    try:
        data=json.loads(Path(filepath).read_text(encoding="utf-8"))
        return data if isinstance(data,dict) else {}
    except FileNotFoundError:
        return {}
    except (ValueError,TypeError):
        raise RuntimeError("Rechnungs-Sync-Zustandsdatei ist beschädigt; keine Originale überschreiben.")

def write_index(filepath,state):
    filepath=Path(filepath)
    tmp=filepath.with_suffix(filepath.suffix+".tmp-"+str(os.getpid()))
    try:
        tmp.write_text(json.dumps(state,sort_keys=True,indent=2),encoding="utf-8")
        os.replace(tmp,filepath)
    finally:
        tmp.unlink(missing_ok=True)

def safe_pdf(store,row):
    pdf=Path(str(row.get("pdf_path") or ""))
    if not pdf.is_file() or not pdf.resolve().is_relative_to(store.output_root.resolve()):
        raise FileNotFoundError("Ausgangsrechnungs-PDF fehlt im vorgesehenen Originalverzeichnis")
    if pdf.stat().st_size>20*1024*1024:
        raise ValueError("Rechnungs-PDF überschreitet die Importgrenze")
    data=pdf.read_bytes()
    if not data.startswith(b"%PDF-"):
        raise ValueError("Originaldatei ist kein PDF")
    digest=hashlib.sha256(data).hexdigest()
    saved=str(row.get("pdf_sha256") or "").lower()
    if saved and saved!=digest:
        raise ValueError("Original-PDF-Prüfsumme stimmt nicht")
    return data,digest

def send_original(base,secret,row,data,digest,post=None):
    host=urlparse(base)
    if host.scheme!="https" or host.netloc!="protokoll.krista.at" or host.path not in ("","/"):
        raise ValueError("Rechnungen dürfen ausschließlich in die firmeneigene Produktionsakte übertragen werden")
    project=str(row["project_number"]).strip()
    number=str(row["invoice_number"]).strip()
    req=urllib.request.Request(
        "https://protokoll.krista.at/admin/api/job/"+project+"/documentation/issued-invoice",
        method="POST",data=data,
        headers={
          "Content-Type":"application/pdf",
          "X-Admin-Token":secret,
          "X-Invoice-Number":number,
          "X-Invoice-Id":str(row["id"]),
          "X-Invoice-Source":"KRISTINE",
          "X-Invoice-Kind":str(row["kind"]),
          "X-Invoice-Date":str(row["issue_date"])[:10],
          "X-Invoice-Sha256":digest,
        })
    request_fn=post or urllib.request.urlopen
    with request_fn(req,timeout=20) as response:
        if int(response.status) not in (200,201):
            raise RuntimeError("Cloud-Archiv antwortet nicht erfolgreich")

def sync_once(store,base,secret,post=None,max_batch=75):
    if not secret:
        return {"status":"not_configured","synced":0,"pending":0}
    with _LOCK:
        statefile=store.db_path.parent/"invoice_project_sync_state.json"
        state=uploaded_index(statefile)
        synced=0
        pending=0
        failures=[]
        for row in candidate_rows(store):
            if not str(row.get("project_number") or "").isdigit():
                pending+=1
                continue
            key=str(row["id"])
            try:
                saved_digest=str(row.get("pdf_sha256") or "").lower()
                if (saved_digest and state.get(key)==saved_digest
                        and Path(str(row.get("pdf_path") or "")).is_file()):
                    continue
                if synced>=max_batch:
                    pending+=1
                    continue
                data,digest=safe_pdf(store,row)
                send_original(base,secret,row,data,digest,post=post)
                state[key]=digest
                synced+=1
            except Exception as error:
                pending+=1
                failures.append((key,type(error).__name__))
        if synced:
            write_index(statefile,state)
        return {"status":"ok" if not failures else "partial","synced":synced,
                "pending":pending,"failureTypes":failures[:5]}

def start_worker(store,base,secret,logger=print,first_delay=20,period=75):
    if not secret:
        logger("KRISTINE Rechnung->Akte: Zugang fehlt; Sync wird nicht gestartet")
        return None
    def run():
        threading.Event().wait(first_delay)
        while True:
            try:
                status=sync_once(store,base,secret)
                if status["synced"] or status["pending"]:
                    logger("KRISTINE Rechnung->Akte: "+str(status["synced"])+" synchronisiert, "+
                           str(status["pending"])+" noch offen; Status "+status["status"])
            except Exception as error:
                logger("KRISTINE Rechnung->Akte Fehler: "+type(error).__name__)
            threading.Event().wait(period)
    thread=threading.Thread(target=run,name="kristine-invoice-archive-sync",daemon=True)
    thread.start()
    return thread


def start_from_environment(store):
    """Use the same existing authorized KRISTINE cloud connection as other Brain functions."""
    base=str(os.environ.get("KRISTINE_API_BASE") or "https://protokoll.krista.at").rstrip("/")
    secret=str(os.environ.get("KRISTINE_ADMIN_TOKEN") or os.environ.get("ADMIN_TOKEN") or "").strip()
    return start_worker(store,base,secret)
