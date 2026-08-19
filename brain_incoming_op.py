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
        allowed.add("/incoming/open-items/override")

    def _override_connection():
        connection_factory = ns.get("_capture_connection")
        db_path = ns.get("CAPTURE_DB")
        if not callable(connection_factory):
            raise RuntimeError("KRISTINE-Datenbank nicht verfügbar.")
        con = connection_factory(db_path)
        con.execute("""
            CREATE TABLE IF NOT EXISTS brain_op_overrides (
                source TEXT NOT NULL,
                source_id TEXT NOT NULL,
                status TEXT NOT NULL,
                note TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(source, source_id)
            )
        """)
        con.commit()
        return con

    def _ww_override_map():
        con = _override_connection()
        try:
            rows = con.execute("""
                SELECT source_id, status, note, updated_at
                FROM brain_op_overrides
                WHERE source='WinWorker'
            """).fetchall()
            return {
                str(row["source_id"]): {
                    "status": str(row["status"] or ""),
                    "note": str(row["note"] or ""),
                    "updatedAt": str(row["updated_at"] or ""),
                }
                for row in rows
            }
        finally:
            con.close()

    def _set_ww_override(source_id, paid=True, note=""):
        from datetime import datetime
        source_id = str(source_id or "").strip()
        if not source_id.startswith("ww:"):
            raise ValueError("Ungültige WinWorker-OP.")
        con = _override_connection()
        try:
            if paid:
                con.execute("""
                    INSERT INTO brain_op_overrides(source, source_id, status, note, updated_at)
                    VALUES('WinWorker', ?, 'paid', ?, ?)
                    ON CONFLICT(source, source_id) DO UPDATE SET
                        status='paid', note=excluded.note, updated_at=excluded.updated_at
                """, (source_id, str(note or "").strip()[:500], datetime.now().isoformat(timespec="seconds")))
            else:
                con.execute(
                    "DELETE FROM brain_op_overrides WHERE source='WinWorker' AND source_id=?",
                    (source_id,),
                )
            con.commit()
        finally:
            con.close()

    def _ww_open_items(include_resolved=False):
        sql_connection = ns.get("sql_connection")
        payment_state = ns.get("_payment_state")
        iso_date = ns.get("_iso_date")
        pdf_lookup = ns.get("_pdf_paths_by_docids")
        if not callable(sql_connection) or not callable(payment_state):
            return []

        overrides = _ww_override_map()
        con = sql_connection("WinWorker_Projekte_Standard")
        try:
            rows = con.cursor().execute("""
                SELECT
                    e.cID,
                    e.sBelegnummer,
                    e.dzBelegdatum,
                    e.dblBruttoBetrag,
                    e.lVonAdrIndex,
                    e.sZahlungsStatus,
                    dm.sDocID,
                    k.sFirma,
                    k.sName,
                    k.sVorname
                FROM dbo.Eingangsbelege AS e
                LEFT JOIN dbo.DokumentenManagement AS dm
                    ON dm.gID = e.gDMID
                LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden AS k
                    ON k.StammIndex = e.lVonAdrIndex
                ORDER BY e.dzBelegdatum ASC, e.cID ASC
            """).fetchall()
        finally:
            con.close()

        pending = []
        doc_ids = []
        for row in rows:
            state = payment_state(row.sZahlungsStatus)
            if state != "open":
                continue
            source_id = f"ww:{int(row.cID)}"
            override = overrides.get(source_id)
            if override and override.get("status") == "paid" and not include_resolved:
                continue
            doc_id = str(row.sDocID or "").strip()
            if doc_id:
                doc_ids.append(doc_id)
            pending.append((row, doc_id, source_id, override))

        pdf_paths = {}
        if callable(pdf_lookup) and doc_ids:
            try:
                pdf_paths = pdf_lookup(doc_ids, include_text=False)
            except Exception:
                pdf_paths = {}

        result = []
        for row, doc_id, source_id, override in pending:
            company = str(row.sFirma or "").strip()
            person = " ".join(
                x for x in [str(row.sVorname or "").strip(), str(row.sName or "").strip()] if x
            )
            supplier = company or person or f"WW-Adresse {row.lVonAdrIndex or ''}".strip()
            invoice_date = iso_date(row.dzBelegdatum) if callable(iso_date) else str(row.dzBelegdatum or "")[:10]
            found = pdf_paths.get(doc_id, {}) if doc_id else {}
            path = str(found.get("pdfPath") or found.get("originalPath") or "")
            locally_paid = bool(override and override.get("status") == "paid")
            result.append({
                "id": source_id,
                "docId": doc_id,
                "supplier": supplier,
                "invoiceNumber": str(row.sBelegnummer or "").strip(),
                "invoiceDate": invoice_date or "",
                "dueDate": invoice_date or "",
                "amount": float(row.dblBruttoBetrag or 0),
                "currency": "EUR",
                "paymentState": "paid" if locally_paid else "open",
                "workflowStatus": "WinWorker",
                "path": path,
                "source": "WinWorker",
                "brainOverride": "paid" if locally_paid else "",
                "brainOverrideAt": str((override or {}).get("updatedAt") or ""),
                "brainOverrideNote": str((override or {}).get("note") or ""),
            })
        return result

    def _kristine_live_open_items():
        connection_factory = ns.get("_capture_connection")
        db_path = ns.get("CAPTURE_DB")
        if not callable(connection_factory):
            return []
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
            return [{
                "id": f"kristine:{int(row['id'])}",
                "docId": str(row["doc_id"] or ""),
                "supplier": str(row["supplier_name"] or ""),
                "invoiceNumber": str(row["supplier_invoice_number"] or ""),
                "invoiceDate": str(row["invoice_date"] or ""),
                "dueDate": str(row["due_date_effective"] or ""),
                "amount": float(row["gross_amount"] or 0),
                "currency": str(row["currency"] or "EUR"),
                "paymentState": str(row["payment_state"] or "open"),
                "workflowStatus": str(row["workflow_status"] or ""),
                "path": str(row["pdf_path"] or ""),
                "source": "KRISTINE",
                "brainOverride": "",
            } for row in rows]
        finally:
            con.close()

    if "brain_incoming_open_items" not in app.view_functions:
        from flask import request, jsonify

        @app.get("/incoming/open-items")
        def brain_incoming_open_items():
            try:
                include_resolved = str(request.args.get("includeResolved") or "").strip().lower() in {"1", "true", "yes", "ja"}
                ww_items = _ww_open_items(include_resolved=include_resolved)
                local_items = _kristine_live_open_items()

                # Ein Beleg darf nie doppelt in der OP-Liste stehen. Sobald eine
                # gleiche Dokument-ID in KRISTINE existiert, gewinnt KRISTINE.
                local_doc_ids = {
                    str(item.get("docId") or "").strip()
                    for item in local_items
                    if str(item.get("docId") or "").strip()
                }
                items = [
                    item for item in ww_items
                    if str(item.get("docId") or "").strip() not in local_doc_ids
                ] + local_items

                items.sort(key=lambda item: (
                    str(item.get("dueDate") or item.get("invoiceDate") or ""),
                    str(item.get("supplier") or "").lower(),
                    float(item.get("amount") or 0),
                ))
                open_items = [item for item in items if item.get("brainOverride") != "paid"]
                resolved_items = [item for item in items if item.get("brainOverride") == "paid"]
                total = round(sum(float(item.get("amount") or 0) for item in open_items), 2)
                return jsonify({
                    "ok": True,
                    "area": "live",
                    "source": "WinWorker + KRISTINE",
                    "count": len(open_items),
                    "resolvedCount": len(resolved_items),
                    "total": total,
                    "items": items,
                })
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

        @app.post("/incoming/open-items/override")
        def brain_incoming_open_items_override():
            try:
                body = request.get_json(silent=True) or {}
                source = str(body.get("source") or "").strip()
                source_id = str(body.get("id") or "").strip()
                paid = bool(body.get("paid", True))
                note = str(body.get("note") or "").strip()
                if source != "WinWorker":
                    raise ValueError("Lokale OP-Korrekturen sind nur für WinWorker-Altdaten vorgesehen.")
                _set_ww_override(source_id, paid=paid, note=note)
                return jsonify({"ok": True, "id": source_id, "paid": paid})
            except ValueError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

    # Vorherige OP-Injektionen entfernen, damit garantiert nur V3 sichtbar ist.
    import re
    page = re.sub(r'<section id="incomingOpenItemsPanel".*?</section>', '', page, flags=re.S)
    page = re.sub(r'<script id="kristaIncomingOpenItemsV[12]">.*?</script>', '', page, flags=re.S)

    panel = r'''
    <section id="incomingOpenItemsPanel" class="incoming-op-panel">
      <div class="incoming-op-head">
        <div><strong>OP-Liste</strong><div class="sub" id="incomingOpMeta">Offene Eingangsrechnungen · WinWorker + KRISTINE</div></div>
        <div class="incoming-op-head-actions">
          <div class="incoming-op-switch" role="group" aria-label="OP-Liste sortieren">
            <button type="button" class="active" data-op-view="due">Fälligkeit</button>
            <button type="button" data-op-view="supplier">Lieferant</button>
            <button type="button" data-op-view="amount">Betrag ↑</button>
          </div>
          <button id="incomingOpResolvedToggle" class="incoming-op-resolved-toggle" type="button">Erledigte</button>
        </div>
      </div>
      <div id="incomingOpList" class="incoming-op-list"><div class="empty">OP-Liste wird geladen …</div></div>
    </section>
'''

    css = r'''
.incoming-op-panel{margin:12px 0 18px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card)}
.incoming-op-head{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.incoming-op-head strong{font-size:17px}.incoming-op-head-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.incoming-op-switch{display:flex;gap:6px;flex-wrap:wrap}
.incoming-op-switch button,.incoming-op-resolved-toggle{padding:8px 11px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit;font-weight:750;cursor:pointer;height:auto}
.incoming-op-switch button.active{background:#2f7f4f;color:#fff;border-color:#2f7f4f}.incoming-op-resolved-toggle.active{background:#38404b;color:#fff;border-color:#626d7c}
.incoming-op-row{display:grid;grid-template-columns:105px minmax(180px,1.3fr) minmax(130px,.9fr) 105px 110px minmax(150px,auto);gap:10px;align-items:center;padding:9px 10px;border-top:1px solid var(--line);font-size:13px}
.incoming-op-row:first-child{border-top:0}.incoming-op-row .amount{text-align:right;font-weight:850}.incoming-op-row .due{font-weight:750}.incoming-op-actions{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap}.incoming-op-actions .action{padding:7px 9px}.incoming-op-done{background:#213c2c!important;color:#bce8c9!important;border:1px solid #3f7652!important;padding:7px 9px!important;height:auto}.incoming-op-restore{background:#2c323b!important;color:#fff!important;border:1px solid #56606e!important;padding:7px 9px!important;height:auto}.incoming-op-local-note{color:var(--good);font-size:11px;font-weight:800;margin-top:3px}
.incoming-op-group{margin-top:12px}.incoming-op-group-title{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:9px;background:rgba(127,127,127,.12);font-weight:850}
@media(max-width:900px){.incoming-op-row{grid-template-columns:1fr 1fr}.incoming-op-actions{justify-content:flex-start}}
'''

    script = r'''
<script id="kristaIncomingOpenItemsV3">
(function(){
  const panel=document.getElementById('incomingOpenItemsPanel'),list=document.getElementById('incomingOpList'),meta=document.getElementById('incomingOpMeta'),resolvedToggle=document.getElementById('incomingOpResolvedToggle');
  if(!panel||!list)return;
  let rows=[],view='due',showResolved=false,lastMeta={count:0,total:0,resolvedCount:0};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=(n,c='EUR')=>{try{return new Intl.NumberFormat('de-AT',{style:'currency',currency:c||'EUR'}).format(Number(n||0))}catch(_){return Number(n||0).toFixed(2)+' '+(c||'EUR')}};
  const date=s=>{if(!s)return '–';const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'.'+m[2]+'.'+m[1]:String(s)};
  const pdfLink=r=>r.path?`<a class="action" href="/pdf?path=${encodeURIComponent(r.path)}" target="_blank" rel="noopener">PDF</a>`:'';
  function actions(r){
    const pdf=pdfLink(r);
    if(r.source!=='WinWorker')return pdf;
    if(r.brainOverride==='paid')return `${pdf}<button class="incoming-op-restore" type="button" data-op-restore="${esc(r.id)}">↶ wieder offen</button>`;
    return `${pdf}<button class="incoming-op-done" type="button" data-op-paid="${esc(r.id)}">✓ bezahlt</button>`;
  }
  function rowHtml(r){return `<div class="incoming-op-row"><div class="due">${esc(date(r.dueDate))}</div><div><strong>${esc(r.supplier)}</strong><div class="sub">${esc(r.source||'')} ${r.docId?'· '+esc(r.docId):''}</div>${r.brainOverride==='paid'?'<div class="incoming-op-local-note">in The Brain als bezahlt markiert</div>':''}</div><div>${esc(r.invoiceNumber||'–')}</div><div>${esc(date(r.invoiceDate))}</div><div class="amount">${esc(money(r.amount,r.currency))}</div><div class="incoming-op-actions">${actions(r)}</div></div>`}
  function bindRowActions(){
    list.querySelectorAll('[data-op-paid]').forEach(btn=>btn.addEventListener('click',()=>setPaid(btn.dataset.opPaid,true)));
    list.querySelectorAll('[data-op-restore]').forEach(btn=>btn.addEventListener('click',()=>setPaid(btn.dataset.opRestore,false)));
  }
  function visibleRows(){return rows.filter(r=>showResolved?r.brainOverride==='paid':r.brainOverride!=='paid')}
  function render(){
    panel.querySelectorAll('[data-op-view]').forEach(b=>b.classList.toggle('active',b.dataset.opView===view));
    resolvedToggle?.classList.toggle('active',showResolved);
    const source=visibleRows();
    if(!source.length){list.innerHTML=`<div class="empty">${showResolved?'Keine lokal erledigten WinWorker-OPs.':'Keine offenen Eingangsrechnungen.'}</div>`;return}
    if(view==='supplier'){
      const groups=new Map();
      [...source].sort((a,b)=>String(a.supplier).localeCompare(String(b.supplier),'de',{sensitivity:'base'})||String(a.dueDate).localeCompare(String(b.dueDate))).forEach(r=>{const k=r.supplier||'Ohne Lieferant';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r)});
      list.innerHTML=[...groups.entries()].map(([name,items])=>{const sum=items.reduce((s,r)=>s+Number(r.amount||0),0);return `<div class="incoming-op-group"><div class="incoming-op-group-title"><span>${esc(name)} · ${items.length}</span><span>${esc(money(sum,items[0]?.currency||'EUR'))}</span></div>${items.map(rowHtml).join('')}</div>`}).join('');
      bindRowActions();return;
    }
    const sorted=[...source].sort(view==='amount'?(a,b)=>Number(a.amount||0)-Number(b.amount||0)||String(a.dueDate).localeCompare(String(b.dueDate)):(a,b)=>String(a.dueDate).localeCompare(String(b.dueDate))||String(a.supplier).localeCompare(String(b.supplier),'de',{sensitivity:'base'}));
    list.innerHTML=sorted.map(rowHtml).join('');bindRowActions();
  }
  async function setPaid(id,paid){
    if(paid&&!confirm('Diese WinWorker-Rechnung in The Brain als bezahlt markieren?\n\nWinWorker selbst bleibt unverändert.'))return;
    try{const r=await fetch('/incoming/open-items/override',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'WinWorker',id,paid})}),d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Korrektur konnte nicht gespeichert werden');await load()}catch(e){alert(e.message)}
  }
  async function load(){
    list.innerHTML='<div class="empty">OP-Liste wird geladen …</div>';
    try{const r=await fetch('/incoming/open-items?includeResolved=1',{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'OP-Liste konnte nicht geladen werden');rows=Array.isArray(d.items)?d.items:[];lastMeta={count:Number(d.count||0),total:Number(d.total||0),resolvedCount:Number(d.resolvedCount||0)};meta.textContent=`${lastMeta.count} offen · ${money(lastMeta.total)} · ${lastMeta.resolvedCount} lokal erledigt · WinWorker + KRISTINE`;render()}catch(e){list.innerHTML=`<div class="empty">${esc(e.message)}</div>`}
  }
  panel.querySelectorAll('[data-op-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.opView||'due';render()}));
  resolvedToggle?.addEventListener('click',()=>{showResolved=!showResolved;render()});
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
    print("✅ Brain OP-Liste V3 aktiv: WW+KRISTINE · lokale bezahlt-Korrekturen")
