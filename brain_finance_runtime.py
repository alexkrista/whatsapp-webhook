# coding: utf-8
from __future__ import annotations
import re
from brain_finance_source import FinanceStore,norm_method,norm_status,METHODS,STATUSES
from brain_finance_ui import payments_page,revolut_page

def install(ns):
    page=str(ns.get("MOBILE_PAGE") or ""); app=ns.get("app")
    if not page or app is None:return
    allowed=ns.get("MOBILE_ALLOWED_PATHS")
    paths=("/incoming/open-items","/incoming/open-items/override","/incoming/payment-meta","/incoming/payment-open-items","/incoming/payment-batch/prepare","/incoming/payments","/incoming/revolut/items","/incoming/revolut")
    if isinstance(allowed,set):
        for p in paths:allowed.add(p)
    store=FinanceStore(ns)
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
        @app.get("/incoming/payment-open-items")
        def brain_incoming_payment_open_items():
            try:
                items=store.items(False); transfer=[x for x in items if norm_method(x.get("paymentMethod"))=="transfer" and norm_status(x.get("paymentStatus"))!="paid"]; unknown=[x for x in items if norm_method(x.get("paymentMethod"))=="unknown" and norm_status(x.get("paymentStatus"))!="paid"]
                return jsonify(ok=True,count=len(transfer),total=round(sum(float(x.get("amount") or 0) for x in transfer),2),unclassifiedCount=len(unknown),items=transfer,unclassified=unknown)
            except Exception as e:return jsonify(ok=False,error=str(e)),500
        @app.post("/incoming/payment-batch/prepare")
        def brain_incoming_payment_batch_prepare():
            try:
                b=request.get_json(silent=True) or {}; req=b.get("items") or []
                if not isinstance(req,list) or not req:raise ValueError("Keine Rechnungen ausgewählt.")
                live={(x["source"],x["id"]):x for x in store.items(False)}; out=[]; total=0.0
                for r in req:
                    key=(str((r or {}).get("source") or ""),str((r or {}).get("id") or "")); x=live.get(key)
                    if not x:raise ValueError(f"Rechnung nicht mehr offen: {key[1]}")
                    if norm_method(x.get("paymentMethod"))!="transfer":raise ValueError(f"Nicht als Überweisung markiert: {x.get('supplier') or key[1]}")
                    saved=store.set_meta(key[0],key[1],method="transfer",status="sepa_submitted"); y=dict(x);y.update(saved);out.append(y);total+=float(x.get("amount") or 0)
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
    page=re.sub(r'<section id="incomingOpenItemsPanel".*?</section>','',page,flags=re.S); page=re.sub(r'<script id="kristaIncomingOpenItemsV[1234]">.*?</script>','',page,flags=re.S)
    panel=r'''<section id="incomingRevolutPanel" class="incoming-revolut-panel"><div><strong>Revolut</strong><div class="sub" id="incomingRevolutMeta">Kartenbelege und offene Zuordnungen</div></div><a class="action incoming-revolut-open" href="/incoming/revolut">Revolut öffnen →</a></section>'''
    css=r'''.incoming-revolut-panel{margin:12px 0 18px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card);display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap}.incoming-revolut-panel strong{font-size:17px}.incoming-revolut-open{font-weight:850;text-decoration:none}'''
    script=r'''<script id="kristaIncomingRevolutV1">(()=>{const m=document.getElementById('incomingRevolutMeta');if(!m)return;const f=n=>new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(n||0));fetch('/incoming/revolut/items',{cache:'no-store'}).then(r=>r.json()).then(d=>{if(!d.ok)throw Error(d.error||'Fehler');m.textContent=`${d.openCount||0} offen · ${f(d.openTotal)} · Belege/Rechnungen`}).catch(e=>m.textContent=e.message)})();</script>'''
    marker='<div class="capture-dashboard" id="captureDashboard"></div>'
    if 'id="incomingRevolutPanel"' not in page and marker in page:page=page.replace(marker,marker+"\n"+panel,1)
    if ".incoming-revolut-panel{" not in page:page=page.replace("</style>",css+"\n</style>",1)
    if "kristaIncomingRevolutV1" not in page:page=page.replace("</body>",script+"\n</body>",1)
    ns["MOBILE_PAGE"]=page; print("✅ Brain Finance V4: Bezahl-OP separat · Revolut in Erfassung")
