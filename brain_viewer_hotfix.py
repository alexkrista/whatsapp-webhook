# coding: utf-8
"""Brain-Hotfix: Dunja-PDF-Superviewer zuverlässig starten + Drucken im Brain-PDF-Viewer."""


def install(ns):
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

    if "kristaBrainViewerReliableV4" in page:
        ns["MOBILE_PAGE"] = page
        return

    css = r'''
#capturePdfPreview.brain-super-hidden,
#capturePdfEmpty.brain-super-hidden{
  display:none!important;
  visibility:hidden!important;
  height:0!important;
  min-height:0!important;
  margin:0!important;
  padding:0!important;
  border:0!important;
}
.capture-pdf-shell.brain-preview-loading::after{
  content:'PDF-Vorschau wird vorbereitet …';
  position:absolute;
  inset:0;
  display:grid;
  place-items:center;
  background:rgba(12,14,16,.84);
  color:#cbd4df;
  font-size:13px;
  z-index:4;
  pointer-events:none;
}
#pdfPrint{white-space:nowrap}
'''

    script = r'''
<script id="kristaBrainViewerReliableV4">
(function(){
  function installPrintButton(){
    const original=document.getElementById('pdfOriginal');
    if(!original||document.getElementById('pdfPrint'))return;
    const button=document.createElement('button');
    button.id='pdfPrint';
    button.type='button';
    button.textContent='🖨 Drucken';
    button.addEventListener('click',()=>{
      const href=String(original.href||'');
      if(!href||href.endsWith('#'))return;
      const printWindow=window.open(href,'_blank');
      if(!printWindow)return;
      const tryPrint=()=>{try{printWindow.focus();printWindow.print()}catch(_){}};
      try{printWindow.addEventListener('load',()=>setTimeout(tryPrint,700),{once:true})}catch(_){setTimeout(tryPrint,1200)}
      setTimeout(tryPrint,1600);
    });
    original.parentNode.insertBefore(button,original);
  }

  const fileInput=document.getElementById('captureFile');
  const frame=document.getElementById('capturePdfPreview');
  const empty=document.getElementById('capturePdfEmpty');
  const tools=document.getElementById('captureSuperTools');
  const shell=frame?.closest('.capture-pdf-shell');

  installPrintButton();

  if(fileInput&&frame&&empty&&tools&&shell){
    function currentImage(){return document.getElementById('capturePdfPageImage')}
    function syncSingleViewer(){
      const image=currentImage();
      const superActive=!tools.hidden && !!(image && !image.hidden && image.getAttribute('src'));
      frame.classList.toggle('brain-super-hidden',superActive);
      empty.classList.toggle('brain-super-hidden',superActive);
      if(superActive){frame.hidden=true;empty.hidden=true}
    }
    async function primePreview(file){
      if(!file||!String(file.name||'').toLowerCase().endsWith('.pdf'))return;
      shell.classList.add('brain-preview-loading');
      try{
        const fd=new FormData();fd.append('file',file);
        const response=await fetch('/incoming/capture/analyze-preview',{method:'POST',body:fd,cache:'no-store'});
        const data=await response.clone().json().catch(()=>({}));
        if(!response.ok||!data.ok)throw new Error(data.error||'PDF-Vorschau fehlgeschlagen');
        setTimeout(syncSingleViewer,0);setTimeout(syncSingleViewer,120);setTimeout(syncSingleViewer,450);
      }catch(error){
        console.error('Dunja PDF-Superviewer Preview-Upload:',error);
        frame.classList.remove('brain-super-hidden');empty.classList.remove('brain-super-hidden');
      }finally{shell.classList.remove('brain-preview-loading')}
    }
    fileInput.addEventListener('change',()=>{const file=fileInput.files?.[0];if(file)primePreview(file)},true);
    const observer=new MutationObserver(()=>{syncSingleViewer();installPrintButton()});
    observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','src','class','href']});
    setInterval(()=>{syncSingleViewer();installPrintButton()},700);
    syncSingleViewer();
  }
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Brain Viewer V4 aktiv: Preview + Drucken")
