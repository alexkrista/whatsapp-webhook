# coding: utf-8
from __future__ import annotations
import hashlib
from datetime import datetime

METHODS={"unknown","transfer","direct_debit","revolut","cash"}
STATUSES={"open","sepa_submitted","paid"}

def norm_method(v):
    r=str(v or "").strip().lower().replace("-","_").replace(" ","_")
    return {"":"unknown","zahlung":"transfer","ueberweisung":"transfer","überweisung":"transfer","sepa":"transfer","bank":"transfer","einzug":"direct_debit","lastschrift":"direct_debit","abbucher":"direct_debit","kreditkarte":"revolut","karte":"revolut","barzahlung":"cash","bar":"cash"}.get(r,r if r in METHODS else "unknown")

def norm_status(v):
    r=str(v or "").strip().lower().replace("-","_").replace(" ","_")
    return {"":"open","offen":"open","sepa":"sepa_submitted","sepa_uebergeben":"sepa_submitted","sepa_übergeben":"sepa_submitted","uebergeben":"sepa_submitted","übergeben":"sepa_submitted","bezahlt":"paid","closed":"paid","geschlossen":"paid"}.get(r,r if r in STATUSES else "open")

def payment_id(source,source_id):
    h=hashlib.sha256(f"{source}:{source_id}".encode("utf-8","ignore")).hexdigest()[:20].upper()
    return f"KRI-{h}"

class FinanceStore:
    def __init__(self,ns): self.ns=ns
    def con(self):
        f=self.ns.get("_capture_connection"); db=self.ns.get("CAPTURE_DB")
        if not callable(f): raise RuntimeError("KRISTINE-Datenbank nicht verfügbar.")
        c=f(db)
        c.execute("CREATE TABLE IF NOT EXISTS brain_op_overrides(source TEXT NOT NULL,source_id TEXT NOT NULL,status TEXT NOT NULL,note TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(source,source_id))")
        c.execute("CREATE TABLE IF NOT EXISTS brain_payment_meta(source TEXT NOT NULL,source_id TEXT NOT NULL,payment_method TEXT NOT NULL DEFAULT 'unknown',payment_status TEXT NOT NULL DEFAULT 'open',payment_id TEXT NOT NULL DEFAULT '',note TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(source,source_id))")
        c.commit(); return c
    def meta(self):
        c=self.con()
        try:
            rows=c.execute("SELECT source,source_id,payment_method,payment_status,payment_id,note,updated_at FROM brain_payment_meta").fetchall()
            return {(str(r["source"]),str(r["source_id"])):{"paymentMethod":norm_method(r["payment_method"]),"paymentStatus":norm_status(r["payment_status"]),"paymentId":str(r["payment_id"] or ""),"paymentNote":str(r["note"] or ""),"paymentUpdatedAt":str(r["updated_at"] or "")} for r in rows}
        finally:c.close()
    def set_meta(self,source,source_id,method=None,status=None,note=None):
        source=str(source or "").strip(); source_id=str(source_id or "").strip()
        if source not in {"WinWorker","KRISTINE"} or not source_id: raise ValueError("Ungültige Rechnung.")
        c=self.con()
        try:
            old=c.execute("SELECT payment_method,payment_status,payment_id,note FROM brain_payment_meta WHERE source=? AND source_id=?",(source,source_id)).fetchone()
            m=norm_method(method if method is not None else (old["payment_method"] if old else "unknown")); s=norm_status(status if status is not None else (old["payment_status"] if old else "open"))
            n=str(note if note is not None else (old["note"] if old else "") or "").strip()[:1000]; pid=str(old["payment_id"] or "") if old else ""
            if m=="transfer" and not pid: pid=payment_id(source,source_id)
            if m!="transfer" and s=="sepa_submitted": s="open"
            c.execute("INSERT INTO brain_payment_meta(source,source_id,payment_method,payment_status,payment_id,note,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source,source_id) DO UPDATE SET payment_method=excluded.payment_method,payment_status=excluded.payment_status,payment_id=excluded.payment_id,note=excluded.note,updated_at=excluded.updated_at",(source,source_id,m,s,pid,n,datetime.now().isoformat(timespec="seconds")))
            c.commit(); return {"paymentMethod":m,"paymentStatus":s,"paymentId":pid,"paymentNote":n}
        finally:c.close()
    def legacy(self):
        c=self.con()
        try:return {str(r["source_id"]):dict(status=str(r["status"] or ""),note=str(r["note"] or ""),updatedAt=str(r["updated_at"] or "")) for r in c.execute("SELECT source_id,status,note,updated_at FROM brain_op_overrides WHERE source='WinWorker'").fetchall()}
        finally:c.close()
    def set_legacy(self,source_id,paid=True,note=""):
        source_id=str(source_id or "").strip()
        if not source_id.startswith("ww:"): raise ValueError("Ungültige WinWorker-OP.")
        c=self.con()
        try:
            if paid:c.execute("INSERT INTO brain_op_overrides(source,source_id,status,note,updated_at) VALUES('WinWorker',?,'paid',?,?) ON CONFLICT(source,source_id) DO UPDATE SET status='paid',note=excluded.note,updated_at=excluded.updated_at",(source_id,str(note or "")[:500],datetime.now().isoformat(timespec="seconds")))
            else:c.execute("DELETE FROM brain_op_overrides WHERE source='WinWorker' AND source_id=?",(source_id,))
            c.commit()
        finally:c.close()
    def ww(self,include_resolved=False):
        sql=self.ns.get("sql_connection"); pay=self.ns.get("_payment_state"); iso=self.ns.get("_iso_date"); lookup=self.ns.get("_pdf_paths_by_docids")
        if not callable(sql) or not callable(pay): return []
        legacy=self.legacy(); meta=self.meta(); c=sql("WinWorker_Projekte_Standard")
        try: rows=c.cursor().execute("SELECT e.cID,e.sBelegnummer,e.dzBelegdatum,e.dblBruttoBetrag,e.lVonAdrIndex,e.sZahlungsStatus,dm.sDocID,k.sFirma,k.sName,k.sVorname FROM dbo.Eingangsbelege e LEFT JOIN dbo.DokumentenManagement dm ON dm.gID=e.gDMID LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden k ON k.StammIndex=e.lVonAdrIndex ORDER BY e.dzBelegdatum,e.cID").fetchall()
        finally:c.close()
        keep=[]; docs=[]
        for r in rows:
            sid=f"ww:{int(r.cID)}"; lg=legacy.get(sid); ex=meta.get(("WinWorker",sid),{}); paid_local=bool(lg and lg.get("status")=="paid") or norm_status(ex.get("paymentStatus"))=="paid"
            if pay(r.sZahlungsStatus)!="open" and not include_resolved: continue
            if paid_local and not include_resolved: continue
            doc=str(r.sDocID or "").strip(); docs.append(doc) if doc else None; keep.append((r,sid,doc,lg,ex,paid_local))
        paths={}
        if callable(lookup) and docs:
            try:paths=lookup(docs,include_text=False)
            except Exception:pass
        out=[]
        for r,sid,doc,lg,ex,is_paid in keep:
            company=str(r.sFirma or "").strip(); person=" ".join(x for x in [str(r.sVorname or "").strip(),str(r.sName or "").strip()] if x); found=paths.get(doc,{}) if doc else {}; m=norm_method(ex.get("paymentMethod")); st="paid" if is_paid else norm_status(ex.get("paymentStatus")); dt=iso(r.dzBelegdatum) if callable(iso) else str(r.dzBelegdatum or "")[:10]
            out.append(dict(id=sid,docId=doc,supplier=company or person or f"WW-Adresse {r.lVonAdrIndex or ''}".strip(),invoiceNumber=str(r.sBelegnummer or "").strip(),invoiceDate=dt or "",dueDate=dt or "",amount=float(r.dblBruttoBetrag or 0),currency="EUR",paymentState=st,paymentStatus=st,paymentMethod=m,paymentId=str(ex.get("paymentId") or (payment_id("WinWorker",sid) if m=="transfer" else "")),workflowStatus="WinWorker",path=str(found.get("pdfPath") or found.get("originalPath") or ""),source="WinWorker",brainOverride="paid" if is_paid else ""))
        return out
    def kristine(self,include_resolved=False):
        f=self.ns.get("_capture_connection"); db=self.ns.get("CAPTURE_DB")
        if not callable(f): return []
        meta=self.meta(); c=f(db)
        try:
            where="" if include_resolved else "WHERE LOWER(COALESCE(payment_state,'open')) NOT IN ('paid','bezahlt','closed','geschlossen')"
            rows=c.execute(f"SELECT id,doc_id,supplier_name,supplier_invoice_number,invoice_date,COALESCE(NULLIF(net_due_date,''),NULLIF(due_date,''),invoice_date) due_date_effective,gross_amount,currency,payment_state,workflow_status,pdf_path FROM incoming_invoices {where} ORDER BY due_date_effective,supplier_name COLLATE NOCASE,gross_amount").fetchall()
        finally:c.close()
        out=[]
        for r in rows:
            sid=f"kristine:{int(r['id'])}"; ex=meta.get(("KRISTINE",sid),{}); m=norm_method(ex.get("paymentMethod")); src=norm_status(r["payment_state"]); st="paid" if src=="paid" else norm_status(ex.get("paymentStatus"))
            if st=="paid" and not include_resolved: continue
            out.append(dict(id=sid,docId=str(r["doc_id"] or ""),supplier=str(r["supplier_name"] or ""),invoiceNumber=str(r["supplier_invoice_number"] or ""),invoiceDate=str(r["invoice_date"] or ""),dueDate=str(r["due_date_effective"] or ""),amount=float(r["gross_amount"] or 0),currency=str(r["currency"] or "EUR"),paymentState=st,paymentStatus=st,paymentMethod=m,paymentId=str(ex.get("paymentId") or (payment_id("KRISTINE",sid) if m=="transfer" else "")),workflowStatus=str(r["workflow_status"] or ""),path=str(r["pdf_path"] or ""),source="KRISTINE",brainOverride=""))
        return out
    def items(self,include_resolved=False):
        ww=self.ww(include_resolved); local=self.kristine(include_resolved); docs={str(x.get("docId") or "").strip() for x in local if str(x.get("docId") or "").strip()}; rows=[x for x in ww if str(x.get("docId") or "").strip() not in docs]+local
        rows.sort(key=lambda x:(str(x.get("dueDate") or x.get("invoiceDate") or ""),str(x.get("supplier") or "").lower(),float(x.get("amount") or 0))); return rows
