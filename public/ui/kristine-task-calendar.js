"use strict";

(function(){
  const VERSION="2026-09-01-auth-files-v7";
  let currentTask=null;
  let currentRequestId="";
  let visitRecorder=null,visitStream=null,visitChunks=[],visitConsentAt="",discardVisitRecording=false,visitOwnMemo=false;

  const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));
  const pad=n=>String(n).padStart(2,"0");

  function authenticatedUrl(path){
    const target=new URL(path,location.origin),token=new URLSearchParams(location.search).get("token");
    if(token&&target.origin===location.origin)target.searchParams.set("token",token);
    return target.origin===location.origin?`${target.pathname}${target.search}${target.hash}`:target.href;
  }

  function taskById(id){
    try{return (typeof data!=="undefined"&&Array.isArray(data.tasks)?data.tasks:[]).find(t=>String(t.id)===String(id))||null}catch{return null}
  }

  function parseExplicitDate(text){
    const source=String(text||"");
    let m=source.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if(m)return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m=source.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})\b/);
    if(m)return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    return "";
  }

  function parseExplicitTime(text){
    const source=String(text||"");
    const m=source.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:uhr)?\b/i);
    if(!m)return "";
    return `${pad(m[1])}:${pad(m[2])}`;
  }

  function plusHour(hm){
    const m=String(hm||"").match(/^(\d{2}):(\d{2})$/);if(!m)return "";
    let mins=Number(m[1])*60+Number(m[2])+60;mins=Math.min(mins,23*60+59);
    return `${pad(Math.floor(mins/60))}:${pad(mins%60)}`;
  }

  function installStyle(){
    if(document.getElementById("kristaTaskCalendarCss"))return;
    const s=document.createElement("style");s.id="kristaTaskCalendarCss";s.textContent=`
      .krista-calendar-task{background:#315d91!important;border-color:#315d91!important;color:#fff!important;font-weight:800}
      .ktc-bg{position:fixed;inset:0;z-index:80050;display:none;place-items:center;padding:18px;background:rgba(0,0,0,.55)}.ktc-bg.open{display:grid}
      .ktc-modal{width:min(650px,100%);max-height:92vh;overflow:auto;background:#fff;border-radius:18px;padding:18px;box-shadow:0 26px 90px rgba(0,0,0,.35)}
      .ktc-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.ktc-head h3{margin:0}.ktc-close{width:38px;min-width:38px;height:38px;padding:0;background:#fff;color:#222;border:1px solid #ccc}
      .ktc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.ktc-grid .full{grid-column:1/-1}.ktc-grid label{font-size:11px;color:#666;margin-bottom:4px}.ktc-grid input,.ktc-grid textarea{width:100%}.ktc-grid textarea{min-height:105px}
      .ktc-all-day{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid #ddd;border-radius:10px;background:#faf9f6}.ktc-all-day input{width:auto}
      .ktc-hint{margin-top:10px;padding:10px;border-radius:10px;background:#f4f2ed;color:#626862;font-size:12px}.ktc-hint.warn{background:#fff4d9;color:#765400}.ktc-hint.ok{background:#e5f5e9;color:#155c2a}.ktc-hint.bad{background:#fde8e7;color:#8b241c}
      .ktc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.ktc-actions button{font-weight:800}.ktc-google{background:#27713d!important;border-color:#27713d!important}.ktc-ics{background:#fff!important;color:#222!important}
      .kvp-bg{position:fixed;inset:0;z-index:80100;display:none;place-items:start center;padding:12px;background:rgba(0,0,0,.62);overflow:auto}.kvp-bg.open{display:grid}.kvp{width:min(760px,100%);background:#f6f4ef;border-radius:18px;padding:16px;box-shadow:0 24px 80px rgba(0,0,0,.4)}
      .kvp-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.kvp-head h2{margin:0 0 4px;font-size:22px}.kvp-card{background:#fff;border:1px solid #ddd8cf;border-radius:13px;padding:13px;margin-top:11px}.kvp-card h3{margin:0 0 9px;font-size:15px}.kvp-meta{display:grid;grid-template-columns:auto 1fr;gap:5px 11px;font-size:13px}.kvp-meta span{color:#777}.kvp-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:11px}.kvp-actions a{display:flex;justify-content:center;align-items:center;text-decoration:none;border-radius:11px;padding:12px;font-weight:850;background:#27713d;color:#fff}.kvp-actions a.call{background:#315d91}.kvp label{display:block;font-size:12px;font-weight:750;color:#555;margin:9px 0 4px}.kvp textarea,.kvp input{width:100%}.kvp textarea{min-height:90px}.kvp-files{display:grid;gap:8px}.kvp-file{display:flex;gap:9px;align-items:center;padding:8px;border:1px solid #e3dfd7;border-radius:9px;text-decoration:none;color:#222}.kvp-file img{width:76px;height:58px;object-fit:cover;border-radius:7px}.kvp-save{width:100%;margin-top:12px;padding:13px;font-weight:900}.kvp-status{min-height:18px;margin-top:8px;font-size:12px;color:#27713d}
      .kvp-rec{background:#f7f2e8;border:1px solid #dfd2b7;border-radius:11px;padding:11px;margin:10px 0}.kvp-rec-question{font-weight:800;line-height:1.45}.kvp-rec-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}.kvp-rec-actions button{font-weight:800}.kvp-rec-live{color:#9c251d;font-weight:850}.kvp-recording{margin-top:9px;padding:9px;background:#fff;border-radius:9px}.kvp-recording audio{width:100%;margin-top:6px}.kvp-transcript{white-space:pre-wrap;font-size:13px;line-height:1.45;margin-top:7px}
      @media(max-width:620px){.ktc-bg{padding:8px}.ktc-grid{grid-template-columns:1fr}.ktc-grid .full{grid-column:auto}.ktc-actions button{width:100%}}
    `;document.head.appendChild(s);
  }

  function ensureModal(){
    let bg=document.getElementById("kristaTaskCalendarBg");if(bg)return bg;
    bg=document.createElement("div");bg.id="kristaTaskCalendarBg";bg.className="ktc-bg";
    bg.innerHTML=`<section class="ktc-modal" role="dialog" aria-modal="true" aria-labelledby="ktcTitle"><div class="ktc-head"><div><h3 id="ktcTitle">📅 Termin aus Aufgabe</h3><div class="small">Der Termin bleibt in KRISTINE gespeichert und wird zusätzlich an Alex' Outlook gesendet.</div></div><button type="button" class="ktc-close" data-ktc-close>×</button></div><div class="ktc-grid"><div class="full"><label>Titel</label><input id="ktcEventTitle"></div><div><label>Datum</label><input id="ktcDate" type="date"></div><div class="ktc-all-day"><input id="ktcAllDay" type="checkbox"><label for="ktcAllDay" style="margin:0">Ganztägig</label></div><div><label>Von</label><input id="ktcFrom" type="time"></div><div><label>Bis</label><input id="ktcTo" type="time"></div><div class="full"><label>Ort</label><input id="ktcLocation"></div><div class="full"><label>Notiz</label><textarea id="ktcDetails"></textarea></div></div><div id="ktcHint" class="ktc-hint"></div><div id="ktcStatus" class="ktc-hint">Outlook-Status wird geprüft …</div><div class="ktc-actions"><button id="ktcSave" type="button">Termin speichern + Outlook</button><button id="ktcLogin" type="button" class="secondary" hidden>Outlook anmelden</button><button id="ktcRetry" type="button" class="secondary" hidden>Outlook erneut versuchen</button><button id="ktcGoogle" type="button" class="ktc-google">In Google öffnen</button><button id="ktcIcs" type="button" class="ktc-ics">Kalenderdatei (.ics)</button><button type="button" class="secondary" data-ktc-close>Abbrechen</button></div></section>`;
    document.body.appendChild(bg);
    bg.addEventListener("click",e=>{if(e.target===bg||e.target.closest("[data-ktc-close]"))close()});
    bg.querySelector("#ktcAllDay").addEventListener("change",syncAllDay);
    bg.querySelector("#ktcGoogle").addEventListener("click",openGoogle);
    bg.querySelector("#ktcIcs").addEventListener("click",downloadIcs);
    bg.querySelector("#ktcSave").addEventListener("click",saveAppointment);
    bg.querySelector("#ktcLogin").addEventListener("click",loginOutlook);
    return bg;
  }

  function syncAllDay(){
    const all=document.getElementById("ktcAllDay")?.checked;
    for(const id of ["ktcFrom","ktcTo"]){const el=document.getElementById(id);if(el)el.disabled=!!all}
  }

  function taskText(task){return [task?.title,task?.reminder,task?.contactName,task?.contactPhone,task?.contactEmail,task?.jobName].filter(Boolean).join("\n")}

  function open(taskId){
    const task=taskById(taskId);if(!task)return;
    currentTask=task;installStyle();const bg=ensureModal();
    const saveButton=document.getElementById("ktcSave");saveButton.disabled=false;saveButton.textContent="Termin speichern + Outlook";
    currentRequestId=(globalThis.crypto?.randomUUID?.()||`request-${Date.now()}-${Math.random()}`);
    const text=taskText(task),date=task.appointment?.date||parseExplicitDate(text),time=task.appointment?.from||parseExplicitTime(text);
    document.getElementById("ktcEventTitle").value=String(task.title||"Termin").replace(/^Rückruf\s+/i,"").trim()||"Termin";
    document.getElementById("ktcDate").value=date;
    document.getElementById("ktcFrom").value=time;
    document.getElementById("ktcTo").value=task.appointment?.to||(time?plusHour(time):"");
    document.getElementById("ktcAllDay").checked=false;
    document.getElementById("ktcLocation").value=task.address||task.jobName||"";
    document.getElementById("ktcDetails").value=[task.reminder,task.contactName||task.contactPhone||task.contactEmail?`Kontakt: ${[task.contactName,task.contactPhone,task.contactEmail].filter(Boolean).join(" · ")}`:"",task.jobName?`Baustelle: ${task.jobName}`:""].filter(Boolean).join("\n\n");
    const hint=document.getElementById("ktcHint");
    if(date&&time){hint.className="ktc-hint";hint.textContent="Datum und Uhrzeit wurden eindeutig aus der Aufgabe erkannt. Bitte kurz prüfen."}
    else if(date){hint.className="ktc-hint warn";hint.textContent="Datum erkannt, aber keine eindeutige Uhrzeit. Bitte Von/Bis wählen oder ganztägig markieren."}
    else{hint.className="ktc-hint warn";hint.textContent=`Kein eindeutiges Termindatum im Aufgabentext. Bitte Datum wählen.${task.dueDate?` Aufgaben-Fälligkeit ist ${task.dueDate} – sie wird bewusst nicht automatisch als Termin verwendet.`:""}`}
    document.getElementById("ktcRetry").hidden=true;
    syncAllDay();bg.classList.add("open");
    if(task.appointment?.id&&task.appointment?.outlook?.status!=="synced"){
      const retry=document.getElementById("ktcRetry");retry.hidden=false;retry.onclick=()=>retryOutlook(task.appointment.id);
      setStatus("Outlook noch nicht synchronisiert","warn");
    }else if(task.appointment?.outlook?.status==="synced"){
      setStatus("Outlook-Termin erstellt ✅","ok");document.getElementById("ktcSave").textContent="Gespeichert ✓";
    }else loadOutlookStatus();
  }

  function close(){document.getElementById("kristaTaskCalendarBg")?.classList.remove("open")}

  function values(){
    const title=document.getElementById("ktcEventTitle")?.value.trim()||"Termin";
    const date=document.getElementById("ktcDate")?.value||"";
    const allDay=!!document.getElementById("ktcAllDay")?.checked;
    const from=document.getElementById("ktcFrom")?.value||"";
    const to=document.getElementById("ktcTo")?.value||"";
    const location=document.getElementById("ktcLocation")?.value.trim()||"";
    const details=document.getElementById("ktcDetails")?.value.trim()||"";
    if(!date)throw new Error("Bitte ein Datum wählen.");
    if(!allDay){if(!from||!to)throw new Error("Bitte Von und Bis wählen oder ganztägig markieren.");if(to<=from)throw new Error("Bis muss nach Von liegen.")}
    return {title,date,allDay,from,to,location,details};
  }

  function setStatus(text,kind=""){
    const el=document.getElementById("ktcStatus");if(!el)return;el.textContent=text;el.className=`ktc-hint ${kind}`.trim();
  }

  async function loadOutlookStatus(){
    const login=document.getElementById("ktcLogin");
    try{const result=await api("/kristine/api/outlook/status");const ready=result.connected&&String(result.account||"").toLowerCase()==="alexander.krista@krista.at";login.hidden=ready;setStatus(ready?"Outlook bereit: Alexander Krista":"Outlook ist noch nicht angemeldet. Der KRISTINE-Termin wird trotzdem sicher gespeichert.",ready?"ok":"warn")}
    catch(e){login.hidden=false;setStatus(`Outlook-Status nicht verfügbar: ${e.message}`,"warn")}
  }

  async function loginOutlook(){
    const button=document.getElementById("ktcLogin");button.disabled=true;
    const microsoftWindow=window.open("about:blank","_blank");
    try{
      const start=await api("/kristine/api/outlook/login/start",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
      if(microsoftWindow)microsoftWindow.location.href=start.verificationUri;
      setStatus(`Microsoft-Code ${start.userCode}: im geöffneten Fenster als alexander.krista@krista.at anmelden. KRISTINE wartet automatisch auf die Bestätigung …`,"warn");
      for(let attempt=0;attempt<90;attempt++){
        await new Promise(resolve=>setTimeout(resolve,Math.max(5,Number(start.interval||5))*1000));
        const response=await fetch((typeof url==="function"?url("/kristine/api/outlook/login/poll"):"/kristine/api/outlook/login/poll"),{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:start.sessionId})});
        const text=await response.text();let result={};try{result=JSON.parse(text)}catch{}if(response.status===202)continue;if(!response.ok)throw new Error(result.error||text||"Outlook-Anmeldung fehlgeschlagen.");
        setStatus("Outlook ist jetzt mit Alexander Krista verbunden.","ok");button.hidden=true;return;
      }
      throw new Error("Zeit für die Outlook-Anmeldung abgelaufen.");
    }catch(e){if(microsoftWindow&&!microsoftWindow.closed)microsoftWindow.close();setStatus(e.message,"bad")}finally{button.disabled=false}
  }

  function mapsHref(address){return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address||"")}`}

  function ensureVisitProtocol(){
    let bg=document.getElementById("kristaVisitProtocol");if(bg)return bg;
    bg=document.createElement("div");bg.id="kristaVisitProtocol";bg.className="kvp-bg";
    bg.innerHTML=`<section class="kvp" role="dialog" aria-modal="true"><div class="kvp-head"><div><h2 id="kvpTitle">Termin</h2><div id="kvpWhen" class="small"></div></div><div class="kvp-rec-actions"><button type="button" class="secondary" data-kvp-tower>← KRISTOWER</button><button type="button" class="secondary" data-kvp-close>Schließen</button></div></div><div id="kvpMeta" class="kvp-card"></div><div id="kvpQuick" class="kvp-actions"></div><div class="kvp-card"><h3>Was ist zu tun?</h3><div id="kvpTodo"></div></div><div class="kvp-card"><h3>Fotos & Anlagen</h3><div id="kvpFiles" class="kvp-files"><span class="small">Wird geladen …</span></div></div><div class="kvp-card"><h3>Besprechung vor Ort</h3><label for="kvpDiscussion">Besprochen / Kundenwunsch</label><textarea id="kvpDiscussion" placeholder="Was wurde mit dem Kunden besprochen?"></textarea><label for="kvpWork">Vereinbarte Arbeiten</label><textarea id="kvpWork" placeholder="Welche Arbeiten sollen ausgeführt werden?"></textarea><label for="kvpEstimate">Preisschätzung</label><input id="kvpEstimate" placeholder="z. B. ca. 1.500–2.000 € netto"><label for="kvpNext">Nächste Schritte</label><textarea id="kvpNext" placeholder="Angebot, Material, Rückmeldung, Ausführung …"></textarea><button id="kvpSave" type="button" class="green kvp-save">Protokoll speichern</button><div class="kvp-actions"><button id="kvpOffer" type="button" class="secondary">Als Angebot vorbereiten</button><button id="kvpOrder" type="button" class="secondary">Direkt als Auftrag übernehmen</button></div><div id="kvpStatus" class="kvp-status"></div></div></section>`;
    document.body.appendChild(bg);bg.addEventListener("click",e=>{if(e.target.closest("[data-kvp-tower]")){location.href=authenticatedUrl("/kontrollzentrum");return}if(e.target===bg||e.target.closest("[data-kvp-close]"))bg.classList.remove("open")});
    const firstLabel=bg.querySelector("#kvpDiscussion")?.previousElementSibling;const rec=document.createElement("div");rec.className="kvp-rec";rec.innerHTML=`<div class="kvp-rec-question">Zuerst hörbar fragen: „Darf ich unser Gespräch für interne Zwecke aufnehmen und automatisch verschriftlichen?“</div><div id="kvpRecStatus" class="small">Noch keine Aufnahme.</div><div class="kvp-rec-actions"><button id="kvpRecStart" type="button">🎙 Gesprächsprotokoll · mit Zustimmung</button><button id="kvpOwnMemo" type="button" class="secondary">🧮 Kalkulationsprotokoll · eigene Notiz</button><button id="kvpRecStop" type="button" class="secondary" hidden>■ Aufnahme beenden</button></div><div id="kvpRecordings"></div>`;firstLabel?.parentNode?.insertBefore(rec,firstLabel);
    const fileHost=bg.querySelector("#kvpFiles"),pick=document.createElement("button"),input=document.createElement("input");pick.type="button";pick.className="green";pick.textContent="📷 Fotos übernehmen";input.type="file";input.accept="image/*";input.multiple=true;input.hidden=true;fileHost?.parentNode?.insertBefore(pick,fileHost);fileHost?.parentNode?.insertBefore(input,fileHost);pick.addEventListener("click",()=>input.click());input.addEventListener("change",()=>uploadVisitPhotos(input.files));
    bg.querySelector("#kvpSave").addEventListener("click",saveVisitProtocol);bg.querySelector("#kvpOffer").addEventListener("click",()=>stageVisitProtocol("offer"));bg.querySelector("#kvpOrder").addEventListener("click",()=>stageVisitProtocol("order"));bg.querySelector("#kvpRecStart").addEventListener("click",()=>startVisitRecording(false));bg.querySelector("#kvpOwnMemo").addEventListener("click",()=>startVisitRecording(true));bg.querySelector("#kvpRecStop").addEventListener("click",stopVisitRecording);return bg;
  }

  async function visitFiles(taskId){
    const host=document.getElementById("kvpFiles");
    try{const r=await fetch(authenticatedUrl(`/kristine/api/inbox/task/${encodeURIComponent(taskId)}`),{credentials:"same-origin"});const j=await r.json();if(!r.ok)throw new Error(j.error||"Anlagen nicht verfügbar");const inbox=(Array.isArray(j.items)?j.items:[]).map(item=>({...item,url:`/kristine/api/inbox/${encodeURIComponent(item.id)}/file`})),photos=currentTask?.visitProtocol?.files||[],items=[...photos,...inbox];host.innerHTML=items.length?items.map(item=>{const href=authenticatedUrl(item.url),mime=String(item.mimeType||"");return `<a class="kvp-file" href="${href}" target="_blank" rel="noopener">${mime.startsWith("image/")?`<img src="${href}" alt="Foto">`:"📎"}<strong>${esc(item.name||"Anlage")}</strong></a>`}).join(""):"<span class=\"small\">Noch keine Fotos oder Anlagen.</span>"}catch(e){host.innerHTML=`<span class="small">Anlagen konnten nicht geladen werden: ${esc(e.message)}</span>`}
  }

  async function uploadVisitPhotos(fileList){
    const files=[...(fileList||[])];if(!currentTask||!files.length)return;const status=document.getElementById("kvpStatus");status.textContent=`${files.length} Foto${files.length===1?"":"s"} werden übernommen …`;
    try{const added=[];for(const file of files){const r=await fetch(authenticatedUrl(`/kristine/api/tasks/${encodeURIComponent(currentTask.id)}/visit-file`),{method:"POST",credentials:"same-origin",headers:{"Content-Type":file.type||"application/octet-stream","X-File-Name":encodeURIComponent(file.name||"Foto.jpg")},body:file});const j=await r.json();if(!r.ok)throw new Error(j.error||"Foto konnte nicht gespeichert werden");added.push(j.file)}currentTask.visitProtocol={...(currentTask.visitProtocol||{}),files:[...(currentTask.visitProtocol?.files||[]),...added]};await persistTasks();await visitFiles(currentTask.id);status.textContent=`✓ ${added.length} Foto${added.length===1?"":"s"} übernommen`;}catch(e){status.textContent="Foto-Übernahme fehlgeschlagen: "+e.message}
  }

  function renderVisitRecordings(){
    const host=document.getElementById("kvpRecordings"),rows=currentTask?.visitProtocol?.recordings||[];if(!host)return;
    host.innerHTML=rows.map(r=>{const title=r.kind==="own_memo"?"Kalkulationsprotokoll · eigene Notiz":"Gesprächsprotokoll · mit Zustimmung";const audio=r.audioUrl?`<audio controls preload="none" src="${authenticatedUrl(r.audioUrl)}"></audio>`:"";const transcript=r.transcript?`<div class="kvp-transcript">${esc(r.transcript)}</div>`:'<div class="small">Transkript nicht verfügbar.</div>';return `<div class="kvp-recording"><strong>${title}</strong><div class="small">${new Date(r.recordedAt||Date.now()).toLocaleString("de-AT")}</div>${audio}${transcript}</div>`}).join("");
  }

  async function startVisitRecording(ownMemo){
    if(visitRecorder?.state==="recording")return;
    try{
      visitOwnMemo=!!ownMemo;visitChunks=[];discardVisitRecording=false;visitConsentAt="";visitStream=await navigator.mediaDevices.getUserMedia({audio:true});
      const preferred=MediaRecorder.isTypeSupported("audio/webm;codecs=opus")?"audio/webm;codecs=opus":"audio/webm";visitRecorder=new MediaRecorder(visitStream,{mimeType:preferred});visitRecorder.ondataavailable=e=>{if(e.data?.size)visitChunks.push(e.data)};visitRecorder.onstop=finishVisitRecording;visitRecorder.start(1000);
      document.getElementById("kvpRecStart").disabled=true;document.getElementById("kvpOwnMemo").disabled=true;document.getElementById("kvpRecStop").hidden=false;document.getElementById("kvpRecStatus").innerHTML=ownMemo?'<span class="kvp-rec-live">● Kalkulationsprotokoll läuft · bitte ohne Kundenstimme</span>':'<span class="kvp-rec-live">● Gesprächsprotokoll läuft · Zustimmungsfrage jetzt stellen</span>';
    }catch(e){document.getElementById("kvpRecStatus").textContent="Mikrofon nicht verfügbar: "+e.message}
  }

  function stopVisitRecording(){if(visitRecorder?.state==="recording")visitRecorder.stop()}

  async function finishVisitRecording(){
    visitStream?.getTracks().forEach(t=>t.stop());document.getElementById("kvpRecStart").disabled=false;document.getElementById("kvpOwnMemo").disabled=false;document.getElementById("kvpRecStop").hidden=true;
    const blob=new Blob(visitChunks,{type:visitRecorder?.mimeType||"audio/webm"});visitChunks=[];
    if(!visitOwnMemo&&!confirm("Ist am Anfang der Aufnahme ein klares Ja des Kunden enthalten?\n\nOK = speichern und transkribieren\nAbbrechen = Aufnahme endgültig verwerfen")){document.getElementById("kvpRecStatus").textContent="Aufnahme verworfen. Du kannst jetzt eine eigene interne Notiz aufnehmen.";return}
    visitConsentAt=new Date().toISOString();document.getElementById("kvpRecStatus").textContent="Wird sicher gespeichert und transkribiert …";
    try{
      const response=await fetch(authenticatedUrl(`/kristine/api/tasks/${encodeURIComponent(currentTask.id)}/visit-recording`),{method:"POST",credentials:"same-origin",headers:{"Content-Type":blob.type||"audio/webm","X-Consent-At":visitOwnMemo?`own-memo:${visitConsentAt}`:visitConsentAt,"X-Recording-Kind":visitOwnMemo?"own_memo":"customer_conversation"},body:blob});const json=await response.json();if(!response.ok)throw new Error(json.error||"Aufnahme konnte nicht gespeichert werden");
      const recording={...json.recording,kind:visitOwnMemo?"own_memo":"customer_conversation"};currentTask.visitProtocol={...(currentTask.visitProtocol||{}),recordings:[...(currentTask.visitProtocol?.recordings||[]),recording]};await persistTasks();renderVisitRecordings();document.getElementById("kvpRecStatus").textContent=recording.transcript?"✓ Aufnahme und Transkript gespeichert":"✓ Aufnahme gespeichert; Transkript konnte nicht erstellt werden";
    }catch(e){document.getElementById("kvpRecStatus").textContent="Fehler: "+e.message}
  }

  function openVisitProtocol(taskId){
    const task=taskById(taskId);if(!task)return;currentTask=task;installStyle();const bg=ensureVisitProtocol(),a=task.appointment||{},saved=task.visitProtocol||{};
    document.getElementById("kvpTitle").textContent=task.title||"Termin";document.getElementById("kvpWhen").textContent=[a.date,a.from&&a.to?`${a.from}–${a.to}`:""].filter(Boolean).join(" · ");
    const address=task.address||task.jobName||"",contact=[task.contactName,task.contactPhone].filter(Boolean).join(" · ");document.getElementById("kvpMeta").innerHTML=`<h3>Terminübersicht</h3><div class="kvp-meta">${address?`<span>Adresse</span><strong>${esc(address)}</strong>`:""}${contact?`<span>Kontakt</span><strong>${esc(contact)}</strong>`:""}<span>Status</span><strong>${task.status==="done"?"Erledigt":"Termin vereinbart"}</strong></div>`;
    document.getElementById("kvpQuick").innerHTML=`${address?`<a href="${mapsHref(address)}" target="_blank" rel="noopener">🧭 Navigation</a>`:""}${task.contactPhone?`<a class="call" href="tel:${esc(task.contactPhone)}">📞 Anrufen</a>`:""}`;
    document.getElementById("kvpTodo").textContent=task.reminder||task.details||"Noch keine Arbeitsbeschreibung hinterlegt.";document.getElementById("kvpDiscussion").value=saved.discussion||"";document.getElementById("kvpWork").value=saved.work||"";document.getElementById("kvpEstimate").value=saved.estimate||"";document.getElementById("kvpNext").value=saved.nextSteps||"";document.getElementById("kvpStatus").textContent=saved.conversionTarget?`✓ Für ${saved.conversionTarget==="order"?"Auftrag":"Angebot"} vorbereitet`:saved.savedAt?"Zuletzt gespeichert: "+new Date(saved.savedAt).toLocaleString("de-AT"):"";bg.classList.add("open");renderVisitRecordings();visitFiles(taskId);
  }

  async function saveVisitProtocol(){
    if(!currentTask)return;const b=document.getElementById("kvpSave");b.disabled=true;b.textContent="Speichert …";currentTask.visitProtocol={...(currentTask.visitProtocol||{}),discussion:document.getElementById("kvpDiscussion").value.trim(),work:document.getElementById("kvpWork").value.trim(),estimate:document.getElementById("kvpEstimate").value.trim(),nextSteps:document.getElementById("kvpNext").value.trim(),savedAt:new Date().toISOString()};
    try{await persistTasks();document.getElementById("kvpStatus").textContent="✓ Besprechungsprotokoll gespeichert"}catch(e){document.getElementById("kvpStatus").textContent="Speichern fehlgeschlagen: "+e.message}finally{b.disabled=false;b.textContent="Protokoll speichern"}
  }

  async function stageVisitProtocol(target){
    await saveVisitProtocol();if(!currentTask)return;currentTask.visitProtocol={...(currentTask.visitProtocol||{}),conversionTarget:target,conversionStatus:"prepared",conversionPreparedAt:new Date().toISOString(),sourceTaskId:String(currentTask.id||"")};try{await persistTasks();const r=await fetch(authenticatedUrl("/kristool/api/workflows"),{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:currentTask.id,target,title:currentTask.title,customer:currentTask.contactName,address:currentTask.address,createdAt:currentTask.createdAt,appointment:currentTask.appointment,protocol:currentTask.visitProtocol})});const j=await r.json();if(!r.ok)throw new Error(j.error||"KRISTOOL-Übergabe fehlgeschlagen");document.getElementById("kvpStatus").innerHTML=`✓ In KRISTOOL für ${target==="order"?"Auftragsfreigabe":"Angebotserstellung"} bereit · <a href="${authenticatedUrl("/kristool-workflow")}" target="_blank">Arbeitskorb öffnen</a>`;}catch(e){document.getElementById("kvpStatus").textContent="Vorbereitung fehlgeschlagen: "+e.message}
  }

  async function saveAppointment(){
    let v;try{v=values()}catch(e){alert(e.message);return}
    const button=document.getElementById("ktcSave");button.disabled=true;button.textContent="Wird gespeichert …";document.getElementById("ktcRetry").hidden=true;
    try{
      const result=await api("/kristine/api/appointments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...v,taskId:String(currentTask?.id||""),requestId:currentRequestId})});
      const appointment=result.appointment;
      if(result.outlookSynced){setStatus("Outlook-Termin erstellt ✅","ok");button.textContent="Gespeichert ✓"}
      else{
        setStatus(`Outlook noch nicht synchronisiert: ${appointment?.outlook?.error||"unbekannter Fehler"}`,"warn");button.textContent="In KRISTINE gespeichert ✓";
        const retry=document.getElementById("ktcRetry");retry.hidden=false;retry.onclick=()=>retryOutlook(appointment.id);
      }
    }catch(e){setStatus(`Termin konnte nicht gespeichert werden: ${e.message}`,"bad");button.disabled=false;button.textContent="Termin speichern + Outlook"}
  }

  async function retryOutlook(id){
    const button=document.getElementById("ktcRetry");button.disabled=true;button.textContent="Outlook wird erneut versucht …";
    try{const result=await api(`/kristine/api/appointments/${encodeURIComponent(id)}/retry`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});if(result.outlookSynced){setStatus("Outlook-Termin wurde erfolgreich nachgetragen.","ok");button.hidden=true}else{setStatus(`Outlook weiterhin nicht erreichbar: ${result.appointment?.outlook?.error||"unbekannter Fehler"}`,"warn")}}
    catch(e){setStatus(`Wiederholung fehlgeschlagen: ${e.message}`,"bad")}finally{button.disabled=false;button.textContent="Outlook erneut versuchen"}
  }

  function compactDate(date){return String(date||"").replace(/-/g,"")}
  function googleDates(v){
    if(v.allDay){const d=new Date(v.date+"T12:00:00");d.setDate(d.getDate()+1);const end=`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;return `${compactDate(v.date)}/${end}`}
    return `${compactDate(v.date)}T${v.from.replace(":","")}00/${compactDate(v.date)}T${v.to.replace(":","")}00`;
  }

  function openGoogle(){
    let v;try{v=values()}catch(e){alert(e.message);return}
    const u=new URL("https://calendar.google.com/calendar/render");u.searchParams.set("action","TEMPLATE");u.searchParams.set("text",v.title);u.searchParams.set("dates",googleDates(v));u.searchParams.set("ctz","Europe/Vienna");if(v.details)u.searchParams.set("details",v.details);if(v.location)u.searchParams.set("location",v.location);
    window.open(u.href,"_blank","noopener");
  }

  function icsEscape(v){return String(v||"").replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;")}
  function icsLocal(date,time){return `${compactDate(date)}T${String(time||"").replace(":","")}00`}
  function downloadIcs(){
    let v;try{v=values()}catch(e){alert(e.message);return}
    const uid=`kristine-${String(currentTask?.id||Date.now()).replace(/[^A-Za-z0-9_-]/g,"")}@krista.local`;
    const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//KRISTINE//Aufgabe zu Termin//DE","CALSCALE:GREGORIAN","BEGIN:VEVENT",`UID:${uid}`,`SUMMARY:${icsEscape(v.title)}`];
    if(v.allDay){const d=new Date(v.date+"T12:00:00");d.setDate(d.getDate()+1);const end=`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;lines.push(`DTSTART;VALUE=DATE:${compactDate(v.date)}`,`DTEND;VALUE=DATE:${end}`)}else lines.push(`DTSTART;TZID=Europe/Vienna:${icsLocal(v.date,v.from)}`,`DTEND;TZID=Europe/Vienna:${icsLocal(v.date,v.to)}`);
    if(v.location)lines.push(`LOCATION:${icsEscape(v.location)}`);if(v.details)lines.push(`DESCRIPTION:${icsEscape(v.details)}`);lines.push("END:VEVENT","END:VCALENDAR");
    const blob=new Blob([lines.join("\r\n")+"\r\n"],{type:"text/calendar;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`Termin-${v.date}.ics`;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);
  }

  function inject(taskId){
    const list=document.getElementById("taskModalList");if(!list||!taskId)return;
    const item=list.querySelector(".task-modal-item");const actions=item?.querySelector(".actions");if(!actions||actions.querySelector("[data-krista-calendar-task]"))return;
    const task=taskById(taskId),appointment=task?.appointment;
    const b=document.createElement("button");b.type="button";b.className="krista-calendar-task";b.dataset.kristaCalendarTask=String(taskId);
    if(appointment?.date){
      const date=String(appointment.date).split("-").reverse().join(".");
      const time=appointment.from&&appointment.to?` · ${appointment.from}–${appointment.to}`:"";
      b.textContent=`✓ Termin ausgemacht · ${date}${time}`;b.disabled=true;b.title=appointment.outlook?.status==="synced"?"In KRISTINE und Outlook gespeichert":"In KRISTINE gespeichert; Outlook noch nicht synchronisiert";
    }else{b.textContent="📅 Termin anlegen";b.onclick=()=>open(taskId)}
    actions.insertBefore(b,actions.firstChild);
  }

  function hook(){
    const fn=window.openTaskListModal;if(typeof fn!=="function"||fn.__kristaTaskCalendar)return;
    const wrapped=function(focusId=""){const result=fn.apply(this,arguments);if(focusId)setTimeout(()=>inject(String(focusId)),0);return result};
    for(const key of ["__kristaAttachments"])if(fn[key])wrapped[key]=fn[key];wrapped.__kristaTaskCalendar=true;window.openTaskListModal=wrapped;
  }

  function boot(){
    if(!location.pathname.toLowerCase().includes("/kristine"))return;installStyle();ensureModal();hook();
    setTimeout(hook,200);setTimeout(hook,900);setInterval(hook,1800);
    const linkedTask=new URLSearchParams(location.search).get("task");if(linkedTask)setTimeout(()=>openVisitProtocol(linkedTask),900);
    console.info("KRISTINE Aufgabe → Termin",VERSION);
  }

  window.KristineTaskCalendar={open,close,openVisitProtocol,version:VERSION};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
