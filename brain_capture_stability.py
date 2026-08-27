# coding: utf-8
"""KRISTINE Eingangsrechnungen: UI-Haenger vermeiden.

Zwei teure Schritte liefen bisher seriell im sichtbaren Bearbeiten-Flow:
1) Rechnungseingang wartete beim Wechsel TEST -> LIVE auf den kompletten Area-Refresh.
2) PDF-Analyse wartete auf mehrere WinWorker-Lieferantensuchen.

Der Hotfix macht beides nicht-blockierend: Area-Wechsel wird nur kurz angestossen,
die PDF-Datei hat einen klaren Timeout, und Lieferantenvorschlaege werden nach der
OCR-Antwort separat im Hintergrund geladen.
"""
from __future__ import annotations


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    original_suggestions = ns.get("_capture_supplier_suggestions")
    if app is None or not page:
        return

    # Die eigentliche OCR/Analyse darf nicht auf bis zu vier serielle WW-Suchen
    # warten. Die bestehende, gute Vorschlagslogik bleibt erhalten, wird aber ueber
    # einen separaten Endpunkt nachgeladen.
    if callable(original_suggestions) and not getattr(original_suggestions, "_krista_deferred", False):
        def deferred_suggestions(analysis, limit=8):
            return [], ""
        deferred_suggestions._krista_deferred = True
        ns["_capture_supplier_suggestions"] = deferred_suggestions

        if "brain_capture_supplier_suggestions_async" not in app.view_functions:
            from flask import request, jsonify

            @app.post("/incoming/capture/supplier-suggestions-async")
            def brain_capture_supplier_suggestions_async():
                try:
                    body = request.get_json(silent=True) or {}
                    analysis = body.get("analysis") or {}
                    rows, error = original_suggestions(analysis, 8)
                    return jsonify(ok=True, addresses=rows or [], error=error or "")
                except Exception as exc:
                    return jsonify(ok=False, error=str(exc)), 500

    # Bestehenden Rechnungseingang minimal patchen, damit "Bearbeiten" nicht den
    # kompletten LIVE-Refresh abwartet und der Cloud-Dateidownload nicht 30s lang
    # wie ein eingefrorener Browser wirkt.
    old_switch = "if(typeof captureArea!=='undefined'&&captureArea!=='live'&&typeof setCaptureArea==='function'){await Promise.resolve(setCaptureArea('live'));await new Promise(r=>setTimeout(r,80))}"
    new_switch = "if(typeof captureArea!=='undefined'&&captureArea!=='live'&&typeof setCaptureArea==='function'){Promise.resolve(setCaptureArea('live')).catch(()=>{});let _w=0;while(typeof captureArea!=='undefined'&&captureArea!=='live'&&_w<1000){await new Promise(r=>setTimeout(r,50));_w+=50}}"
    page = page.replace(old_switch, new_switch)

    old_fetch = "const r=await fetch('/incoming/intake-file?id='+encodeURIComponent(id),{cache:'no-store'});if(!r.ok)"
    new_fetch = "const _ctl=new AbortController(),_to=setTimeout(()=>_ctl.abort(),12000);let r;try{r=await fetch('/incoming/intake-file?id='+encodeURIComponent(id),{cache:'no-store',signal:_ctl.signal})}catch(_e){if(_e&&_e.name==='AbortError')throw Error('PDF-Laden dauert zu lange. Bitte noch einmal auf Bearbeiten klicken.');throw _e}finally{clearTimeout(_to)}if(!r.ok)"
    page = page.replace(old_fetch, new_fetch)

    if "kristaCaptureStabilityV1" not in page:
        script = r'''
<script id="kristaCaptureStabilityV1">
(function(){
  const priorFetch=window.fetch.bind(window);
  let suggestionCtl=null,suggestionSeq=0;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function suggestionStatus(text,kind=''){
    const box=document.getElementById('captureSupplierResults');
    if(!box||document.querySelector('#captureSelectedSupplier .capture-selected'))return;
    if(text)box.innerHTML='<div class="empty '+esc(kind)+'">'+esc(text)+'</div>';
  }

  async function loadSuggestions(analysis,seq){
    if(!analysis||seq!==suggestionSeq)return;
    if(suggestionCtl)try{suggestionCtl.abort()}catch(_){}
    suggestionCtl=new AbortController();
    const timeout=setTimeout(()=>suggestionCtl.abort(),7000);
    try{
      suggestionStatus('Lieferantenvorschläge werden im Hintergrund geladen …');
      const r=await priorFetch('/incoming/capture/supplier-suggestions-async',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({analysis}),signal:suggestionCtl.signal,cache:'no-store'
      });
      const d=await r.json();
      if(seq!==suggestionSeq)return;
      if(!r.ok||!d.ok)throw Error(d.error||'Lieferantensuche fehlgeschlagen');
      const rows=d.addresses||[];
      if(rows.length&&typeof renderCaptureSupplierResults==='function'){
        renderCaptureSupplierResults(rows,true);
      }else if(!rows.length){
        suggestionStatus('Kein sicherer Lieferantenvorschlag · Suche ist trotzdem sofort benutzbar.');
      }
    }catch(e){
      if(seq!==suggestionSeq)return;
      if(e?.name==='AbortError')suggestionStatus('Lieferantensuche dauert länger · bitte Lieferant händisch wählen.','warn');
      else suggestionStatus('Lieferantensuche im Hintergrund fehlgeschlagen · händische Suche funktioniert.','warn');
    }finally{clearTimeout(timeout)}
  }

  window.fetch=async function(input,init){
    const response=await priorFetch(input,init);
    try{
      const url=typeof input==='string'?input:(input?.url||'');
      if(url.includes('/incoming/capture/analyze')&&!url.includes('supplier-suggestions-async')&&response.ok){
        const seq=++suggestionSeq;
        response.clone().json().then(d=>{
          if(d?.ok&&d.analysis)setTimeout(()=>loadSuggestions(d.analysis,seq),40);
        }).catch(()=>{});
      }
    }catch(_){}
    return response;
  };

  // Sichtbares Feedback statt scheinbarem Stillstand beim Cloud-PDF.
  document.addEventListener('click',e=>{
    const b=e.target?.closest?.('#invoiceIntakeList [data-intake]');
    if(!b)return;
    const old=b.textContent;b.disabled=true;b.textContent='PDF wird geladen …';
    setTimeout(()=>{if(document.body.contains(b)){b.disabled=false;b.textContent=old}},13000);
  },true);
})();
</script>
'''
        page = page.replace("</body>", script + "\n</body>", 1)

    ns["MOBILE_PAGE"] = page
    print("✅ Eingangsrechnungen stabilisiert: OCR ohne WW-Wartekette · Intake ohne Area-Blockade")
