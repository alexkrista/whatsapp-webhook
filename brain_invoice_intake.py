# coding: utf-8
"""The Brain: gemeinsamer Rechnungseingang fuer spaetere Bearbeitung.

PDF/Fotos koennen im Brain nur abgelegt werden. KGO kann Belege per Handykamera
in denselben Eingang schicken. Jeder Eintrag behaelt Quelle, Person und Zeitpunkt.
Beim Bearbeiten wird ein Foto fuer die bestehende Rechnungserfassung verlustfrei
als Arbeits-PDF bereitgestellt; das Original bleibt im Eingang erhalten.
"""
from __future__ import annotations

import base64
import json
import re
import urllib.parse
import urllib.request
from io import BytesIO


def _safe_id(value):
    return re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))[:180]


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    kristine_api = ns.get("kristine_api_request")
    api_base = str(ns.get("KRISTINE_API_BASE") or "https://protokoll.krista.at").rstrip("/")
    admin_token = str(ns.get("KRISTINE_ADMIN_TOKEN") or "").strip()
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if app is None or not page or not callable(kristine_api):
        return

    routes = (
        "/incoming/intake-list",
        "/incoming/intake-import",
        "/incoming/intake-file",
        "/incoming/intake-complete",
    )
    if isinstance(allowed, set):
        for route in routes:
            allowed.add(route)

    if "brain_invoice_intake_list" not in app.view_functions:
        from flask import request, jsonify, send_file

        @app.get("/incoming/intake-list")
        def brain_invoice_intake_list():
            try:
                data = kristine_api("/kristine/api/invoice-intake") or {}
                rows = list(data.get("items") or [])
                rows.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)
                return jsonify(ok=True, count=len(rows), items=rows)
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 502

        @app.post("/incoming/intake-import")
        def brain_invoice_intake_import():
            try:
                upload = request.files.get("file")
                if not upload:
                    return jsonify(ok=False, error="Datei fehlt"), 400
                raw = upload.read()
                if not raw:
                    return jsonify(ok=False, error="Datei ist leer"), 400
                if len(raw) > 12 * 1024 * 1024:
                    return jsonify(ok=False, error="Datei ist größer als 12 MB"), 413
                name = str(upload.filename or "Rechnung.pdf")[:180]
                mime = str(upload.mimetype or "application/octet-stream")[:160]
                submitted_by = str(request.form.get("submittedByName") or "Brain")[:160]
                payload = {
                    "name": name,
                    "type": mime,
                    "data": base64.b64encode(raw).decode("ascii"),
                    "source": "Brain Eingang",
                    "submittedById": str(request.form.get("submittedById") or "brain")[:160],
                    "submittedByName": submitted_by,
                    "capturedAt": str(request.form.get("capturedAt") or "")[:60],
                    "paymentContext": str(request.form.get("paymentContext") or "")[:80],
                }
                result = kristine_api("/kristine/api/invoice-intake/import", method="POST", payload=payload) or {}
                return jsonify(result)
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 502

        @app.get("/incoming/intake-file")
        def brain_invoice_intake_file():
            item_id = _safe_id(request.args.get("id"))
            if not item_id:
                return jsonify(ok=False, error="Eingang fehlt"), 400
            if not admin_token:
                return jsonify(ok=False, error="KRISTINE_ADMIN_TOKEN fehlt"), 503
            url = (
                f"{api_base}/kristine/api/invoice-intake/{urllib.parse.quote(item_id)}/file"
                f"?token={urllib.parse.quote(admin_token)}"
            )
            try:
                req = urllib.request.Request(url, headers={"Accept": "*/*", "User-Agent": "KRISTINE-Brain/1.0"})
                with urllib.request.urlopen(req, timeout=30) as response:
                    raw = response.read()
                    mime = str(response.headers.get("content-type") or "application/octet-stream").split(";", 1)[0].strip().lower()
                    disposition = str(response.headers.get("content-disposition") or "")
                name_match = re.search(r"filename\*=UTF-8''([^;]+)", disposition, re.I)
                original_name = urllib.parse.unquote(name_match.group(1)) if name_match else f"{item_id}.bin"

                if mime == "application/pdf" or original_name.lower().endswith(".pdf"):
                    return send_file(BytesIO(raw), mimetype="application/pdf", download_name=original_name, as_attachment=False)

                if mime.startswith("image/") or re.search(r"\.(jpe?g|png|webp|heic|heif)$", original_name, re.I):
                    try:
                        import pymupdf
                        kind = {
                            "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/png": "png",
                            "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
                        }.get(mime)
                        if not kind:
                            ext = original_name.rsplit(".", 1)[-1].lower() if "." in original_name else "jpeg"
                            kind = "jpeg" if ext in {"jpg", "jpeg"} else ext
                        source = pymupdf.open(stream=raw, filetype=kind)
                        pdf_bytes = source.convert_to_pdf()
                        source.close()
                        pdf_name = re.sub(r"\.[^.]+$", "", original_name) + ".pdf"
                        return send_file(BytesIO(pdf_bytes), mimetype="application/pdf", download_name=pdf_name, as_attachment=False)
                    except Exception as exc:
                        return jsonify(ok=False, error=f"Foto konnte nicht als PDF geöffnet werden: {exc}"), 415

                return jsonify(ok=False, error="Dieses Dateiformat kann die Rechnungserfassung noch nicht öffnen."), 415
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 502

        @app.post("/incoming/intake-complete")
        def brain_invoice_intake_complete():
            try:
                body = request.get_json(silent=True) or {}
                item_id = _safe_id(body.get("id"))
                if not item_id:
                    return jsonify(ok=False, error="Eingang fehlt"), 400
                result = kristine_api(
                    f"/kristine/api/invoice-intake/{item_id}/complete",
                    method="POST",
                    payload={
                        "processedDocId": str(body.get("docId") or "")[:160],
                        "processedBy": str(body.get("processedBy") or "Dunja")[:160],
                    },
                ) or {}
                return jsonify(result)
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 502

    if "kristaInvoiceIntakeV1" in page:
        ns["MOBILE_PAGE"] = page
        return

    css = r'''
.invoice-intake{margin:14px 0;border:1px solid #46515d;border-radius:14px;background:#141920;padding:14px}
.invoice-intake-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.invoice-intake-head h3{margin:0}.invoice-intake-count{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:28px;padding:0 9px;border-radius:999px;background:#2d7047;color:#fff;font-weight:900;font-size:12px}
.invoice-intake-drop{margin-top:12px;border:2px dashed #566575;border-radius:12px;padding:15px;text-align:center;background:#10151b;cursor:pointer}.invoice-intake-drop.dragover{border-color:#6db486;background:#14241b}.invoice-intake-drop strong{display:block}.invoice-intake-drop small{display:block;color:#9faab5;margin-top:3px}
.invoice-intake-list{display:grid;gap:8px;margin-top:12px}.invoice-intake-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;border:1px solid #343d47;border-radius:11px;padding:10px 11px;background:#1b2128}.invoice-intake-title{font-weight:850;overflow-wrap:anywhere}.invoice-intake-meta{font-size:11px;color:#9faab5;margin-top:3px}.invoice-intake-actions{display:flex;gap:7px;flex-wrap:wrap}.invoice-intake-actions button,.invoice-intake-actions a{border:1px solid #526170;border-radius:9px;padding:8px 10px;background:#25303a;color:#fff;text-decoration:none;font-weight:800;font-size:12px;cursor:pointer}.invoice-intake-actions .primary{background:#2d7047;border-color:#3d8d5e}.invoice-intake-empty{padding:8px 0;color:#9faab5;font-size:12px}.invoice-intake-current{margin-top:10px;padding:9px 11px;border-radius:10px;background:#17301f;border:1px solid #3c7350;font-size:12px}.invoice-intake-current[hidden]{display:none!important}
@media(max-width:700px){.invoice-intake-item{grid-template-columns:1fr}.invoice-intake-actions>*{flex:1}}
'''

    script = r'''
<script id="kristaInvoiceIntakeV1">
(function(){
  if(typeof captureFile==='undefined')return;
  let currentIntakeId='',currentIntakeStamp='';
  const anchor=document.getElementById('captureDashboard')||captureFile.closest('.card')||captureFile.parentElement;
  if(!anchor)return;
  const panel=document.createElement('section');panel.id='invoiceIntakePanel';panel.className='invoice-intake';
  panel.innerHTML=`<div class="invoice-intake-head"><div><h3>📥 Rechnungseingang</h3><div class="sub">Nur ablegen. Dunja verarbeitet die Belege später.</div></div><span id="invoiceIntakeCount" class="invoice-intake-count">–</span></div><div id="invoiceIntakeDrop" class="invoice-intake-drop"><strong>PDF oder Foto hier hineinziehen</strong><small>Mehrere Dateien auf einmal möglich · landet nur im Eingangskorb</small><input id="invoiceIntakeFile" type="file" accept="application/pdf,image/*" multiple hidden></div><div id="invoiceIntakeCurrent" class="invoice-intake-current" hidden></div><div id="invoiceIntakeList" class="invoice-intake-list"><div class="invoice-intake-empty">Eingang wird geladen …</div></div>`;
  if(anchor.id==='captureDashboard')anchor.insertAdjacentElement('afterend',panel);else anchor.parentElement?.insertBefore(panel,anchor);
  const count=document.getElementById('invoiceIntakeCount'),drop=document.getElementById('invoiceIntakeDrop'),input=document.getElementById('invoiceIntakeFile'),list=document.getElementById('invoiceIntakeList'),current=document.getElementById('invoiceIntakeCurrent');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtTime=s=>{if(!s)return '';try{return new Intl.DateTimeFormat('de-AT',{dateStyle:'short',timeStyle:'short'}).format(new Date(s))}catch(_){return s}};
  const person=()=>document.querySelector('.krista-brain-user strong')?.textContent?.trim()||'Brain';
  async function load(){try{const r=await fetch('/incoming/intake-list',{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Eingang nicht erreichbar');const rows=d.items||[];count.textContent=rows.length;list.innerHTML=rows.length?rows.map(x=>`<div class="invoice-intake-item"><div><div class="invoice-intake-title">${esc(x.name||'Rechnung')}</div><div class="invoice-intake-meta">${esc(x.source||'Eingang')} · ${esc(x.submittedByName||'Unbekannt')} · ${esc(fmtTime(x.capturedAt||x.createdAt))}${x.paymentContext?' · '+esc(x.paymentContext):''}</div></div><div class="invoice-intake-actions"><button class="primary" type="button" data-intake="${esc(x.id)}" data-name="${esc(x.name||'Rechnung')}" data-stamp="${esc((x.source||'Eingang')+' · '+(x.submittedByName||'Unbekannt')+' · '+fmtTime(x.capturedAt||x.createdAt))}">Bearbeiten</button></div></div>`).join(''):'<div class="invoice-intake-empty">✓ Eingangskorb leer.</div>';list.querySelectorAll('[data-intake]').forEach(b=>b.onclick=()=>openItem(b.dataset.intake,b.dataset.name,b.dataset.stamp))}catch(e){count.textContent='!';list.innerHTML='<div class="invoice-intake-empty">'+esc(e.message||e)+'</div>'}}
  async function uploadFiles(files){const rows=[...(files||[])];if(!rows.length)return;drop.classList.remove('dragover');drop.querySelector('strong').textContent='Wird abgelegt …';let ok=0;for(const file of rows){try{const fd=new FormData();fd.append('file',file);fd.append('submittedById','brain');fd.append('submittedByName',person());fd.append('capturedAt',new Date().toISOString());const r=await fetch('/incoming/intake-import',{method:'POST',body:fd}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Upload fehlgeschlagen');ok++}catch(e){alert((file.name||'Datei')+': '+(e.message||e))}}drop.querySelector('strong').textContent='PDF oder Foto hier hineinziehen';if(ok)await load()}
  async function openItem(id,name,stamp){if(!id)return;try{if(typeof captureArea!=='undefined'&&captureArea!=='live'&&typeof setCaptureArea==='function'){await Promise.resolve(setCaptureArea('live'));await new Promise(r=>setTimeout(r,80))}currentIntakeId=id;currentIntakeStamp=stamp||'';current.hidden=false;current.innerHTML='<strong>In Bearbeitung:</strong> '+esc(name)+' · '+esc(stamp||'');const r=await fetch('/incoming/intake-file?id='+encodeURIComponent(id),{cache:'no-store'});if(!r.ok){let msg='Datei konnte nicht geöffnet werden';try{const d=await r.json();msg=d.error||msg}catch(_){}throw Error(msg)}const blob=await r.blob();const pdfName=String(name||'Rechnung').replace(/\.[^.]+$/, '')+'.pdf';const file=new File([blob],pdfName,{type:'application/pdf'});if(typeof setCaptureFile==='function')setCaptureFile(file);else{const dt=new DataTransfer();dt.items.add(file);captureFile.files=dt.files;captureFile.dispatchEvent(new Event('change',{bubbles:true}))}setTimeout(()=>{try{if(currentIntakeStamp&&captureNote&&!String(captureNote.value||'').includes(currentIntakeStamp))captureNote.value=(String(captureNote.value||'').trim()?String(captureNote.value||'').trim()+'\n':'')+'Eingang: '+currentIntakeStamp}catch(_){}},250)}catch(e){currentIntakeId='';currentIntakeStamp='';current.hidden=true;alert(e.message||e)}}
  drop.onclick=()=>input.click();input.onchange=()=>{const files=[...(input.files||[])];input.value='';uploadFiles(files)};['dragenter','dragover'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();e.stopPropagation();drop.classList.add('dragover')}));['dragleave','drop'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('dragover')}));drop.addEventListener('drop',e=>uploadFiles(e.dataTransfer?.files));
  const priorFetch=window.fetch.bind(window);window.fetch=async function(inputArg,init){const response=await priorFetch(inputArg,init);try{const url=typeof inputArg==='string'?inputArg:(inputArg?.url||'');if(currentIntakeId&&url.includes('/incoming/capture/save')&&!url.includes('/analyze')&&response.ok){response.clone().json().then(async d=>{if(!d?.ok||!d?.invoice?.docId)return;const id=currentIntakeId;currentIntakeId='';currentIntakeStamp='';current.hidden=true;try{await priorFetch('/incoming/intake-complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,docId:d.invoice.docId,processedBy:(typeof captureCreatedBy!=='undefined'?captureCreatedBy.value:'Dunja')||'Dunja'})});await load()}catch(_){}}).catch(()=>{})}}catch(_){}return response};
  load();setInterval(load,60000);
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Rechnungseingang aktiv: Brain-Drop + KGO-Scan · Person/Zeit · spaetere Bearbeitung")
