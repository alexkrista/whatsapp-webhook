# coding: utf-8
"""KRISTINE Finance · eigenes Kassa-Modul.

Kassa ist ein eigener Belegkanal wie Revolut. Ein als Kassa/Kassabeleg erfasster
Beleg wird hier abschliessend genau einer von zwei Zahlungsarten zugeordnet:
- bar bezahlt -> Zahlungsstatus bezahlt, kein OP / keine SEPA-Zahlung
- Ueberweisung -> in den normalen Bezahl-OP / SEPA-Workflow verschieben

TEST und Echtbetrieb bleiben getrennt. Im TEST wird niemals eine echte Zahlung
ausgeloest; dort wird nur die gewaehlte Zahlungsart gespeichert.
"""
from __future__ import annotations

from datetime import datetime

from brain_finance_source_v2 import FinanceStore
from brain_finance_source import norm_method, norm_status


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if app is None or not page or not callable(area_connection) or not callable(capture_area):
        return

    store = FinanceStore(ns)
    paths = ("/incoming/kassa", "/incoming/kassa/items", "/incoming/kassa/settle")
    if isinstance(allowed, set):
        for path in paths:
            allowed.add(path)

    def ensure_test_schema(con):
        existing = {str(row[1]) for row in con.execute("PRAGMA table_info(incoming_invoices)").fetchall()}
        if "payment_method" not in existing:
            con.execute("ALTER TABLE incoming_invoices ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'unknown'")
        con.commit()

    def test_items():
        con = area_connection("test")
        try:
            ensure_test_schema(con)
            rows = con.execute("""
                SELECT id,doc_id,supplier_name,supplier_invoice_number,invoice_date,
                       COALESCE(NULLIF(net_due_date,''),NULLIF(due_date,''),invoice_date) AS due_date_effective,
                       gross_amount,currency,payment_state,payment_status,pdf_path,payment_method
                FROM incoming_invoices
                WHERE LOWER(COALESCE(payment_method,'unknown'))='cash'
                  AND LOWER(COALESCE(payment_state,'open')) NOT IN ('paid','bezahlt','closed','geschlossen')
                ORDER BY due_date_effective,supplier_name COLLATE NOCASE,id
            """).fetchall()
            return [
                {
                    "id": f"kristine:{int(row['id'])}",
                    "source": "KRISTINE_TEST",
                    "docId": str(row["doc_id"] or ""),
                    "supplier": str(row["supplier_name"] or ""),
                    "invoiceNumber": str(row["supplier_invoice_number"] or ""),
                    "invoiceDate": str(row["invoice_date"] or ""),
                    "dueDate": str(row["due_date_effective"] or ""),
                    "amount": float(row["gross_amount"] or 0),
                    "currency": str(row["currency"] or "EUR"),
                    "paymentMethod": "cash",
                    "paymentStatus": norm_status(row["payment_state"]),
                    "path": str(row["pdf_path"] or ""),
                }
                for row in rows
            ]
        finally:
            con.close()

    def live_items():
        # Bewusst nur offene Belege laden. store.items(True) wuerde den gesamten
        # historischen WinWorker-Bestand samt PDF-Lookup laden und ist fuer diese
        # operative Kassa-Liste weder notwendig noch sinnvoll.
        return [
            dict(item)
            for item in store.items(False)
            if norm_method(item.get("paymentMethod")) == "cash"
            and norm_status(item.get("paymentStatus")) != "paid"
        ]

    if "brain_incoming_kassa_items" not in app.view_functions:
        from flask import request, jsonify, Response

        @app.get("/incoming/kassa/items")
        def brain_incoming_kassa_items():
            try:
                area = capture_area(request.args.get("area") or "live")
                items = test_items() if area == "test" else live_items()
                total = round(sum(float(x.get("amount") or 0) for x in items), 2)
                return jsonify(
                    ok=True,
                    area=area,
                    trainingMode=(area == "test"),
                    count=len(items),
                    openCount=len(items),
                    openTotal=total,
                    items=items,
                )
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

        @app.post("/incoming/kassa/settle")
        def brain_incoming_kassa_settle():
            try:
                body = request.get_json(silent=True) or {}
                area = capture_area(body.get("area") or "live")
                source = str(body.get("source") or "").strip()
                source_id = str(body.get("id") or "").strip()
                mode = str(body.get("mode") or "").strip().lower()
                if mode not in {"cash", "transfer"}:
                    raise ValueError("Bitte Bar oder Ueberweisung waehlen.")
                if not source_id:
                    raise ValueError("Kassabeleg fehlt.")

                if area == "test":
                    if not source_id.startswith("kristine:"):
                        raise ValueError("Im TEST koennen nur TEST-Belege geaendert werden.")
                    invoice_id = int(source_id.split(":", 1)[1])
                    con = area_connection("test")
                    try:
                        ensure_test_schema(con)
                        found = con.execute("SELECT id FROM incoming_invoices WHERE id=?", (invoice_id,)).fetchone()
                        if not found:
                            raise ValueError("TEST-Kassabeleg nicht gefunden.")
                        if mode == "cash":
                            con.execute(
                                "UPDATE incoming_invoices SET payment_method='cash', payment_state='paid', payment_status='Bezahlt', updated_at=? WHERE id=?",
                                (datetime.now().isoformat(timespec="seconds"), invoice_id),
                            )
                            message = "TEST · bar bezahlt markiert."
                        else:
                            con.execute(
                                "UPDATE incoming_invoices SET payment_method='transfer', payment_state='open', payment_status='Offen', updated_at=? WHERE id=?",
                                (datetime.now().isoformat(timespec="seconds"), invoice_id),
                            )
                            message = "TEST · als Ueberweisung markiert. Keine echte SEPA-Datei wird erzeugt."
                        con.commit()
                    finally:
                        con.close()
                    return jsonify(ok=True, area="test", mode=mode, message=message, sepaUrl="/incoming/payments")

                if source not in {"WinWorker", "KRISTINE"}:
                    raise ValueError("Ungueltiger Echtbeleg.")
                if mode == "cash":
                    saved = store.set_meta(source, source_id, method="cash", status="paid", note="Kassa · bar bezahlt")
                    message = "Bar bezahlt · kein OP und keine SEPA-Zahlung."
                else:
                    saved = store.set_meta(source, source_id, method="transfer", status="open", note="Kassa → Ueberweisung / SEPA")
                    message = "Zur Ueberweisung verschoben · erscheint jetzt im Bezahl-OP / SEPA."
                return jsonify(ok=True, area="live", mode=mode, message=message, sepaUrl="/incoming/payments", **saved)
            except ValueError as exc:
                return jsonify(ok=False, error=str(exc)), 400
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

        @app.get("/incoming/kassa")
        def brain_incoming_kassa_page():
            area = capture_area(request.args.get("area") or "live")
            area_q = "test" if area == "test" else "live"
            test_note = "<div class=\"note\"><strong>TESTGELAENDE.</strong> Bar/Ueberweisung wird nur simuliert; keine echte SEPA-Zahlung.</div>" if area == "test" else ""
            html = f'''<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KRISTINE · Kassa</title><style>
:root{{color-scheme:dark;--bg:#101316;--card:#171b20;--line:#343c46;--text:#eef2f4;--muted:#9da8b3;--accent:#438b5c;--blue:#315d91}}*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}}.shell{{max-width:1500px;margin:auto;padding:18px}}.head,.section-title{{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}}.head h1{{margin:0}}.sub,.hint{{color:var(--muted);font-size:12px}}.back,.pdf{{color:inherit;font-weight:800}}.metrics{{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}}.metric,.card,.note{{border:1px solid var(--line);border-radius:13px;background:var(--card);padding:12px}}.metric span{{display:block;color:var(--muted);font-size:12px}}.metric strong{{font-size:20px}}.card{{margin-bottom:14px}}.note{{margin-bottom:14px}}.row{{display:grid;grid-template-columns:105px minmax(180px,1.5fr) minmax(120px,.8fr) 125px 100px minmax(240px,auto);gap:9px;align-items:center;padding:10px 6px;border-top:1px solid var(--line);font-size:13px}}.row:first-child{{border-top:0}}.amount{{font-weight:850;text-align:right}}button,a.action{{border:1px solid #485461;border-radius:9px;padding:8px 10px;color:inherit;background:#252c34;text-decoration:none;font-weight:850;cursor:pointer}}button.cash{{background:var(--accent);border-color:var(--accent)}}button.transfer{{background:var(--blue);border-color:var(--blue)}}.actions{{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}}.empty{{padding:20px;text-align:center;color:var(--muted)}}@media(max-width:900px){{.metrics{{grid-template-columns:1fr 1fr}}.row{{grid-template-columns:1fr 1fr}}.amount{{text-align:left}}.actions{{justify-content:flex-start}}}}@media(max-width:520px){{.metrics,.row{{grid-template-columns:1fr}}}}
</style></head><body><main class="shell"><div class="head"><div><h1>Kassa{' · TEST' if area == 'test' else ''}</h1><div class="sub">Kassabelege: bar bezahlt oder Ueberweisung / SEPA.</div></div><div class="actions"><a class="action" href="/incoming/payments">SEPA / OP</a><a class="back" href="/">← Erfassung</a></div></div>{test_note}<div class="metrics"><div class="metric"><span>Kassabelege offen</span><strong id="cnt">–</strong></div><div class="metric"><span>Offener Betrag</span><strong id="tot">–</strong></div><div class="metric"><span>Zahlungsart</span><strong>Bar / SEPA</strong></div></div><section class="card"><div class="section-title"><h2>Zu klaeren</h2><span class="hint">Bar = erledigt. Ueberweisung = wandert in den normalen Bezahl-OP und wird dort erst nach Freigabe SEPA-faehig.</span></div><div id="rows"><div class="empty">Wird geladen …</div></div></section></main><script>
(()=>{{const area={area_q!r},box=document.getElementById('rows'),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c])),money=(n,c='EUR')=>{{try{{return new Intl.NumberFormat('de-AT',{{style:'currency',currency:c||'EUR'}}).format(Number(n||0))}}catch(_){{return Number(n||0).toFixed(2)+' '+(c||'EUR')}}}},date=s=>{{const m=String(s||'').match(/^(\\d{{4}})-(\\d{{2}})-(\\d{{2}})/);return m?m[3]+'.'+m[2]+'.'+m[1]:(s||'–')}};async function settle(x,mode){{const text=mode==='cash'?'Als BAR BEZAHLT markieren?':'In UEBERWEISUNG / SEPA verschieben?';if(!confirm(text+'\\n\\n'+(x.supplier||'')+' · '+(x.invoiceNumber||'')+' · '+money(x.amount,x.currency)))return;const r=await fetch('/incoming/kassa/settle',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{area,source:x.source,id:x.id,mode}})}}),d=await r.json();if(!r.ok||!d.ok)return alert(d.error||'Fehler');alert(d.message||'Gespeichert');await load()}}async function load(){{const r=await fetch('/incoming/kassa/items?area='+encodeURIComponent(area),{{cache:'no-store'}}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Kassa konnte nicht geladen werden');cnt.textContent=d.openCount||0;tot.textContent=money(d.openTotal||0);const items=d.items||[];box.innerHTML=items.length?items.map((x,i)=>`<div class="row"><div>${{esc(date(x.invoiceDate||x.dueDate))}}</div><div><strong>${{esc(x.supplier||'–')}}</strong><div class="sub">${{esc(x.docId||'')}}</div></div><div>${{esc(x.invoiceNumber||'–')}}</div><div class="amount">${{esc(money(x.amount,x.currency))}}</div><div>${{x.path?`<a class="pdf" href="/pdf?path=${{encodeURIComponent(x.path)}}" target="_blank">PDF</a>`:'–'}}</div><div class="actions"><button class="cash" type="button" data-i="${{i}}" data-mode="cash">✓ Bar bezahlt</button><button class="transfer" type="button" data-i="${{i}}" data-mode="transfer">→ Ueberweisung / SEPA</button></div></div>`).join(''):'<div class="empty">Keine offenen Kassabelege.</div>';box.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>settle(items[Number(b.dataset.i)],b.dataset.mode))}}load().catch(e=>box.innerHTML='<div class="empty">'+esc(e.message||e)+'</div>')}})();
</script></body></html>'''
            return Response(html, mimetype="text/html")

    # Capture-Auswahl klarer benennen: Kassa ist der Kanal; Bar/Ueberweisung wird
    # danach im eigenen Kassa-Modul entschieden.
    page = page.replace('<option value="cash">Bar / Kassa</option>', '<option value="cash">Kassa / Kassabeleg</option>')

    panel = r'''<section id="incomingKassaPanel" class="incoming-kassa-panel"><div><strong>Kassa</strong><div class="sub" id="incomingKassaMeta">Kassabelege · Bar oder Ueberweisung</div></div><a class="action incoming-kassa-open" href="/incoming/kassa">Kassa oeffnen →</a></section>'''
    css = r'''.incoming-kassa-panel{margin:12px 0 18px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card);display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap}.incoming-kassa-panel strong{font-size:17px}.incoming-kassa-open{font-weight:850;text-decoration:none}'''
    script = r'''
<script id="kristaIncomingKassaV1">
(function(){
  function area(){try{return typeof captureArea!=='undefined'&&captureArea==='live'?'live':'test'}catch(_){return localStorage.getItem('kristineCaptureArea')==='live'?'live':'test'}}
  function money(n){return new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(n||0))}
  function refresh(){const a=area(),link=document.querySelector('.incoming-kassa-open'),meta=document.getElementById('incomingKassaMeta');if(link)link.href='/incoming/kassa?area='+encodeURIComponent(a);if(!meta)return;fetch('/incoming/kassa/items?area='+encodeURIComponent(a),{cache:'no-store'}).then(r=>r.json()).then(d=>{if(!d.ok)throw Error(d.error||'Fehler');meta.textContent=(a==='test'?'TEST · ':'')+`${d.openCount||0} offen · ${money(d.openTotal||0)} · Bar oder Ueberweisung`}).catch(e=>meta.textContent=e.message||String(e))}
  setTimeout(refresh,0);document.getElementById('captureAreaTest')?.addEventListener('click',()=>setTimeout(refresh,0));document.getElementById('captureAreaLive')?.addEventListener('click',()=>setTimeout(refresh,0));
})();
</script>
'''
    marker = '<section id="incomingRevolutPanel"'
    if 'id="incomingKassaPanel"' not in page:
        pos = page.find(marker)
        if pos >= 0:
            end = page.find('</section>', pos)
            if end >= 0:
                end += len('</section>')
                page = page[:end] + "\n" + panel + page[end:]
        else:
            dash = '<div class="capture-dashboard" id="captureDashboard"></div>'
            if dash in page:
                page = page.replace(dash, dash + "\n" + panel, 1)
    if ".incoming-kassa-panel{" not in page:
        page = page.replace("</style>", css + "\n</style>", 1)
    if "kristaIncomingKassaV1" not in page:
        page = page.replace("</body>", script + "\n</body>", 1)

    # Auch im Bezahl-OP die Bezeichnung konsistent halten, ohne die grosse UI-Datei
    # anzufassen.
    payment_page = app.view_functions.get("brain_incoming_payments_page")
    if payment_page and not getattr(payment_page, "_krista_kassa_label", False):
        def wrapped_payment_page():
            response = app.make_response(payment_page())
            try:
                html = response.get_data(as_text=True)
                html = html.replace("Bar / Kassa", "Kassa / Kassabeleg")
                html = html.replace("Einzug/Revolut/Bar verschwinden", "Einzug/Revolut/Kassa verschwinden")
                response.set_data(html)
                response.headers["Content-Type"] = "text/html; charset=utf-8"
            except Exception:
                pass
            return response
        wrapped_payment_page.__name__ = "brain_incoming_payments_page_kassa_label"
        wrapped_payment_page._krista_kassa_label = True
        app.view_functions["brain_incoming_payments_page"] = wrapped_payment_page

    ns["MOBILE_PAGE"] = page
    print("✅ Kassa aktiv: eigener Bereich · Bar bezahlt oder Ueberweisung → Bezahl-OP/SEPA")
