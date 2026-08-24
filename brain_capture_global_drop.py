# coding: utf-8
"""Eingangsrechnung: ein einziger, seitenweiter Datei-Einzug.

Die zwei grossen Drop-Zonen (Rechnungseingang + aktive Rechnung) werden visuell
entfernt. Stattdessen ist die ganze Erfassungsseite Drop-Zone, analog Aufgaben:
- genau 1 PDF -> sofort in die aktive Rechnungserfassung
- mehrere Dateien oder Fotos -> in den Rechnungseingang fuer spaetere Bearbeitung
Die Dateiauswahl bleibt als kompakter Fallback in den jeweiligen Kopfzeilen.
"""


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page or "kristaCaptureGlobalDropV1" in page:
        return

    css = r'''
<style id="kristaCaptureGlobalDropCss">
#captureDrop.krista-global-drop-hidden,
#invoiceIntakeDrop.krista-global-drop-hidden{display:none!important}
.capture-global-file-button{display:inline-flex;align-items:center;gap:7px;min-height:38px;padding:8px 12px;border:1px solid #526170;border-radius:9px;background:#25303a;color:#fff;font-weight:850;font-size:12px;cursor:pointer;text-decoration:none}
.capture-global-file-button:hover{background:#303d49}
.capture-preview-head .capture-global-file-button{margin-left:auto}
.invoice-intake-head .capture-global-file-button{margin-left:auto}
#captureAnalyzeSteps.capture-global-steps{margin:8px 0 10px}
.capture-global-drop-overlay{position:fixed;inset:0;z-index:20000;display:none;align-items:center;justify-content:center;padding:28px;background:rgba(4,8,12,.78);backdrop-filter:blur(3px);pointer-events:none}
.capture-global-drop-overlay.show{display:flex}.capture-global-drop-card{width:min(720px,92vw);padding:34px;border:2px dashed #79bd90;border-radius:22px;background:#111820;color:#fff;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.45)}
.capture-global-drop-card .icon{font-size:42px}.capture-global-drop-card strong{display:block;margin-top:10px;font-size:25px}.capture-global-drop-card small{display:block;margin-top:8px;color:#b9c5cf;font-size:13px;line-height:1.45}
body.capture-global-dragging{overflow:hidden}
@media(max-width:700px){.capture-global-drop-card{padding:25px 18px}.capture-global-drop-card strong{font-size:20px}.capture-global-file-button{width:auto}}
</style>
'''

    script = r'''
<script id="kristaCaptureGlobalDropV1">
(function(){
  const directInput=document.getElementById('captureFile');
  if(!directInput)return;
  const directDrop=document.getElementById('captureDrop');
  const previewHead=directDrop?.closest('.card')?.querySelector('.capture-preview-head')||document.querySelector('.capture-preview-head');
  const analyzeSteps=document.getElementById('captureAnalyzeSteps');

  function directChooseButton(){
    if(!previewHead||document.getElementById('captureGlobalChoose'))return;
    const button=document.createElement('button');button.id='captureGlobalChoose';button.type='button';button.className='capture-global-file-button';button.textContent='📄 PDF auswählen';
    button.onclick=()=>directInput.click();
    const open=document.getElementById('captureOpenPdf');
    if(open)previewHead.insertBefore(button,open);else previewHead.appendChild(button);
  }
  function simplifyDirect(){
    directChooseButton();
    if(analyzeSteps&&directDrop&&analyzeSteps.parentElement===directDrop){directDrop.insertAdjacentElement('afterend',analyzeSteps);analyzeSteps.classList.add('capture-global-steps')}
    directDrop?.classList.add('krista-global-drop-hidden');
  }

  function simplifyIntake(){
    const drop=document.getElementById('invoiceIntakeDrop'),input=document.getElementById('invoiceIntakeFile'),head=document.querySelector('.invoice-intake-head');
    if(!drop||!input||!head)return false;
    drop.classList.add('krista-global-drop-hidden');
    if(!document.getElementById('captureGlobalIntakeChoose')){
      const button=document.createElement('button');button.id='captureGlobalIntakeChoose';button.type='button';button.className='capture-global-file-button';button.textContent='＋ Dateien ablegen';button.onclick=()=>input.click();
      const count=document.getElementById('invoiceIntakeCount');if(count)head.insertBefore(button,count);else head.appendChild(button);
    }
    return true;
  }

  function setDirectFile(file){
    if(!file)return;
    if(typeof setCaptureFile==='function'){setCaptureFile(file);return}
    try{const dt=new DataTransfer();dt.items.add(file);directInput.files=dt.files;directInput.dispatchEvent(new Event('change',{bubbles:true}))}catch(_){alert('PDF konnte nicht übernommen werden. Bitte „PDF auswählen“ verwenden.')}
  }
  function queueFiles(files){
    const input=document.getElementById('invoiceIntakeFile');
    if(!input){alert('Rechnungseingang ist noch nicht bereit.');return}
    try{const dt=new DataTransfer();[...(files||[])].forEach(f=>dt.items.add(f));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))}catch(_){input.click()}
  }

  simplifyDirect();
  if(!simplifyIntake())setTimeout(simplifyIntake,0);
  const observer=new MutationObserver(()=>simplifyIntake());observer.observe(document.body,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),4000);

  const overlay=document.createElement('div');overlay.id='captureGlobalDropOverlay';overlay.className='capture-global-drop-overlay';overlay.innerHTML='<div class="capture-global-drop-card"><div class="icon">📥</div><strong>Rechnung hier loslassen</strong><small>Eine PDF wird sofort zur Bearbeitung geöffnet.<br>Mehrere Dateien oder Fotos landen gesammelt im Rechnungseingang.</small></div>';document.body.appendChild(overlay);
  let depth=0;
  const hasFiles=e=>Array.from(e.dataTransfer?.types||[]).includes('Files');
  function show(){overlay.classList.add('show');document.body.classList.add('capture-global-dragging')}
  function hide(){depth=0;overlay.classList.remove('show');document.body.classList.remove('capture-global-dragging')}
  document.addEventListener('dragenter',e=>{if(!hasFiles(e))return;e.preventDefault();depth++;show()},true);
  document.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='copy';show()},true);
  document.addEventListener('dragleave',e=>{if(!hasFiles(e))return;depth=Math.max(0,depth-1);if(!depth)hide()},true);
  document.addEventListener('drop',e=>{
    if(!hasFiles(e))return;e.preventDefault();e.stopPropagation();const files=[...(e.dataTransfer?.files||[])];hide();if(!files.length)return;
    const onePdf=files.length===1&&(files[0].type==='application/pdf'||/\.pdf$/i.test(files[0].name||''));
    if(onePdf)setDirectFile(files[0]);else queueFiles(files);
  },true);
})();
</script>
'''

    page = page.replace("</head>", css + "\n</head>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Rechnungserfassung: ganzer Bildschirm ist Datei-Einzug · Doppel-Drop entfernt")
