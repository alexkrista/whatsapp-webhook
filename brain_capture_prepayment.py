# coding: utf-8
"""Vorkassarechnungen, revisionssicheres Entfernen und Original-Nachforderung.

Eine Vorkassarechnung ist ein normaler offener Kreditorenposten. Kommt spaeter
die endgueltige Rechnung mit derselben Lieferanten-Rechnungsnummer, wird der
bestehende Datensatz aktualisiert. Dadurch bleiben OP-/Zahlungsverknuepfungen
auf derselben KRISTINE-ID erhalten. Die alte Fassung wird samt PDF-Pfaden in
einer Historientabelle archiviert.

Echtbelege werden niemals physisch geloescht: Der Datensatz wandert in die
Historie, die PDF-Dateien bleiben am Speicherort. Bereits bezahlte oder an SEPA
uebergebene Belege sind gesperrt.
"""
from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import shutil


PREPAYMENT_TYPE = "Vorkassarechnung"


def _ensure_history(con):
    con.execute("""
        CREATE TABLE IF NOT EXISTS incoming_invoice_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            doc_id TEXT NOT NULL,
            action TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            allocations_json TEXT NOT NULL DEFAULT '[]',
            reason TEXT,
            archived_by TEXT NOT NULL,
            archived_at TEXT NOT NULL
        )
    """)
    con.execute("""
        CREATE INDEX IF NOT EXISTS idx_incoming_invoice_history_invoice
        ON incoming_invoice_history(invoice_id, archived_at DESC)
    """)
    con.commit()


def _snapshot(con, row, action, actor, reason="", extra=None):
    allocations = [dict(item) for item in con.execute(
        "SELECT * FROM incoming_allocations WHERE invoice_id=? ORDER BY line_no",
        (int(row["id"]),),
    ).fetchall()]
    data = dict(row)
    if extra:
        data.update(extra)
    con.execute("""
        INSERT INTO incoming_invoice_history
        (invoice_id,doc_id,action,snapshot_json,allocations_json,reason,archived_by,archived_at)
        VALUES (?,?,?,?,?,?,?,?)
    """, (
        int(row["id"]), str(row["doc_id"] or ""), action,
        json.dumps(data, ensure_ascii=False, default=str),
        json.dumps(allocations, ensure_ascii=False, default=str),
        str(reason or "")[:1000], str(actor or "Dunja")[:100],
        datetime.now().isoformat(timespec="seconds"),
    ))


def _payment_locked(con, invoice_id, row):
    state = str(row["payment_state"] or "").strip().lower()
    if state in {"paid", "bezahlt", "sepa_submitted", "sepa", "uebergeben", "übergeben"}:
        return True
    try:
        meta = con.execute("""
            SELECT payment_status FROM brain_payment_meta
            WHERE source='KRISTINE' AND source_id=?
        """, (f"kristine:{int(invoice_id)}",)).fetchone()
    except Exception:
        meta = None
    status = str(meta["payment_status"] if meta else "").strip().lower()
    return status in {"paid", "bezahlt", "sepa_submitted", "sepa", "uebergeben", "übergeben"}


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    invoice_norm = ns.get("_capture_invoice_number_norm")
    analyze_pdf = ns.get("_capture_analyze_pdf")
    public_row = ns.get("_capture_row_public")
    allocations_public = ns.get("_capture_allocations")
    capture_date = ns.get("_capture_date")
    capture_float = ns.get("_capture_float")
    capture_truthy = ns.get("_capture_truthy")
    norm_iban = ns.get("_norm_iban")
    iban_valid = ns.get("_iban_valid")
    supplier_context = ns.get("_capture_supplier_context")
    if not all((app, page, callable(area_connection), callable(capture_area),
                callable(invoice_norm), callable(analyze_pdf), callable(public_row),
                callable(allocations_public), callable(capture_date),
                callable(capture_float), callable(capture_truthy), callable(norm_iban),
                callable(iban_valid), callable(supplier_context))):
        return

    for area_name in ("live", "test"):
        con = area_connection(area_name)
        try:
            _ensure_history(con)
        finally:
            con.close()

    from flask import jsonify, request

    def replace_prepayment(payload, upload, existing_id, area):
        supplier = payload.get("supplier") or {}
        address_id = str(supplier.get("addressId") or "").strip()
        supplier_name = str(supplier.get("name") or "").strip()
        invoice_number = str(payload.get("supplierInvoiceNumber") or "").strip()
        number_norm = invoice_norm(invoice_number)
        if not address_id or not supplier_name or not number_norm:
            raise ValueError("Lieferant oder Rechnungsnummer fehlt.")

        invoice_date = capture_date(payload.get("invoiceDate"), "Rechnungsdatum")
        net_due_date = capture_date(payload.get("netDueDate") or payload.get("dueDate"), "Nettofälligkeit", allow_empty=True)
        skonto_enabled = capture_truthy(payload.get("skontoEnabled"))
        skonto_percent = capture_float(payload.get("skontoPercent"), "Skonto-Prozent", allow_none=True)
        if skonto_enabled and (skonto_percent is None or skonto_percent <= 0):
            raise ValueError("Bei Skonto bitte einen Prozentsatz größer 0 eintragen.")
        skonto_due_date = capture_date(payload.get("skontoDueDate"), "Skontofälligkeit", allow_empty=True)
        net = capture_float(payload.get("netAmount"), "Netto")
        vat = capture_float(payload.get("vatAmount"), "USt")
        gross = capture_float(payload.get("grossAmount"), "Brutto")
        if abs((net + vat) - gross) > 0.05:
            raise ValueError("Netto + USt stimmt nicht mit Brutto überein.")

        rows = payload.get("allocations") or []
        if not isinstance(rows, list) or not rows:
            raise ValueError("Mindestens eine Kontierungszeile ist erforderlich.")
        clean = []
        allocated = 0.0
        cost_types = set(ns.get("CAPTURE_COST_TYPES") or [])
        for index, item in enumerate(rows, 1):
            amount = capture_float(item.get("netAmount"), f"Kontierung Zeile {index}")
            allocated += amount
            cost_type = str(item.get("costType") or "Sonstiges").strip()
            if cost_types and cost_type not in cost_types:
                cost_type = "Sonstiges"
            clean.append({
                "line_no": index,
                "account": str(item.get("account") or "").strip(),
                "cost_type": cost_type,
                "cost_center": str(item.get("costCenter") or "").strip(),
                "project_id": str(item.get("projectId") or "").strip(),
                "description": str(item.get("description") or "").strip(),
                "net_amount": amount,
                "vat_rate": capture_float(item.get("vatRate"), f"USt-Satz Zeile {index}", allow_none=True),
            })
        if abs(allocated - net) > 0.02:
            raise ValueError("Kontierung stimmt nicht mit dem Netto überein.")

        pdf_bytes = upload.read()
        if not pdf_bytes:
            raise ValueError("PDF ist leer.")
        analysis = analyze_pdf(pdf_bytes, upload.filename)
        now = datetime.now().isoformat(timespec="seconds")
        context = supplier_context(address_id, area)
        invoice_iban = norm_iban(payload.get("invoiceIban") or analysis.get("iban"))
        master_iban = norm_iban(payload.get("masterIban") or context.get("latestIban"))
        accept_new_iban = capture_truthy(payload.get("acceptNewIban"))
        if accept_new_iban and (not invoice_iban or not iban_valid(invoice_iban)):
            raise ValueError("Die neue IBAN ist leer oder formal ungültig.")
        iban = invoice_iban if accept_new_iban else master_iban
        workflow = str(payload.get("workflowStatus") or "zu_pruefen")
        if workflow not in {"zu_pruefen", "geprueft"}:
            workflow = "zu_pruefen"

        con = area_connection(area)
        backups = []
        replaced_paths = []
        try:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (int(existing_id),)).fetchone()
            if not row or str(row["document_type"] or "") != PREPAYMENT_TYPE:
                raise ValueError("Die zu ersetzende Vorkassarechnung wurde nicht mehr gefunden.")
            if str(row["supplier_address_id"] or "") != address_id or str(row["supplier_invoice_number_norm"] or "") != number_norm:
                raise ValueError("Vorkassa und Originalrechnung passen nicht eindeutig zusammen.")
            if str(row["file_sha256"] or "") == str(analysis["sha256"]):
                raise ValueError("Die neue PDF ist identisch mit der Vorkassarechnung.")
            duplicate = con.execute(
                "SELECT doc_id FROM incoming_invoices WHERE file_sha256=? AND id<>? LIMIT 1",
                (analysis["sha256"], int(existing_id)),
            ).fetchone()
            if duplicate:
                raise ValueError(f"Diese PDF ist bereits als {duplicate['doc_id']} gespeichert.")

            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            archived = {}
            for field, label in (("pdf_path", "Arbeitsdatei"), ("original_path", "Original")):
                source = Path(str(row[field] or ""))
                if not source.is_file():
                    continue
                folder = source.parent / "Archiv"
                folder.mkdir(parents=True, exist_ok=True)
                target = folder / f"{row['doc_id']}_Vorkassa_{stamp}_{label}{source.suffix or '.pdf'}"
                shutil.copy2(source, target)
                backups.append((source, target))
                archived[field + "_archived"] = str(target)
            _snapshot(con, row, "prepayment_replaced", payload.get("createdBy") or "Dunja",
                      "Originalrechnung mit gleicher Lieferanten-Rechnungsnummer eingegangen", archived)

            for field in ("pdf_path", "original_path"):
                target = Path(str(row[field] or ""))
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name("." + target.name + ".replacement.tmp")
                temporary.write_bytes(pdf_bytes)
                temporary.replace(target)
                replaced_paths.append(target)

            con.execute("""
                UPDATE incoming_invoices SET
                    document_type='Rechnung', supplier_name=?, supplier_address=?,
                    supplier_number=?, our_customer_number=?, supplier_invoice_number=?,
                    supplier_invoice_number_norm=?, invoice_date=?, due_date=?, net_due_date=?,
                    skonto_enabled=?, skonto_percent=?, skonto_due_date=?, payment_terms=?,
                    net_amount=?, vat_amount=?, gross_amount=?, currency=?, iban=?, invoice_iban=?,
                    master_iban=?, bank_change_accepted=?, swift='', account_holder=?,
                    customer_number_external=?, workflow_status=?, booking_text=?, note=?,
                    original_filename=?, file_sha256=?, pdf_text=?, page_count=?, ocr_used=?,
                    ocr_pages=?, ocr_warning=?, created_by=?, updated_at=?
                WHERE id=?
            """, (
                supplier_name, str(supplier.get("address") or ""),
                str(supplier.get("supplierNumber") or ""), str(supplier.get("ourCustomerNumber") or ""),
                invoice_number, number_norm, invoice_date, net_due_date, net_due_date,
                1 if skonto_enabled else 0, skonto_percent, skonto_due_date,
                str(payload.get("paymentTerms") or "").strip()[:500], net, vat, gross,
                str(payload.get("currency") or "EUR")[:3].upper(), iban, invoice_iban, master_iban,
                1 if accept_new_iban else 0, str(payload.get("accountHolder") or "").strip(),
                str(supplier.get("ourCustomerNumber") or payload.get("customerNumberExternal") or analysis.get("customerNumberExternal") or "").strip(),
                workflow, str(payload.get("bookingText") or analysis.get("bookingText") or "").strip(),
                str(payload.get("note") or "").strip(), str(upload.filename or ""),
                analysis["sha256"], analysis.get("text") or "", int(analysis.get("pageCount") or 0),
                1 if analysis.get("ocrUsed") else 0, int(analysis.get("ocrPages") or 0),
                str(analysis.get("ocrWarning") or ""), str(payload.get("createdBy") or "Dunja")[:100],
                now, int(existing_id),
            ))
            con.execute("DELETE FROM incoming_allocations WHERE invoice_id=?", (int(existing_id),))
            for item in clean:
                con.execute("""
                    INSERT INTO incoming_allocations
                    (invoice_id,line_no,account,cost_type,cost_center,project_id,description,net_amount,vat_rate)
                    VALUES (?,?,?,?,?,?,?,?,?)
                """, (int(existing_id), item["line_no"], item["account"], item["cost_type"],
                      item["cost_center"], item["project_id"], item["description"],
                      item["net_amount"], item["vat_rate"]))
            if accept_new_iban and invoice_iban:
                con.execute("""
                    INSERT INTO supplier_bank_accounts
                    (supplier_address_id,iban,source_invoice_id,source_doc_id,confirmed_by,confirmed_at,note)
                    VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT(supplier_address_id,iban) DO UPDATE SET
                      source_invoice_id=excluded.source_invoice_id, source_doc_id=excluded.source_doc_id,
                      confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at,
                      note=excluded.note
                """, (address_id, invoice_iban, int(existing_id), str(row["doc_id"] or ""),
                      str(payload.get("createdBy") or "Dunja")[:100], now,
                      "Neue IBAN aus Originalrechnung nach Vorkassa übernommen"))
            con.commit()
            saved = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (int(existing_id),)).fetchone()
            result = public_row(saved, allocations_public(con, int(existing_id)), area=area)
        except Exception:
            con.rollback()
            for target, archive in backups:
                try:
                    shutil.copy2(archive, target)
                except Exception:
                    pass
            raise
        finally:
            con.close()

        try:
            from brain_capture_tax_ui import _save_tax_classes
            _save_tax_classes(area_connection, area, int(existing_id), rows)
        except Exception as exc:
            print("⚠ Steuerklassen nach Vorkassa-Ersatz nicht aktualisiert:", exc)
        return jsonify({
            "ok": True, "area": area, "trainingMode": area == "test",
            "invoice": result, "replacedPrepayment": True,
            "warnings": ["Vorkassarechnung ersetzt; OP- und Zahlungsstand wurden beibehalten"],
        })

    original_save = app.view_functions.get("incoming_capture_save")
    if original_save and not getattr(original_save, "_krista_prepayment_replace", False):
        def save_with_prepayment_replace():
            try:
                raw = request.form.get("payload") or "{}"
                payload = json.loads(raw) if isinstance(raw, str) else (raw or {})
                area = capture_area(payload.get("area") or "live")
                supplier = payload.get("supplier") or {}
                address_id = str(supplier.get("addressId") or "").strip()
                number = invoice_norm(payload.get("supplierInvoiceNumber"))
                doc_type = str(payload.get("documentType") or "Rechnung").strip()
                if doc_type == "Rechnung" and address_id and number:
                    con = area_connection(area)
                    try:
                        _ensure_history(con)
                        row = con.execute("""
                            SELECT id FROM incoming_invoices
                            WHERE supplier_address_id=? AND supplier_invoice_number_norm=?
                              AND document_type=?
                            ORDER BY id DESC LIMIT 1
                        """, (address_id, number, PREPAYMENT_TYPE)).fetchone()
                    finally:
                        con.close()
                    if row:
                        upload = request.files.get("file")
                        if not upload or not str(upload.filename or "").lower().endswith(".pdf"):
                            return jsonify(ok=False, error="PDF der Originalrechnung fehlt."), 400
                        return replace_prepayment(payload, upload, int(row["id"]), area)
            except ValueError as exc:
                return jsonify(ok=False, error=str(exc)), 400
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500
            return original_save()

        save_with_prepayment_replace.__name__ = "incoming_capture_save_prepayment_replace"
        save_with_prepayment_replace._krista_prepayment_replace = True
        app.view_functions["incoming_capture_save"] = save_with_prepayment_replace

    original_delete = app.view_functions.get("incoming_capture_delete")
    if original_delete and not getattr(original_delete, "_krista_live_archive_delete", False):
        def delete_or_archive(invoice_id):
            area = capture_area(request.args.get("area") or "live")
            if area == "test":
                return original_delete(invoice_id)
            body = request.get_json(silent=True) or {}
            reason = str(body.get("reason") or "").strip()
            actor = str(body.get("deletedBy") or "Dunja").strip() or "Dunja"
            con = area_connection("live")
            try:
                _ensure_history(con)
                con.execute("BEGIN IMMEDIATE")
                row = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (int(invoice_id),)).fetchone()
                if not row:
                    con.rollback()
                    return jsonify(ok=False, error="Rechnung nicht gefunden."), 404
                if str(body.get("confirm") or "") != str(row["doc_id"] or ""):
                    con.rollback()
                    return jsonify(ok=False, error="Die interne Belegnummer wurde nicht bestätigt."), 400
                if len(reason) < 3:
                    con.rollback()
                    return jsonify(ok=False, error="Bitte einen kurzen Löschgrund angeben."), 400
                if _payment_locked(con, invoice_id, row):
                    con.rollback()
                    return jsonify(ok=False, error="Bezahlte oder bereits an SEPA übergebene Rechnungen dürfen nicht gelöscht werden."), 409
                _snapshot(con, row, "deleted", actor, reason)
                con.execute("DELETE FROM brain_payment_meta WHERE source='KRISTINE' AND source_id=?", (f"kristine:{int(invoice_id)}",))
                con.execute("DELETE FROM incoming_invoices WHERE id=?", (int(invoice_id),))
                con.commit()
                return jsonify(ok=True, archived=True, deletedInvoiceId=int(invoice_id),
                               docId=str(row["doc_id"] or ""), filesPreserved=True)
            except Exception as exc:
                con.rollback()
                return jsonify(ok=False, error=str(exc)), 500
            finally:
                con.close()

        delete_or_archive.__name__ = "incoming_capture_delete_or_archive"
        delete_or_archive._krista_live_archive_delete = True
        app.view_functions["incoming_capture_delete"] = delete_or_archive

    if "brain_capture_prepayments" not in app.view_functions:
        @app.get("/incoming/capture/prepayments")
        def brain_capture_prepayments():
            try:
                area = capture_area(request.args.get("area") or "live")
                con = area_connection(area)
                try:
                    rows = con.execute("""
                        SELECT * FROM incoming_invoices
                        WHERE document_type=? ORDER BY invoice_date, id
                    """, (PREPAYMENT_TYPE,)).fetchall()
                    items = [public_row(row, allocations_public(con, int(row["id"])), area=area) for row in rows]
                finally:
                    con.close()
                return jsonify(ok=True, area=area, count=len(items), invoices=items)
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

    if "kristaCapturePrepaymentV1" in page:
        return

    css = r'''
.capture-prepayment-list{display:grid;gap:9px}.capture-prepayment-card{border:1px solid #82652d!important;background:#261f12!important}
.capture-prepayment-card .capture-badge{background:#6d4f18!important;color:#ffe1a1!important}.capture-delete-live{background:#713631!important;border-color:#a74f48!important;color:#fff!important}
.capture-prepayment-help{margin-top:5px;color:#e4c982;font-size:12px}.capture-document-note{margin-top:5px;color:#aeb8c2;font-size:11px}
'''
    script = r'''
<script id="kristaCapturePrepaymentV1">
(function(){
  if(typeof captureDocumentType==='undefined'||typeof captureRecent==='undefined')return;
  if(![...captureDocumentType.options].some(o=>o.value==='Vorkassarechnung')){
    const option=document.createElement('option');option.value='Vorkassarechnung';option.textContent='Vorkassarechnung';captureDocumentType.append(option);
  }
  if(!document.getElementById('captureDocumentTypeNote')){
    const note=document.createElement('div');note.id='captureDocumentTypeNote';note.className='capture-document-note';note.textContent='Vorkassa kommt sofort in die OP. Die spätere Rechnung mit derselben Nummer ersetzt sie automatisch.';captureDocumentType.insertAdjacentElement('afterend',note);
  }
  const recentSection=captureRecent.closest('.section');
  const section=document.createElement('div');section.className='section';section.id='capturePrepaymentSection';section.innerHTML='<div class="section-head"><div><h2>Vorkassarechnungen · Original fehlt</h2><div class="sub">Diese Belege sind in der OP. Bei Eingang der Rechnung dieselbe Lieferanten-Rechnungsnummer verwenden.</div></div><span class="capture-badge" id="capturePrepaymentCount">0 offen</span></div><div id="capturePrepaymentList" class="capture-prepayment-list"></div>';
  recentSection?.parentElement?.insertBefore(section,recentSection);
  const list=document.getElementById('capturePrepaymentList'),count=document.getElementById('capturePrepaymentCount');

  async function loadPrepayments(){
    if(captureAreaIsTest()){section.hidden=true;return}
    section.hidden=false;
    try{
      const response=await fetch('/incoming/capture/prepayments?area=live',{cache:'no-store'}),data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.error||'Vorkassaliste konnte nicht geladen werden');
      const rows=data.invoices||[];count.textContent=rows.length+' offen';
      list.innerHTML=rows.length?rows.map(x=>`<div class="card capture-prepayment-card"><div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(x.docId)} · ${esc(x.supplierName)}</strong><span class="capture-badge">Original fehlt</span></div><div class="sub">Rechnung ${esc(x.invoiceNumber)} · ${esc(captureDateDE(x.invoiceDate))}</div><div class="invoice-amount">${esc(invoiceMoney(x.grossAmount))}</div><div class="capture-prepayment-help">Die Originalrechnung mit derselben Nummer erfasst → diese Vorkassa wird automatisch ersetzt.</div><div class="actions"><a class="action" href="${urlFor('/pdf',x.path)}" target="_blank" rel="noopener">Vorkassa öffnen</a></div></div>`).join(''):'<div class="empty">Keine Vorkassarechnung wartet auf ein Original.</div>';
    }catch(error){list.innerHTML='<div class="empty error">'+esc(error.message)+'</div>'}
  }

  async function deleteLiveInvoice(x,button){
    const reason=prompt(`Beleg ${x.docId} · ${x.supplierName} wirklich aus Rechnungseingang und OP entfernen?\n\nDie PDF und eine vollständige Historie bleiben zur Wiederherstellung erhalten.\nBezahlte/SEPA-Belege sind gesperrt.\n\nLöschgrund:`,'Doppelt oder falsch erfasst');
    if(reason===null)return;if(reason.trim().length<3)return alert('Bitte einen kurzen Löschgrund eingeben.');
    if(!confirm(`${x.docId} jetzt archivieren und aus der OP entfernen?`))return;
    button.disabled=true;
    try{
      const response=await fetch('/incoming/capture/'+encodeURIComponent(x.id)+'?area=live',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:x.docId,reason:reason.trim(),deletedBy:document.getElementById('captureCreatedBy')?.value||'Dunja'})}),data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.error||'Löschen fehlgeschlagen');
      setCaptureMessage('✓ '+x.docId+' archiviert und aus der OP entfernt','success');await Promise.all([loadCaptureDashboard(),loadCaptureRecent(),loadPrepayments()]);
    }catch(error){button.disabled=false;alert(error.message)}
  }

  if(typeof renderCaptureRecent==='function'){
    const originalRender=renderCaptureRecent;
    renderCaptureRecent=function(rows){
      const result=originalRender.apply(this,arguments),cards=[...captureRecent.querySelectorAll(':scope > .card')];
      (rows||[]).forEach((x,index)=>{
        if(x.trainingMode)return;const actions=cards[index]?.querySelector('.actions');if(!actions||actions.querySelector('[data-delete-live]'))return;
        const button=document.createElement('button');button.type='button';button.className='capture-delete-live';button.dataset.deleteLive=String(x.id||'');button.textContent='Löschen';button.onclick=()=>deleteLiveInvoice(x,button);actions.append(button);
      });return result;
    };
  }
  if(typeof loadCaptureRecent==='function'){
    const originalLoad=loadCaptureRecent;loadCaptureRecent=async function(){const result=await originalLoad.apply(this,arguments);await loadPrepayments();return result};
  }
  loadPrepayments();
})();
</script>
'''
    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Rechnungseingang: Vorkassa-Ersatz · Original-Nachforderung · revisionssicheres Löschen")
