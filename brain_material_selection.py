# coding: utf-8
"""Material aus archivierten Rechnungen: markierbare PDF-Texte und geprüfte Übernahme."""
from __future__ import annotations

import math
import secrets
import threading
import time
from pathlib import Path

from brain_invoice_material_review import extract_material_lines


def compact(value):
    return " ".join(str(value or "").split())


def page_text(ns, path, number):
    with ns["pymupdf"].open(path) as document:
        if number < 1 or number > document.page_count:
            raise ValueError("PDF-Seite existiert nicht.")
        page = document[number - 1]
        words = page.get_text("words", sort=True)
        if len("".join(str(w[4]) for w in words)) < 20:
            try:
                tp = page.get_textpage_ocr(language=ns.get("CAPTURE_OCR_LANG") or "deu+eng", dpi=190, full=True)
                words = page.get_text("words", textpage=tp, sort=True)
            except Exception:
                pass
        # get_text coordinates are unrotated; page images use the rotated page rect.
        result = []
        for word in words:
            rect = ns["pymupdf"].Rect(*word[:4]) * page.rotation_matrix
            result.append(dict(x0=rect.x0, y0=rect.y0, x1=rect.x1, y1=rect.y1,
                               text=str(word[4]), line=list(word[5:7])))
        return dict(width=page.rect.width, height=page.rect.height, words=result, page=number)


def source_metadata(ns, path):
    row = next((r for r in ns["_incoming_catalog"]() if str(r.get("path")) == str(path)), {})
    raw = row.get("_raw_text") or ""
    if not raw:
        with ns["pymupdf"].open(path) as document:
            raw = "\n".join(document[i].get_text() for i in range(min(2, document.page_count)))
    fingerprint = ns["_extract_supplier_fingerprint"](raw) if raw else {}
    supplier = row.get("_supplier") or ns.get("_extract_supplier_identity", lambda _: {})(raw)
    return dict(path=str(path), supplier=supplier.get("name") or "",
                invoiceNumber=fingerprint.get("invoiceNumber") or "", invoiceDate=row.get("invoiceDate") or "",
                indexedText=raw)


def draft_from_selection(ns, body):
    path = ns["validate_indexed_pdf_path"](body.get("path"))
    test_root = ns.get("CAPTURE_TEST_ROOT")
    if test_root and Path(path).resolve().is_relative_to(Path(test_root).resolve()):
        raise ValueError("Testgelände: Der Materialstamm bleibt unverändert.")
    selection = compact(body.get("selection"))
    if not selection or len(selection) > 600:
        raise ValueError("Bitte eine einzelne Materialposition mit höchstens 600 Zeichen markieren.")
    source = source_metadata(ns, path)
    number = int(body.get("page") or 0)
    if number:
        data = page_text(ns, path, number)
        text = " ".join(w["text"] for w in data["words"])
        if selection not in compact(text):
            raise ValueError("Die Auswahl passt nicht mehr zur PDF-Seite. Bitte erneut markieren.")
    elif selection not in compact(source["indexedText"]):
        raise ValueError("Bitte die Rechnung öffnen und die vollständige Position markieren.")
    source.pop("indexedText")
    source.update(page=number, selection=selection)
    parsed = extract_material_lines(selection)
    line = parsed[0] if len(parsed) == 1 else {}
    fields = dict(product=line.get("description") or selection[:180], supplier=source["supplier"],
                  supplierArticleNumber=line.get("sku") or "", unit=line.get("unit") or "Stk",
                  containerSize=line.get("containerSize") or 1, purchasePrice=line.get("unitPrice", ""))
    return dict(source=source, fields=fields, recognized=bool(line))


def material_payload(draft, fields):
    limits = dict(product=180, supplier=120, supplierArticleNumber=100, unit=20)
    payload = {}
    for key, limit in limits.items():
        value = compact(fields.get(key))
        if len(value) > limit or (not value and key != "supplierArticleNumber"):
            raise ValueError("Bitte Name, Lieferant und Einheit vollständig und in zulässiger Länge angeben.")
        payload[key] = value
    for key in ("purchasePrice", "containerSize"):
        raw = str(fields.get(key, "")).strip()
        if "," in raw:
            raw = raw.replace(".", "").replace(",", ".")
        try:
            number = float(raw)
        except ValueError:
            raise ValueError("Bitte EK netto und Gebinde als Zahl eintragen.")
        if not math.isfinite(number) or number <= 0:
            raise ValueError("EK netto und Gebinde müssen größer als null sein.")
        payload[key] = number
    source = draft["source"]
    note = (f"The Brain · Rechnung {source['invoiceNumber'] or 'ohne erkannte Nummer'}"
            f" · {source['invoiceDate']} · Lieferant: {source['supplier'] or payload['supplier']}\n"
            f"Quelle: {source['path']}" + (f" · Seite {source['page']}" if source['page'] else "")
            + f"\nRechnungsposition: {source['selection']}")
    if len(note) > 1000:
        raise ValueError("Die Quellenangabe ist zu lang. Bitte eine kürzere Einzelposition markieren.")
    payload.update(note=note, sourceSheet="The Brain · Rechnungsposition", group="Sonstiges")
    if source["invoiceDate"]:
        payload.update(priceValidFrom=source["invoiceDate"], priceCheckedAt=source["invoiceDate"])
    return payload


def save_material(ns, draft, fields):
    payload = material_payload(draft, fields)
    data = ns["kristine_api_request"]("/admin/api/materials?limit=5000")
    if not data.get("ok", True):
        raise ValueError(data.get("error") or "Materialstamm konnte nicht geprüft werden.")
    for row in data.get("materials") or []:
        same_name = compact(row.get("product")).casefold() == payload["product"].casefold()
        same_article = (payload["supplierArticleNumber"] and
                        compact(row.get("supplierArticleNumber")).casefold() == payload["supplierArticleNumber"].casefold() and
                        compact(row.get("supplier")).casefold() == payload["supplier"].casefold())
        if same_name or same_article:
            return dict(ok=True, created=False, material=row)
    # Existing API performs its own name duplicate check. Never force a duplicate or update prices.
    return ns["kristine_api_request"]("/admin/api/materials/auto", method="POST", payload=payload)


def install(ns):
    app = ns.get("app")
    if app is None or not ns.get("MOBILE_PAGE") or "brain_selection_text" in app.view_functions:
        return
    from flask import jsonify, request
    drafts = {}
    lock = threading.Lock()
    prefix = "/incoming/capture/material-selection"

    @app.get(prefix + "/text")
    def brain_selection_text():
        try:
            path = ns["validate_indexed_pdf_path"](request.args.get("path"))
            return jsonify(ok=True, **page_text(ns, path, int(request.args.get("page", 1))))
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400

    @app.post(prefix + "/preview")
    def brain_selection_preview():
        try:
            draft = draft_from_selection(ns, request.get_json(silent=True) or {})
            with lock:
                for key in list(drafts):
                    if drafts[key]["expires"] < time.monotonic():
                        drafts.pop(key)
                if len(drafts) >= 300:
                    raise ValueError("Zu viele offene Materialentwürfe. Bitte später erneut versuchen.")
                token = secrets.token_urlsafe(24)
                drafts[token] = dict(draft=draft, expires=time.monotonic() + 3600, result=None)
            return jsonify(ok=True, token=token, **draft)
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400

    @app.post(prefix + "/save")
    def brain_selection_save():
        try:
            body = request.get_json(silent=True) or {}
            with lock:
                entry = drafts.get(str(body.get("token") or ""))
                if not entry or entry["expires"] < time.monotonic():
                    raise ValueError("Entwurf abgelaufen. Bitte die Position erneut auswählen.")
                if entry["result"] is None:
                    result = save_material(ns, entry["draft"], body.get("fields") or {})
                    if not result.get("ok", True):
                        raise ValueError(result.get("error") or "Speichern fehlgeschlagen.")
                    entry["result"] = result
                return jsonify(entry["result"])
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400

    ns["MOBILE_PAGE"] = ns["MOBILE_PAGE"].replace("</body>", UI + "\n</body>", 1)


UI = r'''
<style>
#brainSelectionLayer{position:absolute;text-align:left;z-index:1;user-select:text;-webkit-user-select:text;color:transparent;line-height:1;pointer-events:auto}
#brainSelectionLayer span{position:absolute;white-space:pre;transform-origin:0 0;color:transparent;cursor:text;user-select:text;-webkit-user-select:text}
#brainSelectionLayer span::selection{background:rgba(40,125,255,.4);color:transparent}
#brainSelectionStatus{padding:6px 14px;font-size:12px;color:#cbd4df}
.brain-line-actions{display:flex;gap:6px;margin:5px 0 10px}.brain-line-actions button{padding:5px 9px;font-size:12px}
#brainMaterialDialog{width:min(640px,94vw);max-height:90vh;overflow:auto;background:#141a22;color:#fff;border:1px solid #536171;border-radius:14px;padding:20px;z-index:11000}
#brainMaterialDialog::backdrop{background:#000b}#brainMaterialDialog form{display:grid;gap:12px}#brainMaterialDialog label{display:grid;gap:4px;font-size:13px}
#brainMaterialDialog input{width:100%;box-sizing:border-box;padding:9px;background:#0d1217;color:#fff;border:1px solid #536171;border-radius:6px}
#brainMaterialSource{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:#cbd4df}.material-hit-line{user-select:text;-webkit-user-select:text}
</style>
<dialog id="brainMaterialDialog" aria-labelledby="brainMaterialTitle">
 <form id="brainMaterialForm"><strong id="brainMaterialTitle">Material aus Rechnungsposition anlegen</strong>
 <div id="brainMaterialSource"></div><div id="brainMaterialMessage" role="status"></div>
 <label>Materialname<input name="product" required maxlength="180"></label>
 <label>Lieferant<input name="supplier" required maxlength="120"></label>
 <label>Artikelnummer des Lieferanten<input name="supplierArticleNumber" maxlength="100"></label>
 <label>Einheit<input name="unit" required maxlength="20" list="brainMaterialUnits"></label>
 <datalist id="brainMaterialUnits"><option value="Stk"><option value="l"><option value="kg"><option value="m"><option value="m²"><option value="Rolle"><option value="Gebinde"></datalist>
 <label>Gebindegröße<input name="containerSize" required inputmode="decimal"></label>
 <label>EK netto pro Gebinde / Einheit (€)<input name="purchasePrice" required inputmode="decimal"></label>
 <div class="actions"><button id="brainMaterialSave" type="submit">Im Materialstamm speichern</button><button id="brainMaterialCancel" type="button">Schließen</button></div>
 </form>
</dialog>
<script id="brainMaterialSelectionV1">
(function(){
 const modal=document.getElementById('pdfSuperModal'),stage=document.getElementById('pdfStage'),img=document.getElementById('pdfImage');
 if(!modal||!stage||!img)return;
 const prefix='/incoming/capture/material-selection',dialog=document.getElementById('brainMaterialDialog'),form=document.getElementById('brainMaterialForm'),message=document.getElementById('brainMaterialMessage'),save=document.getElementById('brainMaterialSave');
 let selected='',selectedContext=null,requestId=0,draftToken='',previewId=0,saving=false;
 const layer=document.createElement('div');layer.id='brainSelectionLayer';stage.append(layer);
 const status=document.createElement('div');status.id='brainSelectionStatus';status.setAttribute('role','status');stage.before(status);
 const tools=modal.querySelector('.pdf-super-tools'),copy=document.createElement('button'),create=document.createElement('button');
 copy.type=create.type='button';copy.textContent='Auswahl kopieren';create.textContent='＋ Material aus Auswahl';tools.append(copy,create);
 function context(){return {path:pdfState.path,page:pdfState.page}}
 function reset(){requestId++;selected='';selectedContext=null;layer.replaceChildren();copy.disabled=create.disabled=true;status.textContent='Text wird geladen …'}
 reset();
 async function api(path,body){const r=await fetch(prefix+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Anfrage fehlgeschlagen');return d}
 async function loadText(){
  const id=++requestId,ctx=context(),src=img.getAttribute('src');
  try{const d=await api('/text?path='+encodeURIComponent(ctx.path)+'&page='+ctx.page);
   if(id!==requestId||modal.hidden||src!==img.getAttribute('src'))return;
   const sx=img.offsetWidth/d.width,sy=img.offsetHeight/d.height;
   layer.style.left=img.offsetLeft+'px';layer.style.top=img.offsetTop+'px';layer.style.width=img.offsetWidth+'px';layer.style.height=img.offsetHeight+'px';
   layer.replaceChildren();
   for(const w of d.words){const s=document.createElement('span');s.textContent=w.text+' ';s.style.left=w.x0*sx+'px';s.style.top=w.y0*sy+'px';s.style.fontSize=Math.max(5,(w.y1-w.y0)*sy*.85)+'px';s.style.height=(w.y1-w.y0)*sy+'px';layer.append(s);const measured=s.getBoundingClientRect().width;if(measured)s.style.transform='scaleX('+((w.x1-w.x0)*sx/measured)+')'}
   status.textContent=d.words.length?'Rechnungsposition mit der Maus oder durch langes Drücken markieren.':'Kein auswählbarer Text erkannt. Bitte die Textzeile aus den Suchtreffern verwenden.';
  }catch(e){if(id===requestId)status.textContent=e.message}
 }
 const originalRender=renderPdfPage;renderPdfPage=function(){reset();return originalRender.apply(this,arguments)};
 const originalOpen=openBrainPdf;openBrainPdf=async function(){reset();return originalOpen.apply(this,arguments)};
 img.addEventListener('load',loadText);
 document.getElementById('pdfClose').addEventListener('click',reset);
 // Retain selection when a toolbar button takes focus; invalidate it on page/document changes.
 for(const b of [copy,create])b.addEventListener('mousedown',e=>e.preventDefault());
 document.addEventListener('selectionchange',()=>{
  const s=window.getSelection();if(!s||!s.rangeCount||modal.hidden)return;
  if(layer.contains(s.anchorNode)&&layer.contains(s.focusNode)){
   selected=s.toString().replace(/\s+/g,' ').trim();selectedContext=context();copy.disabled=create.disabled=!selected;
  }else if(!tools.contains(document.activeElement)&&!dialog.open){
   selected='';selectedContext=null;copy.disabled=create.disabled=true;
  }
 });
 async function copyText(text,target){
  try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);else throw Error('fallback');target.textContent='Auswahl kopiert.'}
  catch(_){const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.top='0';document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();target.textContent=ok?'Auswahl kopiert.':'Kopieren nicht möglich. Bitte Text markieren und Strg+C verwenden.'}
 }
 copy.onclick=()=>{if(selected)copyText(selected,status)};
 async function prepare(ctx,selection){
  if(saving)return;const id=++previewId;draftToken='';form.reset();save.disabled=true;message.textContent='Rechnungsposition wird gelesen …';document.getElementById('brainMaterialSource').textContent='';if(!dialog.open)dialog.showModal();
  try{const d=await api('/preview',{...ctx,selection});if(id!==previewId||!dialog.open)return;draftToken=d.token;
   for(const [key,value] of Object.entries(d.fields))if(form.elements.namedItem(key))form.elements.namedItem(key).value=value;
   const s=d.source;document.getElementById('brainMaterialSource').textContent='Quelle: '+s.path+(s.page?' · Seite '+s.page:'')+'\nRechnung: '+(s.invoiceNumber||'nicht sicher erkannt')+' · '+s.invoiceDate+'\n'+s.selection;
   message.textContent=d.recognized?'Angaben bitte prüfen. Der EK wird als fester Preis übernommen.':'Position nicht vollständig erkannt. Bitte Angaben ergänzen und EK prüfen.';save.disabled=false;
  }catch(e){if(id===previewId)message.textContent=e.message}
 }
 create.onclick=()=>{if(selected&&selectedContext)prepare(selectedContext,selected)};
 document.getElementById('brainMaterialCancel').onclick=()=>{if(!saving)dialog.close()};
 dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault()});dialog.addEventListener('close',()=>{previewId++;draftToken=''});
 form.onsubmit=async e=>{e.preventDefault();if(!draftToken||saving)return;saving=true;save.disabled=true;message.textContent='Material wird gespeichert …';
  try{const fields=Object.fromEntries(new FormData(form).entries()),d=await api('/save',{token:draftToken,fields});
   message.textContent=d.created?'✓ Material gespeichert: '+(d.material?.product||fields.product):'Material bereits vorhanden: '+(d.material?.product||fields.product)+' — keine Dublette angelegt und kein Preis verändert.';draftToken='';
  }catch(e){message.textContent=e.message;save.disabled=false}finally{saving=false}
 };
 function addLineActions(){document.querySelectorAll('.material-hit-line').forEach(line=>{
  if(line.dataset.brainSelectionReady)return;line.dataset.brainSelectionReady='1';
  const card=line.closest('.material-global-card,.doc'),link=card?.querySelector('a[href*="/pdf?path="]');if(!link)return;
  let path;try{path=new URL(link.href,location.href).searchParams.get('path')}catch(_){return}if(!path)return;
  const row=document.createElement('div');row.className='brain-line-actions';const c=document.createElement('button'),a=document.createElement('button'),note=document.createElement('span');c.type=a.type='button';c.textContent='Zeile kopieren';a.textContent='＋ Material anlegen';note.setAttribute('role','status');
  c.onclick=()=>copyText(line.textContent,note);a.onclick=()=>prepare({path,page:0},line.textContent);row.append(c,a,note);line.after(row);
 })}
 const observer=new MutationObserver(addLineActions);for(const id of ['materialResults','incomingGrouped']){const host=document.getElementById(id);if(host)observer.observe(host,{childList:true,subtree:true})}addLineActions();
})();
</script>
'''
