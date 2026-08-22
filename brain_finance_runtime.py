# coding: utf-8
from __future__ import annotations
import os
import re
from datetime import datetime
from urllib.parse import quote, unquote
from brain_finance_source import FinanceStore,norm_method,norm_status,METHODS,STATUSES,payment_id
from brain_finance_ui import payments_page,revolut_page

FINANCE_MARKER="[FINANCE_APPROVAL]"
FINAL_APPROVALS={"approved","reduced"}


def _enc(v):
    return quote(str(v or ""),safe="")


def _dec(v):
    return unquote(str(v or ""))


def _finance_reminder(item,decision="pending",mode="",deduction=0.0,approved=None,reason=""):
    amount=float(item.get("amount") or 0)
    if approved is None:approved=amount
    values={
        "source":item.get("source") or "",
        "id":item.get("id") or "",
        "doc":item.get("docId") or "",
        "invoice":item.get("invoiceNumber") or "",
        "amount":f"{amount:.2f}",
        "currency":item.get("currency") or "EUR",
        "decision":decision or "pending",
        "mode":mode or "",
        "deduction":f"{float(deduction or 0):.2f}",
        "approved":f"{float(approved or 0):.2f}",
        "reason":reason or "",
    }
    body=";".join(f"{k}={_enc(v)}" for k,v in values.items())
    return f"{FINANCE_MARKER}{body}"[:500]


def _parse_finance_task(task):
    text=str((task or {}).get("reminder") or "")
    if FINANCE_MARKER not in text:return None
    body=text.split(FINANCE_MARKER,1)[1].strip()
    meta={}
    for part in body.split(";"):
        if "=" not in part:continue
        key,val=part.split("=",1);meta[key.strip()]=_dec(val)
    source=str(meta.get("source") or ""); sid=str(meta.get("id") or "")
    if not source or not sid:return None
    for k in ("amount","deduction","approved"):
        try:meta[k]=float(str(meta.get(k) or "0").replace(",","."))
        except Exception:meta[k]=0.0
    meta["decision"]=str(meta.get("decision") or "pending").lower()
    meta["taskId"]=str((task or {}).get("id") or "")
    meta["taskStatus"]=str((task or {}).get("status") or "open")
    return meta


def install(ns):
    page=str(ns.get("MOBILE_PAGE") or ""); app=ns.get("app")
    if not page or app is None:return
    allowed=ns.get("MOBILE_ALLOWED_PATHS")
    paths=("/incoming/open-items","/incoming/open-items/override","/incoming/payment-meta","/incoming/payment-open-items","/incoming/payment-batch/prepare","/incoming/payment-approvals/sync","/incoming/payments","/incoming/revolut/items","/incoming/revolut")
    if isinstance(allowed,set):
        for p in paths:allowed.add(p)
    store=FinanceStore(ns)
    kristine_api=ns.get("kristine_api_request")

    def finance_tasks():
        if not callable(kristine_api):raise RuntimeError("KRISTINE-Aufgaben-API ist im Brain nicht verfügbar.")
        boot=kristine_api("/kristine/api/bootstrap") or {}
        return boot,list(boot.get("tasks") or [])

    def pick_approver(boot):
        employees=list(boot.get("employees") or [])
        wanted_id=str(os.environ.get("KRISTINE_FINANCE_APPROVER_ID") or "").strip()
        wanted_name=str(os.environ.get("KRISTINE_FINANCE_APPROVER_NAME") or "Alex").strip() or "Alex"
        if wanted_id:
            hit=next((e for e in employees if str(e.get("id") or e.get("employeeId") or "")==wanted_id),None)
            if hit:return wanted_id,str(hit.get("nickname") or hit.get("name") or wanted_name)
            return wanted_id,wanted_name
        def score(e):
            name=" ".join(str(e.get(k) or "") for k in ("nickname","name","employeeName")).strip().lower()
            if not name:return 0
            w=wanted_name.lower()
            if w and w in name:return 100
            if "alex" in name:return 90
            if "alexander" in name:return 85
            return 0
        ranked=sorted(((score(e),e) for e in employees),key=lambda x:x[0],reverse=True)
        if ranked and ranked[0][0]>0:
            e=ranked[0][1];return str(e.get("id") or e.get("employeeId") or "admin"),str(e.get("nickname") or e.get("name") or e.get("employeeName") or wanted_name)
        return "admin",wanted_name

    def sync_finance_tasks():
        boot,tasks=finance_tasks(); existing={}
        for t in tasks:
            m=_parse_finance_task(t)
            if m:existing[(m["source"],m["id"])]=t
        approver_id,approver_name=pick_approver(boot); created=[]; now=datetime.now().isoformat(timespec="seconds"); today=datetime.now().date().isoformat()
        for x in store.items(False):
            if str(x.get("source") or "")!="KRISTINE":continue
            key=("KRISTINE",str(x.get("id") or ""))
            if key in existing:continue
            amount=float(x.get("amount") or 0); supplier=str(x.get("supplier") or "Lieferant").strip(); inv=str(x.get("invoiceNumber") or "").strip()
            tid="finance-"+payment_id("KRISTINE",key[1]).replace("KRI-","").lower()
            task={
                "id":tid,
                "title":f"💶 Rechnung freigeben · {supplier}"[:180],
                "assigneeId":approver_id,
                "assigneeName":approver_name,
                "jobId":"",
                "jobName":"",
                "taskType":"Sonstiges",
                "priority":"heute",
                "creatorId":"brain-finance",
                "creatorName":"Dunja / The Brain",
                "address":"",
                "contactName":"",
                "contactPhone":"",
                "contactEmail":"",
                "dueDate":today,
                "reminder":_finance_reminder(x),
                "status":"open",
                "createdAt":now,
                "completedAt":None,
            }
            tasks.append(task);existing[key]=task;created.append(task)
        if created:
            kristine_api("/kristine/api/tasks",method="PUT",payload={"tasks":tasks})
            # Backend liefert die gespeicherte Liste nicht zwingend zurück; Bootstrap neu lesen,
            # damit die anschließende Zahlungsprüfung immer den persistierten Stand sieht.
            boot,tasks=finance_tasks()
        return {"created":len(created),"tasks":tasks,"approverId":approver_id,"approverName":approver_name}

    def approval_index(tasks):
        out={}
        for task in tasks or []:
            meta=_parse_finance_task(task)
            if meta:out[(meta["source"],meta["id"])]=meta
        return out

    def apply_approval(item,index):
        row=dict(item);amount=max(0.0,float(row.get("amount") or 0))
        if str(row.get("source") or "")!="KRISTINE":
            row.update(approvalStatus="not_required",approvalTaskId="",approvalReason="",approvalDeduction=0.0,approvedAmount=amount,paymentAmount=amount,approvalMode="")
            return row
        meta=index.get(("KRISTINE",str(row.get("id") or "")))
        if not meta:
            row.update(approvalStatus="pending",approvalTaskId="",approvalReason="",approvalDeduction=0.0,approvedAmount=0.0,paymentAmount=0.0,approvalMode="")
            return row
        decision=str(meta.get("decision") or "pending").lower(); deduction=max(0.0,float(meta.get("deduction") or 0)); approved=float(meta.get("approved") or 0)
        if decision=="approved":approved=amount;deduction=0.0
        elif decision=="reduced":
            if approved<=0 and deduction<amount:approved=amount-deduction
            approved=min(amount,max(0.0,approved));deduction=max(0.0,amount-approved)
        elif decision=="blocked":approved=0.0
        else:decision="pending";approved=0.0;deduction=0.0
        row.update(approvalStatus=decision,approvalTaskId=meta.get("taskId") or "",approvalReason=str(meta.get("reason") or ""),approvalDeduction=round(deduction,2),approvedAmount=round(approved,2),paymentAmount=round(approved,2),approvalMode=str(meta.get("mode") or ""))
        return row

    def remittance_for(item):
        inv=str(item.get("invoiceNumber") or item.get("docId") or "Rechnung").strip()
        if item.get("approvalStatus")!="reduced":return inv[:140]
        deduction=float(item.get("approvalDeduction") or 0); reason=" ".join(str(item.get("approvalReason") or "").split())
        base=f"{inv} - Abzug {deduction:.2f} EUR"
        if reason:base+=f": {reason}"
        return base[:140]

    if "brain_incoming_open_items" not in app.view_functions:
        from flask import request,jsonify,Response
        @app.get("/incoming/open-items")
        def brain_incoming_open_items():
            try:
                inc=str(request.args.get("includeResolved") or "").lower() in {"1","true","yes","ja"}; items=store.items(inc); opened=[x for x in items if norm_status(x.get("paymentStatus"))!="paid"]
                return jsonify(ok=True,area="live",source="WinWorker + KRISTINE",count=len(opened),total=round(sum(float(x.get("amount") or 0) for x in opened),2),items=items)
            except Exception as e:return jsonify(ok=False,error=str(e)),500
        @app.post("/incoming/open-items/override")
        def brain_incoming_open_items_override():
            try:
                b=request.get_json(silent=True) or {}; source=str(b.get("source") or ""); sid=str(b.get("id") or ""); paid=bool(b.get("paid",True)); note=str(b.get("note") or "")
                if source!="WinWorker":raise ValueError("Lokale OP-Korrekturen sind nur für WinWorker-Altdaten vorgesehen.")
                store.set_legacy(sid,paid,note)
                if paid:store.set_meta(source,sid,status="paid",note=note)
                return jsonify(ok=True,id=sid,paid=paid)
            except ValueError as e:return jsonify(ok=False,error=str(e)),400
            except Exception as e:return jsonify(ok=False,error=str(e)),500
        @app.post("/incoming/payment-meta")
        def brain_incoming_payment_meta():
            try:
                b=request.get_json(silent=True) or {}; m=b.get("paymentMethod") if "paymentMethod" in b else None; s=b.get("paymentStatus") if "paymentStatus" in b else None
                if m is not None and norm_method(m) not in METHODS:raise ValueError("Ungültiger Zahlungsweg.")
                if s is not None and norm_status(s) not in STATUSES:raise ValueError("Ungültiger Zahlungsstatus.")
                saved=store.set_meta(b.get("source"),b.get("id"),m,s,b.get("note") if "note" in b else None); return jsonify(ok=True,**saved)
            except ValueError as e:return jsonify(ok=False,error=str(e)),400
            except Exception as e:return jsonify(ok=False,error=str(e)),500
        @app.post("/incoming/payment-approvals/sync")
        def brain_incoming_payment_approvals_sync():
            try:
                s=sync_finance_tasks();return jsonify(ok=True,created=s["created"],approverId=s["approverId"],approverName=s["approverName"])
            except Exception as e:return jsonify(ok=False,error=str(e)),500
        @app.get("/incoming/payment-open-items")
        def brain_incoming_payment_open_items():
            try:
                sync_error=""
                try:synced=sync_finance_tasks();tasks=synced["tasks"]
                except Exception as e:
                    sync_error=str(e)
                    try:_boot,tasks=finance_tasks()
                    except Exception:tasks=[]
                idx=approval_index(tasks);all_items=[apply_approval(x,idx) for x in store.items(False)]
                transfer=[x for x in all_items if norm_method(x.get("paymentMethod"))=="transfer" and norm_status(x.get("paymentStatus"))!="paid"]
                unknown=[x for x in all_items if norm_method(x.get("paymentMethod"))=="unknown" and norm_status(x.get("paymentStatus"))!="paid"]
                local=[x for x in all_items if str(x.get("source") or "")=="KRISTINE" and norm_status(x.get("paymentStatus"))!="paid"]
                pending=[x for x in local if x.get("approvalStatus")=="pending"]; blocked=[x for x in local if x.get("approvalStatus")=="blocked"]; approved=[x for x in local if x.get("approvalStatus") in FINAL_APPROVALS]
                payable=[x for x in transfer if x.get("approvalStatus") in FINAL_APPROVALS or x.get("approvalStatus")=="not_required"]
                return jsonify(ok=True,count=len(transfer),total=round(sum(float(x.get("paymentAmount") if x.get("paymentAmount") is not None else x.get("amount") or 0) for x in payable),2),unclassifiedCount=len(unknown),approvalPendingCount=len(pending),approvalBlockedCount=len(blocked),approvalApprovedCount=len(approved),approvalSyncError=sync_error,items=transfer,unclassified=unknown)
            except Exception as e:return jsonify(ok=False,error=str(e)),500
        @app.post("/incoming/payment-batch/prepare")
        def brain_incoming_payment_batch_prepare():
            try:
                b=request.get_json(silent=True) or {}; req=b.get("items") or []
                if not isinstance(req,list) or not req:raise ValueError("Keine Rechnungen ausgewählt.")
                _boot,tasks=finance_tasks();idx=approval_index(tasks);live={(x["source"],x["id"]):apply_approval(x,idx) for x in store.items(False)};out=[];total=0.0
                for r in req:
                    key=(str((r or {}).get("source") or ""),str((r or {}).get("id") or "")); x=live.get(key)
                    if not x:raise ValueError(f"Rechnung nicht mehr offen: {key[1]}")
                    if norm_method(x.get("paymentMethod"))!="transfer":raise ValueError(f"Nicht als Überweisung markiert: {x.get('supplier') or key[1]}")
                    if norm_status(x.get("paymentStatus"))=="sepa_submitted":raise ValueError(f"Bereits an SEPA übergeben: {x.get('supplier') or key[1]}")
                    if key[0]=="KRISTINE" and x.get("approvalStatus") not in FINAL_APPROVALS:
                        label="gesperrt" if x.get("approvalStatus")=="blocked" else "noch nicht freigegeben"
                        raise ValueError(f"Rechnung {label}: {x.get('supplier') or key[1]}")
                    pay=float(x.get("paymentAmount") if x.get("paymentAmount") is not None else x.get("amount") or 0)
                    if pay<=0:raise ValueError(f"Freigabebetrag ist 0,00 EUR: {x.get('supplier') or key[1]}")
                    remittance=remittance_for(x);saved=store.set_meta(key[0],key[1],method="transfer",status="sepa_submitted",note=remittance);y=dict(x);y.update(saved);y["paymentAmount"]=round(pay,2);y["remittanceText"]=remittance;out.append(y);total+=pay
                return jsonify(ok=True,status="sepa_submitted",count=len(out),total=round(total,2),items=out,message="SEPA übergeben vorgemerkt; bezahlt erst nach Bankabgleich.")
            except ValueError as e:return jsonify(ok=False,error=str(e)),400
            except Exception as e:return jsonify(ok=False,error=str(e)),500
        @app.get("/incoming/revolut/items")
        def brain_incoming_revolut_items():
            try:
                items=[x for x in store.items(True) if norm_method(x.get("paymentMethod"))=="revolut"]; opened=[x for x in items if norm_status(x.get("paymentStatus"))!="paid"]
                return jsonify(ok=True,count=len(items),openCount=len(opened),openTotal=round(sum(float(x.get("amount") or 0) for x in opened),2),items=items)
            except Exception as e:return jsonify(ok=False,error=str(e)),500
        @app.get("/incoming/payments")
        def brain_incoming_payments_page():return Response(payments_page(),mimetype="text/html")
        @app.get("/incoming/revolut")
        def brain_incoming_revolut_page():return Response(revolut_page(),mimetype="text/html")

        if not getattr(app,"_brain_finance_approval_after_capture",False):
            @app.after_request
            def brain_finance_approval_after_capture(response):
                if request.method=="POST" and request.path=="/incoming/capture/save" and response.status_code<400:
                    try:
                        payload=response.get_json(silent=True) or {}
                        if payload.get("ok") and not payload.get("trainingMode"):sync_finance_tasks()
                    except Exception as e:print("⚠️ Brain Finance: Freigabe-Aufgabe konnte nicht synchronisiert werden:",e)
                return response
            app._brain_finance_approval_after_capture=True

    page=re.sub(r'<section id="incomingOpenItemsPanel".*?</section>','',page,flags=re.S); page=re.sub(r'<script id="kristaIncomingOpenItemsV[1234]">.*?</script>','',page,flags=re.S)
    panel=r'''<section id="incomingRevolutPanel" class="incoming-revolut-panel"><div><strong>Revolut</strong><div class="sub" id="incomingRevolutMeta">Kartenbelege und offene Zuordnungen</div></div><a class="action incoming-revolut-open" href="/incoming/revolut">Revolut öffnen →</a></section>'''
    css=r'''.incoming-revolut-panel{margin:12px 0 18px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card);display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap}.incoming-revolut-panel strong{font-size:17px}.incoming-revolut-open{font-weight:850;text-decoration:none}'''
    script=r'''<script id="kristaIncomingRevolutV1">(()=>{const m=document.getElementById('incomingRevolutMeta');if(!m)return;const f=n=>new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(n||0));fetch('/incoming/revolut/items',{cache:'no-store'}).then(r=>r.json()).then(d=>{if(!d.ok)throw Error(d.error||'Fehler');m.textContent=`${d.openCount||0} offen · ${f(d.openTotal)} · Belege/Rechnungen`}).catch(e=>m.textContent=e.message)})();</script>'''
    marker='<div class="capture-dashboard" id="captureDashboard"></div>'
    if 'id="incomingRevolutPanel"' not in page and marker in page:page=page.replace(marker,marker+"\n"+panel,1)
    if ".incoming-revolut-panel{" not in page:page=page.replace("</style>",css+"\n</style>",1)
    if "kristaIncomingRevolutV1" not in page:page=page.replace("</body>",script+"\n</body>",1)
    ns["MOBILE_PAGE"]=page; print("✅ Brain Finance V5: Freigabe-Aufgaben · Kürzung · SEPA-Sperre")
