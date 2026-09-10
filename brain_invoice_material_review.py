# coding: utf-8
"""Eingangsrechnung -> Materialstamm: Positionen erkennen, vergleichen und freigeben."""
from __future__ import annotations

import difflib
import json
import re
from urllib.parse import quote

_INSTALLED = False


def _clean(value, maximum=240):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:maximum]


def _key(value):
    return re.sub(r"[^0-9a-z]+", "", _clean(value).lower())


def _article_key(value):
    return re.sub(r"[^0-9a-z]+", "", _clean(value).lower())


def _number(value):
    raw = _clean(value, 80).replace("€", "").replace("EUR", "").replace(" ", "")
    if not raw:
        return 0.0
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        return float(raw)
    except Exception:
        return 0.0


def _size_from_text(value):
    match = re.search(r"(?i)\b(\d+(?:[.,]\d+)?)\s*(ml|l|kg|g|m|m2|m²|stk)\b", str(value or ""))
    if not match:
        return 1.0, ""
    return max(0.001, _number(match.group(1))), match.group(2).replace("m²", "m2")


def extract_material_lines(text):
    """Konservative Zeilenerkennung. Unsichere Treffer bleiben in der editierbaren Maske."""
    rows = []
    seen = set()
    stop = re.compile(r"(?i)\b(summe|netto|brutto|mwst|umsatzsteuer|steuer|zahlbar|skonto|iban|übertrag)\b")
    unit = r"Stk\.?|Stück|kg|g|l|ml|m|lfm|m2|m²|Rolle|Dose|Eimer|Pack|Paket|VE"
    money = r"[-+]?\d{1,6}(?:[. ]\d{3})*(?:,\d{2,4})|[-+]?\d{1,6}(?:\.\d{2,4})"
    patterns = [
        re.compile(rf"^\s*(?:Pos\.?\s*)?\d{{1,4}}\s+([A-Z0-9][A-Z0-9./_-]{{2,32}})\s+(.{{3,180}}?)\s+(\d+(?:[.,]\d+)?)\s*({unit})\s+({money})\s+(?:{money})\s*$", re.I),
        re.compile(rf"^\s*([A-Z0-9][A-Z0-9./_-]{{2,32}})\s+(.{{3,180}}?)\s+(\d+(?:[.,]\d+)?)\s*({unit})\s+({money})\s+(?:{money})\s*$", re.I),
        re.compile(rf"^\s*(?:Pos\.?\s*)?\d{{1,4}}\s+(.{{4,180}}?)\s+(\d+(?:[.,]\d+)?)\s*({unit})\s+({money})\s+(?:{money})\s*$", re.I),
    ]
    for raw in str(text or "").splitlines():
        line = _clean(raw, 400)
        if len(line) < 10 or stop.search(line):
            continue
        lg = re.match(
            rf"^\s*(?:\d{{1,4}}\s+)?([A-Z0-9]{{8,20}})\s+LG\s+(.+?)\s+"
            rf"(Hi White|Medium|Deep|Extra Deep|Transparent|Yellow|Pastel|White ASP)\s+"
            rf"(250ml|500ml|750ml|1L|2L|2[.,]5L|4L|5L|10L)\s+"
            rf"(\d+(?:[.,]\d+)?)\s+({money})\s+(?:{money})\s*$",
            line, re.I,
        )
        if lg:
            sku, product, base, size, qty, price = lg.groups()
            container_size, container_unit = _size_from_text(size)
            identity = (_article_key(sku), _key(product + base + size), round(_number(qty), 4), round(_number(price), 4))
            if identity not in seen and _number(qty) > 0 and _number(price) > 0:
                seen.add(identity)
                rows.append({
                    "sku": _clean(sku, 100),
                    "description": _clean(f"{product} · {base} · {size}", 220),
                    "quantity": round(_number(qty), 4),
                    "unit": container_unit or "Stk",
                    "containerSize": container_size,
                    "containerUnit": container_unit,
                    "unitPrice": round(_number(price), 4),
                    "sourceLine": line,
                })
            continue
        sku = description = qty = line_unit = price = ""
        match = patterns[0].match(line) or patterns[1].match(line)
        if match:
            sku, description, qty, line_unit, price = match.groups()
        else:
            match = patterns[2].match(line)
            if not match:
                continue
            description, qty, line_unit, price = match.groups()
        if _key(description) in {"artikel", "bezeichnung", "beschreibung"}:
            continue
        quantity = _number(qty)
        unit_price = _number(price)
        if quantity <= 0 or unit_price <= 0:
            continue
        container_size, container_unit = _size_from_text(description)
        identity = (_article_key(sku), _key(description), round(quantity, 4), round(unit_price, 4))
        if identity in seen:
            continue
        seen.add(identity)
        rows.append({
            "sku": _clean(sku, 100),
            "description": _clean(description, 220),
            "quantity": round(quantity, 4),
            "unit": _clean(container_unit or line_unit, 20),
            "containerSize": container_size,
            "containerUnit": container_unit,
            "unitPrice": round(unit_price, 4),
            "sourceLine": line,
        })
        if len(rows) >= 160:
            break
    return rows


def _supplier_matches(material, supplier):
    address_id = _clean(supplier.get("addressId"), 120)
    if address_id and address_id == _clean(material.get("wwSupplierAddressId"), 120):
        return True
    wanted = _key(supplier.get("name"))
    names = [material.get("supplier"), *(material.get("supplierAliases") or [])]
    return bool(wanted and any(_key(name) == wanted for name in names))


def compare_material_lines(lines, materials, supplier):
    pool = [row for row in materials if row.get("active") is not False and _supplier_matches(row, supplier)]
    reviewed = []
    for raw in lines[:200]:
        line = {
            "sku": _clean(raw.get("sku"), 100),
            "description": _clean(raw.get("description"), 220),
            "quantity": round(max(0.0, _number(raw.get("quantity"))), 4),
            "unit": _clean(raw.get("unit"), 20) or "Stk",
            "containerSize": max(0.001, _number(raw.get("containerSize")) or 1.0),
            "unitPrice": round(max(0.0, _number(raw.get("unitPrice"))), 4),
        }
        sku_key = _article_key(line["sku"])
        exact = None
        if sku_key:
            for material in pool:
                codes = [material.get(field) for field in (
                    "supplierArticleNumber", "articleNumber", "materialId", "sourceId", "priceSourceId"
                )]
                if sku_key in {_article_key(code) for code in codes if code}:
                    exact = material
                    break
        if exact is None:
            name_key = _key(line["description"])
            exact = next((material for material in pool if name_key and _key(material.get("product")) == name_key), None)

        candidates = []
        wanted_name = _key(line["description"])
        for material in pool:
            score = difflib.SequenceMatcher(None, wanted_name, _key(material.get("product"))).ratio() if wanted_name else 0
            if score >= .48:
                candidates.append({
                    "materialId": material.get("materialId") or material.get("id") or "",
                    "product": material.get("product") or "",
                    "purchasePrice": float(material.get("purchasePrice") or 0),
                    "score": round(score, 3),
                })
        candidates.sort(key=lambda row: row["score"], reverse=True)
        candidates = candidates[:5]
        if exact:
            current = round(float(exact.get("purchasePrice") or 0), 4)
            difference = round(line["unitPrice"] - current, 4)
            same = abs(difference) <= .01
            status = "same" if same else "changed"
            reviewed.append({
                **line,
                "status": status,
                "decision": "confirm" if same else "none",
                "materialId": exact.get("materialId") or exact.get("id") or "",
                "materialProduct": exact.get("product") or "",
                "currentPrice": current,
                "difference": difference,
                "differencePercent": round(difference / current * 100, 1) if current else None,
                "candidates": candidates,
            })
        else:
            reviewed.append({
                **line,
                "status": "new",
                "decision": "none",
                "materialId": "",
                "materialProduct": "",
                "currentPrice": None,
                "difference": None,
                "differencePercent": None,
                "candidates": candidates,
            })
    return reviewed


def _material_review(ns, supplier, lines):
    data = ns["kristine_api_request"]("/admin/api/materials?limit=5000&activeOnly=1")
    return compare_material_lines(lines, data.get("materials") or [], supplier)


def _apply_review(ns, payload):
    if str(payload.get("area") or "live").lower() != "live":
        return {"applied": 0, "testMode": True, "results": []}
    supplier = payload.get("supplier") or {}
    supplier_name = _clean(supplier.get("name"), 120)
    invoice_date = _clean(payload.get("invoiceDate"), 10)
    invoice_number = _clean(payload.get("supplierInvoiceNumber"), 120)
    requested_rows = (payload.get("materialReview") or [])[:200]
    fresh_rows = _material_review(ns, supplier, requested_rows)
    results = []
    for index, requested in enumerate(requested_rows):
        row = fresh_rows[index] if index < len(fresh_rows) else requested
        row = {**row, "decision": requested.get("decision"), "materialId": requested.get("materialId") or row.get("materialId")}
        decision = _clean(row.get("decision"), 20).lower()
        material_id = _clean(row.get("materialId"), 120)
        price = round(max(0.0, _number(row.get("unitPrice"))), 4)
        try:
            if decision == "confirm" and material_id and row.get("status") == "same":
                response = ns["kristine_api_request"](
                    "/admin/api/materials/" + quote(material_id, safe="") + "/check-price",
                    method="POST", payload={"priceCheckedAt": invoice_date}
                )
                results.append({"action": "confirmed", "materialId": material_id, "ok": bool(response.get("ok", True))})
            elif decision == "update" and material_id and price > 0 and row.get("status") == "changed":
                response = ns["kristine_api_request"](
                    "/admin/api/materials/" + quote(material_id, safe="") + "/check-price",
                    method="POST", payload={"purchasePrice": price, "priceCheckedAt": invoice_date, "priceValidFrom": invoice_date}
                )
                results.append({"action": decision, "materialId": material_id, "ok": bool(response.get("ok", True))})
            elif decision == "link" and material_id and price > 0:
                response = ns["kristine_api_request"](
                    "/admin/api/materials/" + quote(material_id, safe="") + "/check-price",
                    method="POST", payload={"purchasePrice": price, "priceCheckedAt": invoice_date, "priceValidFrom": invoice_date}
                )
                results.append({"action": decision, "materialId": material_id, "ok": bool(response.get("ok", True))})
            elif decision == "create" and row.get("status") == "new" and price > 0 and _clean(row.get("description")):
                response = ns["kristine_api_request"](
                    "/admin/api/materials/auto", method="POST", payload={
                        "product": _clean(row.get("description"), 180),
                        "supplier": supplier_name,
                        "supplierArticleNumber": _clean(row.get("sku"), 100),
                        "containerSize": max(0.001, _number(row.get("containerSize")) or 1),
                        "unit": _clean(row.get("unit"), 20) or "Stk",
                        "purchasePrice": price,
                        "priceCheckedAt": invoice_date,
                        "priceValidFrom": invoice_date,
                        "forceCreate": True,
                        "note": "Aus Eingangsrechnung " + invoice_number,
                        "sourceSheet": "KRISTINE Eingangsrechnung",
                    }
                )
                material = response.get("material") or {}
                results.append({"action": "created", "materialId": material.get("materialId") or "", "ok": bool(response.get("ok", True))})
        except Exception as exc:
            results.append({"action": decision or "none", "materialId": material_id, "ok": False, "error": str(exc)})
    return {"applied": sum(1 for row in results if row.get("ok")), "results": results}


def _install_routes(ns):
    app = ns["app"]
    if "brain_invoice_material_review" not in app.view_functions:
        from flask import jsonify, request

        @app.post("/incoming/capture/material-review")
        def brain_invoice_material_review():
            try:
                body = request.get_json(silent=True) or {}
                supplier = body.get("supplier") or {}
                if not _clean(supplier.get("name")):
                    return jsonify(ok=False, error="Bitte zuerst den Lieferanten auswählen."), 400
                rows = _material_review(ns, supplier, body.get("lines") or [])
                return jsonify(ok=True, rows=rows, count=len(rows))
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

    original_save = app.view_functions.get("incoming_capture_save")
    if original_save and not getattr(original_save, "_krista_material_review", False):
        def wrapped_save(*args, **kwargs):
            from flask import request
            response = app.make_response(original_save(*args, **kwargs))
            if not response.is_json or response.status_code >= 400:
                return response
            body = response.get_json(silent=True) or {}
            if not body.get("ok"):
                return response
            try:
                payload = json.loads(str(request.form.get("payload") or "{}"))
                warnings = body.get("warnings")
                if not isinstance(warnings, list):
                    warnings = []
                    body["warnings"] = warnings
                review_result = _apply_review(ns, payload)
                body["materialReview"] = review_result
                if str(payload.get("area") or "live").lower() != "live":
                    warnings.append("Testgelände: Materialstamm und Lager bleiben unverändert.")
                elif review_result.get("applied"):
                    warnings.append(
                        "Materialstamm: "
                        + str(int(review_result.get("applied") or 0))
                        + " Position(en) bestätigt oder aktualisiert."
                    )
                failed = [row for row in review_result.get("results") or [] if not row.get("ok")]
                if failed:
                    warnings.append(
                        "Materialstamm: "
                        + str(len(failed))
                        + " Position(en) konnten nicht übernommen werden."
                    )
                if str(payload.get("area") or "live").lower() == "live" and str(payload.get("workflowStatus") or "") == "geprueft":
                    row = body.get("invoice") or {}
                    if row.get("id"):
                        factory = ns.get("_capture_connection")
                        public_row = ns.get("_capture_row_public")
                        if callable(factory) and callable(public_row):
                            con = factory()
                            try:
                                raw = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (int(row["id"]),)).fetchone()
                                if raw:
                                    full_row = public_row(raw, [], include_text=True)
                                    import brain_lg_sync
                                    if brain_lg_sync._is_lg(full_row):
                                        try:
                                            body["lgStockSync"] = brain_lg_sync._sync_stock_and_turnover(ns, full_row)
                                        except Exception as exc:
                                            body["lgStockSync"] = {"ok": False, "error": str(exc)}
                                        stock_result = body.get("lgStockSync") or {}
                                        if stock_result.get("ok") and stock_result.get("duplicate"):
                                            warnings.append("LG-Lager: Rechnung war bereits eingebucht – Bestand nicht doppelt erhöht.")
                                        elif stock_result.get("ok"):
                                            count = int(stock_result.get("paintLines") or stock_result.get("updated") or 0)
                                            warnings.append("LG-Lager: " + str(count) + " Position(en) eingebucht.")
                                        else:
                                            warnings.append(
                                                "LG-Lager nicht verändert: "
                                                + str(stock_result.get("error") or "Lagerbuchung fehlgeschlagen")
                                            )
                            finally:
                                con.close()
            except Exception as exc:
                body.setdefault("warnings", []).append("Materialstamm-Abgleich wartet: " + str(exc))
            response.set_data(app.json.dumps(body))
            response.content_type = "application/json"
            return response

        wrapped_save._krista_material_review = True
        wrapped_save.__name__ = "incoming_capture_save_material_review"
        app.view_functions["incoming_capture_save"] = wrapped_save


def _install_analyzer(ns):
    original = ns.get("_capture_analyze_pdf")
    if not callable(original) or getattr(original, "_krista_material_lines", False):
        return

    def wrapped(pdf_bytes, filename=""):
        result = original(pdf_bytes, filename)
        result["materialLines"] = extract_material_lines(result.get("text") or "")
        return result

    wrapped._krista_material_lines = True
    ns["_capture_analyze_pdf"] = wrapped


def _install_ui(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaInvoiceMaterialReviewV1" in page:
        return
    card = r'''
        <div class="card" id="captureMaterialReviewCard" hidden>
          <div class="section-head"><div><div class="project-title">4 · Materialstamm prüfen</div><div class="sub">Rechnungspositionen mit dem Lieferanten-Materialstamm vergleichen. Änderungen werden erst mit der Rechnung gespeichert.</div></div><div class="actions"><button id="captureMaterialAdd" type="button" class="dark">＋ Position</button><button id="captureMaterialRecheck" type="button" class="dark">↻ Neu vergleichen</button></div></div>
          <div id="captureMaterialReviewMeta" class="capture-material-meta"></div>
          <div id="captureMaterialReviewRows" class="capture-material-rows"></div>
        </div>
'''
    marker = '<div class="card">\n          <div class="section-head">\n            <div><div class="project-title">4 · Kontierung</div>'
    if marker in page:
        page = page.replace(marker, card + '\n        ' + marker.replace('4 · Kontierung', '5 · Kontierung'), 1)
    css = r'''
<style id="kristaInvoiceMaterialReviewCss">
.capture-material-meta{margin:10px 0;color:var(--muted);font-size:12px}.capture-material-rows{display:grid;gap:9px}
.capture-material-row{border:1px solid #39434e;border-radius:11px;background:#11171d;padding:10px}.capture-material-row.same{border-color:#376a48;background:#122219}.capture-material-row.changed{border-color:#806028;background:#2a2112}.capture-material-row.new{border-color:#506071}
.capture-material-fields{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(260px,1.7fr) 90px 80px 90px 105px auto;gap:7px;align-items:end}.capture-material-fields label{display:grid;gap:3px;color:var(--muted);font-size:10px}.capture-material-fields input,.capture-material-fields select{width:100%;min-height:37px;border:1px solid #46515d;border-radius:8px;background:#0d1217;color:#fff;padding:7px 8px}.capture-material-fields button{min-height:37px;padding:7px 9px}.capture-material-result{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}.capture-material-result strong{font-size:12px}.capture-material-result .ok{color:#9bd4ac}.capture-material-result .warn{color:#f0ce7a}.capture-material-result .new{color:#b7c8d9}.capture-material-actions{display:flex;gap:6px;flex-wrap:wrap}.capture-material-actions button.selected{background:#2d7047;border-color:#4b9667}.capture-material-actions select{min-height:35px;max-width:310px;background:#111820;color:#fff;border:1px solid #4b5865;border-radius:8px;padding:6px}.capture-material-remove{background:#3b1d1c!important;color:#ffc0bc!important;border-color:#70413e!important}
@media(max-width:1050px){.capture-material-fields{grid-template-columns:1fr 2fr 80px 80px}.capture-material-fields>*:nth-child(n+5){grid-column:auto}}
@media(max-width:650px){.capture-material-fields{grid-template-columns:1fr 1fr}.capture-material-fields label:nth-child(2){grid-column:1/-1}.capture-material-result{align-items:flex-start;flex-direction:column}}
</style>
'''
    script = r'''
<script id="kristaInvoiceMaterialReviewV1">
(function(){
 const card=document.getElementById('captureMaterialReviewCard'),rowsHost=document.getElementById('captureMaterialReviewRows'),meta=document.getElementById('captureMaterialReviewMeta');if(!card||!rowsHost)return;
 let lines=[],review=[],busy=false;const n=v=>{const x=Number(String(v??'').replace(',','.'));return Number.isFinite(x)?x:0},money=v=>new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(n(v));
 function lineFrom(raw={}){return{sku:String(raw.sku||''),description:String(raw.description||''),quantity:n(raw.quantity)||1,unit:String(raw.unit||'Stk'),containerSize:n(raw.containerSize)||1,unitPrice:n(raw.unitPrice)}}
 function syncInputs(){rowsHost.querySelectorAll('[data-material-row]').forEach(node=>{const i=Number(node.dataset.materialRow),row=review[i]||lines[i];if(!row)return;node.querySelectorAll('[data-mf]').forEach(input=>{row[input.dataset.mf]=['quantity','containerSize','unitPrice'].includes(input.dataset.mf)?n(input.value):input.value})})}
 function statusText(row){if(row.status==='same')return `<strong class="ok">✓ Preis gleich · ${money(row.unitPrice)} · Preisstand wird auf Rechnungsdatum bestätigt</strong>`;if(row.status==='changed'){const sign=n(row.difference)>0?'+':'';return `<strong class="warn">Preisänderung: ${money(row.currentPrice)} → ${money(row.unitPrice)} · ${sign}${n(row.differencePercent).toLocaleString('de-AT')} %</strong>`}return '<strong class="new">Neues Material dieses Lieferanten erkannt</strong>'}
 function candidates(row,i){if(row.status!=='new'||!row.candidates?.length)return'';return `<select data-link="${i}"><option value="">– oder mit vorhandenem Material verknüpfen –</option>${row.candidates.map(x=>`<option value="${esc(x.materialId)}">${esc(x.materialId)} · ${esc(x.product)} · ${money(x.purchasePrice)}</option>`).join('')}</select><button type="button" data-link-go="${i}">Verknüpfen + EK übernehmen</button>`}
 function render(){card.hidden=false;if(!review.length){rowsHost.innerHTML='<div class="empty">Keine einzelne Materialposition sicher erkannt. Positionen können mit „＋ Position“ ergänzt werden.</div>';meta.textContent=lines.length?'Bitte Lieferant auswählen und neu vergleichen.':'Noch keine Positionen erkannt.';return}meta.textContent=`${review.length} Position(en) · grün = bestätigt · gelb = Preisänderung · blau = neuer Artikel`;
  rowsHost.innerHTML=review.map((row,i)=>`<div class="capture-material-row ${esc(row.status||'new')}" data-material-row="${i}"><div class="capture-material-fields"><label>Artikel-Nr.<input data-mf="sku" value="${esc(row.sku||'')}"></label><label>Artikel<input data-mf="description" value="${esc(row.description||'')}"></label><label>Menge<input data-mf="quantity" inputmode="decimal" value="${String(row.quantity||1).replace('.',',')}"></label><label>Einheit<input data-mf="unit" value="${esc(row.unit||'Stk')}"></label><label>Gebinde<input data-mf="containerSize" inputmode="decimal" value="${String(row.containerSize||1).replace('.',',')}"></label><label>EK netto<input data-mf="unitPrice" inputmode="decimal" value="${String(row.unitPrice||0).replace('.',',')}"></label><button type="button" class="capture-material-remove" data-remove-material="${i}">×</button></div><div class="capture-material-result"><div>${statusText(row)}${row.materialId?`<div class="sub">Materialstamm: ${esc(row.materialId)} · ${esc(row.materialProduct||'')}</div>`:''}</div><div class="capture-material-actions">${row.status==='changed'?`<button type="button" data-decision="update" data-index="${i}" class="${row.decision==='update'?'selected':''}">${row.decision==='update'?'✓ Neuer EK wird übernommen':'Neuen EK übernehmen'}</button>`:''}${row.status==='new'?`<button type="button" data-decision="create" data-index="${i}" class="${row.decision==='create'?'selected':''}">${row.decision==='create'?'✓ Wird neu gespeichert':'Neu im Materialstamm speichern'}</button>${candidates(row,i)}`:''}</div></div></div>`).join('');wire()}
 function wire(){rowsHost.querySelectorAll('[data-remove-material]').forEach(b=>b.onclick=()=>{review.splice(Number(b.dataset.removeMaterial),1);lines=review.map(lineFrom);render()});rowsHost.querySelectorAll('[data-decision]').forEach(b=>b.onclick=()=>{syncInputs();const row=review[Number(b.dataset.index)],next=b.dataset.decision;row.decision=row.decision===next?'none':next;render()});rowsHost.querySelectorAll('[data-link-go]').forEach(b=>b.onclick=()=>{syncInputs();const i=Number(b.dataset.linkGo),select=rowsHost.querySelector(`[data-link="${i}"]`),choice=(review[i].candidates||[]).find(x=>String(x.materialId)===String(select?.value||''));if(!choice)return;review[i].materialId=choice.materialId;review[i].materialProduct=choice.product;review[i].decision='link';render()})}
 async function compare(){syncInputs();if(!lines.length&&review.length)lines=review.map(lineFrom);if(!captureSelectedSupplier?.name){review=lines.map(x=>({...lineFrom(x),status:'new',decision:'none',candidates:[]}));render();meta.textContent='Bitte zuerst den Lieferanten auswählen.';return}busy=true;card.hidden=false;meta.textContent='Materialstamm wird verglichen …';try{const r=await fetch('/incoming/capture/material-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({supplier:captureSelectedSupplier,lines:lines.length?lines:review})}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Abgleich fehlgeschlagen');review=d.rows||[];render()}catch(e){meta.textContent='Materialabgleich nicht möglich: '+e.message}finally{busy=false}}
 const originalAnalyze=analyzeCaptureFile;analyzeCaptureFile=async function(){await originalAnalyze.apply(this,arguments);lines=(captureAnalysis?.materialLines||[]).map(lineFrom);review=[];if(captureFile.files?.length){card.hidden=false;await compare()}else resetReview()};captureFile.onchange=analyzeCaptureFile;
 const originalSelect=selectCaptureSupplier;selectCaptureSupplier=async function(){await originalSelect.apply(this,arguments);if(lines.length||captureFile.files?.length)await compare()};
 const originalPayload=capturePayload;capturePayload=function(){syncInputs();const payload=originalPayload();payload.materialReview=review.map(row=>({sku:row.sku,description:row.description,quantity:n(row.quantity),unit:row.unit,containerSize:n(row.containerSize)||1,unitPrice:n(row.unitPrice),status:row.status,decision:row.decision||'none',materialId:row.materialId||''}));return payload};
 const originalReset=resetCaptureForm;function resetReview(){lines=[];review=[];card.hidden=true;rowsHost.innerHTML='';meta.textContent=''}resetCaptureForm=function(){const result=originalReset.apply(this,arguments);resetReview();return result};
 document.getElementById('captureMaterialAdd').onclick=()=>{syncInputs();review.push({sku:'',description:'',quantity:1,unit:'Stk',containerSize:1,unitPrice:0,status:'new',decision:'none',candidates:[]});lines=review.map(lineFrom);render()};document.getElementById('captureMaterialRecheck').onclick=()=>{syncInputs();lines=review.map(lineFrom);compare()};
})();
</script>
'''
    page = page.replace("</head>", css + "\n</head>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page


def install(ns):
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True
    _install_analyzer(ns)
    _install_routes(ns)
    _install_ui(ns)
    print("✅ Eingangsrechnung ↔ Materialstamm aktiv: Preisprüfung · neue Artikel · LG-Lager")
