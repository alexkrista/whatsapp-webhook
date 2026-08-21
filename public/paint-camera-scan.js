"use strict";
(function(){
  const params=new URLSearchParams(location.search);
  const directScan=params.get("scan")==="1";
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
    @media(max-width:750px){#cameraReader{min-height:220px}.camera-scan-actions{display:grid;grid-template-columns:1fr}.camera-scan-actions .btn{width:100%;font-size:16px;min-height:52px}}
  `;
  document.head.appendChild(style);

  const actions=document.createElement("div");
  actions.className="camera-scan-actions";
  actions.innerHTML=`
    <button id="cameraScanBtn" class="btn primary" type="button">📷 Kamera öffnen</button>
    <button id="cameraPhotoBtn" class="btn" type="button">📸 Barcode fotografieren</button>
    <input id="cameraPhotoInput" type="file" accept="image/*" capture="environment" hidden>
  `;
  const panel=document.createElement("div");
  panel.id="cameraScanPanel";
  panel.className="camera-scan-panel";
  panel.hidden=true;
  panel.innerHTML='<div id="cameraReader"></div>';
  const hint=document.createElement("div");
  hint.className="camera-hint";
  hint.textContent="Am iPhone muss die Kamera aus Sicherheitsgründen durch einen echten Fingertipp geöffnet werden. Falls Live-Scan blockiert ist, funktioniert „Barcode fotografieren“ als Reserve.";

  card.insertBefore(actions,ean);
  card.insertBefore(panel,ean);
  card.insertBefore(hint,ean.nextSibling);

  const button=document.getElementById("cameraScanBtn");
  const photoButton=document.getElementById("cameraPhotoBtn");
  const photoInput=document.getElementById("cameraPhotoInput");
  let scanner=null;
  let starting=false;
  let locked=false;

  function setStatus(text){if(scanInfo)scanInfo.textContent=text||""}

  function friendlyCameraError(error){
    const name=String(error?.name||"");
    const raw=String(error?.message||error||"");
    const lower=(name+" "+raw).toLowerCase();
    if(lower.includes("notallowed")||lower.includes("permission")||lower.includes("denied")||lower.includes("security")){
      return "Kamera ist für diese Website nicht erlaubt. Am iPhone in den Website-/Browser-Einstellungen für protokoll.krista.at die Kamera auf „Erlauben“ stellen und danach erneut auf Kamera öffnen tippen";
    }
    if(lower.includes("notfound")||lower.includes("devicesnotfound"))return "Keine Kamera gefunden";
    if(lower.includes("notreadable")||lower.includes("trackstarterror"))return "Kamera ist gerade von einer anderen App belegt. Kamera-App schließen und nochmals probieren";
    if(lower.includes("https")||lower.includes("secure context"))return "Kamera braucht eine sichere HTTPS-Verbindung";
    if(lower.includes("scanner-bibliothek")||lower.includes("failed to load")||lower.includes("network"))return "Scanner konnte nicht geladen werden. Internetverbindung prüfen und nochmals probieren";
    return raw||"Kamera konnte nicht gestartet werden";
  }

  function loadScript(src){
    return new Promise((resolve,reject)=>{
      const script=document.createElement("script");
      script.src=src;
      script.async=true;
      script.dataset.lgCameraLib="1";
      script.onload=()=>resolve();
      script.onerror=()=>{script.remove();reject(new Error("Scanner-Bibliothek konnte nicht geladen werden"));};
      document.head.appendChild(script);
    });
  }

  async function loadScannerLibrary(){
    if(window.Html5Qrcode)return;
    const existing=document.querySelector('script[data-lg-camera-lib]');
    if(existing){
      await new Promise((resolve,reject)=>{
        if(window.Html5Qrcode)return resolve();
        existing.addEventListener("load",resolve,{once:true});
        existing.addEventListener("error",()=>reject(new Error("Scanner-Bibliothek konnte nicht geladen werden")),{once:true});
        setTimeout(()=>window.Html5Qrcode?resolve():reject(new Error("Scanner-Bibliothek konnte nicht geladen werden")),7000);
      }).catch(()=>{});
      if(window.Html5Qrcode)return;
    }
    const sources=[
      "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js",
      "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"
    ];
    let lastError=null;
    for(const src of sources){
      try{await loadScript(src);if(window.Html5Qrcode)return;}catch(error){lastError=error;}
    }
    throw lastError||new Error("Scanner-Bibliothek konnte nicht geladen werden");
  }

  async function stopCamera(clearStatus=false){
    locked=false;
    try{
      if(scanner){
        if(scanner.isScanning)await scanner.stop();
        try{await scanner.clear()}catch{}
      }
    }catch{}
    scanner=null;
    panel.hidden=true;
    button.textContent="📷 Kamera öffnen";
    button.classList.add("primary");
    if(clearStatus)setStatus("");
  }

  async function acceptCode(decoded){
    if(locked)return;
    const code=String(decoded||"").replace(/\D/g,"");
    if(code.length<8||code.length>14)return;
    locked=true;
    ean.value=code;
    await stopCamera(false);
    setStatus("EAN erkannt: "+code+" · Dose wird geladen …");
    ean.dispatchEvent(new Event("input",{bubbles:true}));
    ean.dispatchEvent(new Event("change",{bubbles:true}));
    try{navigator.vibrate?.(80)}catch{}
  }

  async function startCamera(){
    if(starting)return;
    if(scanner){await stopCamera(true);return;}
    starting=true;
    button.disabled=true;
    setStatus("Rückkamera wird gestartet …");
    try{
      if(!window.isSecureContext)throw new Error("Kamera braucht eine HTTPS-Verbindung");
      if(!navigator.mediaDevices?.getUserMedia)throw new Error("Dieser Browser erlaubt hier keinen Kamerazugriff");
      await loadScannerLibrary();
      if(!window.Html5Qrcode)throw new Error("Scanner-Bibliothek konnte nicht geladen werden");

      panel.hidden=false;
      const formats=window.Html5QrcodeSupportedFormats;
      const wanted=formats?[formats.EAN_13,formats.EAN_8,formats.UPC_A,formats.UPC_E,formats.CODE_128].filter(v=>v!==undefined):undefined;
      scanner=new window.Html5Qrcode("cameraReader",wanted?.length?{formatsToSupport:wanted,verbose:false}:{verbose:false});
      button.textContent="✕ Kamera schließen";
      button.classList.remove("primary");
      await scanner.start(
        {facingMode:"environment"},
        {fps:12,qrbox:{width:300,height:150},aspectRatio:1.777778,disableFlip:true},
        decoded=>acceptCode(decoded),
        ()=>{}
      );
      setStatus("Kamera aktiv · EAN-Strichcode quer vor die Kamera halten");
    }catch(error){
      await stopCamera(false);
      setStatus(friendlyCameraError(error)+". Alternativ „Barcode fotografieren“ verwenden oder EAN manuell eingeben.");
    }finally{
      starting=false;
      button.disabled=false;
    }
  }

  async function scanPhoto(file){
    if(!file)return;
    setStatus("Barcode-Foto wird gelesen …");
    photoButton.disabled=true;
    try{
      await stopCamera(false);
      await loadScannerLibrary();
      panel.hidden=false;
      scanner=new window.Html5Qrcode("cameraReader",{verbose:false});
      const decoded=await scanner.scanFile(file,true);
      await acceptCode(decoded);
    }catch(error){
      await stopCamera(false);
      setStatus("Kein Barcode erkannt. Bitte näher fotografieren, Barcode gerade halten und nochmals probieren. "+friendlyCameraError(error));
    }finally{
      photoButton.disabled=false;
      photoInput.value="";
    }
  }

  function openScanTab(){
    const scanTab=document.querySelector('[data-tab="scan"]');
    if(scanTab&&!scanTab.classList.contains("active"))scanTab.click();
    else if(typeof window.showTab==="function")window.showTab("scan");
  }

  function enterDirectScan(){
    openScanTab();
    try{
      const url=new URL(location.href);
      url.searchParams.delete("scan");
      history.replaceState(null,"",url.pathname+url.search+url.hash);
    }catch{}
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      setStatus("Bereit zum Scannen · am iPhone einmal „Kamera öffnen“ antippen");
      if(window.matchMedia?.("(max-width:900px),(pointer:coarse)")?.matches)button.focus();
      else ean.focus();
    }));
  }

  button.addEventListener("click",startCamera);
  photoButton.addEventListener("click",()=>photoInput.click());
  photoInput.addEventListener("change",event=>scanPhoto(event.target.files?.[0]));
  document.querySelectorAll("[data-tab]").forEach(tab=>tab.addEventListener("click",()=>{if(tab.dataset.tab!=="scan"&&scanner)stopCamera(true)}));
  window.addEventListener("pagehide",()=>{if(scanner)stopCamera(false)});

  if(directScan){
    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",enterDirectScan,{once:true});
    else setTimeout(enterDirectScan,0);
  }
})();
