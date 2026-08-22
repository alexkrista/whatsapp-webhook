# coding: utf-8
"""KRISTINE · lokale Lieferantenstammdaten fuer neue Eingangsrechnungs-Lieferanten.

WinWorker bleibt read-only. Neue Lieferanten werden deshalb in der jeweiligen
KRISTINE-Eingangsrechnungs-Datenbank angelegt. Test und Echtbetrieb bleiben durch
CAPTURE_TEST_DB / CAPTURE_DB automatisch getrennt.
"""
from __future__ import annotations

import re
from datetime import datetime


def _norm(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _iban(value):
    return re.sub(r"\s+", "", str(value or "")).upper().strip()


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    if app is None or not page or not callable(area_connection) or not callable(capture_area):
        return

    def ensure_schema(con):
        con.executescript("""
            CREATE TABLE IF NOT EXISTS incoming_suppliers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                address TEXT,
                vat_id TEXT,
                email TEXT,
                phone TEXT,
                our_customer_number TEXT,
                iban TEXT,
                swift TEXT,
                account_holder TEXT,
                supplier_number TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_incoming_suppliers_name
                ON incoming_suppliers(name COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_incoming_suppliers_vat
                ON incoming_suppliers(vat_id);
        """)
        con.commit()

    def public_supplier(row):
        data = dict(row)
        sid = int(data.get("id") or 0)
        return {
            "addressId": f"kri:{sid}",
            "name": str(data.get("name") or ""),
            "address": str(data.get("address") or ""),
            "supplierNumber": str(data.get("supplier_number") or f"KRI-{sid:05d}"),
            "customerNumber": "",
            "ourCustomerNumber": str(data.get("our_customer_number") or ""),
            "vatId": str(data.get("vat_id") or ""),
            "email": str(data.get("email") or ""),
            "phone": str(data.get("phone") or ""),
            "iban": str(data.get("iban") or ""),
            "swift": str(data.get("swift") or ""),
            "accountHolder": str(data.get("account_holder") or ""),
            "source": "KRISTINE",
        }

    def local_search(query, area="live", limit=25):
        wanted = _norm(query)
        if not wanted:
            return []
        con = area_connection(area)
        try:
            ensure_schema(con)
            rows = con.execute("SELECT * FROM incoming_suppliers ORDER BY name COLLATE NOCASE, id").fetchall()
            scored = []
            for row in rows:
                item = public_supplier(row)
                hay = _norm(" ".join([
                    item.get("name") or "", item.get("address") or "", item.get("vatId") or "",
                    item.get("ourCustomerNumber") or "", item.get("email") or "", item.get("phone") or "",
                    item.get("iban") or "",
                ]))
                if wanted not in hay:
                    continue
                name = _norm(item.get("name"))
                score = 100 if name == wanted else (80 if name.startswith(wanted) else 60)
                scored.append((score, item))
            scored.sort(key=lambda x: (-x[0], _norm(x[1].get("name"))))
            return [item for _, item in scored[: max(1, int(limit or 25))]]
        finally:
            con.close()

    # Die bestehende WinWorker-Suche bleibt Master fuer vorhandene Adressen.
    # Im Eingangsrechnungsbereich werden lokale KRISTINE-Lieferanten davor gemischt.
    original_search = ns.get("ww_address_search")
    if callable(original_search) and not getattr(original_search, "_krista_local_suppliers", False):
        from flask import request

        def combined_address_search(query, limit=25):
            ww = list(original_search(query, limit) or [])
            try:
                if not str(request.path or "").startswith("/incoming/capture/"):
                    return ww
                raw_area = request.args.get("area") or request.form.get("area") or "live"
                local = local_search(query, capture_area(raw_area), limit)
                return (local + ww)[: max(1, int(limit or 25))]
            except Exception:
                return ww

        combined_address_search._krista_local_suppliers = True
        ns["ww_address_search"] = combined_address_search

    # Der vorhandene Lieferanten-Kontext darf fuer lokale IDs nicht in WinWorker suchen.
    original_ww_incoming = ns.get("ww_incoming_for_address")
    if callable(original_ww_incoming) and not getattr(original_ww_incoming, "_krista_local_suppliers", False):
        def safe_ww_incoming_for_address(address_id):
            if str(address_id or "").startswith("kri:"):
                return []
            return original_ww_incoming(address_id)

        safe_ww_incoming_for_address._krista_local_suppliers = True
        ns["ww_incoming_for_address"] = safe_ww_incoming_for_address

    if "brain_local_supplier_create" not in app.view_functions:
        from flask import request, jsonify

        @app.post("/incoming/capture/supplier-create")
        def brain_local_supplier_create():
            try:
                body = request.get_json(silent=True) or {}
                area = capture_area(body.get("area") or "live")
                name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()
                if len(name) < 2:
                    raise ValueError("Firmenname fehlt.")
                address = re.sub(r"\s+", " ", str(body.get("address") or "")).strip()
                vat_id = re.sub(r"\s+", "", str(body.get("vatId") or "")).upper().strip()
                email = str(body.get("email") or "").strip()
                phone = re.sub(r"\s+", " ", str(body.get("phone") or "")).strip()
                customer = str(body.get("ourCustomerNumber") or "").strip()
                iban = _iban(body.get("iban"))
                swift = re.sub(r"\s+", "", str(body.get("swift") or "")).upper().strip()
                holder = re.sub(r"\s+", " ", str(body.get("accountHolder") or "")).strip()
                now = datetime.now().isoformat(timespec="seconds")

                con = area_connection(area)
                try:
                    ensure_schema(con)
                    found = None
                    if vat_id:
                        found = con.execute(
                            "SELECT * FROM incoming_suppliers WHERE UPPER(COALESCE(vat_id,''))=? ORDER BY id LIMIT 1",
                            (vat_id,),
                        ).fetchone()
                    if not found:
                        for row in con.execute("SELECT * FROM incoming_suppliers ORDER BY id").fetchall():
                            if _norm(row["name"]) == _norm(name) and _norm(row["address"]) == _norm(address):
                                found = row
                                break

                    if found:
                        # Bestehende Stammdaten nie blind ueberschreiben. Nur leere Felder ergaenzen.
                        con.execute("""
                            UPDATE incoming_suppliers SET
                                address=CASE WHEN COALESCE(address,'')='' THEN ? ELSE address END,
                                vat_id=CASE WHEN COALESCE(vat_id,'')='' THEN ? ELSE vat_id END,
                                email=CASE WHEN COALESCE(email,'')='' THEN ? ELSE email END,
                                phone=CASE WHEN COALESCE(phone,'')='' THEN ? ELSE phone END,
                                our_customer_number=CASE WHEN COALESCE(our_customer_number,'')='' THEN ? ELSE our_customer_number END,
                                iban=CASE WHEN COALESCE(iban,'')='' THEN ? ELSE iban END,
                                swift=CASE WHEN COALESCE(swift,'')='' THEN ? ELSE swift END,
                                account_holder=CASE WHEN COALESCE(account_holder,'')='' THEN ? ELSE account_holder END,
                                updated_at=?
                            WHERE id=?
                        """, (address, vat_id, email, phone, customer, iban, swift, holder, now, int(found["id"])))
                        supplier_id = int(found["id"])
                        existed = True
                    else:
                        cur = con.execute("""
                            INSERT INTO incoming_suppliers
                            (name,address,vat_id,email,phone,our_customer_number,iban,swift,account_holder,supplier_number,created_at,updated_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                        """, (name, address, vat_id, email, phone, customer, iban, swift, holder, "", now, now))
                        supplier_id = int(cur.lastrowid)
                        supplier_number = f"KRI-{supplier_id:05d}"
                        con.execute("UPDATE incoming_suppliers SET supplier_number=? WHERE id=?", (supplier_number, supplier_id))
                        existed = False

                    row = con.execute("SELECT * FROM incoming_suppliers WHERE id=?", (supplier_id,)).fetchone()
                    supplier = public_supplier(row)
                    master_iban = _iban(supplier.get("iban"))
                    if master_iban:
                        con.execute("""
                            INSERT INTO supplier_bank_accounts
                            (supplier_address_id,iban,source_invoice_id,source_doc_id,confirmed_by,confirmed_at,note)
                            VALUES (?,?,NULL,?,'Lieferantenanlage',?,?)
                            ON CONFLICT(supplier_address_id,iban) DO UPDATE SET
                                confirmed_at=excluded.confirmed_at,
                                note=excluded.note
                        """, (
                            supplier["addressId"], master_iban, "supplier-master", now,
                            "Bei Lieferantenanlage aus Rechnungsdaten uebernommen",
                        ))
                    con.commit()
                    return jsonify({"ok": True, "area": area, "supplier": supplier, "existing": existed})
                finally:
                    con.close()
            except ValueError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

    css = r'''
.capture-new-supplier-btn{white-space:nowrap;background:#315d91!important;border-color:#315d91!important}
.capture-new-supplier-panel{margin-top:10px;border:1px solid #445366;border-radius:13px;background:#121820;padding:13px}
.capture-new-supplier-panel[hidden]{display:none!important}
.capture-new-supplier-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:10px}
.capture-new-supplier-head strong{font-size:15px}.capture-new-supplier-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.capture-new-supplier-grid label{font-size:11px;color:var(--muted)}.capture-new-supplier-grid input{margin-top:4px}
.capture-new-supplier-grid .wide{grid-column:1/-1}.capture-new-supplier-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:11px}
.capture-local-badge{display:inline-block;background:#1f4774;color:#dbeaff;border-radius:999px;padding:3px 7px;font-size:10px;font-weight:900;margin-bottom:5px}
@media(max-width:700px){.capture-new-supplier-grid{grid-template-columns:1fr}.capture-new-supplier-grid .wide{grid-column:auto}}
'''

    script = r'''
<script id="kristaLocalSuppliersV1">
(function(){
  if(typeof captureSupplierQ==='undefined'||typeof captureSupplierGo==='undefined')return;
  const searchRow=captureSupplierQ.closest('.searchrow');
  if(!searchRow||document.getElementById('captureSupplierNew'))return;

  const newBtn=document.createElement('button');
  newBtn.id='captureSupplierNew';newBtn.type='button';newBtn.className='capture-new-supplier-btn';newBtn.textContent='+ Neuer Lieferant';
  searchRow.appendChild(newBtn);

  const panel=document.createElement('div');panel.id='captureNewSupplierPanel';panel.className='capture-new-supplier-panel';panel.hidden=true;
  panel.innerHTML=`<div class="capture-new-supplier-head"><div><strong>Neuen Lieferanten anlegen</strong><div class="sub">KRISTINE fuellt aus der Rechnung vor. Nur leere oder falsche Felder korrigieren.</div></div></div>
    <div class="capture-new-supplier-grid">
      <label class="wide">Firma / Name<input id="newSupplierName"></label>
      <label class="wide">Adresse<input id="newSupplierAddress"></label>
      <label>UID<input id="newSupplierVat"></label>
      <label>Unsere Kundennummer dort<input id="newSupplierCustomer"></label>
      <label>E-Mail<input id="newSupplierEmail" type="email"></label>
      <label>Telefon<input id="newSupplierPhone"></label>
      <label>IBAN<input id="newSupplierIban"></label>
      <label>BIC / SWIFT<input id="newSupplierSwift"></label>
      <label class="wide">Kontoinhaber<input id="newSupplierHolder"></label>
    </div>
    <div id="newSupplierMsg" class="sub" style="margin-top:8px"></div>
    <div class="capture-new-supplier-actions"><button id="newSupplierCancel" type="button" class="secondary">Abbrechen</button><button id="newSupplierSave" type="button">Anlegen & auswaehlen</button></div>`;
  searchRow.parentNode.insertBefore(panel,searchRow.nextSibling);

  const el=id=>document.getElementById(id);
  const fields={name:el('newSupplierName'),address:el('newSupplierAddress'),vatId:el('newSupplierVat'),ourCustomerNumber:el('newSupplierCustomer'),email:el('newSupplierEmail'),phone:el('newSupplierPhone'),iban:el('newSupplierIban'),swift:el('newSupplierSwift'),accountHolder:el('newSupplierHolder')};
  const msg=el('newSupplierMsg');
  const analysis=()=>{try{return (typeof captureAnalysis!=='undefined'&&captureAnalysis)||{}}catch(_){return {}}};
  const area=()=>{try{return typeof captureArea!=='undefined'?captureArea:'live'}catch(_){return 'live'}};
  const formatIban=value=>String(value||'').replace(/\s+/g,'').toUpperCase().replace(/(.{4})/g,'$1 ').trim();

  function prefill(){
    const a=analysis();
    fields.name.value=a.supplierName||captureSupplierQ.value||'';
    fields.address.value=a.supplierAddress||'';
    fields.vatId.value=a.uid||'';
    fields.ourCustomerNumber.value=a.customerNumberExternal||'';
    fields.email.value=a.supplierEmail||'';
    fields.phone.value=a.supplierPhone||'';
    fields.iban.value=formatIban(a.iban||'');
    fields.swift.value=a.swift||'';
    fields.accountHolder.value=a.accountHolder||a.supplierName||'';
    msg.textContent='Automatisch erkannt – bitte nur kontrollieren und falsche/fehlende Zeilen aendern.';
  }
  function close(){panel.hidden=true;msg.textContent=''}
  newBtn.onclick=()=>{prefill();panel.hidden=false;fields.name.focus();fields.name.select()};
  el('newSupplierCancel').onclick=close;

  const originalSelect=selectCaptureSupplier;
  selectCaptureSupplier=async function(supplier){
    await originalSelect(supplier);
    if(supplier?.source==='KRISTINE'){
      captureSelectedSupplierBox.innerHTML=`<div class="card capture-selected"><span class="capture-local-badge">KRISTINE-Lieferant</span><strong>${esc(supplier.name||'Lieferant')}</strong>${supplier.address?`<div class="sub">${esc(supplier.address)}</div>`:''}<div class="sub">${esc(supplier.supplierNumber||'')}</div>${supplier.ourCustomerNumber?`<div class="payment-ok">Unsere KundenNr. dort: ${esc(supplier.ourCustomerNumber)}</div>`:''}</div>`;
    }
  };

  renderCaptureSupplierResults=function(rows=[],suggested=false){
    captureSupplierResults.innerHTML=rows.length?rows.map((s,i)=>`<div class="card capture-supplier-choice ${i===0&&suggested?'best':''}" data-capture-supplier="${i}">
      ${s.source==='KRISTINE'?'<span class="capture-local-badge">KRISTINE</span>':(i===0&&suggested?'<span class="capture-match-badge">★ Bester Vorschlag</span>':'')}
      <strong>${esc(s.name||'Adresse')}</strong>${s.address?`<div class="sub">${esc(s.address)}</div>`:''}
      ${s.source==='KRISTINE'?`<div class="sub">${esc(s.supplierNumber||'Lokaler Lieferant')}</div>`:`<div class="sub">Lieferant ${esc(s.supplierNumber||'–')} · WW-Adresse ${esc(s.customerNumber||s.addressId||'–')}</div>`}
      ${s.ourCustomerNumber?`<div class="sub">Unsere KundenNr. dort: ${esc(s.ourCustomerNumber)}</div>`:''}
      ${s.vatId?`<div class="sub">UID ${esc(s.vatId)}</div>`:''}
      ${(s.matchReasons||[]).length?`<div class="capture-match-reasons">${esc(s.matchReasons.join(' · '))}</div>`:''}
    </div>`).join(''):'<div class="empty">Keine passende Adresse gefunden. Mit <strong>+ Neuer Lieferant</strong> direkt in KRISTINE anlegen.</div>';
    captureSupplierResults.querySelectorAll('[data-capture-supplier]').forEach(card=>card.onclick=()=>selectCaptureSupplier(rows[Number(card.dataset.captureSupplier)]));
  };

  searchCaptureSuppliers=async function(){
    const term=captureSupplierQ.value.trim();if(term.length<2){captureSupplierQ.focus();return}
    captureSupplierResults.innerHTML='<div class="empty">Suche …</div>';
    try{
      const r=await fetch('/incoming/capture/suppliers?q='+encodeURIComponent(term)+'&area='+encodeURIComponent(area()),{cache:'no-store'}),d=await r.json();
      if(!r.ok||!d.ok)throw new Error(d.error||'Adresssuche fehlgeschlagen');renderCaptureSupplierResults(d.addresses||[],false)
    }catch(e){captureSupplierResults.innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}
  };
  captureSupplierGo.onclick=searchCaptureSuppliers;
  captureSupplierQ.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopImmediatePropagation();searchCaptureSuppliers()}},true);

  el('newSupplierSave').onclick=async()=>{
    const payload={area:area()};Object.entries(fields).forEach(([key,input])=>payload[key]=input.value.trim());
    if(!payload.name){fields.name.focus();msg.textContent='Firmenname fehlt.';return}
    const button=el('newSupplierSave');button.disabled=true;msg.textContent='Lieferant wird angelegt …';
    try{
      const r=await fetch('/incoming/capture/supplier-create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();
      if(!r.ok||!d.ok)throw new Error(d.error||'Lieferant konnte nicht angelegt werden');
      const supplier=d.supplier||{};captureSupplierQ.value=supplier.name||payload.name;close();await selectCaptureSupplier(supplier);
      if(payload.iban&&typeof captureInvoiceIban!=='undefined')captureInvoiceIban.value=formatIban(payload.iban);
      if(typeof checkCaptureBankWarning==='function')checkCaptureBankWarning();
      if(typeof setCaptureMessage==='function')setCaptureMessage((d.existing?'✓ Vorhandenen KRISTINE-Lieferanten verwendet: ':'✓ Neuer Lieferant angelegt: ')+(supplier.name||payload.name),'success');
    }catch(error){msg.textContent=error.message||String(error)}finally{button.disabled=false}
  };
})();
</script>
'''

    if "kristaLocalSuppliersV1" not in page:
        page = page.replace("</style>", css + "\n</style>", 1)
        page = page.replace("</body>", script + "\n</body>", 1)
        ns["MOBILE_PAGE"] = page

    print("✅ KRISTINE Lieferanten-Neuanlage aktiv: OCR-Vorbefuellung · Test/Echt getrennt")
