# coding: utf-8
"""KRISTINE Eingangsrechnung: erfasste, noch ungepruefte Rechnungen erneut bearbeiten.

Die interne Belegnummer und die gespeicherte PDF bleiben unveraendert. Nach
workflow_status=geprueft ist die Bearbeitung sowohl in der UI als auch serverseitig gesperrt.
"""
from __future__ import annotations

import re
from datetime import datetime


def _norm_invoice_number(value):
    return re.sub(r"[^A-Za-z0-9]+", "", str(value or "")).upper().strip()


def _money(value):
    try:
        return float(value or 0)
    except Exception:
        return 0.0


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    if app is None or not page or not callable(area_connection) or not callable(capture_area):
        return

    def public_row(row, allocations):
        d = dict(row)
        address_id = str(d.get("supplier_address_id") or "")
        return {
            "id": int(d.get("id") or 0),
            "docId": str(d.get("doc_id") or ""),
            "documentType": str(d.get("document_type") or "Rechnung"),
            "addressId": address_id,
            "supplierName": str(d.get("supplier_name") or ""),
            "supplierAddress": str(d.get("supplier_address") or ""),
            "supplierNumber": str(d.get("supplier_number") or ""),
            "ourCustomerNumber": str(d.get("our_customer_number") or ""),
            "invoiceNumber": str(d.get("supplier_invoice_number") or ""),
            "invoiceDate": str(d.get("invoice_date") or ""),
            "dueDate": str(d.get("due_date") or ""),
            "netDueDate": str(d.get("net_due_date") or d.get("due_date") or ""),
            "skontoEnabled": bool(d.get("skonto_enabled") or 0),
            "skontoPercent": d.get("skonto_percent"),
            "skontoDueDate": str(d.get("skonto_due_date") or ""),
            "paymentTerms": str(d.get("payment_terms") or ""),
            "netAmount": _money(d.get("net_amount")),
            "vatAmount": _money(d.get("vat_amount")),
            "grossAmount": _money(d.get("gross_amount")),
            "currency": str(d.get("currency") or "EUR"),
            "masterIban": str(d.get("master_iban") or ""),
            "invoiceIban": str(d.get("invoice_iban") or d.get("iban") or ""),
            "iban": str(d.get("iban") or ""),
            "bankChangeAccepted": bool(d.get("bank_change_accepted") or 0),
            "swift": str(d.get("swift") or ""),
            "accountHolder": str(d.get("account_holder") or ""),
            "customerNumberExternal": str(d.get("customer_number_external") or ""),
            "workflowStatus": str(d.get("workflow_status") or "zu_pruefen"),
            "paymentStatus": str(d.get("payment_status") or "Offen"),
            "paymentState": str(d.get("payment_state") or "open"),
            "bookingText": str(d.get("booking_text") or ""),
            "note": str(d.get("note") or ""),
            "createdBy": str(d.get("created_by") or "Dunja"),
            "path": str(d.get("pdf_path") or ""),
            "originalPath": str(d.get("original_path") or ""),
            "source": "KRISTINE" if address_id.startswith("kri:") else "WinWorker",
            "allocations": [dict(x) for x in allocations],
        }

    if "brain_capture_edit_data" not in app.view_functions:
        from flask import request, jsonify

        @app.get("/incoming/capture/<int:invoice_id>/edit-data")
        def brain_capture_edit_data(invoice_id):
            try:
                area = capture_area(request.args.get("area") or "live")
                con = area_connection(area)
                try:
                    row = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (invoice_id,)).fetchone()
                    if not row:
                        return jsonify({"ok": False, "error": "Rechnung nicht gefunden."}), 404
                    allocations = con.execute("""
                        SELECT line_no AS lineNo, account, cost_type AS costType,
                               cost_center AS costCenter, project_id AS projectId,
                               description, net_amount AS netAmount, vat_rate AS vatRate
                        FROM incoming_allocations WHERE invoice_id=? ORDER BY line_no
                    """, (invoice_id,)).fetchall()
                    return jsonify({"ok": True, "area": area, "invoice": public_row(row, allocations)})
                finally:
                    con.close()
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

        @app.put("/incoming/capture/<int:invoice_id>/edit")
        def brain_capture_edit_save(invoice_id):
            try:
                body = request.get_json(silent=True) or {}
                area = capture_area(body.get("area") or "live")
                supplier = body.get("supplier") or {}
                address_id = str(supplier.get("addressId") or "").strip()
                supplier_name = re.sub(r"\s+", " ", str(supplier.get("name") or "")).strip()
                if not address_id or not supplier_name:
                    raise ValueError("Lieferant fehlt.")
                invoice_number = str(body.get("supplierInvoiceNumber") or "").strip()
                invoice_number_norm = _norm_invoice_number(invoice_number)
                if not invoice_number_norm:
                    raise ValueError("Lieferanten-Rechnungsnummer fehlt.")
                invoice_date = str(body.get("invoiceDate") or "").strip()
                if not invoice_date:
                    raise ValueError("Rechnungsdatum fehlt.")
                allocations = body.get("allocations") or []
                if not isinstance(allocations, list) or not allocations:
                    raise ValueError("Kontierung fehlt.")
                net = _money(body.get("netAmount"))
                allocation_sum = round(sum(_money(x.get("netAmount")) for x in allocations), 2)
                if abs(round(net, 2) - allocation_sum) > 0.02:
                    raise ValueError("Kontierung stimmt nicht mit dem Netto überein.")

                con = area_connection(area)
                try:
                    row = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (invoice_id,)).fetchone()
                    if not row:
                        return jsonify({"ok": False, "error": "Rechnung nicht gefunden."}), 404
                    if str(row["workflow_status"] or "").lower() == "geprueft":
                        return jsonify({"ok": False, "error": "Diese Rechnung ist bereits geprüft und deshalb gesperrt."}), 409

                    duplicate = con.execute("""
                        SELECT id,doc_id FROM incoming_invoices
                        WHERE supplier_address_id=? AND supplier_invoice_number_norm=? AND id<>?
                        LIMIT 1
                    """, (address_id, invoice_number_norm, invoice_id)).fetchone()
                    if duplicate:
                        raise ValueError(f"Diese Lieferanten-Rechnungsnummer ist bereits als {duplicate['doc_id']} vorhanden.")

                    now = datetime.now().isoformat(timespec="seconds")
                    invoice_iban = re.sub(r"\s+", "", str(body.get("invoiceIban") or "")).upper().strip()
                    master_iban = re.sub(r"\s+", "", str(body.get("masterIban") or "")).upper().strip()
                    accepted = bool(body.get("acceptNewIban"))
                    con.execute("""
                        UPDATE incoming_invoices SET
                            document_type=?, supplier_address_id=?, supplier_name=?, supplier_address=?,
                            supplier_number=?, our_customer_number=?, supplier_invoice_number=?,
                            supplier_invoice_number_norm=?, invoice_date=?, due_date=?, net_due_date=?,
                            skonto_enabled=?, skonto_percent=?, skonto_due_date=?, payment_terms=?,
                            net_amount=?, vat_amount=?, gross_amount=?, currency=?, iban=?, invoice_iban=?,
                            master_iban=?, bank_change_accepted=?, customer_number_external=?,
                            booking_text=?, note=?, created_by=?, updated_at=?
                        WHERE id=?
                    """, (
                        str(body.get("documentType") or "Rechnung"), address_id, supplier_name,
                        str(supplier.get("address") or ""), str(supplier.get("supplierNumber") or ""),
                        str(supplier.get("ourCustomerNumber") or ""), invoice_number, invoice_number_norm,
                        invoice_date, str(body.get("dueDate") or body.get("netDueDate") or ""),
                        str(body.get("netDueDate") or body.get("dueDate") or ""),
                        1 if body.get("skontoEnabled") else 0,
                        _money(body.get("skontoPercent")) if body.get("skontoEnabled") else None,
                        str(body.get("skontoDueDate") or ""), str(body.get("paymentTerms") or ""),
                        net, _money(body.get("vatAmount")), _money(body.get("grossAmount")),
                        str(body.get("currency") or "EUR").upper()[:3], invoice_iban, invoice_iban,
                        master_iban, 1 if accepted else 0, str(body.get("customerNumberExternal") or ""),
                        str(body.get("bookingText") or "")[:1000], str(body.get("note") or "")[:2000],
                        str(body.get("createdBy") or row["created_by"] or "Dunja")[:100], now, invoice_id,
                    ))
                    con.execute("DELETE FROM incoming_allocations WHERE invoice_id=?", (invoice_id,))
                    for index, item in enumerate(allocations, 1):
                        con.execute("""
                            INSERT INTO incoming_allocations
                            (invoice_id,line_no,account,cost_type,cost_center,project_id,description,net_amount,vat_rate)
                            VALUES (?,?,?,?,?,?,?,?,?)
                        """, (
                            invoice_id, index, str(item.get("account") or ""),
                            str(item.get("costType") or "Sonstiges"), str(item.get("costCenter") or ""),
                            str(item.get("projectId") or ""), str(item.get("description") or ""),
                            _money(item.get("netAmount")), _money(item.get("vatRate")),
                        ))
                    if accepted and invoice_iban:
                        con.execute("""
                            INSERT INTO supplier_bank_accounts
                            (supplier_address_id,iban,source_invoice_id,source_doc_id,confirmed_by,confirmed_at,note)
                            VALUES (?,?,?,?,?,?,?)
                            ON CONFLICT(supplier_address_id,iban) DO UPDATE SET
                                source_invoice_id=excluded.source_invoice_id,
                                source_doc_id=excluded.source_doc_id,
                                confirmed_by=excluded.confirmed_by,
                                confirmed_at=excluded.confirmed_at,
                                note=excluded.note
                        """, (address_id, invoice_iban, invoice_id, str(row["doc_id"] or ""),
                              str(body.get("createdBy") or "Dunja"), now, "Bei Rechnungsbearbeitung bestätigt"))
                    con.commit()
                    updated = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (invoice_id,)).fetchone()
                    updated_alloc = con.execute("""
                        SELECT line_no AS lineNo, account, cost_type AS costType,
                               cost_center AS costCenter, project_id AS projectId,
                               description, net_amount AS netAmount, vat_rate AS vatRate
                        FROM incoming_allocations WHERE invoice_id=? ORDER BY line_no
                    """, (invoice_id,)).fetchall()
                    return jsonify({"ok": True, "area": area, "invoice": public_row(updated, updated_alloc)})
                finally:
                    con.close()
            except ValueError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

    if "kristaCaptureEditV1" in page:
        ns["MOBILE_PAGE"] = page
        return

    css = r'''
.capture-edit-button{background:#315d91!important;border-color:#315d91!important;color:#fff!important;font-weight:850}
.capture-edit-banner{display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin:10px 0;padding:11px 13px;border:1px solid #526d8a;border-radius:12px;background:#152334}
.capture-edit-banner[hidden]{display:none!important}.capture-edit-banner strong{color:#fff}.capture-edit-banner .actions{margin:0}
'''

    script = r'''
<script id="kristaCaptureEditV1">
(function(){
  if(typeof captureRecent==='undefined'||typeof captureSave==='undefined')return;
  let editingId=0,editingDoc='',editingPath='';
  const originalSave=typeof saveCaptureInvoice==='function'?saveCaptureInvoice:null;
  const banner=document.createElement('div');banner.id='captureEditBanner';banner.className='capture-edit-banner';banner.hidden=true;
  banner.innerHTML='<div><strong id="captureEditTitle">Rechnung bearbeiten</strong><div class="sub">Nur solange sie noch nicht geprüft ist. Die interne Belegnummer und PDF bleiben unverändert.</div></div><div class="actions"><a id="captureEditPdf" class="action" target="_blank" rel="noopener">PDF öffnen</a><button id="captureEditCancel" type="button" class="secondary">Bearbeitung abbrechen</button></div>';
  const saveCard=captureSave.closest('.card')||captureSave.parentElement;if(saveCard)saveCard.insertBefore(banner,saveCard.firstChild);
  const title=document.getElementById('captureEditTitle'),pdf=document.getElementById('captureEditPdf'),cancel=document.getElementById('captureEditCancel');
  const formatIban=v=>String(v||'').replace(/\s+/g,'').toUpperCase().replace(/(.{4})/g,'$1 ').trim();
  const ensureCurrency=code=>{code=String(code||'EUR').toUpperCase();if(![...captureCurrency.options].some(o=>o.value===code||o.textContent===code)){const o=document.createElement('option');o.value=code;o.textContent=code;captureCurrency.appendChild(o)}captureCurrency.value=code};

  function editSupplier(invoice){
    return {addressId:invoice.addressId||'',name:invoice.supplierName||'',address:invoice.supplierAddress||'',supplierNumber:invoice.supplierNumber||'',ourCustomerNumber:invoice.ourCustomerNumber||'',source:invoice.source||(String(invoice.addressId||'').startsWith('kri:')?'KRISTINE':'WinWorker')};
  }
  async function startEdit(id){
    const r=await fetch('/incoming/capture/'+encodeURIComponent(id)+'/edit-data?area='+encodeURIComponent(captureArea),{cache:'no-store'}),d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'Rechnung konnte nicht geöffnet werden');
    const x=d.invoice||{};if(String(x.workflowStatus||'').toLowerCase()==='geprueft')throw new Error('Diese Rechnung ist bereits geprüft und gesperrt.');
    editingId=Number(x.id||id);editingDoc=x.docId||'';editingPath=x.path||'';
    captureFile.value='';try{showCapturePdf(null)}catch(_){}
    captureDocumentType.value=x.documentType||'Rechnung';
    captureInvoiceNumber.value=x.invoiceNumber||'';captureInvoiceDate.value=x.invoiceDate||'';captureNetDueDate.value=x.netDueDate||x.dueDate||'';
    captureSkontoEnabled.value=x.skontoEnabled?'1':'0';captureSkontoPercent.value=x.skontoPercent??'';captureSkontoDueDate.value=x.skontoDueDate||'';capturePaymentTerms.value=x.paymentTerms||'';if(typeof updateCaptureSkontoUi==='function')updateCaptureSkontoUi();
    captureNet.value=Number(x.netAmount||0).toFixed(2);captureVat.value=Number(x.vatAmount||0).toFixed(2);captureGross.value=Number(x.grossAmount||0).toFixed(2);ensureCurrency(x.currency||'EUR');
    captureMasterIban.value=formatIban(x.masterIban||'');captureInvoiceIban.value=formatIban(x.invoiceIban||x.iban||'');captureExternalCustomerNo.value=x.customerNumberExternal||x.ourCustomerNumber||'';
    captureBookingText.value=x.bookingText||'';captureNote.value=x.note||'';captureCreatedBy.value=x.createdBy||'Dunja';
    captureSelectedSupplier=editSupplier(x);captureAcceptNewIban=Boolean(x.bankChangeAccepted);
    if(typeof selectCaptureSupplier==='function')await selectCaptureSupplier(captureSelectedSupplier);else captureSelectedSupplierBox.innerHTML='<div class="card capture-selected"><strong>'+esc(captureSelectedSupplier.name)+'</strong></div>';
    captureExternalCustomerNo.value=x.customerNumberExternal||x.ourCustomerNumber||'';captureMasterIban.value=formatIban(x.masterIban||'');captureInvoiceIban.value=formatIban(x.invoiceIban||x.iban||'');
    captureAllocationRows=(x.allocations||[]).map(a=>({account:a.account||'',costType:a.costType||'Sonstiges',costCenter:a.costCenter||'',projectId:a.projectId||'',description:a.description||'',netAmount:Number(a.netAmount||0).toFixed(2),vatRate:Number(a.vatRate||0)}));
    if(!captureAllocationRows.length)captureAllocationRows=[captureAllocationSeed()];renderCaptureAllocations();
    if(typeof checkCaptureBankWarning==='function')checkCaptureBankWarning();
    title.textContent='✎ '+(editingDoc||'Rechnung')+' bearbeiten';pdf.href=editingPath?urlFor('/pdf',editingPath):'#';pdf.hidden=!editingPath;banner.hidden=false;captureSave.textContent='Änderungen speichern';
    try{captureSupplierQ.closest('.card')?.scrollIntoView({behavior:'smooth',block:'start'})}catch(_){}
  }
  function stopEdit(reset=true){editingId=0;editingDoc='';editingPath='';banner.hidden=true;captureSave.textContent='Rechnung speichern';if(reset&&typeof resetCaptureForm==='function')resetCaptureForm()}
  cancel.onclick=()=>stopEdit(true);

  async function saveEdit(){
    if(!editingId)return;
    if(!captureSelectedSupplier?.addressId)return setCaptureMessage('Bitte einen Lieferanten auswählen.','error');
    if(!captureInvoiceNumber.value.trim())return setCaptureMessage('Lieferanten-Rechnungsnummer fehlt.','error');
    if(!captureInvoiceDate.value)return setCaptureMessage('Rechnungsdatum fehlt.','error');
    if(captureSkontoEnabled.value==='1'&&captureNumber(captureSkontoPercent.value)<=0)return setCaptureMessage('Bei Skonto bitte den Prozentsatz eintragen.','error');
    if(!updateCaptureAllocationTotal())return setCaptureMessage('Kontierung stimmt noch nicht mit dem Netto überein.','error');
    captureSave.disabled=true;setCaptureMessage('Änderungen werden gespeichert …');
    try{
      const payload=capturePayload();
      const r=await fetch('/incoming/capture/'+encodeURIComponent(editingId)+'/edit',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();
      if(!r.ok||!d.ok)throw new Error(d.error||'Änderungen konnten nicht gespeichert werden');
      const doc=d.invoice?.docId||editingDoc;stopEdit(true);setCaptureMessage('✓ '+doc+' geändert · weiterhin Zu prüfen','success');await Promise.all([loadCaptureDashboard(),loadCaptureRecent()]);
    }catch(e){setCaptureMessage(e.message||String(e),'error')}finally{captureSave.disabled=false}
  }
  captureSave.onclick=()=>editingId?saveEdit():(originalSave?originalSave():undefined);

  if(typeof renderCaptureRecent==='function'){
    const originalRender=renderCaptureRecent;
    renderCaptureRecent=function(rows){const result=originalRender.apply(this,arguments);const cards=[...captureRecent.querySelectorAll(':scope > .card')];(rows||[]).forEach((x,i)=>{if(String(x.workflowStatus||'').toLowerCase()==='geprueft')return;const actions=cards[i]?.querySelector('.actions');if(!actions||actions.querySelector('[data-edit-invoice]'))return;const b=document.createElement('button');b.type='button';b.className='capture-edit-button';b.dataset.editInvoice=String(x.id||'');b.textContent='✎ Bearbeiten';b.onclick=()=>startEdit(x.id).catch(e=>alert(e.message||String(e)));actions.insertBefore(b,actions.firstChild)});return result};
  }
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Eingangsrechnung Bearbeiten aktiv: bis Prüfung offen · danach gesperrt")
