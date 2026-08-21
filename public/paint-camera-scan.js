"use strict";
(function(){
  const params=new URLSearchParams(location.search);
  const directScan=params.get("scan")==="1";
  const token=params.get("token")||"";
  const ean=document.getElementById("ean");
  const scanInfo=document.getElementById("scanInfo");
  if(!ean)return;

  const card=ean.closest(".card");
  if(!card||document.getElementById("cameraScanBtn"))return;

  const style=document.createElement("style");
  style.textContent=`
    .camera-scan-actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}
    .camera-scan-actions .btn{min-height:46px}
    .camera-scan-panel{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#111;margin:0 0 10px;position:relative}
    .camera-scan-panel[hidden]{display:none!important}
    #cameraReader{width:100%;min-height:260px;background:#111}
    #cameraReader video{width:100%!important;height:auto!important;display:block;border-radius:0!important}
    .camera-hint{font-size:12px;color:#70766f;margin:7px 0 0;line-height:1.45}
    .batch-guide{position:absolute;left:8%;top:29%;width:84%;height:42%;border:3px solid #f6d86a;border-radius:12px;z-index:8;pointer-events:none;display:flex;align-items:flex-start;justify-content:center;box-shadow:0 0 0 9999px #0002}
    .batch-guide[hidden]{display:none!important}.batch-guide span{margin-top:5px;background:#111d;color:#fff;padding:5px 9px;border-radius:8px;font-size:12px;font-weight:900;letter-spacing:.06em}
    .colourant-batch{margin:12px 0 0;border:2px solid #2f7d4a;border-radius:15px;background:#eef7f0;padding:13px 15px;text-align:center}
    .colourant-batch[hidden]{display:none!important}.colourant-batch-label{font-size:12px;font-weight:900;letter-spacing:.12em;color:#536159}.colourant-batch-value{font-size:42px;line-height:1.05;font-weight:1000;letter-spacing:.08em;color:#17211b;margin:5px 0;word-break:break-word}.colourant-batch-note{font-size:12px;color:#69736b}.colourant-batch-retry{margin-top:9px}
    @media(max-width:750px){#cameraReader{min-height:220px}.camera-scan-actions{display:grid;grid-template-columns:1fr}.camera-scan-actions .btn{width:100%;font-size:16px;min-height:52px}.colourant-batch-value{font-size:48px}.colourant-batch{padding:16px 10px}}
  `;
  document.head.appendChild(style);

  const actions=document.createElement("div");
  actions.className="camera-scan-actions";
  actions.innerHTML='<button id="cameraScanBtn" class="btn primary" type="button">📷 Barcode scannen</button>';

  const panel=document.createElement("div");
  panel.id="cameraScanPanel";
  panel.className="camera-scan-panel";
  panel.hidden=true;
  panel.innerHTML='<div id="cameraReader"></div><div id="batchGuide" class="batch-guide" hidden><span>BATCH-AUFDRUCK HIER</span></div>';

  const hint=document.createElement("div");
  hint.className="camera-hint";
  hint.textContent="EAN-Strichcode quer ins Zielfeld halten. Bei Colourants liest KRISTINE danach den kleinen Batch-Aufdruck von der Dose und zeigt ihn groß an.";

  const batchBox=document.createElement("div");
  batchBox.id="colourantBatchBox";
  batchBox.className="colourant-batch";
  batchBox.hidden=true;
  batchBox.innerHTML='<div class="colourant-batch-label">BATCH FÜR MISCHMASCHINE</div><div id="colourantBatchValue" class="colourant-batch-value">…</div><div id="colourantBatchNote" class="colourant-batch-note"></div><button id="colourantBatchRetry" class="btn colourant-batch-retry" type="button" hidden>Batch nochmals lesen</button>';

  card.insertBefore(actions,ean);
  card.insertBefore(panel,ean);
  card.insertBefore(hint,ean.nextSibling);
  const scanAction=document.getElementById("scanAction");
  if(scanAction)scanAction.insertBefore(batchBox,scanAction.firstChild?.nextSibling||scanAction.firstChild);
  else card.appendChild(batchBox);

  const button=document.getElementById("cameraScanBtn");
  const batchGuide=document.getElementById("batchGuide");
  const batchValue=document.getElementById("colourantBatchValue");
  const batchNote=document.getElementById("colourantBatchNote");
  const batchRetry=document.getElementById("colourantBatchRetry");
  let scanner=null;
  let starting=false;
  let locked=false;
  let batchReading=false;
  let currentColourantEan="";

  function setStatus(text){if(scanInfo)scanInfo.textContent=text||""}
  function tokenized(url){return url+(url.includes("?")?"&":"?")+(token?"token="+encodeURIComponent(token):"").replace(/[?&]$/,"")}

  async function lookupArticle(code){
    const url="/admin/api/paint/scan?ean="+encodeURIComponent(code)+(token?"&token="+encodeURIComponent(token):"");
    const response=await fetch(url,{headers:{"Accept":"application/json"}});
    const data=await response.json().catch(()=>({ok:false,error:"Keine JSON-Antwort"}));
    if(!response.ok||data.ok===false)throw new Error(data.error||("HTTP "+response.status));
    return data.article||null;
  }

  function isColourant(article){
    const category=String(article?.category||"").toLowerCase();
    const product=String(article?.product||"").toLowerCase();
    return category==="colourant"||product==="colourants"||product==="colorants";
  }

  function friendlyCameraError(error){
    const name=String(error?.name||"");
    const raw=String(error?.message||error||"");
    const lower=(name+" "+raw).toLowerCase();
    if(lower.includes("notallowed")||lower.includes("permission")||lower.includes("denied")||lower.includes("security"))return "Kamera ist für diese Website nicht erlaubt. Am iPhone in den Website-Einstellungen die Kamera auf „Erlauben“ stellen";
    if(lower.includes("notfound")||lower.includes("devicesnotfound"))return "Keine Kamera gefunden";
    if(lower.includes("notreadable")||lower.includes("trackstarterror"))return "Kamera ist gerade von einer anderen App belegt";
    if(lower.includes("https")||lower.includes("secure context"))return "Kamera braucht eine sichere HTTPS-Verbindung";
    if(lower.includes("scanner-bibliothek")||lower.includes("failed to load")||lower.includes("network"))return "Scanner konnte nicht geladen werden. Internetverbindung prüfen";
    return raw||"Kamera konnte nicht gestartet werden";
  }

  function loadScript(src,dataKey){
    return new Promise((resolve,reject)=>{
      const script=document.createElement("script");
      script.src=src;script.async=true;script.dataset[dataKey]="1";
      script.onload=resolve;
      script.onerror=()=>{script.remove();reject(new Error("Bibliothek konnte nicht geladen werden"));};
      document.head.appendChild(script);
    });
  }

  async function loadScannerLibrary(){
    if(window.Html5Qrcode)return;
    const existing=document.querySelector('script[data-lg-camera-lib]');
    if(existing){
      await new Promise(resolve=>{if(window.Html5Qrcode)return resolve();existing.addEventListener("load",resolve,{once:true});setTimeout(resolve,3500);});
      if(window.Html5Qrcode)return;
    }
    for(const src of ["https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js","https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"]){
      try{await loadScript(src,"lgCameraLib");if(window.Html5Qrcode)return;}catch{}
    }
    throw new Error("Scanner-Bibliothek konnte nicht geladen werden");
  }

  async function loadOcrLibrary(){
    if(window.Tesseract?.recognize)return;
    const existing=document.querySelector('script[data-lg-batch-ocr]');
    if(existing){
      await new Promise(resolve=>{if(window.Tesseract?.recognize)return resolve();existing.addEventListener("load",resolve,{once:true});setTimeout(resolve,5000);});
      if(window.Tesseract?.recognize)return;
    }
    for(const src of ["https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js","https://unpkg.com/tesseract.js@5/dist/tesseract.min.js"]){
      try{await loadScript(src,"lgBatchOcr");if(window.Tesseract?.recognize)return;}catch{}
    }
    throw new Error("Batch-Leser konnte nicht geladen werden");
  }

  async function stopCamera(clearStatus=false){
    locked=false;batchReading=false;currentColourantEan="";
    try{if(scanner){if(scanner.isScanning)await scanner.stop();try{await scanner.clear()}catch{}}}catch{}
    scanner=null;panel.hidden=true;batchGuide.hidden=true;button.textContent="📷 Barcode scannen";button.classList.add("primary");
    if(clearStatus)setStatus("");
  }

  function clearBatch(){
    batchBox.hidden=true;batchValue.textContent="…";batchNote.textContent="";batchRetry.hidden=true;batchGuide.hidden=true;
  }

  function captureBatchCanvas(){
    const video=panel.querySelector("video");
    if(!video||!video.videoWidth||!video.videoHeight)throw new Error("Kamerabild noch nicht bereit");
    const vw=video.videoWidth,vh=video.videoHeight;
    const sx=Math.round(vw*0.08),sy=Math.round(vh*0.29),sw=Math.round(vw*0.84),sh=Math.round(vh*0.42);
    const scale=Math.min(2,1600/Math.max(1,sw));
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(sw*scale));canvas.height=Math.max(1,Math.round(sh*scale));
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(video,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),d=image.data;
    for(let i=0;i<d.length;i+=4){const y=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];const v=y<150?0:y>220?255:Math.round((y-150)*255/70);d[i]=d[i+1]=d[i+2]=v;}
    ctx.putImageData(image,0,0);
    return canvas;
  }

  function normalizeOcrText(text){return String(text||"").toUpperCase().replace(/[|]/g,"I").replace(/[^A-Z0-9:\-./\s]/g," ").replace(/\s+/g," ").trim()}

  function extractBatch(text,eanCode){
    const t=normalizeOcrText(text);
    const labelled=t.match(/\b(?:BATCH|LOT|BATCH\s*NO|LOT\s*NO|BATCHNR|LOTNR)\s*[:#.-]?\s*([A-Z0-9][A-Z0-9./-]{2,20})\b/i);
    if(labelled)return labelled[1].toUpperCase();
    const tokens=t.split(/\s+/).map(x=>x.replace(/^[^A-Z0-9]+|[^A-Z0-9./-]+$/g,"")).filter(Boolean);
    const eanDigits=String(eanCode||"").replace(/\D/g,"");
    const candidates=tokens.filter(x=>{
      if(x.length<4||x.length>18)return false;
      const digits=x.replace(/\D/g,"");
      if(digits&&digits===eanDigits)return false;
      if(/^(BATCH|LOT|COLOURANTS?|COLORANTS?|1L|LG)$/i.test(x))return false;
      return /\d/.test(x)&&(/[A-Z]/.test(x)||digits.length>=5);
    });
    candidates.sort((a,b)=>{
      const sa=(/[A-Z]/.test(a)&&/\d/.test(a)?4:0)+(a.length>=6&&a.length<=12?3:0)+(/[-/.]/.test(a)?1:0);
      const sb=(/[A-Z]/.test(b)&&/\d/.test(b)?4:0)+(b.length>=6&&b.length<=12?3:0)+(/[-/.]/.test(b)?1:0);
      return sb-sa;
    });
    return candidates[0]||"";
  }

  async function gentlyZoomForBatch(){
    try{
      const video=panel.querySelector("video");const track=video?.srcObject?.getVideoTracks?.()[0];const caps=track?.getCapabilities?.();
      if(!track||!caps?.zoom)return;
      const min=Number(caps.zoom.min||1),max=Number(caps.zoom.max||1);const zoom=Math.min(max,Math.max(min,1.6));
      await track.applyConstraints({advanced:[{zoom}]});
    }catch{}
  }

  async function readColourantBatch(eanCode){
    if(batchReading)return;
    batchReading=true;currentColourantEan=eanCode;
    batchBox.hidden=false;batchValue.textContent="…";batchNote.textContent="Batch-Aufdruck ins gelbe Feld halten – KRISTINE liest ihn automatisch.";batchRetry.hidden=true;batchGuide.hidden=false;
    setStatus("Colourant erkannt · jetzt den kleinen Batch-/LOT-Aufdruck ins gelbe Feld halten.");
    try{scanner?.pause?.(true)}catch{}
    await gentlyZoomForBatch();
    try{
      await loadOcrLibrary();
      let batch="";
      for(let attempt=1;attempt<=3&&!batch;attempt+=1){
        batchNote.textContent=`Batch wird gelesen … Versuch ${attempt}/3`;
        await new Promise(resolve=>setTimeout(resolve,attempt===1?900:700));
        const canvas=captureBatchCanvas();
        const result=await window.Tesseract.recognize(canvas,"eng",{logger:()=>{},tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./: "});
        batch=extractBatch(result?.data?.text||"",eanCode);
      }
      if(batch){
        batchValue.textContent=batch;batchNote.textContent="Diese Batch-Nummer an der Mischmaschine eingeben.";batchRetry.hidden=false;batchRetry.textContent="Batch neu lesen";batchGuide.hidden=true;
        setStatus("Batch erkannt: "+batch);
        try{navigator.vibrate?.([70,50,70])}catch{}
        try{if(scanner?.isScanning)await scanner.stop();}catch{}
        panel.hidden=true;button.textContent="📷 Barcode scannen";button.classList.add("primary");
      }else{
        batchValue.textContent="NICHT ERKANNT";batchNote.textContent="Dose näher halten und den kleinen Batch-/LOT-Aufdruck gerade ins gelbe Feld bringen.";batchRetry.hidden=false;batchRetry.textContent="Batch nochmals lesen";
        setStatus("Batch nicht sicher erkannt. Kamera bleibt offen – Dose näher halten und nochmals lesen.");
      }
    }catch(error){
      batchValue.textContent="NICHT ERKANNT";batchNote.textContent=String(error?.message||error||"Batch konnte nicht gelesen werden");batchRetry.hidden=false;batchRetry.textContent="Batch nochmals lesen";
      setStatus(batchNote.textContent);
    }finally{batchReading=false;}
  }

  async function acceptCode(decoded){
    if(locked)return;
    const code=String(decoded||"").replace(/\D/g,"");
    if(code.length<8||code.length>14)return;
    locked=true;clearBatch();ean.value=code;
    setStatus("EAN erkannt: "+code+" · Dose wird geladen …");
    ean.dispatchEvent(new Event("input",{bubbles:true}));ean.dispatchEvent(new Event("change",{bubbles:true}));
    try{navigator.vibrate?.(80)}catch{}

    let article=null;
    try{article=await lookupArticle(code)}catch{}
    if(isColourant(article)){
      await readColourantBatch(code);
      return;
    }
    await stopCamera(false);
  }

  async function startCamera(){
    if(starting)return;
    if(scanner){await stopCamera(true);return;}
    clearBatch();starting=true;button.disabled=true;setStatus("Rückkamera wird gestartet …");
    try{
      if(!window.isSecureContext)throw new Error("Kamera braucht eine HTTPS-Verbindung");
      if(!navigator.mediaDevices?.getUserMedia)throw new Error("Dieser Browser erlaubt hier keinen Kamerazugriff");
      await loadScannerLibrary();if(!window.Html5Qrcode)throw new Error("Scanner-Bibliothek konnte nicht geladen werden");
      panel.hidden=false;
      const formats=window.Html5QrcodeSupportedFormats;
      const wanted=formats?[formats.EAN_13,formats.EAN_8,formats.UPC_A,formats.UPC_E,formats.CODE_128].filter(v=>v!==undefined):undefined;
      scanner=new window.Html5Qrcode("cameraReader",wanted?.length?{formatsToSupport:wanted,verbose:false}:{verbose:false});
      button.textContent="✕ Kamera schließen";button.classList.remove("primary");
      await scanner.start({facingMode:"environment"},{fps:12,qrbox:{width:300,height:150},aspectRatio:1.777778,disableFlip:true},decoded=>acceptCode(decoded),()=>{});
      setStatus("Kamera aktiv · EAN-Strichcode quer vor die Kamera halten");
    }catch(error){await stopCamera(false);setStatus(friendlyCameraError(error)+". EAN kann weiterhin manuell eingegeben werden.");}
    finally{starting=false;button.disabled=false;}
  }

  async function retryBatch(){
    if(!currentColourantEan)return;
    locked=true;
    if(!scanner||!scanner.isScanning){
      try{
        await loadScannerLibrary();panel.hidden=false;
        const formats=window.Html5QrcodeSupportedFormats;const wanted=formats?[formats.EAN_13,formats.EAN_8,formats.UPC_A,formats.UPC_E,formats.CODE_128].filter(v=>v!==undefined):undefined;
        scanner=new window.Html5Qrcode("cameraReader",wanted?.length?{formatsToSupport:wanted,verbose:false}:{verbose:false});
        await scanner.start({facingMode:"environment"},{fps:8,qrbox:{width:300,height:150},aspectRatio:1.777778,disableFlip:true},()=>{},()=>{});
      }catch(error){setStatus(friendlyCameraError(error));return;}
    }
    await readColourantBatch(currentColourantEan);
  }

  function openScanTab(){const scanTab=document.querySelector('[data-tab="scan"]');if(scanTab&&!scanTab.classList.contains("active"))scanTab.click();else if(typeof window.showTab==="function")window.showTab("scan")}
  function enterDirectScan(){openScanTab();try{const url=new URL(location.href);url.searchParams.delete("scan");history.replaceState(null,"",url.pathname+url.search+url.hash)}catch{}requestAnimationFrame(()=>requestAnimationFrame(()=>{setStatus("Bereit zum Scannen · am iPhone einmal „Barcode scannen“ antippen");if(window.matchMedia?.("(max-width:900px),(pointer:coarse)")?.matches)button.focus();else ean.focus()}))}

  button.addEventListener("click",startCamera);batchRetry.addEventListener("click",retryBatch);
  document.querySelectorAll("[data-tab]").forEach(tab=>tab.addEventListener("click",()=>{if(tab.dataset.tab!=="scan"&&scanner)stopCamera(true)}));
  window.addEventListener("pagehide",()=>{if(scanner)stopCamera(false)});
  if(directScan){if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",enterDirectScan,{once:true});else setTimeout(enterDirectScan,0)}
})();
