# coding: utf-8
"""TEST-Rechnung kontrolliert in den Echtbetrieb uebernehmen.

Prinzip:
- Die TEST-Rechnung bleibt als Uebungs-/Historieneintrag erhalten.
- Der Echtbeleg wird ueber denselben /incoming/capture/save-Workflow erzeugt wie
  eine normal erfasste Rechnung. Damit bleiben Nummernkreis, PDF-Ablage,
  Duplikatpruefung, FX-/Zahlungsweg und Freigabe-Workflow identisch.
- TEST-Freigabe, TEST-Zahlungsstatus und TEST-Abgleich werden nie uebernommen.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
from datetime import datetime
from pathlib import Path


def _norm(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _invoice_norm(value):
    return re.sub(r"[^A-Za-z0-9]+", "", str(value or "")).upper().strip()


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    area_connection = ns.get("_capture_area_connection")
    kristine_api = ns.get("kristine_api_request")
    if app is None or not page or not callable(area_connection):
        return

    def ensure_promotion_schema(con):
        con.execute("""
            CREATE TABLE IF NOT EXISTS brain_test_invoice_promotions(
                test_invoice_id INTEGER PRIMARY KEY,
                test_doc_id TEXT NOT NULL,
                live_invoice_id INTEGER NOT NULL,
                live_doc_id TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'created',
                promoted_at TEXT NOT NULL,
                promoted_by TEXT NOT NULL DEFAULT 'Alex'
            )
        """)
        con.commit()

    def ensure_supplier_schema(con):
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

    def promotion_rows():
        con = area_connection("test")
        try:
            ensure_promotion_schema(con)
            rows = con.execute("SELECT * FROM brain_test_invoice_promotions ORDER BY promoted_at DESC").fetchall()
            return [dict(row) for row in rows]
        finally:
            con.close()

    def save_promotion(test_invoice_id, test_doc_id, live_invoice_id, live_doc_id, mode="created"):
        now = datetime.now().isoformat(timespec="seconds")
        con = area_connection("test")
        try:
            ensure_promotion_schema(con)
            con.execute("""
                INSERT INTO brain_test_invoice_promotions
                    (test_invoice_id,test_doc_id,live_invoice_id,live_doc_id,mode,promoted_at,promoted_by)
                VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(test_invoice_id) DO UPDATE SET
                    live_invoice_id=excluded.live_invoice_id,
                    live_doc_id=excluded.live_doc_id,
                    mode=excluded.mode,
                    promoted_at=excluded.promoted_at,
                    promoted_by=excluded.promoted_by
            """, (
                int(test_invoice_id), str(test_doc_id or ""), int(live_invoice_id), str(live_doc_id or ""),
                str(mode or "created"), now, "Alex",
            ))
            con.commit()
        finally:
            con.close()

    def get_test_invoice(invoice_id):
        con = area_connection("test")
        try:
            ensure_promotion_schema(con)
            promoted = con.execute(
                "SELECT * FROM brain_test_invoice_promotions WHERE test_invoice_id=?",
                (int(invoice_id),),
            ).fetchone()
            if promoted:
                return None, [], dict(promoted)
            row = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (int(invoice_id),)).fetchone()
            if not row:
                return None, [], None
            allocations = con.execute("""
                SELECT line_no,account,cost_type,cost_center,project_id,description,net_amount,vat_rate
                FROM incoming_allocations WHERE invoice_id=? ORDER BY line_no
            """, (int(invoice_id),)).fetchall()
            return dict(row), [dict(x) for x in allocations], None
        finally:
            con.close()

    def test_local_supplier(address_id):
        if not str(address_id or "").startswith("kri:"):
            return None
        try:
            sid = int(str(address_id).split(":", 1)[1])
        except Exception:
            return None
        con = area_connection("test")
        try:
            ensure_supplier_schema(con)
            row = con.execute("SELECT * FROM incoming_suppliers WHERE id=?", (sid,)).fetchone()
            return dict(row) if row else None
        finally:
            con.close()

    def promote_local_supplier(test_supplier):
        """Lokalen TEST-Lieferanten dedupliziert im Echtbetrieb anlegen/verwenden."""
        if not test_supplier:
            return None
        now = datetime.now().isoformat(timespec="seconds")
        vat = re.sub(r"\s+", "", str(test_supplier.get("vat_id") or "")).upper().strip()
        name = re.sub(r"\s+", " ", str(test_supplier.get("name") or "")).strip()
        address = re.sub(r"\s+", " ", str(test_supplier.get("address") or "")).strip()
        con = area_connection("live")
        try:
            ensure_supplier_schema(con)
            found = None
            if vat:
                found = con.execute(
                    "SELECT * FROM incoming_suppliers WHERE UPPER(COALESCE(vat_id,''))=? ORDER BY id LIMIT 1",
                    (vat,),
                ).fetchone()
            if not found:
                for row in con.execute("SELECT * FROM incoming_suppliers ORDER BY id").fetchall():
                    if _norm(row["name"]) == _norm(name) and _norm(row["address"]) == _norm(address):
                        found = row
                        break
            if found:
                sid = int(found["id"])
            else:
                cur = con.execute("""
                    INSERT INTO incoming_suppliers
                    (name,address,vat_id,email,phone,our_customer_number,iban,swift,account_holder,supplier_number,created_at,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    name, address, vat,
                    str(test_supplier.get("email") or ""), str(test_supplier.get("phone") or ""),
                    str(test_supplier.get("our_customer_number") or ""), str(test_supplier.get("iban") or ""),
                    str(test_supplier.get("swift") or ""), str(test_supplier.get("account_holder") or ""),
                    "", now, now,
                ))
                sid = int(cur.lastrowid)
                con.execute("UPDATE incoming_suppliers SET supplier_number=? WHERE id=?", (f"KRI-{sid:05d}", sid))
                con.commit()
            row = con.execute("SELECT * FROM incoming_suppliers WHERE id=?", (sid,)).fetchone()
            d = dict(row)
            return {
                "addressId": f"kri:{sid}",
                "name": str(d.get("name") or name),
                "address": str(d.get("address") or address),
                "supplierNumber": str(d.get("supplier_number") or f"KRI-{sid:05d}"),
                "ourCustomerNumber": str(d.get("our_customer_number") or ""),
                "vatId": str(d.get("vat_id") or ""),
                "iban": str(d.get("iban") or ""),
                "swift": str(d.get("swift") or ""),
                "accountHolder": str(d.get("account_holder") or ""),
                "source": "KRISTINE",
            }
        finally:
            con.close()

    def source_pdf(row):
        candidates = [row.get("original_path"), row.get("pdf_path")]
        for raw in candidates:
            path = Path(str(raw or ""))
            if path.is_file():
                return path
        return None

    def find_live_duplicate(row, pdf_bytes):
        sha = hashlib.sha256(pdf_bytes).hexdigest()
        inv = _invoice_norm(row.get("supplier_invoice_number"))
        supplier_name = _norm(row.get("supplier_name"))
        con = area_connection("live")
        try:
            rows = con.execute("""
                SELECT id,doc_id,supplier_name,supplier_invoice_number,file_sha256
                FROM incoming_invoices
                WHERE file_sha256=? OR supplier_invoice_number_norm=?
                ORDER BY id DESC
            """, (sha, inv)).fetchall()
            for item in rows:
                d = dict(item)
                if str(d.get("file_sha256") or "") == sha:
                    return d
                if _norm(d.get("supplier_name")) == supplier_name and _invoice_norm(d.get("supplier_invoice_number")) == inv:
                    return d
            return None
        finally:
            con.close()

    def supplier_for_live(row):
        address_id = str(row.get("supplier_address_id") or "")
        if address_id.startswith("kri:"):
            local = test_local_supplier(address_id)
            if not local:
                raise ValueError("Der lokale TEST-Lieferant wurde nicht gefunden.")
            supplier = promote_local_supplier(local)
            if not supplier:
                raise ValueError("Der Lieferant konnte nicht in den Echtbetrieb uebernommen werden.")
            return supplier
        return {
            "addressId": address_id,
            "name": str(row.get("supplier_name") or ""),
            "address": str(row.get("supplier_address") or ""),
            "supplierNumber": str(row.get("supplier_number") or ""),
            "ourCustomerNumber": str(row.get("our_customer_number") or ""),
            "source": "WinWorker",
        }

    def build_payload(row, allocations, supplier):
        d = dict(row)
        payload = {
            "area": "live",
            "trainingMode": False,
            "documentType": str(d.get("document_type") or "Rechnung"),
            "supplier": supplier,
            "supplierInvoiceNumber": str(d.get("supplier_invoice_number") or ""),
            "invoiceDate": str(d.get("invoice_date") or ""),
            "dueDate": str(d.get("due_date") or d.get("net_due_date") or ""),
            "netDueDate": str(d.get("net_due_date") or d.get("due_date") or ""),
            "skontoEnabled": bool(d.get("skonto_enabled") or 0),
            "skontoPercent": d.get("skonto_percent"),
            "skontoDueDate": str(d.get("skonto_due_date") or ""),
            "paymentTerms": str(d.get("payment_terms") or ""),
            "netAmount": float(d.get("net_amount") or 0),
            "vatAmount": float(d.get("vat_amount") or 0),
            "grossAmount": float(d.get("gross_amount") or 0),
            "currency": str(d.get("currency") or "EUR"),
            "invoiceIban": str(d.get("invoice_iban") or d.get("iban") or ""),
            "masterIban": str(supplier.get("iban") or d.get("master_iban") or ""),
            # TEST-Bestaetigung niemals still in den Echtbetrieb uebernehmen.
            "acceptNewIban": False,
            "accountHolder": str(supplier.get("accountHolder") or d.get("account_holder") or ""),
            "customerNumberExternal": str(d.get("customer_number_external") or ""),
            "workflowStatus": "zu_pruefen",
            "bookingText": str(d.get("booking_text") or ""),
            "note": str(d.get("note") or ""),
            "createdBy": str(d.get("created_by") or "Dunja"),
            "allocations": [
                {
                    "account": str(x.get("account") or ""),
                    "costType": str(x.get("cost_type") or "Sonstiges"),
                    "costCenter": str(x.get("cost_center") or ""),
                    "projectId": str(x.get("project_id") or ""),
                    "description": str(x.get("description") or ""),
                    "netAmount": float(x.get("net_amount") or 0),
                    "vatRate": x.get("vat_rate"),
                }
                for x in allocations
            ],
            # Zahlungsweg und Erfassungs-FX sind Sachinformationen und duerfen mit.
            # Zahlungsstatus/Settlement kommen bewusst NICHT mit.
            "paymentMethod": str(d.get("payment_method") or "unknown"),
            "fxRateToEur": d.get("fx_rate_to_eur"),
            "fxRateDate": str(d.get("fx_rate_date") or ""),
            "fxRateSource": str(d.get("fx_rate_source") or ""),
            "fxTolerancePercent": d.get("fx_tolerance_percent"),
            "fxToleranceEur": d.get("fx_tolerance_eur"),
        }
        return payload

    def call_live_save(payload, pdf_bytes, filename):
        save_view = app.view_functions.get("incoming_capture_save")
        if not save_view:
            raise RuntimeError("Echt-Erfassung ist nicht verfuegbar.")
        safe_name = str(filename or "Rechnung.pdf")
        if not safe_name.lower().endswith(".pdf"):
            safe_name = "Rechnung.pdf"
        with app.test_request_context(
            "/incoming/capture/save",
            method="POST",
            data={
                "payload": json.dumps(payload, ensure_ascii=False),
                "file": (io.BytesIO(pdf_bytes), safe_name),
            },
            content_type="multipart/form-data",
            environ_base={"REMOTE_ADDR": "127.0.0.1"},
        ):
            response = app.make_response(save_view())
            # after_request bewusst ausfuehren: dort entstehen u.a. echte Freigabe-Aufgaben.
            response = app.process_response(response)
            body = response.get_json(silent=True) or {}
            return response.status_code, body

    def sync_live_finance():
        view = app.view_functions.get("brain_incoming_payment_approvals_sync")
        if not view:
            return
        try:
            with app.test_request_context(
                "/incoming/payment-approvals/sync", method="POST", environ_base={"REMOTE_ADDR": "127.0.0.1"}
            ):
                response = app.make_response(view())
                app.process_response(response)
        except Exception as exc:
            print("⚠ TEST→Echt: Freigabe-Sync konnte nicht nachgezogen werden:", exc)

    def close_test_finance_task(test_invoice_id, live_doc_id):
        if not callable(kristine_api):
            return
        try:
            from brain_finance_runtime import _parse_finance_task
            boot = kristine_api("/kristine/api/bootstrap") or {}
            tasks = list(boot.get("tasks") or [])
            wanted = f"kristine:{int(test_invoice_id)}"
            changed = False
            now = datetime.now().isoformat(timespec="seconds")
            for task in tasks:
                meta = _parse_finance_task(task)
                if not meta:
                    continue
                if str(meta.get("source") or "") != "KRISTINE_TEST" or str(meta.get("id") or "") != wanted:
                    continue
                task["status"] = "done"
                task["completedAt"] = now
                title = str(task.get("title") or "🧪 TEST · Rechnung")
                suffix = f" → {live_doc_id}"
                if suffix not in title:
                    task["title"] = (title + suffix)[:180]
                changed = True
            if changed:
                kristine_api("/kristine/api/tasks", method="PUT", payload={"tasks": tasks})
        except Exception as exc:
            print("⚠ TEST→Echt: TEST-Freigabe konnte nicht abgeschlossen werden:", exc)

    if "brain_test_invoice_promotions" not in app.view_functions:
        from flask import jsonify, request

        @app.get("/incoming/capture/test-promotions")
        def brain_test_invoice_promotions():
            try:
                rows = promotion_rows()
                return jsonify({"ok": True, "count": len(rows), "items": rows})
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

        @app.post("/incoming/capture/<int:invoice_id>/promote")
        def brain_test_invoice_promote(invoice_id):
            try:
                body = request.get_json(silent=True) or {}
                if not body.get("confirm"):
                    return jsonify({"ok": False, "error": "Bestaetigung zum Scharfstellen fehlt."}), 400

                row, allocations, promoted = get_test_invoice(invoice_id)
                if promoted:
                    return jsonify({
                        "ok": True, "alreadyPromoted": True,
                        "testInvoiceId": int(invoice_id),
                        "liveInvoiceId": int(promoted.get("live_invoice_id") or 0),
                        "liveDocId": str(promoted.get("live_doc_id") or ""),
                        "mode": str(promoted.get("mode") or "created"),
                    })
                if not row:
                    return jsonify({"ok": False, "error": "TEST-Rechnung nicht gefunden."}), 404
                if not allocations:
                    raise ValueError("Die TEST-Rechnung hat keine Kontierung und kann nicht scharf gestellt werden.")

                pdf_path = source_pdf(row)
                if not pdf_path:
                    raise ValueError("Die Original-PDF der TEST-Rechnung wurde nicht gefunden.")
                pdf_bytes = pdf_path.read_bytes()
                if not pdf_bytes:
                    raise ValueError("Die Original-PDF ist leer.")

                # Vor dem Anlegen lokaler Stammdaten pruefen, ob der Beleg ohnehin schon live existiert.
                duplicate = find_live_duplicate(row, pdf_bytes)
                if duplicate:
                    save_promotion(invoice_id, row.get("doc_id"), duplicate["id"], duplicate["doc_id"], "linked_existing")
                    close_test_finance_task(invoice_id, duplicate["doc_id"])
                    sync_live_finance()
                    return jsonify({
                        "ok": True, "linkedExisting": True,
                        "testInvoiceId": int(invoice_id), "testDocId": str(row.get("doc_id") or ""),
                        "liveInvoiceId": int(duplicate["id"]), "liveDocId": str(duplicate["doc_id"] or ""),
                        "message": f"Bereits im Echtbetrieb vorhanden: {duplicate['doc_id']}",
                    })

                supplier = supplier_for_live(row)
                payload = build_payload(row, allocations, supplier)
                status, saved = call_live_save(payload, pdf_bytes, row.get("original_filename") or pdf_path.name)
                if status >= 400 or not saved.get("ok"):
                    error = str(saved.get("error") or f"Echt-Erfassung HTTP {status}")
                    return jsonify({"ok": False, "error": error}), (409 if "Doppelte Rechnung" in error else 400)

                invoice = saved.get("invoice") or {}
                live_id = int(invoice.get("id") or 0)
                live_doc = str(invoice.get("docId") or invoice.get("doc_id") or "")
                if not live_id or not live_doc:
                    raise RuntimeError("Echtbeleg wurde gespeichert, aber die neue Belegnummer fehlt.")
                save_promotion(invoice_id, row.get("doc_id"), live_id, live_doc, "created")
                close_test_finance_task(invoice_id, live_doc)

                warnings = list(saved.get("warnings") or [])
                warnings.append("TEST-Freigabe und TEST-Zahlungsstatus wurden nicht uebernommen.")
                if row.get("bank_change_accepted"):
                    warnings.append("Die TEST-Bestaetigung einer neuen IBAN wurde im Echtbetrieb bewusst nicht automatisch bestaetigt.")
                return jsonify({
                    "ok": True,
                    "testInvoiceId": int(invoice_id), "testDocId": str(row.get("doc_id") or ""),
                    "liveInvoiceId": live_id, "liveDocId": live_doc,
                    "invoice": invoice, "warnings": warnings,
                    "message": f"{live_doc} ist jetzt im Echtbetrieb und wartet auf echte Freigabe.",
                })
            except ValueError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 500

    if "kristaTestPromoteV1" in page:
        ns["MOBILE_PAGE"] = page
        return

    css = r'''
.capture-promote-button{background:#2f7d4a!important;border-color:#2f7d4a!important;color:#fff!important;font-weight:900}
.capture-promote-button:hover{background:#235e38!important}.capture-promoted-badge{display:inline-flex;align-items:center;min-height:36px;padding:7px 10px;border:1px solid #3f7952;border-radius:9px;background:#173a24;color:#bce4c7;font-size:12px;font-weight:900}
'''

    script = r'''
<script id="kristaTestPromoteV1">
(function(){
  if(typeof captureRecent==='undefined'||typeof renderCaptureRecent!=='function')return;
  let promotionMap=new Map(),latestRows=[];
  const currentArea=()=>{try{return captureArea==='live'?'live':'test'}catch(_){return 'test'}};

  async function loadPromotions(){
    if(currentArea()!=='test'){promotionMap=new Map();decorate(latestRows);return}
    try{
      const r=await fetch('/incoming/capture/test-promotions',{cache:'no-store'}),d=await r.json();
      if(!r.ok||!d.ok)throw new Error(d.error||'TEST-Status konnte nicht geladen werden');
      promotionMap=new Map((d.items||[]).map(x=>[Number(x.test_invoice_id),x]));decorate(latestRows);
    }catch(e){console.warn('TEST→Echt Status:',e)}
  }

  function decorate(rows){
    const cards=[...captureRecent.querySelectorAll(':scope > .card')];
    (rows||[]).forEach((x,i)=>{
      const actions=cards[i]?.querySelector('.actions');if(!actions)return;
      actions.querySelectorAll('[data-promote-invoice],.capture-promoted-badge').forEach(n=>n.remove());
      if(currentArea()!=='test')return;
      const promoted=promotionMap.get(Number(x.id||0));
      if(promoted){
        const badge=document.createElement('span');badge.className='capture-promoted-badge';badge.textContent='✓ Scharf · '+String(promoted.live_doc_id||'Echtbetrieb');actions.insertBefore(badge,actions.firstChild);return;
      }
      const b=document.createElement('button');b.type='button';b.className='capture-promote-button';b.dataset.promoteInvoice=String(x.id||'');b.textContent='🚀 Scharf stellen';
      b.onclick=()=>promote(x,b);actions.insertBefore(b,actions.firstChild);
    });
  }

  async function promote(x,button){
    const label=[x.docId||'TEST-Rechnung',x.supplierName||x.supplier||'',x.invoiceNumber||''].filter(Boolean).join(' · ');
    if(!confirm('Diese Rechnung wirklich in den ECHTBETRIEB übernehmen?\n\n'+label+'\n\nDie Daten und das Original-PDF werden übernommen. TEST-Freigabe, TEST-Zahlungsstatus und TEST-Abgleich werden NICHT übernommen. Im Echtbetrieb entsteht eine neue echte Freigabe.'))return;
    const old=button.textContent;button.disabled=true;button.textContent='⏳ wird scharf …';
    try{
      const r=await fetch('/incoming/capture/'+encodeURIComponent(x.id)+'/promote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})}),d=await r.json();
      if(!r.ok||!d.ok)throw new Error(d.error||'Scharfstellen fehlgeschlagen');
      promotionMap.set(Number(x.id),{test_invoice_id:Number(x.id),live_invoice_id:d.liveInvoiceId,live_doc_id:d.liveDocId,mode:d.linkedExisting?'linked_existing':'created'});
      decorate(latestRows);
      if(typeof setCaptureMessage==='function')setCaptureMessage('✓ '+(d.message||((d.liveDocId||'Rechnung')+' ist jetzt im Echtbetrieb.')),'success');
      alert((d.linkedExisting?'Bereits scharf: ':'Scharf gestellt: ')+(d.liveDocId||'Echtbetrieb')+'\n\nIm Echtbetrieb läuft jetzt der echte Freigabe-Workflow.');
    }catch(e){button.disabled=false;button.textContent=old;alert(e.message||String(e))}
  }

  const originalRender=renderCaptureRecent;
  renderCaptureRecent=function(rows){latestRows=Array.isArray(rows)?rows:[];const result=originalRender.apply(this,arguments);decorate(latestRows);return result};
  document.getElementById('captureAreaTest')?.addEventListener('click',()=>setTimeout(loadPromotions,0));
  document.getElementById('captureAreaLive')?.addEventListener('click',()=>setTimeout(loadPromotions,0));
  loadPromotions();
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ TEST→Echt aktiv: Scharf stellen ohne Neueingabe · echte Freigabe neu")
