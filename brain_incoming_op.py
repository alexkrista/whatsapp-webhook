# coding: utf-8
"""The Brain · OP-Liste für die Eingangsrechnungskontrolle."""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    app = ns.get("app")
    if not page or app is None:
        return

    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.add("/incoming/open-items")

    if "brain_incoming_open_items" not in app.view_functions:
        from flask import request, jsonify

        @app.get("/incoming/open-items")
        def brain_incoming_open_items():
            area = str(request.args.get("area") or "live").strip().lower()
            db_path = ns.get("CAPTURE_TEST_DB") if area == "test" else ns.get("CAPTURE_DB")
            connection_factory = ns.get("_capture_connection")
            if not connection_factory:
                return jsonify({"ok": False, "error": "Eingangsrechnungs-Datenbank nicht verfügbar."}), 503
            con = connection_factory(db_path)
            try:
                rows = con.execute("""
                    SELECT id, doc_id, supplier_name, supplier_invoice_number,
                           invoice_date,
                           COALESCE(NULLIF(net_due_date,''), NULLIF(due_date,''), invoice_date) AS due_date_effective,
                           gross_amount, currency, payment_state, workflow_status, pdf_path
                    FROM incoming_invoices
                    WHERE LOWER(COALESCE(payment_state,'open')) NOT IN ('paid','bezahlt','closed','geschlossen')
                    ORDER BY COALESCE(NULLIF(net_due_date,''), NULLIF(due_date,''), invoice_date) ASC,
                             supplier_name COLLATE NOCASE ASC,
                             gross_amount ASC
                """).fetchall()
                items = []
                total = 0.0
                for row in rows:
                    amount = float(row["gross_amount"] or 0)
                    total += amount
                    items.append({
                        "id": int(row["id"]),
                        "docId": str(row["doc_id"] or ""),
                        "supplier": str(row["supplier_name"] or ""),
                        "invoiceNumber": str(row["supplier_invoice_number"] or ""),
                        "invoiceDate": str(row["invoice_date"] or ""),
                        "dueDate": str(row["due_date_effective"] or ""),
                        "amount": amount,
                        "currency": str(row["currency"] or "EUR"),
                        "paymentState": str(row["payment_state"] or "open"),
                        "workflowStatus": str(row["workflow_status"] or ""),
                        "path": str(row["pdf_path"] or ""),
                    })
                return jsonify({
                    "ok": True,
                    "area": "test" if area == "test" else "live",
                    "count": len(items),
                    "total": round(total, 2),
                    "items": items,
                })
            finally:
                con.close()

    if "kristaIncomingOpenItemsV1" in page:
        ns["MOBILE_PAGE"] = page
        return

    panel = r'''
    <section id="incomingOpenItemsPanel" class="incoming-op-panel">
      <div class="incoming-op-head">
        <div><strong>OP-Liste</strong><div class="sub" id="incomingOpMeta">Offene Eingangsrechnungen</div></div>
        <div class="incoming-op-switch" role="group" aria-label="OP-Liste sortieren">
          <button type="button" class="active" data-op-view="due">Fälligkeit</button>
          <button type="button" data-op-view="supplier">Lieferant</button>
          <button type="button" data-op-view="amount">Betrag ↑</button>
        </div>
      </div>
      <div id="incomingOpList" class="incoming-op-list"><div class="empty">OP-Liste wird geladen …</div></div>
    </section>
'''

    css = r'''
.incoming-op-panel{margin:12px 0 18px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card)}
.incoming-op-head{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.incoming-op-head strong{font-size:17px}.incoming-op-switch{display:flex;gap:6px;flex-wrap:wrap}
.incoming-op-switch button{padding:8px 11px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit;font-weight:750;cursor:pointer}
.incoming-op-switch button.active{background:#2f7f4f;color:#fff;border-color:#2f7f4f}
.incoming-op-summary{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:8px 10px;margin-bottom:8px;border-radius:10px;background:rgba(127,127,127,.08)}
.incoming-op-row{display:grid;grid-template-columns:105px minmax(180px,1.3fr) minmax(130px,.9fr) 105px 110px 84px;gap:10px;align-items:center;padding:9px 10px;border-top:1px solid var(--line);font-size:13px}
.incoming-op-row:first-child{border-top:0}.incoming-op-row .amount{text-align:right;font-weight:850}.incoming-op-row .due{font-weight:750}.incoming-op-row .action{justify-self:end}
.incoming-op-group{margin-top:12px}.incoming-op-group-title{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:9px;background:rgba(127,127,127,.12);font-weight:850}
@media(max-width:900px){.incoming-op-row{grid-template-columns:1fr 1fr}.incoming-op-row .action{justify-self:start}}
'''

    script = r'''
<script id="kristaIncomingOpenItemsV1">
(function(){
  const panel=document.getElementById('incomingOpenItemsPanel'),list=document.getElementById('incomingOpList'),meta=document.getElementById('incomingOpMeta');
  if(!panel||!list)return;
  let rows=[],view='due';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=(n,c='EUR')=>{try{return new Intl.NumberFormat('de-AT',{style:'currency',currency:c||'EUR'}).format(Number(n||0))}catch(_){return Number(n||0).toFixed(2)+' '+(c||'EUR')}};
  const date=s=>{if(!s)return '–';const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'.'+m[2]+'.'+m[1]:String(s)};
  const pdfLink=r=>r.path?`<a class="action" href="/pdf?path=${encodeURIComponent(r.path)}" target="_blank" rel="noopener">PDF</a>`:'';
  function rowHtml(r){return `<div class="incoming-op-row"><div class="due">${esc(date(r.dueDate))}</div><div><strong>${esc(r.supplier)}</strong><div class="sub">${esc(r.docId)}</div></div><div>${esc(r.invoiceNumber||'–')}</div><div>${esc(date(r.invoiceDate))}</div><div class="amount">${esc(money(r.amount,r.currency))}</div><div>${pdfLink(r)}</div></div>`}
  function render(){
    panel.querySelectorAll('[data-op-view]').forEach(b=>b.classList.toggle('active',b.dataset.opView===view));
    if(!rows.length){list.innerHTML='<div class="empty">Keine offenen Eingangsrechnungen.</div>';return}
    if(view==='supplier'){
      const groups=new Map();
      [...rows].sort((a,b)=>String(a.supplier).localeCompare(String(b.supplier),'de',{sensitivity:'base'})||String(a.dueDate).localeCompare(String(b.dueDate))).forEach(r=>{const k=r.supplier||'Ohne Lieferant';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r)});
      list.innerHTML=[...groups.entries()].map(([name,items])=>{const sum=items.reduce((s,r)=>s+Number(r.amount||0),0);return `<div class="incoming-op-group"><div class="incoming-op-group-title"><span>${esc(name)} · ${items.length}</span><span>${esc(money(sum,items[0]?.currency||'EUR'))}</span></div>${items.map(rowHtml).join('')}</div>`}).join('');
      return;
    }
    const sorted=[...rows].sort(view==='amount'?(a,b)=>Number(a.amount||0)-Number(b.amount||0)||String(a.dueDate).localeCompare(String(b.dueDate)):(a,b)=>String(a.dueDate).localeCompare(String(b.dueDate))||String(a.supplier).localeCompare(String(b.supplier),'de',{sensitivity:'base'}));
    list.innerHTML=sorted.map(rowHtml).join('');
  }
  async function load(){
    const area=document.getElementById('captureAreaTest')?.classList.contains('active')?'test':'live';
    list.innerHTML='<div class="empty">OP-Liste wird geladen …</div>';
    try{const r=await fetch('/incoming/open-items?area='+encodeURIComponent(area),{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'OP-Liste konnte nicht geladen werden');rows=Array.isArray(d.items)?d.items:[];meta.textContent=`${d.count||0} offen · ${money(d.total||0)} · ${d.area==='test'?'Testgelände':'Echtbetrieb'}`;render()}catch(e){list.innerHTML=`<div class="empty">${esc(e.message)}</div>`}
  }
  panel.querySelectorAll('[data-op-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.opView||'due';render()}));
  document.getElementById('captureAreaTest')?.addEventListener('click',()=>setTimeout(load,80));
  document.getElementById('captureAreaLive')?.addEventListener('click',()=>setTimeout(load,80));
  document.addEventListener('click',e=>{if(e.target?.closest?.('#captureSave'))setTimeout(load,500)});
  load();
})();
</script>
'''

    marker = '<div class="capture-dashboard" id="captureDashboard"></div>'
    if marker in page:
        page = page.replace(marker, marker + "\n" + panel, 1)
    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Brain OP-Liste aktiv: Fälligkeit · Lieferant · Betrag ↑")
