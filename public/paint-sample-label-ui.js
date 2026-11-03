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
      '<section class="sample-history" aria-labelledby="sampleHistoryTitle">',
      '<div class="sample-history-head"><h3 id="sampleHistoryTitle">Letzte Musteretiketten</h3><button id="sampleHistoryReload" class="btn" type="button">Aktualisieren</button></div>',
      '<p class="sample-help">Die letzten übergebenen Beschriftungen von allen KRISTINE-Arbeitsplätzen. Ein erneuter Druck erhält das heutige Datum.</p>',
      '<label for="sampleHistorySearch">In Musteretiketten suchen</label>',
      '<input id="sampleHistorySearch" class="field" type="search" autocomplete="off" placeholder="Farbe, Material oder Nummer …">',
      '<div id="sampleHistoryList" class="sample-history-list" aria-live="polite">Historie wird geladen …</div>',
      '<div class="sample-history-bottom"><span id="sampleHistoryCount" class="sample-history-count"></span><button id="sampleHistoryMore" class="btn" type="button" hidden>Weitere anzeigen</button></div>',
      '<button id="sampleHistoryRetry" class="btn" type="button" hidden>Fehlende Historieneinträge speichern</button>',
      '</section>',
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
      '#returnSampleLabelHistoryOpen{margin-left:7px}',
      '.sample-history{border-top:1px solid #e2e8e0;margin-top:19px;padding-top:13px}',
      '.sample-history-head{display:flex;justify-content:space-between;align-items:center;gap:8px}',
      '.sample-history-head h3{font-size:17px;margin:0}',
      '.sample-history-list{display:grid;gap:8px;margin-top:10px;max-height:360px;overflow:auto}',
      '.sample-history-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border:1px solid #dfe7dd;border-radius:10px;background:#f8faf8}',
      '.sample-history-row strong{font-size:14px;display:block;overflow-wrap:anywhere}',
      '.sample-history-row .sample-history-material{font-size:12px;color:#586458;overflow-wrap:anywhere}',
      '.sample-history-row small{display:block;color:#677166;font-size:11px;margin-top:3px}',
      '.sample-history-buttons{display:flex;gap:5px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}',
      '.sample-history-buttons button{font-size:12px;padding:7px 8px;min-height:34px}',
      '.sample-history-empty{padding:12px;background:#f5f8f5;border-radius:9px;color:#526053;font-size:13px}',
      '.sample-history-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:9px 0}',
      '.sample-history-count{font-size:12px;color:#5f6d5f}',
      '#sampleHistoryRetry{margin:7px 0 0;color:#914d12}',
      '@media(max-width:520px){.sample-history-row{align-items:flex-start;flex-direction:column}.sample-history-buttons{justify-content:flex-start}}',
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
    const historyOpen = document.createElement("button");
    historyOpen.id = "returnSampleLabelHistoryOpen";
    historyOpen.className = "btn";
    historyOpen.type = "button";
    historyOpen.textContent = "Etiketten-Historie";
    open.insertAdjacentElement("afterend",historyOpen);

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
      msg.textContent="";
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
    const historyList = el("sampleHistoryList");
    const historySearch = el("sampleHistorySearch");
    const historyMore = el("sampleHistoryMore");
    const historyCount = el("sampleHistoryCount");
    const historyRetry = el("sampleHistoryRetry");
    let historySequence = 0;
    let historyOffset = 0;
    let historySearchTimer = null;
    let unsaved = [];

    function timeText(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return new Intl.DateTimeFormat("de-AT",{
        dateStyle:"short",timeStyle:"short",timeZone:"Europe/Vienna",
      }).format(date);
    }

    function reuseFromHistory(item) {
      number.value = String(item.reference || "");
      colour.value = String(item.colour || "");
      material.value = String(item.material || "");
      results.replaceChildren();
      updatePreview();
      msg.textContent = "Beschriftung übernommen. Zum Drucken auf „Musteretikett drucken“ klicken.";
      el("samplePreview").scrollIntoView?.({block:"nearest"});
    }

    function createHistoryRow(item) {
      const row = document.createElement("div");
      row.className = "sample-history-row";
      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = String(item.colour || "");
      const substance = document.createElement("div");
      substance.className = "sample-history-material";
      substance.textContent = String(item.material || "");
      const when = document.createElement("small");
      when.textContent = [timeText(item.printedAt),
        item.reference ? "Nr. " + item.reference : "",
        item.printedBy ? "von " + item.printedBy : ""].filter(Boolean).join(" · ");
      details.append(name,substance,when);
      const actions = document.createElement("div");
      actions.className = "sample-history-buttons";
      const use = document.createElement("button");
      use.type = "button"; use.className = "btn";
      use.dataset.sampleReuse = item.id;
      use.textContent = "Übernehmen";
      use.addEventListener("click",()=>reuseFromHistory(item));
      const again = document.createElement("button");
      again.type = "button"; again.className = "btn";
      again.dataset.sampleReprint = item.id;
      again.textContent = "Nochmal drucken";
      again.addEventListener("click",()=>{
        if (print.disabled) return;
        reuseFromHistory(item);
        submitPrint();
      });
      actions.append(use,again);
      row.append(details,actions);
      return row;
    }

    async function loadHistory(reset = true) {
      const run = ++historySequence;
      if (reset) {
        historyOffset = 0;
        historyList.textContent = "Musteretiketten werden geladen …";
      }
      const offset = historyOffset;
      historyMore.disabled = true;
      try {
        const search = historySearch.value.trim();
        const data = await api("/admin/api/paint/sample-label-history?limit=20&offset=" +
          offset + "&q=" + encodeURIComponent(search));
        if (run !== historySequence) return;
        const rows = Array.isArray(data.items) ? data.items : [];
        if (reset) historyList.replaceChildren();
        rows.forEach(item => historyList.appendChild(createHistoryRow(item)));
        historyOffset += rows.length;
        const total = Number(data.count || 0);
        if (!rows.length && reset) {
          const empty = document.createElement("div");
          empty.className = "sample-history-empty";
          empty.textContent = search
            ? "Keine Musteretiketten mit diesem Suchbegriff gefunden."
            : "Noch keine Musteretiketten protokolliert. Neue Drucke erscheinen nach erfolgreicher Zebra-Übergabe.";
          historyList.appendChild(empty);
        }
        historyMore.hidden = historyOffset >= total;
        historyCount.textContent = total ? historyOffset + " von " + total + " Einträgen" : "0 Einträge";
      } catch (error) {
        if (run !== historySequence) return;
        if (reset) {
          historyList.replaceChildren();
          const notice = document.createElement("div");
          notice.className = "sample-history-empty";
          notice.textContent = "Historie nicht erreichbar: " + error.message + " · Drucken ist weiterhin möglich.";
          historyList.appendChild(notice);
        }
        historyMore.hidden = true;
      } finally {
        if (run === historySequence) historyMore.disabled = false;
      }
    }

    async function submitPrint() {
      if (print.disabled) return;
      try { wrapText(colour.value,18,"Farbe"); wrapText(material.value,28,"Material"); }
      catch(error) { msg.textContent = error.message; return; }
      print.disabled = true;
      const content = {
        colour:colour.value.trim(),material:material.value.trim(),reference:number.value.trim(),
      };
      msg.textContent = "Druckauftrag wird übergeben …";
      try {
        const health = await api(localUrl+"/health");
        const parts = String(health.version || "").split(".").map(Number);
        if (!(parts[0]>1 || parts[0]===1 && parts[1]>=7))
          throw Error("Musteretiketten benötigen die lokale Zebra-Bridge 1.7. Bitte am Misch-PC aktualisieren.");
        if (!health.printer?.available) throw Error("Zebra-Drucker nicht verfügbar.");
        const response = await api(localUrl+"/print",{
          method:"POST",
          body:JSON.stringify({sampleLabel:true,colour:content.colour,material:content.material}),
        });
        if (!response.sampleLabel) throw Error("Musteretikett-Druck nicht bestätigt.");
        msg.textContent = "Musteretikett an Zebra übergeben ✓";
        // Erst NACH erfolgreicher Bridge-Antwort protokollieren; niemals
        // einen gescheiterten Druck als gedruckt in die Historie aufnehmen.
        const printRecord = {
          id:"sample_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,14),
          ...content,
        };
        try {
          await api("/admin/api/paint/sample-label-history",{
            method:"POST",body:JSON.stringify(printRecord),
          });
          msg.textContent = "Musteretikett an Zebra übergeben ✓ · in Historie gespeichert ✓";
          await loadHistory(true);
        } catch(error) {
          unsaved.push(printRecord);
          historyRetry.hidden = false;
          msg.textContent = "Musteretikett an Zebra übergeben ✓ · Historie nicht gespeichert: " +
            error.message + ". Nicht nochmals drucken – unten „Fehlende Historieneinträge speichern“ wählen.";
        }
      } catch(error) {
        msg.textContent = "Druck fehlgeschlagen: " + error.message;
      } finally {
        print.disabled = false;
      }
    }

    async function retryUnsaved() {
      if (!unsaved.length) { historyRetry.hidden = true; return; }
      historyRetry.disabled = true;
      const failed = [];
      for (const record of unsaved) {
        try {
          await api("/admin/api/paint/sample-label-history",{
            method:"POST",body:JSON.stringify(record),
          });
        } catch { failed.push(record); }
      }
      const saved = unsaved.length - failed.length;
      unsaved = failed;
      historyRetry.hidden = !failed.length;
      historyRetry.disabled = false;
      msg.textContent = failed.length
        ? saved + " Historieneinträge nachgetragen, " + failed.length + " noch offen."
        : "Alle fehlenden Historieneinträge gespeichert ✓ · kein zweiter Druck.";
      await loadHistory(true);
    }

    function showDialog(onlyHistory = false) {
      results.replaceChildren();
      msg.textContent = unsaved.length ? unsaved.length + " Druckeinträge noch nicht gespeichert." : "";
      updatePreview();
      if (!dlg.open) dlg.showModal();
      loadHistory(true);
      if (onlyHistory) historySearch.focus();
      else number.focus();
    }
    open.addEventListener("click",()=>showDialog(false));
    historyOpen.addEventListener("click",()=>showDialog(true));
    el("sampleCancel").addEventListener("click",()=>dlg.close());
    print.addEventListener("click",submitPrint);
    el("sampleHistoryReload").addEventListener("click",()=>loadHistory(true));
    historyMore.addEventListener("click",()=>{if(!historyMore.disabled)loadHistory(false);});
    historyRetry.addEventListener("click",retryUnsaved);
    historySearch.addEventListener("input",()=>{
      clearTimeout(historySearchTimer);
      historySearchTimer = setTimeout(()=>loadHistory(true),220);
    });
    return true;
  }
  if(!attach()){
    const observer=new MutationObserver(()=>{if(attach())observer.disconnect();});
    observer.observe(document.documentElement,{childList:true,subtree:true});
  }
})();
