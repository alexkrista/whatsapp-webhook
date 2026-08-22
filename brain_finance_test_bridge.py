# coding: utf-8
"""KRISTINE Finance: Freigabe sofort nach Erfassung + Test/Revolut-Bruecke.

Die produktive Finance-Logik bleibt in brain_finance_runtime.py. Dieses kleine Modul
schliesst zwei Testluecken:
- Auch im Testgelaende wird sofort eine klar als TEST markierte Freigabe-Aufgabe erzeugt.
- Die Revolut-Ansicht folgt der aktuell gewaehlten Erfassungs-Area und zeigt den
  Freigabestatus, bevor spaeter der eigentliche Transaktionsabgleich erfolgt.
"""
from __future__ import annotations

from datetime import datetime

from brain_finance_runtime import _finance_reminder, _parse_finance_task
from brain_finance_source import norm_status, payment_id


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    kristine_api = ns.get("kristine_api_request")
    if app is None or not page or not callable(area_connection) or not callable(capture_area):
        return

    def finance_tasks():
        if not callable(kristine_api):
            raise RuntimeError("KRISTINE-Aufgaben-API ist im Brain nicht verfuegbar.")
        boot = kristine_api("/kristine/api/bootstrap") or {}
        return boot, list(boot.get("tasks") or [])

    def pick_approver(boot):
        employees = list(boot.get("employees") or [])
        for wanted in ("alex", "alexander"):
            for employee in employees:
                text = " ".join(str(employee.get(k) or "") for k in ("nickname", "name", "employeeName")).lower()
                if wanted in text:
                    return (
                        str(employee.get("id") or employee.get("employeeId") or "admin"),
                        str(employee.get("nickname") or employee.get("name") or employee.get("employeeName") or "Alex"),
                    )
        return "admin", "Alex"

    def test_meta(task):
        meta = _parse_finance_task(task)
        if not meta or str(meta.get("source") or "") != "KRISTINE_TEST":
            return None
        return meta

    def test_task_index(tasks):
        out = {}
        for task in tasks or []:
            meta = test_meta(task)
            if meta:
                out[str(meta.get("id") or "")] = meta
        return out

    def ensure_test_task(invoice, tasks=None, boot=None):
        if not callable(kristine_api):
            return None
        invoice_id = int((invoice or {}).get("id") or 0)
        if not invoice_id:
            return None
        sid = f"kristine:{invoice_id}"
        if tasks is None or boot is None:
            boot, tasks = finance_tasks()
        existing = test_task_index(tasks)
        if sid in existing:
            return existing[sid]

        approver_id, approver_name = pick_approver(boot)
        supplier = str((invoice or {}).get("supplierName") or (invoice or {}).get("supplier") or "Lieferant").strip()
        item = {
            "source": "KRISTINE_TEST",
            "id": sid,
            "docId": str((invoice or {}).get("docId") or ""),
            "invoiceNumber": str((invoice or {}).get("invoiceNumber") or ""),
            "amount": float((invoice or {}).get("grossAmount") or (invoice or {}).get("amount") or 0),
            "currency": str((invoice or {}).get("currency") or "EUR"),
        }
        now = datetime.now().isoformat(timespec="seconds")
        task = {
            "id": "finance-test-" + payment_id("KRISTINE_TEST", sid).replace("KRI-", "").lower(),
            "title": f"🧪 TEST · Rechnung freigeben · {supplier}"[:180],
            "assigneeId": approver_id,
            "assigneeName": approver_name,
            "jobId": "",
            "jobName": "",
            "taskType": "Sonstiges",
            "priority": "heute",
            "creatorId": "brain-finance",
            "creatorName": "Dunja / The Brain · TEST",
            "address": "",
            "contactName": "",
            "contactPhone": "",
            "contactEmail": "",
            "dueDate": datetime.now().date().isoformat(),
            "reminder": _finance_reminder(item),
            "status": "open",
            "createdAt": now,
            "completedAt": None,
        }
        tasks.append(task)
        kristine_api("/kristine/api/tasks", method="PUT", payload={"tasks": tasks})
        return _parse_finance_task(task)

    # Im Echtbetrieb erzeugt brain_finance_runtime die Aufgabe bereits nach dem Save.
    # Fuer das Testgelaende war sie bisher absichtlich ausgelassen; zum echten Workflow-Test
    # brauchen wir sie aber ebenfalls, klar mit TEST gekennzeichnet.
    if not getattr(app, "_brain_finance_test_approval_after_capture", False):
        from flask import request

        @app.after_request
        def brain_finance_test_approval_after_capture(response):
            if request.method == "POST" and request.path == "/incoming/capture/save" and response.status_code < 400:
                try:
                    payload = response.get_json(silent=True) or {}
                    if payload.get("ok") and payload.get("trainingMode") and isinstance(payload.get("invoice"), dict):
                        ensure_test_task(payload["invoice"])
                except Exception as exc:
                    print("⚠️ Brain Finance TEST: Freigabe-Aufgabe konnte nicht erzeugt werden:", exc)
            return response

        app._brain_finance_test_approval_after_capture = True

    # Revolut-Endpoint area-faehig machen. TEST liest ausschliesslich die Testdatenbank.
    original_revolut_items = app.view_functions.get("brain_incoming_revolut_items")
    if original_revolut_items and not getattr(original_revolut_items, "_krista_area_bridge", False):
        from flask import request, jsonify

        def revolut_items_area():
            area = capture_area(request.args.get("area") or "live")
            if area != "test":
                response = app.make_response(original_revolut_items())
                try:
                    body = response.get_json(silent=True) or {}
                    if body.get("ok"):
                        _boot, tasks = finance_tasks()
                        index = {}
                        for task in tasks:
                            meta = _parse_finance_task(task)
                            if meta and str(meta.get("source") or "") == "KRISTINE":
                                index[str(meta.get("id") or "")] = meta
                        for item in body.get("items") or []:
                            if str(item.get("source") or "") == "KRISTINE":
                                meta = index.get(str(item.get("id") or ""))
                                item["approvalStatus"] = str((meta or {}).get("decision") or "pending")
                    return jsonify(body), response.status_code
                except Exception:
                    return response

            con = area_connection("test")
            try:
                rows = con.execute("""
                    SELECT id,doc_id,supplier_name,supplier_invoice_number,invoice_date,
                           gross_amount,currency,payment_state,pdf_path,payment_method,
                           fx_estimated_eur
                    FROM incoming_invoices
                    WHERE LOWER(COALESCE(payment_method,'unknown'))='revolut'
                    ORDER BY invoice_date DESC,id DESC
                """).fetchall()
                boot, tasks = finance_tasks()
                for row in rows:
                    sid = f"kristine:{int(row['id'])}"
                    if sid not in test_task_index(tasks):
                        ensure_test_task({
                            "id": int(row["id"]), "docId": str(row["doc_id"] or ""),
                            "supplierName": str(row["supplier_name"] or ""),
                            "invoiceNumber": str(row["supplier_invoice_number"] or ""),
                            "grossAmount": float(row["gross_amount"] or 0),
                            "currency": str(row["currency"] or "EUR"),
                        }, tasks=tasks, boot=boot)
                        boot, tasks = finance_tasks()
                approvals = test_task_index(tasks)
                items = []
                for row in rows:
                    sid = f"kristine:{int(row['id'])}"
                    meta = approvals.get(sid) or {}
                    status = norm_status(row["payment_state"])
                    items.append({
                        "id": sid,
                        "docId": str(row["doc_id"] or ""),
                        "supplier": str(row["supplier_name"] or ""),
                        "invoiceNumber": str(row["supplier_invoice_number"] or ""),
                        "invoiceDate": str(row["invoice_date"] or ""),
                        "amount": float(row["gross_amount"] or 0),
                        "currency": str(row["currency"] or "EUR"),
                        "paymentStatus": status,
                        "paymentMethod": "revolut",
                        "approvalStatus": str(meta.get("decision") or "pending"),
                        "path": str(row["pdf_path"] or ""),
                        "source": "KRISTINE_TEST",
                        "estimatedEur": float(row["fx_estimated_eur"]) if row["fx_estimated_eur"] is not None else None,
                    })
                opened = [x for x in items if x["paymentStatus"] != "paid"]
                total_eur = 0.0
                for item in opened:
                    if item.get("estimatedEur") is not None:
                        total_eur += float(item["estimatedEur"])
                    elif item.get("currency") == "EUR":
                        total_eur += float(item.get("amount") or 0)
                return jsonify(
                    ok=True, area="test", trainingMode=True,
                    count=len(items), openCount=len(opened), openTotal=round(total_eur, 2),
                    approvalPendingCount=sum(1 for x in items if x.get("approvalStatus") == "pending"),
                    items=items,
                )
            finally:
                con.close()

        revolut_items_area.__name__ = "brain_incoming_revolut_items_area"
        revolut_items_area._krista_area_bridge = True
        app.view_functions["brain_incoming_revolut_items"] = revolut_items_area

    # Revolut-Seite bekommt die Area aus ?area=test|live und zeigt Freigabe vor Abgleich.
    original_revolut_page = app.view_functions.get("brain_incoming_revolut_page")
    if original_revolut_page and not getattr(original_revolut_page, "_krista_area_bridge", False):
        from flask import request, Response

        def revolut_page_area():
            area = capture_area(request.args.get("area") or "live")
            response = app.make_response(original_revolut_page())
            html = response.get_data(as_text=True)
            area_q = "test" if area == "test" else "live"
            html = html.replace("fetch('/incoming/revolut/items'", f"fetch('/incoming/revolut/items?area={area_q}'")
            html = html.replace(
                "money=n=>new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(n||0))",
                "money=(n,c='EUR')=>new Intl.NumberFormat('de-AT',{style:'currency',currency:c||'EUR'}).format(Number(n||0))",
            )
            html = html.replace("${money(x.amount)}", "${money(x.amount,x.currency)}")
            html = html.replace(
                "${x.paymentStatus==='paid'?'bezahlt':'Abgleich offen'}",
                "${x.approvalStatus==='pending'?'Freigabe offen':x.approvalStatus==='blocked'?'gesperrt':x.paymentStatus==='paid'?'bezahlt':'Abgleich offen'}",
            )
            if area == "test":
                html = html.replace("<h1>Revolut</h1>", "<h1>Revolut · TEST</h1>")
                html = html.replace(
                    "Jede Revolut-Bewegung wird gegen Rechnung/Beleg abgeglichen.",
                    "TESTGELÄNDE · Freigabe zuerst. Danach wird jede Revolut-Bewegung gegen Rechnung/Beleg abgeglichen.",
                )
            else:
                html = html.replace(
                    "Jede Revolut-Bewegung wird gegen Rechnung/Beleg abgeglichen.",
                    "Freigabe zuerst. Danach wird jede Revolut-Bewegung gegen Rechnung/Beleg abgeglichen.",
                )
            return Response(html, mimetype="text/html")

        revolut_page_area.__name__ = "brain_incoming_revolut_page_area"
        revolut_page_area._krista_area_bridge = True
        app.view_functions["brain_incoming_revolut_page"] = revolut_page_area

    # Auf der Erfassungsseite folgt der Revolut-Link der aktuell aktiven Test/Echt-Area.
    script = r'''
<script id="kristaRevolutAreaBridgeV1">
(function(){
  function area(){try{return typeof captureArea!=='undefined'&&captureArea==='live'?'live':'test'}catch(_){return localStorage.getItem('kristineCaptureArea')==='live'?'live':'test'}}
  function refresh(){
    const a=area(),link=document.querySelector('.incoming-revolut-open'),meta=document.getElementById('incomingRevolutMeta');
    if(link)link.href='/incoming/revolut?area='+encodeURIComponent(a);
    if(!meta)return;
    fetch('/incoming/revolut/items?area='+encodeURIComponent(a),{cache:'no-store'}).then(r=>r.json()).then(d=>{
      if(!d.ok)throw Error(d.error||'Fehler');
      const amount=new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(d.openTotal||0));
      const pending=Number(d.approvalPendingCount||0);
      meta.textContent=(a==='test'?'TEST · ':'')+`${d.openCount||0} offen · ${amount}`+(pending?` · ${pending} Freigabe offen`:'')+' · Belege/Rechnungen';
    }).catch(e=>meta.textContent=e.message||String(e));
  }
  setTimeout(refresh,0);
  document.getElementById('captureAreaTest')?.addEventListener('click',()=>setTimeout(refresh,0));
  document.getElementById('captureAreaLive')?.addEventListener('click',()=>setTimeout(refresh,0));
})();
</script>
'''
    if "kristaRevolutAreaBridgeV1" not in page:
        page = page.replace("</body>", script + "\n</body>", 1)
        ns["MOBILE_PAGE"] = page

    print("✅ Finance Test/Revolut Bridge: TEST-Freigabe sofort · Revolut area-faehig")
