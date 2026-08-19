# coding: utf-8
"""Brain · feste WW-Lieferantenzuordnung auch in der Eingangsrechnungserfassung.

Priorität:
1. WinWorker-Dokument-ID aus Dateiname / erkanntem Beleg
2. eindeutige Kombination Rechnungsnummer + Rechnungsdatum aus der persistenten WW-Map
3. erst dann bestehende OCR-/Ähnlichkeitsvorschläge
"""
from __future__ import annotations


def _capture_supplier(ns, filename, payload):
    try:
        import brain_supplier_enrichment as supplier_map
    except Exception:
        return None

    analysis = dict((payload or {}).get("analysis") or {})
    duplicate = dict((payload or {}).get("duplicate") or {})

    # 1) Exakte Dokument-ID: stärkste Zuordnung.
    keys = [
        filename,
        duplicate.get("doc_id"),
        duplicate.get("docId"),
        analysis.get("docId"),
        analysis.get("logical_id"),
        analysis.get("logicalId"),
    ]
    for key in keys:
        if not key:
            continue
        linked = supplier_map.lookup(ns, key)
        if linked:
            return linked

    # 2) Falls die Datei umbenannt wurde: exakte Rechnungsnummer + Datum.
    # Nur übernehmen, wenn alle passenden WW-Dokumente zum selben Lieferanten gehören.
    invoice_no = str(
        analysis.get("supplierInvoiceNumber")
        or analysis.get("invoiceNumber")
        or ""
    ).strip().lower()
    invoice_date = str(analysis.get("invoiceDate") or "").strip()[:10]
    if not invoice_no:
        return None

    data = supplier_map._load(ns)
    candidates = []
    for row in (data.get("documents") or {}).values():
        if str(row.get("invoiceNumber") or "").strip().lower() != invoice_no:
            continue
        row_date = str(row.get("invoiceDate") or "").strip()[:10]
        if invoice_date and row_date and row_date != invoice_date:
            continue
        candidates.append(dict(row))

    if not candidates:
        return None
    address_ids = {str(x.get("addressId") or "").strip() for x in candidates if x.get("addressId")}
    if len(address_ids) != 1:
        return None
    candidates.sort(key=lambda x: (str(x.get("invoiceDate") or ""), int(x.get("wwIncomingId") or 0)), reverse=True)
    return candidates[0]


def _public_supplier(linked):
    if not linked:
        return None
    return {
        "addressId": str(linked.get("addressId") or ""),
        "customerNumber": str(linked.get("customerNumber") or ""),
        "name": str(linked.get("supplierName") or ""),
        "address": str(linked.get("supplierAddress") or ""),
        "supplierNumber": str(linked.get("supplierNumber") or ""),
        "ourCustomerNumber": str(linked.get("ourCustomerNumber") or ""),
        "source": "WinWorker Dokument-ID",
        "confidence": 100,
    }


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    if app is None or not page:
        return

    original = app.view_functions.get("incoming_capture_analyze")
    if original and not getattr(original, "_fixed_ww_supplier", False):
        from flask import request

        def incoming_capture_analyze_fixed_supplier(*args, **kwargs):
            upload = request.files.get("file")
            filename = str(getattr(upload, "filename", "") or "")
            response = app.make_response(original(*args, **kwargs))
            if not response.is_json:
                return response
            payload = response.get_json(silent=True) or {}
            if not payload.get("ok"):
                return response

            linked = _capture_supplier(ns, filename, payload)
            supplier = _public_supplier(linked)
            if not supplier or not supplier.get("addressId"):
                return response

            analysis = dict(payload.get("analysis") or {})
            analysis["supplierName"] = supplier.get("name") or analysis.get("supplierName")
            analysis["supplierAddressId"] = supplier.get("addressId")
            analysis["supplierSource"] = "WinWorker Dokument-ID"
            analysis["supplierConfidence"] = 100
            payload["analysis"] = analysis
            payload["supplierSuggestions"] = [supplier]
            payload["fixedSupplier"] = supplier
            payload["supplierFixedByWinWorker"] = True
            response.set_data(app.json.dumps(payload))
            response.content_type = "application/json"
            return response

        incoming_capture_analyze_fixed_supplier._fixed_ww_supplier = True
        app.view_functions["incoming_capture_analyze"] = incoming_capture_analyze_fixed_supplier

    if "kristaCaptureFixedSupplierV1" not in page:
        script = r'''
<script id="kristaCaptureFixedSupplierV1">
(function(){
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const response=await nativeFetch(input,init);
    try{
      const url=typeof input==='string'?input:String(input?.url||'');
      if(url.includes('/incoming/capture/analyze')&&!url.includes('analyze-preview')){
        response.clone().json().then(data=>{
          const supplier=data?.fixedSupplier;
          if(!data?.ok||!supplier?.addressId)return;
          setTimeout(()=>{
            try{
              const q=document.getElementById('captureSupplierQ');
              if(q)q.value=supplier.name||'';
              if(typeof window.selectCaptureSupplier==='function'){
                window.selectCaptureSupplier(supplier);
              }else if(typeof selectCaptureSupplier==='function'){
                selectCaptureSupplier(supplier);
              }
              const meta=document.getElementById('captureAnalyzeMeta');
              if(meta&&!String(meta.textContent||'').includes('WinWorker fix')){
                meta.textContent=(meta.textContent?meta.textContent+' · ':'')+'✓ Lieferant aus WinWorker fix';
              }
            }catch(error){console.error('WW-Lieferant automatisch wählen:',error)}
          },0);
        }).catch(()=>{});
      }
    }catch(_){ }
    return response;
  };
})();
</script>
'''
        page = page.replace("</body>", script + "\n</body>", 1)
        ns["MOBILE_PAGE"] = page

    print("✅ Brain Erfassung: feste WW-Lieferantenzuordnung vor OCR aktiv")
