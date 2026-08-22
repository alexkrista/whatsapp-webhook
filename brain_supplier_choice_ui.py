# coding: utf-8
"""KRISTINE · klare Lieferantenauswahl und Stammdatenpflege in der Eingangsrechnung.

Treffer bekommen einen sichtbaren Auswahlbutton. Bei lokalen KRISTINE-Lieferanten
koennen Stammdaten direkt ergaenzt oder korrigiert werden. WinWorker bleibt read-only.
"""
from __future__ import annotations

import re
from datetime import datetime


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    app = ns.get("app")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    if not page or app is None:
        return

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

    if callable(area_connection) and callable(capture_area) and "brain_local_supplier_update" not in app.view_functions:
        from flask import request, jsonify

        @app.put("/incoming/capture/supplier-update")
        def brain_local_supplier_update():
            try:
                body = request.get_json(silent=True) or {}
                area = capture_area(body.get("area") or "live")
                address_id = str(body.get("addressId") or "").strip()
                match = re.fullmatch(r"kri:(\d+)", address_id)
                if not match:
                    raise ValueError("Nur KRISTINE-Lieferanten koennen hier bearbeitet werden.")
                supplier_id = int(match.group(1))
                name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()
                if len(name) < 2:
                    raise ValueError("Firmenname fehlt.")
                address = re.sub(r"\s+", " ", str(body.get("address") or "")).strip()
                vat_id = re.sub(r"\s+", "", str(body.get("vatId") or "")).upper().strip()
                email = str(body.get("email") or "").strip()
                phone = re.sub(r"\s+", " ", str(body.get("phone") or "")).strip()
                customer = str(body.get("ourCustomerNumber") or "").strip()
                iban = re.sub(r"\s+", "", str(body.get("iban") or "")).upper().strip()
                swift = re.sub(r"\s+", "", str(body.get("swift") or "")).upper().strip()
                holder = re.sub(r"\s+", " ", str(body.get("accountHolder") or "")).strip()
                now = datetime.now().isoformat(timespec="seconds")

                con = area_connection(area)
                try:
                    row = con.execute("SELECT * FROM incoming_suppliers WHERE id=?", (supplier_id,)).fetchone()
                    if not row:
                        return jsonify({"ok": False, "error": "KRISTINE-Lieferant nicht gefunden."}), 404
                    con.execute("""
                        UPDATE incoming_suppliers SET
                            name=?, address=?, vat_id=?, email=?, phone=?, our_customer_number=?,
                            iban=?, swift=?, account_holder=?, updated_at=?
                        WHERE id=?
                    """, (name, address, vat_id, email, phone, customer, iban, swift, holder, now, supplier_id))

                    # Der aktuelle Stammdatensatz ersetzt nur die bei der Lieferantenanlage
                    # erzeugte Master-IBAN. Rechnungsbezogene bestaetigte IBANs bleiben Historie.
                    con.execute(
                        "DELETE FROM supplier_bank_accounts WHERE supplier_address_id=? AND source_doc_id='supplier-master'",
                        (address_id,),
                    )
                    if iban:
                        con.execute("""
                            INSERT INTO supplier_bank_accounts
                            (supplier_address_id,iban,source_invoice_id,source_doc_id,confirmed_by,confirmed_at,note)
                            VALUES (?,?,NULL,'supplier-master','Stammdaten bearbeitet',?,?)
                            ON CONFLICT(supplier_address_id,iban) DO UPDATE SET
                                confirmed_at=excluded.confirmed_at,
                                confirmed_by=excluded.confirmed_by,
                                note=excluded.note
                        """, (address_id, iban, now, "Aktuelle KRISTINE-Lieferantenstammdaten"))
                    con.commit()
                    updated = con.execute("SELECT * FROM incoming_suppliers WHERE id=?", (supplier_id,)).fetchone()
                    return jsonify({"ok": True, "area": area, "supplier": public_supplier(updated)})
                finally:
                    con.close()
            except ValueError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

    if "kristaSupplierChoiceV2" in page:
        return

    css = r'''
.capture-supplier-choice{cursor:pointer}
.capture-supplier-choice:hover{border-color:#6d8cad!important}
.capture-supplier-pickline{display:flex;justify-content:flex-end;margin-top:9px}
.capture-supplier-pick{background:#315d91!important;border-color:#315d91!important;color:#fff!important;font-weight:850}
.capture-selected{position:relative;padding-right:300px!important}
.capture-supplier-card-actions{position:absolute;right:10px;top:10px;display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.capture-supplier-card-actions button{white-space:nowrap;font-weight:850}
.capture-supplier-edit{background:#315d91!important;border-color:#315d91!important;color:#fff!important}
.capture-supplier-switch{background:#fff!important;color:#111!important;border-color:#bfc4ca!important}
.capture-supplier-edit-panel{margin-top:10px;border:1px solid #445366;border-radius:13px;background:#121820;padding:13px}
.capture-supplier-edit-panel[hidden]{display:none!important}
.capture-supplier-edit-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:10px}
.capture-supplier-edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.capture-supplier-edit-grid label{font-size:11px;color:var(--muted)}.capture-supplier-edit-grid input{margin-top:4px}
.capture-supplier-edit-grid .wide{grid-column:1/-1}.capture-supplier-edit-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:11px}
@media(max-width:850px){.capture-selected{padding-right:12px!important}.capture-supplier-card-actions{position:static;margin-top:10px;justify-content:flex-start}.capture-supplier-edit-grid{grid-template-columns:1fr}.capture-supplier-edit-grid .wide{grid-column:auto}}
'''

    script = r'''
<script id="kristaSupplierChoiceV2">
(function(){
  if(typeof captureSupplierResults==='undefined'||typeof captureSelectedSupplierBox==='undefined')return;

  const area=()=>{try{return typeof captureArea!=='undefined'?captureArea:'live'}catch(_){return 'live'}};
  const formatIban=value=>String(value||'').replace(/\s+/g,'').toUpperCase().replace(/(.{4})/g,'$1 ').trim();

  const editPanel=document.createElement('div');
  editPanel.id='captureSupplierEditPanel';editPanel.className='capture-supplier-edit-panel';editPanel.hidden=true;
  editPanel.innerHTML=`<div class="capture-supplier-edit-head"><div><strong>Lieferanten-Stammdaten bearbeiten</strong><div class="sub">Fehlende Angaben ergaenzen oder falsch erkannte Werte korrigieren.</div></div></div>
    <div class="capture-supplier-edit-grid">
      <label class="wide">Firma / Name<input id="editSupplierName"></label>
      <label class="wide">Adresse<input id="editSupplierAddress"></label>
      <label>UID<input id="editSupplierVat"></label>
      <label>Unsere Kundennummer dort<input id="editSupplierCustomer"></label>
      <label>E-Mail<input id="editSupplierEmail" type="email"></label>
      <label>Telefon<input id="editSupplierPhone"></label>
      <label>IBAN<input id="editSupplierIban"></label>
      <label>BIC / SWIFT<input id="editSupplierSwift"></label>
      <label class="wide">Kontoinhaber<input id="editSupplierHolder"></label>
    </div>
    <div id="editSupplierMsg" class="sub" style="margin-top:8px"></div>
    <div class="capture-supplier-edit-actions"><button id="editSupplierCancel" type="button" class="secondary">Abbrechen</button><button id="editSupplierSave" type="button">Aenderungen speichern</button></div>`;
  captureSelectedSupplierBox.insertAdjacentElement('afterend',editPanel);

  const el=id=>document.getElementById(id);
  const editFields={name:el('editSupplierName'),address:el('editSupplierAddress'),vatId:el('editSupplierVat'),ourCustomerNumber:el('editSupplierCustomer'),email:el('editSupplierEmail'),phone:el('editSupplierPhone'),iban:el('editSupplierIban'),swift:el('editSupplierSwift'),accountHolder:el('editSupplierHolder')};
  const editMsg=el('editSupplierMsg');

  function selectedSupplier(){try{return captureSelectedSupplier||null}catch(_){return null}}
  function closeEdit(){editPanel.hidden=true;editMsg.textContent=''}
  function openEdit(){
    const s=selectedSupplier();
    if(!s||s.source!=='KRISTINE')return;
    editFields.name.value=s.name||'';editFields.address.value=s.address||'';editFields.vatId.value=s.vatId||'';
    editFields.ourCustomerNumber.value=s.ourCustomerNumber||'';editFields.email.value=s.email||'';editFields.phone.value=s.phone||'';
    editFields.iban.value=formatIban(s.iban||'');editFields.swift.value=s.swift||'';editFields.accountHolder.value=s.accountHolder||'';
    editMsg.textContent='Nur das aendern oder ergaenzen, was nicht stimmt.';editPanel.hidden=false;editFields.name.focus();
  }

  function changeSupplier(){
    closeEdit();
    try{captureSelectedSupplier=null}catch(_){}
    try{captureAcceptNewIban=false}catch(_){}
    captureSelectedSupplierBox.innerHTML='Noch kein Lieferant ausgewählt.';
    try{if(captureMasterIban)captureMasterIban.value=''}catch(_){}
    try{if(captureExternalCustomerNo)captureExternalCustomerNo.value=(captureAnalysis?.customerNumberExternal||'')}catch(_){}
    try{if(typeof checkCaptureBankWarning==='function')checkCaptureBankWarning()}catch(_){}
    try{
      captureSupplierQ.focus();captureSupplierQ.select();
      if(String(captureSupplierQ.value||'').trim().length>=2&&typeof searchCaptureSuppliers==='function')searchCaptureSuppliers();
    }catch(_){}
  }

  function decorateSelected(){
    const card=captureSelectedSupplierBox.querySelector('.capture-selected');
    if(!card)return;
    card.querySelectorAll('.capture-supplier-change,.capture-supplier-card-actions').forEach(node=>node.remove());
    const actions=document.createElement('div');actions.className='capture-supplier-card-actions';
    const s=selectedSupplier();
    if(s?.source==='KRISTINE'){
      const edit=document.createElement('button');edit.type='button';edit.className='capture-supplier-edit';edit.textContent='✎ Stammdaten bearbeiten';
      edit.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openEdit()});actions.appendChild(edit);
    }
    const change=document.createElement('button');change.type='button';change.className='capture-supplier-switch';change.textContent='↻ Anderen auswählen';
    change.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();changeSupplier()});actions.appendChild(change);
    card.appendChild(actions);
  }

  function decorateResults(rows){
    captureSupplierResults.querySelectorAll('[data-capture-supplier]').forEach(card=>{
      const index=Number(card.dataset.captureSupplier);
      if(!Number.isFinite(index)||!rows[index])return;
      if(!card.querySelector('.capture-supplier-pick')){
        const line=document.createElement('div');line.className='capture-supplier-pickline';
        const button=document.createElement('button');button.type='button';button.className='capture-supplier-pick';button.textContent='Auswählen';
        button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();selectCaptureSupplier(rows[index])});
        line.appendChild(button);card.appendChild(line);
      }
    });
  }

  if(typeof renderCaptureSupplierResults==='function'){
    const originalRender=renderCaptureSupplierResults;
    renderCaptureSupplierResults=function(rows=[],suggested=false){
      const result=originalRender.apply(this,arguments);decorateResults(rows||[]);return result;
    };
  }

  if(typeof selectCaptureSupplier==='function'){
    const originalSelect=selectCaptureSupplier;
    selectCaptureSupplier=async function(supplier){
      const result=await originalSelect.apply(this,arguments);closeEdit();decorateSelected();return result;
    };
  }

  el('editSupplierCancel').onclick=closeEdit;
  el('editSupplierSave').onclick=async()=>{
    const s=selectedSupplier();if(!s||s.source!=='KRISTINE')return;
    const payload={area:area(),addressId:s.addressId};Object.entries(editFields).forEach(([key,input])=>payload[key]=input.value.trim());
    if(!payload.name){editFields.name.focus();editMsg.textContent='Firmenname fehlt.';return}
    const button=el('editSupplierSave');button.disabled=true;editMsg.textContent='Stammdaten werden gespeichert …';
    try{
      const r=await fetch('/incoming/capture/supplier-update',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();
      if(!r.ok||!d.ok)throw new Error(d.error||'Lieferant konnte nicht gespeichert werden');
      const supplier=d.supplier||{};captureSupplierQ.value=supplier.name||payload.name;await selectCaptureSupplier(supplier);
      if(typeof captureMasterIban!=='undefined')captureMasterIban.value=formatIban(supplier.iban||'');
      if(typeof checkCaptureBankWarning==='function')checkCaptureBankWarning();
      if(typeof setCaptureMessage==='function')setCaptureMessage('✓ Lieferanten-Stammdaten gespeichert: '+(supplier.name||payload.name),'success');
    }catch(error){editMsg.textContent=error.message||String(error)}finally{button.disabled=false}
  };

  const observer=new MutationObserver(()=>{
    const card=captureSelectedSupplierBox.querySelector('.capture-selected');
    if(card&&!card.querySelector('.capture-supplier-card-actions'))decorateSelected();
  });
  observer.observe(captureSelectedSupplierBox,{childList:true,subtree:true});
  decorateSelected();
})();
</script>
'''

    page = re.sub(r'<script\s+id="kristaSupplierChoiceV1">.*?</script>', '', page, flags=re.I | re.S)
    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ KRISTINE Lieferantenauswahl V2: Auswahl + lokale Stammdaten bearbeiten")
