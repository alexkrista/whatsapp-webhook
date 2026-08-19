# coding: utf-8
"""Brain: Dunja-PDF-Viewer + Drucken + OP-Liste + Materialhistorie + WW-Lieferantenmap."""


def install(ns):
    # Feste WW-Dokument-Zuordnung zuerst laden. Materialsuche/-historie nutzt sie dann
    # als fachliche Wahrheit; OCR bleibt nur Fallback.
    import brain_supplier_enrichment
    brain_supplier_enrichment.install(ns)

    # Zusatzmodule; sie arbeiten auf derselben Brain-Seite.
    import brain_incoming_op
    brain_incoming_op.install(ns)
    import brain_material_history
    brain_material_history.install(ns)

    page = str(ns.get("MOBILE_PAGE") or "")
    app = ns.get("app")
    if not page or app is None:
        return

    # brain_line2 liefert weiterhin Toolbar + Preview-Endpunkte, aber sein alter
    # Viewer-V2 darf nicht parallel mit unserem aktuellen Viewer laufen.
    # Zwei Controller auf denselben DOM-Elementen waren die Ursache für den
    # zweiten Browser-Viewer und den großen Leerraum oberhalb der Rechnung.
    import re
    page = re.sub(
        r'<script\s+id="kristaBrainCaptureViewerV2">.*?</script>',
        '',
        page,
        flags=re.I | re.S,
    )

    if "brain_capture_preview_upload" not in app.view_functions:
        from flask import request, jsonify
        import brain_line2

        allowed = ns.get("MOBILE_ALLOWED_PATHS")
        if isinstance(allowed, set):
            allowed.add("/incoming/capture/analyze-preview")

        @app.post("/incoming/capture/analyze-preview")
        def brain_capture_preview_upload():
            upload = request.files.get("file")
            if not upload or not str(upload.filename or "").lower().endswith(".pdf"):
                return jsonify({"ok": False, "error": "Bitte eine PDF-Datei auswählen."}), 400
            try:
                data = upload.read()
                if not data:
                    raise ValueError("PDF ist leer.")
                token = brain_line2._preview_store(data)
                if not token:
                    raise ValueError("PDF-Vorschau konnte nicht vorbereitet werden.")
                return jsonify({"ok": True, "previewToken": token})
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400

    if "kristaBrainViewerReliableV8" in page:
        ns["MOBILE_PAGE"] = page
        return

    # Vorherige V7-Injektion entfernen, damit nach Connector-Neustart garantiert
    # nur die aktuelle Steuerung auf dem Viewer sitzt.
    page = re.sub(r'<script id="kristaBrainViewerReliableV7">.*?</script>', '', page, flags=re.I | re.S)

    css = r'''
#capturePdfPreview.brain-super-hidden,#capturePdfEmpty.brain-super-hidden{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important}
#capturePdfPreview.brain-single-viewer-off{display:none!important;visibility:hidden!important;width:0!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;position:absolute!important;pointer-events:none!important}
.capture-pdf-shell.brain-preview-loading::after{content:'PDF-Vorschau wird vorbereitet …';position:absolute;inset:0;display:grid;place-items:center;background:rgba(12,14,16,.84);color:#cbd4df;font-size:13px;z-index:4;pointer-events:none}
#capturePdfPageImage{display:block;max-width:none;height:auto;margin:0 auto;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.32)}
#capturePdfPageImage[hidden]{display:none!important}#pdfPrint{white-space:nowrap}
.pdf-super-stage{padding-top:0!important}
/* Wenn der Browser-PDF-Viewer bereits eine Quelle hat, darf der leere
   Platzhalter niemals mehr Höhe belegen. Chrome unterstützt :has(). */
.capture-pdf-shell:has(#capturePdfPreview[src]) #capturePdfEmpty,
.capture-pdf-shell:has(#capturePdfPageImage:not([hidden])) #capturePdfEmpty{
  display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;
  margin:0!important;padding:0!important;border:0!important;overflow:hidden!important
}
.capture-pdf-shell:has(#capturePdfPreview[src]){align-items:flex-start!important}
'''

    script = r'''
<script id="kristaBrainViewerReliableV8">
(function(){
  function installPrintButton(){
    const original=document.getElementById('pdfOriginal');
    if(!original||document.getElementById('pdfPrint'))return;
    const button=document.createElement('button');button.id='pdfPrint';button.type='button';button.textContent='🖨 Drucken';
    button.addEventListener('click',()=>{const href=String(original.href||'');if(!href||href.endsWith('#'))return;const w=window.open(href,'_blank');if(!w)return;const p=()=>{try{w.focus();w.print()}catch(_){}};try{w.addEventListener('load',()=>setTimeout(p,700),{once:true})}catch(_){setTimeout(p,1200)}setTimeout(p,1600)});
    original.parentNode.insertBefore(button,original);
  }

  const fileInput=document.getElementById('captureFile'),frame=document.getElementById('capturePdfPreview'),empty=document.getElementById('capturePdfEmpty');
  const shell=frame?.closest('.capture-pdf-shell');
  if(!fileInput||!frame||!empty||!shell){installPrintButton();return}

  function collapseEmptyIfPdfExists(){
    const hasFrameSource=Boolean(String(frame.getAttribute('src')||'').trim());
    const image=document.getElementById('capturePdfPageImage');
    const hasImage=image&&!image.hidden&&Boolean(String(image.getAttribute('src')||'').trim());
    if(hasFrameSource||hasImage){
      empty.hidden=true;
      empty.classList.add('brain-super-hidden');
      empty.style.setProperty('display','none','important');
      empty.style.setProperty('height','0','important');
      empty.style.setProperty('min-height','0','important');
      empty.style.setProperty('margin','0','important');
      empty.style.setProperty('padding','0','important');
    }
  }

  let tools=document.getElementById('captureSuperTools');
  if(!tools){
    tools=document.createElement('div');tools.id='captureSuperTools';tools.className='capture-super-tools';tools.hidden=true;
    tools.innerHTML='<button id="capturePreviewPrev" type="button">←</button><span id="capturePreviewStatus" class="capture-super-status">1 / 1</span><button id="capturePreviewNext" type="button">→</button><button id="capturePreviewMinus" type="button">−</button><button id="capturePreview100" type="button">100 %</button><button id="capturePreviewWidth" type="button">Breite</button><button id="capturePreviewPlus" type="button">＋</button><button type="button" data-capture-loupe="2">🔎 2×</button><button type="button" data-capture-loupe="3">🔎 3×</button><button type="button" data-capture-loupe="4">🔎 4×</button>';
    shell.parentNode.insertBefore(tools,shell);
  }
  let image=document.getElementById('capturePdfPageImage');
  if(!image){image=document.createElement('img');image.id='capturePdfPageImage';image.alt='PDF Vorschau';image.hidden=true;shell.appendChild(image)}
  let loupe=document.getElementById('capturePreviewLoupe');
  if(!loupe){loupe=document.createElement('div');loupe.id='capturePreviewLoupe';loupe.className='capture-preview-loupe';document.body.appendChild(loupe)}

  const status=document.getElementById('capturePreviewStatus'),prev=document.getElementById('capturePreviewPrev'),next=document.getElementById('capturePreviewNext');
  const state={token:'',page:1,pages:1,scale:1.45,width:0,loupe:0,pending:false};
  function pageUrl(){return '/incoming/capture/preview-page?token='+encodeURIComponent(state.token)+'&page='+state.page+'&scale='+Number(state.scale).toFixed(2)}
  function stopLoupe(){state.loupe=0;loupe.style.display='none';tools.querySelectorAll('[data-capture-loupe]').forEach(b=>b.classList.remove('active'))}
  function hideLegacyViewer(){
    if(!state.token&&!state.pending)return;
    frame.hidden=true;frame.classList.add('brain-super-hidden','brain-single-viewer-off');frame.setAttribute('aria-hidden','true');
    if(frame.style.getPropertyValue('display')!=='none'||frame.style.getPropertyPriority('display')!=='important')frame.style.setProperty('display','none','important');
    empty.hidden=true;empty.classList.add('brain-super-hidden');
    collapseEmptyIfPdfExists();
  }
  function releaseLegacyViewer(){
    frame.classList.remove('brain-single-viewer-off','brain-super-hidden');frame.style.removeProperty('display');frame.removeAttribute('aria-hidden');
    empty.classList.remove('brain-super-hidden');empty.style.removeProperty('display');empty.style.removeProperty('height');empty.style.removeProperty('min-height');empty.style.removeProperty('margin');empty.style.removeProperty('padding');
    collapseEmptyIfPdfExists();
  }
  function render(){if(!state.token)return;stopLoupe();status.textContent=state.page+' / '+state.pages;prev.disabled=state.page<=1;next.disabled=state.page>=state.pages;tools.hidden=false;hideLegacyViewer();image.hidden=false;image.src=pageUrl();collapseEmptyIfPdfExists()}
  function fitWidth(){if(!state.width||!shell.clientWidth){render();return}state.scale=Math.max(.55,Math.min(5,Math.max(300,shell.clientWidth-22)/state.width));render()}
  async function activate(token){
    if(!token)return;state.token=token;state.page=1;state.pages=1;state.scale=1.45;state.width=0;
    const r=await fetch('/incoming/capture/preview-info?token='+encodeURIComponent(token),{cache:'no-store'}),d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'PDF-Vorschau fehlgeschlagen');state.pages=Number(d.pages||1);state.width=Number(d.width||0);fitWidth();
  }
  async function primePreview(file){
    if(!file||!String(file.name||'').toLowerCase().endsWith('.pdf'))return;
    state.pending=true;state.token='';tools.hidden=true;image.hidden=true;stopLoupe();hideLegacyViewer();shell.classList.add('brain-preview-loading');
    try{const fd=new FormData();fd.append('file',file);const r=await fetch('/incoming/capture/analyze-preview',{method:'POST',body:fd,cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok||!d.previewToken)throw new Error(d.error||'PDF-Vorschau fehlgeschlagen');await activate(d.previewToken)}
    catch(error){console.error('Dunja PDF-Viewer:',error);state.token='';tools.hidden=true;image.hidden=true;releaseLegacyViewer();frame.hidden=false;empty.hidden=true;collapseEmptyIfPdfExists()}
    finally{state.pending=false;shell.classList.remove('brain-preview-loading');if(state.token)hideLegacyViewer();collapseEmptyIfPdfExists()}
  }

  prev?.addEventListener('click',()=>{if(state.page>1){state.page--;render()}});next?.addEventListener('click',()=>{if(state.page<state.pages){state.page++;render()}});
  document.getElementById('capturePreviewMinus')?.addEventListener('click',()=>{state.scale=Math.max(.45,state.scale-.2);render()});
  document.getElementById('capturePreviewPlus')?.addEventListener('click',()=>{state.scale=Math.min(5,state.scale+.2);render()});
  document.getElementById('capturePreview100')?.addEventListener('click',()=>{state.scale=1;render()});
  document.getElementById('capturePreviewWidth')?.addEventListener('click',fitWidth);
  tools.querySelectorAll('[data-capture-loupe]').forEach(button=>button.addEventListener('click',()=>{const value=Number(button.dataset.captureLoupe||0),same=state.loupe===value;stopLoupe();if(!same){state.loupe=value;button.classList.add('active')}}));
  shell.addEventListener('wheel',e=>{if(!e.ctrlKey||!state.token)return;e.preventDefault();state.scale=Math.max(.45,Math.min(5,state.scale+(e.deltaY<0?.18:-.18)));render()},{passive:false});
  image.addEventListener('mousemove',e=>{if(!state.loupe)return;const r=image.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(x<0||y<0||x>r.width||y>r.height)return;const z=state.loupe,lw=loupe.offsetWidth||340,lh=loupe.offsetHeight||235;loupe.style.display='block';loupe.style.left=Math.min(window.innerWidth-lw-8,e.clientX+24)+'px';loupe.style.top=Math.max(8,Math.min(window.innerHeight-lh-8,e.clientY-lh/2))+'px';loupe.style.backgroundImage='url("'+image.src+'")';loupe.style.backgroundSize=(r.width*z)+'px '+(r.height*z)+'px';loupe.style.backgroundPosition=(-x*z+lw/2)+'px '+(-y*z+lh/2)+'px'});
  image.addEventListener('mouseleave',()=>loupe.style.display='none');
  fileInput.addEventListener('change',()=>{const file=fileInput.files?.[0];if(file)primePreview(file)},true);
  const pageObserver=new MutationObserver(()=>{installPrintButton();collapseEmptyIfPdfExists()});pageObserver.observe(document.documentElement,{childList:true,subtree:true});installPrintButton();
  const legacyObserver=new MutationObserver(()=>{collapseEmptyIfPdfExists();if(state.token||state.pending)hideLegacyViewer()});legacyObserver.observe(frame,{attributes:true,attributeFilter:['hidden','src','class','style']});
  const emptyObserver=new MutationObserver(()=>{if(state.token||state.pending||String(frame.getAttribute('src')||'').trim()){empty.hidden=true;empty.classList.add('brain-super-hidden');collapseEmptyIfPdfExists()}});emptyObserver.observe(empty,{attributes:true,attributeFilter:['hidden','class','style']});
  collapseEmptyIfPdfExists();
  if(fileInput.files?.[0])setTimeout(()=>primePreview(fileInput.files[0]),0);
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Brain Viewer V8 aktiv: Leerplatz kollabiert sicher + Lupe + Fallback")
