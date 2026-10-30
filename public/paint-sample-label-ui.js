"use strict";
(function () {
  if (window.__kristaSampleLabelLoaded) return;
  window.__kristaSampleLabelLoaded = true;

  const localUrl = "http://127.0.0.1:17831";
  const token = new URLSearchParams(location.search).get("token") || "";
  const el = (id) => document.getElementById(id);
  const requestUrl = (url) => url + (token ? (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : "");
  const day = () => new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",month: "2-digit",year: "numeric",timeZone: "Europe/Vienna",
  }).format(new Date());

  async function api(url, options = {}) {
    const response = await fetch(url.startsWith("/admin/") ? requestUrl(url) : url, {
      ...options, cache: "no-store",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({ok:false,error:"Keine JSON-Antwort"}));
    if (!response.ok || data.ok === false) throw Error(data.error || "HTTP " + response.status);
    return data;
  }

  // Exakt dieselben maximalen Zeilenbreiten wie im lokalen Zebra-Modul.
  // Zu lange Eingaben werden nicht still gekuerzt oder abgeschnitten.
  function wrapText(value, maxChars, label) {
    const raw = String(value || "").trim().replace(/\s+/g, " ");
    if (!raw || raw.length > 70 || /[\^~]/.test(raw)) throw Error(label + ": bitte gültigen Text eingeben.");
    const clean = raw.replace(/[Ä]/g,"Ae").replace(/[Ö]/g,"Oe").replace(/[Ü]/g,"Ue")
      .replace(/[ä]/g,"ae").replace(/[ö]/g,"oe").replace(/[ü]/g,"ue").replace(/ß/g,"ss")
      .replace(/[^A-Za-z0-9 .:/_-]/g,"").trim();
    if (!clean) throw Error(label + " fehlt");
    const lines = [];
    let current = "";
    for (const word of clean.split(/\s+/)) {
      if (word.length > maxChars) throw Error(label + ": ein Wort ist zu lang.");
      const next = current ? current + " " + word : word;
      if (next.length <= maxChars) current = next;
      else { if (current) lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    if (lines.length > 2) throw Error(label + ": maximal zwei Druckzeilen.");
    return lines;
  }

  function sampleLabelDialog() {
    const dlg = document.createElement("dialog");
    dlg.id = "returnSampleLabelDialog";
    dlg.setAttribute("aria-labelledby","returnSampleTitle");
    dlg.innerHTML = [
      '<h2 id="returnSampleTitle">Musteretikett · großes Etikett</h2>',
      '<p class="sample-help">Nummer aus neuen oder älteren Rückwaren bzw. aus Little Greene übernehmen – oder Farbe und Material frei eingeben. Das kleine Etikett bleibt leer.</p>',
      '<label for="sampleNumber">Rückwaren-/Farbnummer</label>',
      '<div class="sample-lookup"><input id="sampleNumber" class="field" type="text" maxlength="50" autocomplete="off" placeholder="z. B. LG-65 oder 105"><button id="sampleLookup" class="btn" type="button">Suchen</button></div>',
      '<div id="sampleSearchResults" class="sample-results" aria-live="polite"></div>',
      '<label for="sampleColour">Farbe / Farbton</label>',
      '<input id="sampleColour" class="field" maxlength="70" autocomplete="off" placeholder="z. B. Slaked Lime 105">',
      '<label for="sampleMaterial">Material</label>',
      '<input id="sampleMaterial" class="field" maxlength="70" autocomplete="off" placeholder="z. B. Intelligent Matt">',
      '<p class="sample-help">Farbe und Material bleiben auch nach der Übernahme bearbeitbar. Datum und Logo sind fix.</p>',
      '<div id="samplePreview" class="sample-preview" aria-label="Vorschau des großen Musteretiketts">',
      '<div id="sampleColourPreview" class="sample-colour-preview">Farbe / Farbton</div>',
      '<div id="sampleMaterialPreview" class="sample-material-preview">Material</div>',
      '<div class="sample-footer"><span id="sampleDatePreview"></span><span class="sample-logo-clip" aria-label="Original KRISTA-Logo"><img src="/public/document-logo.png" alt="KRISTA"></span></div>',
      '</div>',
      '<p id="sampleMessage" class="sample-message" role="status" aria-live="polite"></p>',
      '<div class="sample-actions"><button id="sampleCancel" class="btn" type="button">Schließen</button><button id="samplePrint" class="btn primary" type="button">Musteretikett drucken</button></div>',
    ].join("");
    document.body.appendChild(dlg);
    return dlg;
  }

  function style() {
    const sheet = document.createElement("style");
    sheet.textContent = [
      '#returnSampleLabelOpen{margin:12px 0 12px 7px}',
      '#returnSampleLabelDialog{width:min(505px,calc(100% - 22px));max-height:92vh;overflow:auto;border:1px solid #b9c4bc;border-radius:16px;padding:20px;background:#fff;color:#17241b;box-shadow:0 16px 60px #0006}',
      '#returnSampleLabelDialog::backdrop{background:#0009}',
      '#returnSampleLabelDialog h2{margin:0 0 7px;font-size:22px}',
      '#returnSampleLabelDialog label{display:block;font-weight:800;margin:12px 0 5px}',
      '#returnSampleLabelDialog input.field{width:100%;box-sizing:border-box}',
      '.sample-help{color:#59665d;font-size:13px;line-height:1.4}',
      '.sample-lookup{display:grid;grid-template-columns:1fr auto;gap:7px}',
      '.sample-results{font-size:12px;line-height:1.3;margin-top:8px}',
      '.sample-results button{display:block;width:100%;padding:9px 10px;margin-top:5px;text-align:left;border:1px solid #ccd6cc;border-radius:9px;background:#f5f8f5;cursor:pointer}',
      '.sample-preview{position:relative;width:min(315px,100%);aspect-ratio:42/44;margin:17px auto 8px;background:#fff;border:1px solid #b4bdb5;border-radius:6px;box-shadow:0 3px 16px #0001;overflow:hidden}',
      '.sample-colour-preview{position:absolute;top:21%;left:6%;right:6%;height:34%;display:grid;place-content:center;text-align:center;white-space:pre-line;overflow-wrap:anywhere;font-weight:950;font-size:clamp(20px,5vw,35px);line-height:1.08;color:#111}',
      '.sample-material-preview{position:absolute;top:60%;left:6%;right:6%;height:20%;display:grid;place-content:start center;text-align:center;white-space:pre-line;overflow-wrap:anywhere;font-weight:500;font-size:clamp(13px,2.8vw,17px);line-height:1.15;color:#222}',
      '.sample-footer{position:absolute;bottom:4%;left:6%;right:5%;display:flex;align-items:flex-end;justify-content:space-between;gap:10px;font-size:11px;font-weight:650;color:#333}',
      '.sample-logo-clip{position:relative;display:block;width:105px;height:36px;overflow:hidden;flex:0 0 auto}',
      '.sample-logo-clip img{position:absolute;right:0;bottom:0;height:36px;width:auto;max-width:none}',
      '.sample-message{min-height:17px;font-size:12px;font-weight:700}',
      '.sample-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
      '@media(max-width:520px){.sample-lookup{grid-template-columns:1fr}.sample-lookup button{width:100%}}',
    ].join("\n");
    document.head.appendChild(sheet);
  }

  function attach() {
    const free = el("returnFreeLabelOpen");
    if (!free || el("returnSampleLabelOpen")) return false;
    style();
    const open = document.createElement("button");
    open.id = "returnSampleLabelOpen";
    open.className = "btn";
    open.type = "button";
    open.textContent = "Musteretikett";
    free.insertAdjacentElement("afterend",open);

    const dlg = sampleLabelDialog();
    const number = el("sampleNumber");
    const colour = el("sampleColour");
    const material = el("sampleMaterial");
    const results = el("sampleSearchResults");
    const msg = el("sampleMessage");
    const print = el("samplePrint");
    let searchSequence = 0;
    function updatePreview() {
      el("sampleDatePreview").textContent = day();
      try {
        const lines = wrapText(colour.value,18,"Farbe");
        el("sampleColourPreview").textContent = lines.join("\n");
        el("sampleColourPreview").style.fontSize = lines.length === 2 ? "26px" : "34px";
      } catch { el("sampleColourPreview").textContent = colour.value.trim() || "Farbe / Farbton"; }
      try { el("sampleMaterialPreview").textContent = wrapText(material.value,28,"Material").join("\n"); }
      catch { el("sampleMaterialPreview").textContent = material.value.trim() || "Material"; }
    }
    colour.addEventListener("input",updatePreview);
    material.addEventListener("input",updatePreview);

    function choose(item,source) {
      colour.value = String(item.colour || "");
      material.value = String(item.material || "");
      results.replaceChildren();
      const note=document.createElement("p");
      note.textContent=source+" übernommen. Beide Felder können geändert werden.";
      results.appendChild(note);
      updatePreview();
      colour.focus();
    }
    function addChoice(item,source){
      const b=document.createElement("button");
      b.type="button";
      b.textContent=source+" · "+item.colour+(item.material?" · "+item.material:"");
      b.addEventListener("click",()=>choose(item,source));
      results.appendChild(b);
    }
    async function lookup(){
      const query=number.value.trim();
      if(!query){results.textContent="Bitte zuerst eine Nummer eingeben.";return;}
      const run=++searchSequence;
      const lookupBtn=el("sampleLookup");
      lookupBtn.disabled=true;
      results.textContent="Suche Rückwaren und LG-Farbarchiv …";
      const candidates=[];
      const norm=query.toUpperCase().replace(/\s+/g,"");
      const returnCode=/^\d{1,9}$/.test(norm)?"R-"+norm:norm;
      if(/^(?:R-|(?:LG|ST|SY|KB|FC|BX|FM)-?)\d{1,9}$/.test(returnCode)){
        try {
          const data=await api("/admin/api/paint/returns/barcode?code="+encodeURIComponent(returnCode));
          if(data.item){
            const it=data.item;
            candidates.push({item:{colour:it.colour,material:it.material},source:"Rückware "+(it.returnLabel||it.returnNo)});
          }
        }catch{} // Alte Nummer oder kein Rückwareneintrag: LG-Farbsuche folgt.
      }
      const lgCode=norm.replace(/^LG-?/,"");
      if(/^[A-Z0-9 ._-]{1,40}$/.test(lgCode)){
        try{
          const data=await api("/admin/api/paint/search?system=LG&q="+encodeURIComponent(lgCode));
          const matches=(Array.isArray(data.results)?data.results:[]).filter(row=>{
            const terms=[row.code,row.altCode,row.name].filter(Boolean).map(v=>String(v).toUpperCase().trim());
            if(terms.some(term=>term===lgCode))return true;
            if(/^\d+$/.test(lgCode))return terms.some(term=>new RegExp("(^|[^0-9])"+lgCode+"$").test(term));
            return terms.some(term=>term.includes(lgCode));
          }).slice(0,6);
          for(const row of matches){
            candidates.push({item:{colour:row.name||row.code,material:""},source:"LG-Farbarchiv"});
          }
        }catch{}
      }
      if(run!==searchSequence)return;
      lookupBtn.disabled=false;
      results.replaceChildren();
      if(!candidates.length){
        results.textContent="Keine eindeutige Nummer gefunden. Farbe und Material können frei eingetragen werden – auch für Nicht-LG-Muster.";
      }else if(candidates.length===1){
        choose(candidates[0].item,candidates[0].source);
      }else{
        const note=document.createElement("p");note.textContent="Mehrere Treffer – bitte das richtige Muster wählen:";results.appendChild(note);
        candidates.forEach(row=>addChoice(row.item,row.source));
      }
    }
    el("sampleLookup").addEventListener("click",()=>{lookup().catch(e=>{results.textContent=e.message;el("sampleLookup").disabled=false;});});
    number.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();el("sampleLookup").click();}});
    open.addEventListener("click",()=>{
      results.replaceChildren();
      msg.textContent="";
      updatePreview();
      dlg.showModal();
      number.focus();
    });
    el("sampleCancel").addEventListener("click",()=>dlg.close());
    print.addEventListener("click",async()=>{
      try { wrapText(colour.value,18,"Farbe");wrapText(material.value,28,"Material"); }
      catch(error){msg.textContent=error.message;return;}
      print.disabled=true;
      msg.textContent="Druckauftrag wird übergeben …";
      try{
        const health=await api(localUrl+"/health");
        const parts=String(health.version||"").split(".").map(Number);
        if(!(parts[0]>1 || parts[0]===1 && parts[1]>=7))
          throw Error("Musteretiketten benötigen die lokale Zebra-Bridge 1.7. Bitte am Misch-PC aktualisieren.");
        if(!health.printer?.available)throw Error("Zebra-Drucker nicht verfügbar.");
        const response=await api(localUrl+"/print",{
          method:"POST",
          body:JSON.stringify({sampleLabel:true,colour:colour.value.trim(),material:material.value.trim()}),
        });
        if(!response.sampleLabel)throw Error("Musteretikett-Druck nicht bestätigt.");
        msg.textContent="Musteretikett (nur groß) an Zebra übergeben ✓";
      }catch(error){msg.textContent="Druck fehlgeschlagen: "+error.message;}
      finally{print.disabled=false;}
    });
    return true;
  }
  if(!attach()){
    const observer=new MutationObserver(()=>{if(attach())observer.disconnect();});
    observer.observe(document.documentElement,{childList:true,subtree:true});
  }
})();
