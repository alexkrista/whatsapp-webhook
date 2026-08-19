# coding: utf-8
"""Brain: Dunja-PDF-Viewer zuverlässig starten + Drucken + OP-Liste."""


def install(ns):
    # OP-Liste zuerst ergänzen; sie arbeitet auf derselben lokalen Capture-DB.
    import brain_incoming_op
    brain_incoming_op.install(ns)

    page = str(ns.get("MOBILE_PAGE") or "")
    app = ns.get("app")
    if not page or app is None:
        return

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

    if "kristaBrainViewerReliableV5" in page:
        ns["MOBILE_PAGE"] = page
        return

    css = r'''
#capturePdfPreview.brain-super-hidden,#capturePdfEmpty.brain-super-hidden{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important}
.capture-pdf-shell.brain-preview-loading::after{content:'PDF-Vorschau wird vorbereitet …';position:absolute;inset:0;display:grid;place-items:center;background:rgba(12,14,16,.84);color:#cbd4df;font-size:13px;z-index:4;pointer-events:none}
#capturePdfPageImage{display:block;max-width:none;height:auto;margin:0 auto;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.32)}
#capturePdfPageImage[hidden]{display:none!important}#pdfPrint{white-space:nowrap}
'''

    script = r'''
<script id="kristaBrainViewerReliableV5">
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

  let tools=document.getElementById('captureSuperTools');
  if(!tools){
    tools=document.createElement('div');tools.id='captureSuperTools';tools.className='capture-super-tools';tools.hidden=true;
    tools.innerHTML='<button id="capturePreviewPrev" type="button">←</button><span id="capturePreviewStatus" class="capture-super-status">1 / 1</span><button id="capturePreviewNext" type="button">→</button><button id="capturePreviewMinus" type="button">−</button><button id="capturePreview100" type="button">100 %</button><button id="capturePreviewWidth" type="button">Breite</button><button id="capturePreviewPlus" type="button">＋</button>';
    shell.parentNode.insertBefore(tools,shell);
  }
  let image=document.getElementById('capturePdfPageImage');
  if(!image){image=document.createElement('img');image.id='capturePdfPageImage';image.alt='PDF Vorschau';image.hidden=true;shell.appendChild(image)}

  const status=document.getElementById('capturePreviewStatus'),prev=document.getElementById('capturePreviewPrev'),next=document.getElementById('capturePreviewNext');
  const state={token:'',page:1,pages:1,scale:1.45,width:0};
  function pageUrl(){return '/incoming/capture/preview-page?token='+encodeURIComponent(state.token)+'&page='+state.page+'&scale='+Number(state.scale).toFixed(2)}
  function render(){if(!state.token)return;status.textContent=state.page+' / '+state.pages;prev.disabled=state.page<=1;next.disabled=state.page>=state.pages;tools.hidden=false;frame.hidden=true;empty.hidden=true;frame.classList.add('brain-super-hidden');empty.classList.add('brain-super-hidden');image.hidden=false;image.src=pageUrl()}
  function fitWidth(){if(!state.width||!shell.clientWidth){render();return}state.scale=Math.max(.55,Math.min(5,Math.max(300,shell.clientWidth-22)/state.width));render()}
  async function activate(token){
    if(!token)return;state.token=token;state.page=1;state.pages=1;state.scale=1.45;state.width=0;
    const r=await fetch('/incoming/capture/preview-info?token='+encodeURIComponent(token),{cache:'no-store'}),d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'PDF-Vorschau fehlgeschlagen');state.pages=Number(d.pages||1);state.width=Number(d.width||0);fitWidth();
  }
  async function primePreview(file){
    if(!file||!String(file.name||'').toLowerCase().endsWith('.pdf'))return;shell.classList.add('brain-preview-loading');
    try{const fd=new FormData();fd.append('file',file);const r=await fetch('/incoming/capture/analyze-preview',{method:'POST',body:fd,cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok||!d.previewToken)throw new Error(d.error||'PDF-Vorschau fehlgeschlagen');await activate(d.previewToken)}
    catch(error){console.error('Dunja PDF-Viewer:',error);tools.hidden=true;image.hidden=true;frame.classList.remove('brain-super-hidden');empty.classList.remove('brain-super-hidden')}
    finally{shell.classList.remove('brain-preview-loading')}
  }

  prev?.addEventListener('click',()=>{if(state.page>1){state.page--;render()}});next?.addEventListener('click',()=>{if(state.page<state.pages){state.page++;render()}});
  document.getElementById('capturePreviewMinus')?.addEventListener('click',()=>{state.scale=Math.max(.45,state.scale-.2);render()});
  document.getElementById('capturePreviewPlus')?.addEventListener('click',()=>{state.scale=Math.min(5,state.scale+.2);render()});
  document.getElementById('capturePreview100')?.addEventListener('click',()=>{state.scale=1;render()});
  document.getElementById('capturePreviewWidth')?.addEventListener('click',fitWidth);
  shell.addEventListener('wheel',e=>{if(!e.ctrlKey||!state.token)return;e.preventDefault();state.scale=Math.max(.45,Math.min(5,state.scale+(e.deltaY<0?.18:-.18)));render()},{passive:false});
  fileInput.addEventListener('change',()=>{const file=fileInput.files?.[0];if(file)primePreview(file)},true);
  const observer=new MutationObserver(installPrintButton);observer.observe(document.documentElement,{childList:true,subtree:true});installPrintButton();
  if(fileInput.files?.[0])setTimeout(()=>primePreview(fileInput.files[0]),0);
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Brain Viewer V5 aktiv: Dunja direkt + Drucken + OP-Liste")
