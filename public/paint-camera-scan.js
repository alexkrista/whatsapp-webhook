"use strict";
(function(){
  const ean=document.getElementById("ean");
  const scanInfo=document.getElementById("scanInfo");
  if(!ean)return;

  const card=ean.closest(".card");
  if(!card||document.getElementById("cameraScanBtn"))return;

  const style=document.createElement("style");
  style.textContent=`
    .camera-scan-actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}
    .camera-scan-panel{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#111;margin:0 0 10px;position:relative}
    .camera-scan-panel[hidden]{display:none!important}
    #cameraReader{width:100%;min-height:260px;background:#111}
    #cameraReader video{width:100%!important;height:auto!important;display:block;border-radius:0!important}
    .camera-hint{font-size:12px;color:#70766f;margin:7px 0 0}
    @media(max-width:750px){#cameraReader{min-height:220px}.camera-scan-actions .btn{flex:1}}
  `;
  document.head.appendChild(style);

  const actions=document.createElement("div");
  actions.className="camera-scan-actions";
  actions.innerHTML='<button id="cameraScanBtn" class="btn primary" type="button">📷 Dose mit Kamera scannen</button>';
  const panel=document.createElement("div");
  panel.id="cameraScanPanel";
  panel.className="camera-scan-panel";
  panel.hidden=true;
  panel.innerHTML='<div id="cameraReader"></div>';
  const hint=document.createElement("div");
  hint.className="camera-hint";
  hint.textContent="EAN-Strichcode ruhig und möglichst quer ins Kamerabild halten. Rückkamera wird verwendet.";

  card.insertBefore(actions,ean);
  card.insertBefore(panel,ean);
  card.insertBefore(hint,ean.nextSibling);

  const button=document.getElementById("cameraScanBtn");
  let scanner=null;
  let starting=false;
  let locked=false;

  function tokenized(url){
    const token=new URLSearchParams(location.search).get("token")||"";
    if(!token)return url;
    return url+(url.includes("?")?"&":"?")+"token="+encodeURIComponent(token);
  }

  function setStatus(text){if(scanInfo)scanInfo.textContent=text||""}

  function loadScannerLibrary(){
    if(window.Html5Qrcode)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const existing=document.querySelector('script[data-lg-camera-lib]');
      if(existing){existing.addEventListener("load",()=>resolve(),{once:true});existing.addEventListener("error",()=>reject(new Error("Scanner-Bibliothek konnte nicht geladen werden")),{once:true});return;}
      const script=document.createElement("script");
      script.src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
      script.async=true;
      script.dataset.lgCameraLib="1";
      script.onload=()=>resolve();
      script.onerror=()=>reject(new Error("Scanner-Bibliothek konnte nicht geladen werden"));
      document.head.appendChild(script);
    });
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
    button.textContent="📷 Dose mit Kamera scannen";
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
      if(!window.Html5Qrcode)throw new Error("Kamera-Scanner ist nicht verfügbar");

      panel.hidden=false;
      const formats=window.Html5QrcodeSupportedFormats;
      const wanted=formats?[formats.EAN_13,formats.EAN_8,formats.UPC_A,formats.UPC_E,formats.CODE_128].filter(v=>v!==undefined):undefined;
      scanner=new window.Html5Qrcode("cameraReader",wanted?.length?{formatsToSupport:wanted,verbose:false}:{verbose:false});
      button.textContent="✕ Kamera schließen";
      button.classList.remove("primary");
      await scanner.start(
        {facingMode:{ideal:"environment"}},
        {fps:12,qrbox:{width:300,height:150},aspectRatio:1.777778,disableFlip:true},
        decoded=>acceptCode(decoded),
        ()=>{}
      );
      setStatus("Kamera aktiv · EAN vor die Kamera halten");
    }catch(error){
      await stopCamera(false);
      const msg=String(error?.message||error||"Kamera konnte nicht gestartet werden");
      setStatus(msg+". EAN kann weiterhin manuell eingegeben werden.");
    }finally{
      starting=false;
      button.disabled=false;
    }
  }

  button.addEventListener("click",startCamera);
  document.querySelectorAll("[data-tab]").forEach(tab=>tab.addEventListener("click",()=>{if(tab.dataset.tab!=="scan"&&scanner)stopCamera(true)}));
  window.addEventListener("pagehide",()=>{if(scanner)stopCamera(false)});
})();
