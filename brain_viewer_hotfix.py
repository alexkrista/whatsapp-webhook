# coding: utf-8
"""Brain: Dunja-PDF-Viewer + Drucken + OP-Liste + Materialhistorie + WW-Lieferantenmap."""


def install(ns):
    import brain_supplier_enrichment
    brain_supplier_enrichment.install(ns)
    import brain_local_suppliers
    brain_local_suppliers.install(ns)
    import brain_supplier_choice_ui
    brain_supplier_choice_ui.install(ns)
    import brain_incoming_op
    brain_incoming_op.install(ns)
    import brain_material_history
    brain_material_history.install(ns)
    import brain_lg_sync
    brain_lg_sync.install(ns)

    page = str(ns.get("MOBILE_PAGE") or "")
    app = ns.get("app")
    if not page or app is None:
        return

    import re
    page = re.sub(
        r'<script\s+id="kristaBrainCaptureViewerV2">.*?</script>',
        '',
        page,
        flags=re.I | re.S,
    )
    page = re.sub(r'<script id="kristaBrainViewerReliableV[78]">.*?</script>', '', page, flags=re.I | re.S)

    if "kristaBrainViewerReliableV9" in page:
        ns["MOBILE_PAGE"] = page
        return

    css = r'''
/* V9: Der native Browser-PDF-iframe bleibt komplett aus. Große PDFs werden
   nur einmal hochgeladen und danach seitenweise als Bild gerendert. */
#capturePdfPreview{
  display:none!important;visibility:hidden!important;width:0!important;height:0!important;
  min-height:0!important;margin:0!important;padding:0!important;border:0!important;
  position:absolute!important;pointer-events:none!important
}
#capturePdfEmpty.brain-super-hidden{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important}
.capture-pdf-shell{align-items:flex-start!important;justify-content:flex-start!important}
.capture-pdf-shell.brain-preview-loading::after{content:'PDF wird gelesen und Vorschau vorbereitet …';position:absolute;inset:0;display:grid;place-items:center;background:rgba(12,14,16,.84);color:#cbd4df;font-size:13px;z-index:4;pointer-events:none}
#capturePdfPageImage{display:block;max-width:none;height:auto;margin:0 auto;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.32)}
#capturePdfPageImage[hidden]{display:none!important}
#pdfPrint{white-space:nowrap}
.pdf-super-stage{padding-top:0!important}
'''

    script = r'''
<script id="kristaBrainViewerReliableV9">
(function(){
  function installPrintButton(){
    const original=document.getElementById('pdfOriginal');
    if(!original||document.getElementById('pdfPrint'))return;
    const button=document.createElement('button');button.id='pdfPrint';button.type='button';button.textContent='🖨 Drucken';
    button.addEventListener('click',()=>{const href=String(original.href||'');if(!href||href.endsWith('#'))return;const w=window.open(href,'_blank');if(!w)return;const p=()=>{try{w.focus();w.print()}catch(_){}};try{w.addEventListener('load',()=>setTimeout(p,700),{once:true})}catch(_){setTimeout(p,1200)}setTimeout(p,1600)});
    original.parentNode.insertBefore(button,original);
  }

  const fileInput=document.getElementById('captureFile'),frame=document.getElementById('capturePdfPreview'),empty=document.getElementById('capturePdfEmpty'),openPdf=document.getElementById('captureOpenPdf');
  const shell=frame?.closest('.capture-pdf-shell');
  if(!fileInput||!frame||!empty||!shell){installPrintButton();return}

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
  let localObjectUrl='';

  function revokeLocalUrl(){if(localObjectUrl){try{URL.revokeObjectURL(localObjectUrl)}catch(_){}localObjectUrl=''}}
  function pageUrl(){return '/incoming/capture/preview-page?token='+encodeURIComponent(state.token)+'&page='+state.page+'&scale='+Number(state.scale).toFixed(2)}
  function stopLoupe(){state.loupe=0;loupe.style.display='none';tools.querySelectorAll('[data-capture-loupe]').forEach(b=>b.classList.remove('active'))}
  function nativeViewerOff(){if(!frame.hidden)frame.hidden=true;if(frame.hasAttribute('src'))frame.removeAttribute('src');if(frame.getAttribute('aria-hidden')!=='true')frame.setAttribute('aria-hidden','true')}
  function hideEmpty(){empty.hidden=true;empty.classList.add('brain-super-hidden')}
  function showEmpty(){empty.classList.remove('brain-super-hidden');empty.hidden=false}
  function resetPreview(){state.token='';state.page=1;state.pages=1;state.width=0;state.pending=false;stopLoupe();tools.hidden=true;image.hidden=true;image.removeAttribute('src');shell.classList.remove('brain-preview-loading');nativeViewerOff();revokeLocalUrl();if(openPdf){openPdf.hidden=true;openPdf.removeAttribute('href')}showEmpty()}
  function beginFile(file){
    if(!file)return resetPreview();
    state.pending=true;state.token='';tools.hidden=true;image.hidden=true;image.removeAttribute('src');stopLoupe();nativeViewerOff();hideEmpty();shell.classList.add('brain-preview-loading');
    revokeLocalUrl();
    if(openPdf){localObjectUrl=URL.createObjectURL(file);openPdf.href=localObjectUrl;openPdf.hidden=false}
  }
  function render(){if(!state.token)return;stopLoupe();status.textContent=state.page+' / '+state.pages;prev.disabled=state.page<=1;next.disabled=state.page>=state.pages;tools.hidden=false;nativeViewerOff();hideEmpty();image.hidden=false;image.src=pageUrl()}
  function fitWidth(){if(!state.width||!shell.clientWidth){render();return}state.scale=Math.max(.35,Math.min(4.5,Math.max(300,shell.clientWidth-22)/state.width));render()}

  const realFetch=window.fetch.bind(window);
  async function activate(token){
    if(!token)return;
    state.token=token;state.page=1;state.pages=1;state.scale=1.45;state.width=0;
    try{
      const r=await realFetch('/incoming/capture/preview-info?token='+encodeURIComponent(token),{cache:'no-store'}),d=await r.json();
      if(!r.ok||!d.ok)throw new Error(d.error||'PDF-Vorschau fehlgeschlagen');
      state.pages=Number(d.pages||1);state.width=Number(d.width||0);state.pending=false;shell.classList.remove('brain-preview-loading');fitWidth();
    }catch(error){state.pending=false;shell.classList.remove('brain-preview-loading');console.error('Dunja PDF-Viewer:',error);tools.hidden=true;image.hidden=true;hideEmpty()}
  }

  /* showCapturePdf aus archive-connector.py darf KEIN blob: in den iframe setzen. */
  const safeShowCapturePdf=function(file){if(file)beginFile(file);else resetPreview()};
  try{window.showCapturePdf=safeShowCapturePdf}catch(_){}
  try{showCapturePdf=safeShowCapturePdf}catch(_){}
  nativeViewerOff();

  /* Nur EIN Upload: /incoming/capture/analyze liefert bereits previewToken mit. */
  window.fetch=async function(input,init){
    const response=await realFetch(input,init);
    try{
      const url=typeof input==='string'?input:(input?.url||'');
      if(url.includes('/incoming/capture/analyze')&&!url.includes('/analyze-preview')){
        response.clone().json().then(d=>{
          if(d?.ok&&d?.previewToken)activate(d.previewToken);
          else{state.pending=false;shell.classList.remove('brain-preview-loading')}
        }).catch(()=>{state.pending=false;shell.classList.remove('brain-preview-loading')});
      }
    }catch(_){}
    return response;
  };

  prev?.addEventListener('click',()=>{if(state.page>1){state.page--;render()}});
  next?.addEventListener('click',()=>{if(state.page<state.pages){state.page++;render()}});
  document.getElementById('capturePreviewMinus')?.addEventListener('click',()=>{state.scale=Math.max(.35,state.scale-.2);render()});
  document.getElementById('capturePreviewPlus')?.addEventListener('click',()=>{state.scale=Math.min(4.5,state.scale+.2);render()});
  document.getElementById('capturePreview100')?.addEventListener('click',()=>{state.scale=1;render()});
  document.getElementById('capturePreviewWidth')?.addEventListener('click',fitWidth);
  tools.querySelectorAll('[data-capture-loupe]').forEach(button=>button.addEventListener('click',()=>{const value=Number(button.dataset.captureLoupe||0),same=state.loupe===value;stopLoupe();if(!same){state.loupe=value;button.classList.add('active')}}));
  shell.addEventListener('wheel',e=>{if(!e.ctrlKey||!state.token)return;e.preventDefault();state.scale=Math.max(.35,Math.min(4.5,state.scale+(e.deltaY<0?.18:-.18)));render()},{passive:false});
  image.addEventListener('mousemove',e=>{if(!state.loupe)return;const r=image.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(x<0||y<0||x>r.width||y>r.height)return;const z=state.loupe,lw=loupe.offsetWidth||340,lh=loupe.offsetHeight||235;loupe.style.display='block';loupe.style.left=Math.min(window.innerWidth-lw-8,e.clientX+24)+'px';loupe.style.top=Math.max(8,Math.min(window.innerHeight-lh-8,e.clientY-lh/2))+'px';loupe.style.backgroundImage='url("'+image.src+'")';loupe.style.backgroundSize=(r.width*z)+'px '+(r.height*z)+'px';loupe.style.backgroundPosition=(-x*z+lw/2)+'px '+(-y*z+lh/2)+'px'});
  image.addEventListener('mouseleave',()=>loupe.style.display='none');

  fileInput.addEventListener('change',()=>{const file=fileInput.files?.[0];if(file)beginFile(file);else resetPreview()},true);
  const frameObserver=new MutationObserver(()=>{if(frame.hasAttribute('src'))frame.removeAttribute('src');nativeViewerOff()});
  frameObserver.observe(frame,{attributes:true,attributeFilter:['src']});
  const pageObserver=new MutationObserver(installPrintButton);pageObserver.observe(document.documentElement,{childList:true,subtree:true});installPrintButton();
})();
</script>
'''

    page = page.replace("</style>", css + "\n</style>", 1)
    page = page.replace("</body>", script + "\n</body>", 1)
    ns["MOBILE_PAGE"] = page
    print("✅ Brain Viewer V9 aktiv: ein Upload · kein nativer iframe · Seitenviewer")