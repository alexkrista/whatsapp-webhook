# coding: utf-8
"""Revolut Business: Buchungszeile -> Rechnung oder sachliche Kategorie.

Die eigentliche Rest-0,00-Buchung bleibt im zentralen Finance-Abgleich. Diese
Oberflaeche zeigt nur Revolut-Bewegungen und offene Belege aus Revolut Business,
Revolut privat und Kassa. Eine Rechnung wird erst beim bestaetigten Zuordnen als
bezahlt markiert.
"""
from __future__ import annotations

import base64
from datetime import date, datetime, timedelta
import hashlib
from urllib.parse import urlencode

from brain_finance_source import FinanceStore, norm_method, norm_status


def _revolut_rows(connection, start, end):
    lower = start.isoformat() + "T00:00:00Z"
    upper_start = (end + timedelta(days=1)).isoformat() + "T00:00:00Z"

    def collect(kind, size, cursor_field):
        found = {}
        upper = upper_start
        for _ in range(200):
            path = "/" + kind + "?" + urlencode({"from": lower, "to": upper, "count": size})
            page = connection.get(path)
            if not isinstance(page, list):
                raise ValueError("Revolut-Antwort ist unvollständig.")
            for item in page:
                if isinstance(item, dict) and item.get("id"):
                    found[str(item["id"])] = item
            if len(page) < size:
                break
            cursor = str((page[-1] or {}).get(cursor_field) or "")
            if not cursor or cursor >= upper:
                raise ValueError("Revolut-Folgeseite ist unvollständig.")
            upper = cursor
        else:
            raise ValueError("Revolut-Zeitraum ist zu groß.")
        return list(found.values())

    transactions = collect("transactions", 1000, "created_at")
    expenses = collect("expenses", 500, "expense_date")
    rows = []
    by_transaction = {}
    for transaction in transactions:
        if str(transaction.get("state") or "") != "completed":
            continue
        booking = str(transaction.get("completed_at") or transaction.get("created_at") or "")[:10]
        if not start.isoformat() <= booking <= end.isoformat():
            continue
        merchant = transaction.get("merchant") or {}
        merchant_name = str((merchant or {}).get("name") or transaction.get("reference") or transaction.get("type") or "Revolut")
        for index, leg in enumerate(transaction.get("legs") or []):
            if not isinstance(leg, dict) or not leg.get("amount"):
                continue
            external_id = str(transaction.get("id")) + ":" + str(leg.get("leg_id", index))
            row = {
                "id": external_id,
                "transactionId": str(transaction.get("id") or ""),
                "bookingDate": booking,
                "valueDate": booking,
                "amount": str(leg.get("amount")),
                "currency": str(leg.get("currency") or "EUR"),
                "merchant": merchant_name or str(leg.get("description") or "Revolut"),
                "description": str(leg.get("description") or merchant_name),
                "reference": str(transaction.get("reference") or transaction.get("id") or ""),
                "attachments": [],
            }
            rows.append(row)
            by_transaction.setdefault(str(transaction.get("id") or ""), row)
            if leg.get("fee"):
                rows.append({
                    "id": external_id + ":fee",
                    "transactionId": str(transaction.get("id") or ""),
                    "bookingDate": booking,
                    "valueDate": booking,
                    "amount": str(-abs(float(leg.get("fee") or 0))),
                    "currency": str(leg.get("currency") or "EUR"),
                    "merchant": "Revolut Transaktionsgebühr",
                    "description": "Revolut Transaktionsgebühr",
                    "reference": str(transaction.get("reference") or transaction.get("id") or ""),
                })

    receipt_errors = []
    for expense in expenses:
        transaction_id = str(expense.get("transaction_id") or "")
        target = by_transaction.get(transaction_id)
        spent = expense.get("spent_amount") or {}
        if target is None and spent.get("amount"):
            booking = str(expense.get("expense_date") or "")[:10]
            target = {
                "id": "expense:" + str(expense.get("id") or transaction_id),
                "transactionId": transaction_id,
                "bookingDate": booking,
                "valueDate": booking,
                "amount": str(-abs(float(spent.get("amount") or 0))),
                "currency": str(spent.get("currency") or "EUR"),
                "merchant": str(expense.get("merchant") or expense.get("description") or "Revolut Ausgabe"),
                "description": str(expense.get("description") or "Revolut Ausgabe"),
                "reference": transaction_id or str(expense.get("id") or ""),
                "attachments": [],
            }
            rows.append(target)
        if target is None:
            continue
        for receipt_id in expense.get("receipt_ids") or []:
            try:
                raw = connection.receipt(str(expense.get("id")), str(receipt_id))
                mime, extension = "application/octet-stream", "bin"
                if raw.startswith(b"%PDF-"):
                    mime, extension = "application/pdf", "pdf"
                elif raw.startswith(b"\xff\xd8\xff"):
                    mime, extension = "image/jpeg", "jpg"
                elif raw.startswith(b"\x89PNG\r\n\x1a\n"):
                    mime, extension = "image/png", "png"
                target.setdefault("attachments", []).append({
                    "name": "Revolut-Beleg-" + str(expense.get("id")) + "." + extension,
                    "type": mime,
                    "data": base64.b64encode(raw).decode("ascii"),
                })
            except Exception as exc:
                receipt_errors.append({"expenseId": str(expense.get("id") or ""), "error": str(exc)})
    return rows, receipt_errors


def install(ns):
    app = ns.get("app")
    if app is None:
        return
    store = FinanceStore(ns)
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.update({"/incoming/revolut", "/incoming/revolut/candidates", "/incoming/revolut/sync"})

    if "brain_revolut_business_sync" not in app.view_functions:
        from flask import request, jsonify

        @app.post("/incoming/revolut/sync")
        def brain_revolut_business_sync():
            try:
                body = request.get_json(silent=True) or {}
                today = date.today()
                start = date.fromisoformat(str(body.get("from") or (today - timedelta(days=45)).isoformat()))
                end = date.fromisoformat(str(body.get("to") or today.isoformat()))
                if end < start or end > today or (end - start).days > 730:
                    raise ValueError("Bitte den Revolut-Zeitraum prüfen.")
                connection = ns.get("revolut_connection")
                if connection is None:
                    raise ValueError("Die Revolut-Business-Verbindung ist nicht geladen.")
                transactions, receipt_errors = _revolut_rows(connection, start, end)
                if not transactions:
                    return jsonify(ok=True, added=0, suggested=0, attachmentsQueued=0, receiptErrors=receipt_errors)
                importer = app.view_functions.get("brain_reconciliation_import_revolut")
                if importer is None:
                    raise ValueError("Der Revolut-Abgleich ist nicht geladen.")
                content_hash = hashlib.sha256()
                for item in transactions:
                    content_hash.update(str(item.get("id") or "").encode("utf-8", "ignore"))
                    for attachment in item.get("attachments") or []:
                        content_hash.update(str(attachment.get("data") or "").encode("ascii", "ignore"))
                payload = {
                    "channel": "revolut_business",
                    "statementId": "LIVE-" + start.isoformat() + "-" + end.isoformat() + "-" + content_hash.hexdigest()[:16],
                    "periodStart": start.isoformat(),
                    "periodEnd": end.isoformat(),
                    "account": "Revolut Business",
                    "currency": "EUR",
                    "transactions": transactions,
                }
                with app.test_request_context("/incoming/reconciliation/import-revolut", method="POST", json=payload):
                    response = app.make_response(importer())
                    result = response.get_json(silent=True) or {}
                if response.status_code >= 400 or not result.get("ok"):
                    raise ValueError(str(result.get("error") or "Revolut-Import fehlgeschlagen."))
                result["receiptErrors"] = receipt_errors
                result["syncedAt"] = datetime.now().isoformat(timespec="seconds")
                return jsonify(result)
            except ValueError as exc:
                return jsonify(ok=False, error=str(exc)), 400
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

    if "brain_revolut_business_candidates" not in app.view_functions:
        from flask import jsonify

        @app.get("/incoming/revolut/candidates")
        def brain_revolut_business_candidates():
            try:
                rows = []
                for item in store.items(True):
                    method = norm_method(item.get("paymentMethod"))
                    if method not in {"revolut_business", "revolut", "cash"}:
                        continue
                    if norm_status(item.get("paymentStatus")) == "paid":
                        continue
                    rows.append({
                        "source": str(item.get("source") or ""),
                        "id": str(item.get("id") or ""),
                        "docId": str(item.get("docId") or ""),
                        "supplier": str(item.get("supplier") or ""),
                        "invoiceNumber": str(item.get("invoiceNumber") or ""),
                        "invoiceDate": str(item.get("invoiceDate") or ""),
                        "amount": round(float(item.get("amount") or 0), 2),
                        "currency": str(item.get("currency") or "EUR").upper(),
                        "paymentMethod": method,
                        "path": str(item.get("path") or ""),
                    })
                rows.sort(key=lambda x: (x["paymentMethod"], x["supplier"].lower(), x["invoiceDate"]), reverse=False)
                return jsonify(ok=True, count=len(rows), items=rows)
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

    def revolut_business_page():
        from flask import Response
        html = r'''<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revolut Business · The Brain</title><style>
:root{color-scheme:dark;--bg:#0b0f13;--card:#141a21;--card2:#1b232c;--line:#303b47;--text:#f4f6f8;--muted:#9ca9b5;--green:#4c9564;--green2:#27673f;--gold:#c99a37;--red:#a94b45;--blue:#4f79a8}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.42 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1500px;margin:auto;padding:22px}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:18px}.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#84b794;font-weight:850}.top h1{margin:3px 0 4px;font-size:30px}.sub{color:var(--muted);font-size:13px}.button,button{border:1px solid var(--line);border-radius:9px;background:#27313c;color:white;padding:9px 12px;font-weight:800;cursor:pointer;text-decoration:none}.button:hover,button:hover{border-color:#75916f}.primary{background:var(--green2);border-color:var(--green)}.summary{display:grid;grid-template-columns:repeat(3,minmax(160px,1fr));gap:10px;margin-bottom:14px}.tile{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:13px}.tile strong{display:block;font-size:22px;margin-top:3px}.statement{border:1px solid var(--line);background:var(--card);border-radius:15px;margin:12px 0;overflow:hidden}.statement-head{padding:13px 15px;background:var(--card2);display:flex;justify-content:space-between;gap:12px;align-items:center}.move{display:grid;grid-template-columns:110px minmax(230px,1fr) 160px 190px;gap:14px;align-items:center;padding:13px 15px;border-top:1px solid #28323b}.move.reconciled{opacity:.66}.amount{text-align:right;font-size:18px;font-weight:900}.rest{font-size:11px;color:var(--gold)}.ok{color:#71bd88}.badge{display:inline-flex;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:850;background:#26333e}.badge.business{background:#1f4930;color:#a8e4ba}.badge.private{background:#243e58;color:#bdd9f4}.badge.cash{background:#57451f;color:#f0d493}.suggestion{font-size:12px;color:#acd6b9;margin-top:4px}.empty{padding:30px;text-align:center;color:var(--muted)}dialog{width:min(1040px,94vw);max-height:88vh;border:1px solid var(--line);border-radius:16px;background:#111820;color:var(--text);padding:0;box-shadow:0 30px 80px #000b}dialog::backdrop{background:#000a}.modal-head{position:sticky;top:0;background:#182029;padding:15px 17px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:12px;z-index:3}.modal-body{padding:15px}.search{width:100%;border:1px solid var(--line);border-radius:9px;background:#0e141a;color:white;padding:10px 12px;margin-bottom:10px}.candidate{display:grid;grid-template-columns:minmax(230px,1fr) 130px 110px;gap:12px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:10px;margin:7px 0;background:#171f27}.candidate strong{display:block}.candidate .money{text-align:right;font-weight:850}.manual{border-top:1px solid var(--line);margin-top:16px;padding-top:15px}.manual-grid{display:grid;grid-template-columns:1fr 1fr auto;gap:9px}.manual select,.manual input{border:1px solid var(--line);border-radius:9px;background:#0e141a;color:white;padding:10px}.msg{min-height:20px;color:#e3bf6c;font-size:12px;margin-top:8px}@media(max-width:850px){.summary{grid-template-columns:1fr}.move{grid-template-columns:1fr}.amount{text-align:left}.candidate{grid-template-columns:1fr}.candidate .money{text-align:left}.manual-grid{grid-template-columns:1fr}.wrap{padding:12px}}
</style></head><body><main class="wrap"><header class="top"><div><div class="eyebrow">THE BRAIN · FINANZEN</div><h1>Revolut Business</h1><div class="sub">Buchungen zu Rechnungen zuordnen oder ohne Beleg als Spesen, privat oder sonstigen Aufwand buchen.</div><div class="sub" id="syncMsg">Live-Verbindung wird abgefragt …</div><div class="sub" id="accountBalance">Kontostand wird geladen …</div></div><div><button class="primary" id="sync" type="button">↻ Live aktualisieren</button> <a class="button" id="authorizeBank" href="https://protokoll.krista.at/banking/enablebanking" hidden>Bankfreigabe verwalten</a> <a class="button" href="/incoming-capture">← Rechnungseingang</a> <a class="button" href="/incoming/reconciliation">Gesamter Bankabgleich</a></div></header><section class="summary"><div class="tile"><span class="sub">Offene Buchungszeilen</span><strong id="openCount">–</strong></div><div class="tile"><span class="sub">Noch zuzuordnen</span><strong id="openTotal">–</strong></div><div class="tile"><span class="sub">Offene Belege Business / Revolut / Kassa</span><strong id="candidateCount">–</strong></div></section><div id="rows"><div class="empty">Revolut-Buchungen werden geladen …</div></div></main>
<dialog id="assign"><div class="modal-head"><div><strong id="modalTitle">Buchung zuordnen</strong><div class="sub" id="modalMeta"></div></div><button id="close" type="button">Schließen</button></div><div class="modal-body"><input class="search" id="search" placeholder="Lieferant oder Rechnungsnummer suchen"><div id="candidates"></div><section class="manual"><strong>Buchung ohne Beleg erfassen</strong><div class="sub">Auch diese Buchung wird vollständig auf Rest 0,00 abgeschlossen.</div><div class="manual-grid"><select id="category"></select><input id="note" placeholder="Notiz, Kostenart oder Grund"><button class="primary" id="bookNoReceipt" type="button">Ohne Beleg buchen</button></div></section><div class="msg" id="msg"></div></div></dialog>
<script>
(()=>{const personal=location.pathname==='/incoming/revolut-personal';if(personal){document.title='Revolut · The Brain';document.querySelector('.top h1').textContent='Revolut';document.getElementById('candidateCount').closest('.tile').querySelector('.sub').textContent='Offene Belege Revolut';document.getElementById('authorizeBank').hidden=false;}const rows=document.getElementById('rows'),dlg=document.getElementById('assign'),candidatesEl=document.getElementById('candidates'),search=document.getElementById('search'),msg=document.getElementById('msg');let candidates=[],current=null;const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=(n,c='EUR')=>new Intl.NumberFormat('de-AT',{style:'currency',currency:c||'EUR'}).format(Number(n||0)),date=s=>{const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}.${m[2]}.${m[1]}`:(s||'–')},label=m=>m==='revolut_business'?'Revolut Business':m==='revolut'?'Revolut':'Kassa',cls=m=>m==='revolut_business'?'business':m==='revolut'?'private':'cash';
function renderCandidates(){if(current?.direction==='in'){candidatesEl.innerHTML='<div class="empty">Eingangsbuchung: keine Lieferantenrechnung zuordnen.</div>';return}const q=search.value.trim().toLowerCase(),list=candidates.filter(x=>!q||`${x.supplier} ${x.invoiceNumber} ${x.amount}`.toLowerCase().includes(q)).sort((a,b)=>Number(b.id===current?.suggestedId)-Number(a.id===current?.suggestedId));candidatesEl.innerHTML=list.length?list.map(x=>{const exact=current&&x.currency===current.currency&&Math.abs(Number(x.amount)-current.amount)<=.02;return `<div class="candidate"><div><span class="badge ${cls(x.paymentMethod)}">${label(x.paymentMethod)}</span><strong>${esc(x.supplier||'Ohne Lieferant')}</strong><span class="sub">${esc(x.invoiceNumber||'Ohne Rechnungsnummer')} · ${esc(date(x.invoiceDate))}</span></div><div class="money">${esc(money(x.amount,x.currency))}</div>${exact?`<button class="primary" data-source="${esc(x.source)}" data-id="${esc(x.id)}" data-name="${esc((x.supplier||'Rechnung')+' · '+(x.invoiceNumber||''))}">Zuordnen</button>`:'<button disabled title="Betrag oder Währung stimmt nicht überein">Betrag anders</button>'}</div>`}).join(''):'<div class="empty">Kein passender offener Beleg.</div>';candidatesEl.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>assignInvoice(b.dataset.source,b.dataset.id,b.dataset.name))}
async function load(){const [sr,cr]=await Promise.all([fetch('/incoming/reconciliation/statements',{cache:'no-store'}),fetch('/incoming/revolut/candidates',{cache:'no-store'})]),s=await sr.json(),c=await cr.json();if(!sr.ok||!s.ok)throw Error(s.error||'Buchungen nicht erreichbar');if(!cr.ok||!c.ok)throw Error(c.error||'Belege nicht erreichbar');candidates=(c.items||[]).filter(x=>x.paymentMethod===(personal?'revolut':'revolut_business'));document.getElementById('candidateCount').textContent=candidates.length;const statements=(s.statements||[]).filter(x=>x.source===(personal?'REVOLUT':'REVOLUT_BUSINESS')),moves=statements.flatMap(x=>x.movements||[]),open=moves.filter(x=>x.status!=='reconciled'&&Number(x.remaining)>.005),visible=statements.map(st=>({...st,movements:(st.movements||[]).filter(x=>x.status!=='reconciled'&&Number(x.remaining)>.005)})).filter(st=>st.movements.length);document.getElementById('openCount').textContent=open.length;document.getElementById('openTotal').textContent=money(open.reduce((a,x)=>a+Number(x.remaining||0),0));rows.innerHTML=visible.length?visible.map(st=>`<section class="statement"><div class="statement-head"><div><strong>${esc(st.source==='REVOLUT_BUSINESS'?'Revolut Business':'Revolut')} · ${esc(st.accountIban||'')}</strong><div class="sub">${esc(date(st.periodStart))} – ${esc(date(st.periodEnd))} · ${st.movements.length} nicht zugeordnet</div></div><span class="rest">Rest ${esc(money(st.movements.reduce((n,x)=>n+Number(x.remaining||0),0),st.currency))}</span></div>${st.movements.map(x=>`<div class="move ${esc(x.status)}"><div>${esc(date(x.bookingDate))}</div><div><strong>${esc(x.counterpartyName||'Ohne Gegenpartei')}</strong><div class="sub">${esc(x.reference||x.endToEndId||'')}</div>${x.suggestedCategory?`<div class="suggestion">Vorschlag: passende Rechnung gefunden</div>`:''}</div><div><div class="amount">${x.direction==='out'?'−':'+'}${esc(money(x.amount,x.currency))}</div><div class="rest">Rest ${esc(money(x.remaining,x.currency))}</div></div><div><button class="primary" data-move="${x.id}" data-direction="${esc(x.direction)}" data-amount="${Number(x.remaining||x.amount)}" data-currency="${esc(x.currency)}" data-title="${esc(x.counterpartyName||'Buchung')}" data-suggested-source="${esc(x.suggestedTargetSource||'')}" data-suggested-id="${esc(x.suggestedTargetId||'')}">Zuordnen</button></div></div>`).join('')}</section>`).join(''):'<div class="empty">Keine nicht zugeordneten Revolut-Buchungen.</div>';rows.querySelectorAll('[data-move]').forEach(b=>b.onclick=()=>openAssign(b))}
function openAssign(b){current={id:Number(b.dataset.move),direction:b.dataset.direction||'out',amount:Number(b.dataset.amount),currency:b.dataset.currency||'EUR',title:b.dataset.title||'Buchung',suggestedSource:b.dataset.suggestedSource||'',suggestedId:b.dataset.suggestedId||''};document.getElementById('modalTitle').textContent=current.title;document.getElementById('modalMeta').textContent=`${money(current.amount,current.currency)} vollständig zuordnen`;document.getElementById('category').innerHTML=current.direction==='in'?'<option value="other_income">Sonstige Einnahme</option><option value="alex_contribution">Einlage Alex</option><option value="revolut_internal">Umbuchung Revolut ↔ Bank</option>':'<option value="bank_fee">Spesen / Bankgebühr</option><option value="alex_withdrawal">Privat</option><option value="other_expense">Sonstiger Aufwand</option><option value="revolut_internal">Umbuchung Revolut ↔ Bank</option><option value="tax">Steuer / Abgabe</option><option value="cash">Kassa / Bar</option>';search.value='';msg.textContent=current.suggestedId?'Passende Rechnung wurde vorgeschlagen und ist unten auswählbar.':'';renderCandidates();if(current.suggestedId){const hit=candidatesEl.querySelector(`[data-source="${CSS.escape(current.suggestedSource)}"][data-id="${CSS.escape(current.suggestedId)}"]`);hit?.scrollIntoView({block:'center'})}dlg.showModal()}
async function post(category,targetSource='',targetId='',note=''){if(!current)return;msg.textContent='Wird zugeordnet …';const r=await fetch('/incoming/reconciliation/allocate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({movementId:current.id,allocations:[{category,amount:current.amount,targetSource,targetId,note}]})}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Zuordnung fehlgeschlagen');dlg.close();current=null;await load()}
async function sync(){const button=document.getElementById('sync'),status=document.getElementById('syncMsg'),controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),35000);button.disabled=true;status.textContent=(personal?'Revolut':'Revolut Business')+' wird abgerufen …';try{const r=await fetch(personal?'/incoming/revolut-personal/status':'/incoming/revolut/sync',personal?{cache:'no-store',signal:controller.signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:controller.signal}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Live-Abruf fehlgeschlagen');status.textContent=`Live aktualisiert · ${d.added||0} neue Buchung(en)`;if(personal){const balance=(d.balances||[]).find(x=>x.type==='CLAV')||(d.balances||[])[0];document.getElementById('accountBalance').textContent=balance?`Kontostand: ${money(balance.amount,balance.currency)} · Stand ${date(balance.date||d.updatedAt)}`:d.connected?'Kontostand derzeit nicht verfügbar':'Bankfreigabe fehlt';}else{const br=await fetch('/revolut/balances',{cache:'no-store'}),b=await br.json();if(br.ok&&b.ok)document.getElementById('accountBalance').textContent='Kontostand: '+Object.entries(b.totals||{}).map(([currency,amount])=>money(amount,currency)).join(' · ');}}catch(e){if(e.name==='AbortError')throw Error('Live-Abruf dauert zu lange. Gespeicherte Buchungen bleiben sichtbar.');throw e}finally{clearTimeout(timeout);button.disabled=false}}
function assignInvoice(source,id,name){if(!confirm(`${name}\n\nDiese Rechnung mit der Revolut-Buchung bezahlen und zuordnen?`))return;post('supplier_payment',source,id,'Revolut manuell zugeordnet').catch(e=>msg.textContent=e.message)}document.getElementById('bookNoReceipt').onclick=()=>{const cat=document.getElementById('category').value,note=document.getElementById('note').value.trim();if(!confirm('Diese Zahlung ohne Rechnung vollständig buchen?'))return;post(cat,'','',note||'Revolut: Zahlung ohne Beleg').catch(e=>msg.textContent=e.message)};search.oninput=renderCandidates;document.getElementById('close').onclick=()=>dlg.close();document.getElementById('sync').onclick=()=>sync().then(load).catch(e=>{document.getElementById('syncMsg').textContent=e.message});load().catch(e=>{rows.innerHTML=`<div class="empty">${esc(e.message)}</div>`});if(!personal){fetch('/revolut/balances',{cache:'no-store'}).then(r=>r.json()).then(b=>{if(b.ok)document.getElementById('accountBalance').textContent='Kontostand: '+Object.entries(b.totals||{}).map(([currency,amount])=>money(amount,currency)).join(' · ')}).catch(()=>{document.getElementById('accountBalance').textContent='Kontostand derzeit nicht verfügbar'});}sync().then(load).catch(e=>{document.getElementById('syncMsg').textContent=e.message;if(personal)document.getElementById('accountBalance').textContent='Kontostand derzeit nicht verfügbar'});
})();
</script></body></html>'''
        response = Response(html, mimetype="text/html")
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        return response

    ns["revolut_assignment_page"] = revolut_business_page

    # Die Route wurde vom Finance-Kern bereits registriert. Wir ersetzen nur ihre
    # Ansicht, damit alle bestehenden Links stabil bleiben.
    if "brain_incoming_revolut_page" in app.view_functions:
        app.view_functions["brain_incoming_revolut_page"] = revolut_business_page

    print("✅ Revolut Business: Beleg-Zuordnung + Zahlungen ohne Beleg auf Rest 0,00")
