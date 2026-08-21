"use strict";

(function(){
  const VERSION="2026-08-21-0925";
  const PENDING_KEY="kristaInboxPendingTaskItems";
  const ROUTES={task:"Aufgabe",invoice:"Rechnung",filing:"Ablage",appointment:"Termin",order:"Bestellung"};
  let current=null;
  let routing=false;
  let dragDepth=0;

  const esc=v=>String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const tokenUrl=p=>{
    const u=new URL(p,location.origin);
    const token=new URLSearchParams(location.search).get("token");
    if(token&&u.origin===location.origin)u.searchParams.set("token",token);
    return u.origin===location.origin?u.pathname+u.search+u.hash:u.href;
  };
  async function api(p,o={}){
    const r=await fetch(tokenUrl(p),o);
    const txt=await r.text();
    let data;try{data=txt?JSON.parse(txt):null}catch{}
    if(!r.ok)throw new Error(data?.error||txt||r.statusText);
    return data;
  }

  function pending(){try{return JSON.parse(sessionStorage.getItem(PENDING_KEY)||"[]")}catch{return[]}}
  function savePending(rows){sessionStorage.setItem(PENDING_KEY,JSON.stringify(rows||[]));renderPending()}
  function addPending(item){const rows=pending();if(!rows.some(x=>x.id===item.id))rows.push(item);savePending(rows)}

  function installCss(){
    if(document.getElementById("kristaInboxV2Css"))return;
    const s=document.createElement("style");s.id="kristaInboxV2Css";
    s.textContent=`
.krista-inbox-button{display:inline-flex;align-items:center;gap:6px;padding:8px 11px;border-radius:10px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#fff;font-weight:850;cursor:pointer;white-space:nowrap}.krista-inbox-button:hover{background:rgba(255,255,255,.15)}
.krista-inbox-drop{position:fixed;inset:0;z-index:40000;display:none;place-items:center;background:rgba(17,37,24,.84);padding:24px}.krista-inbox-drop.open{display:grid}.krista-inbox-drop>div{width:min(700px,100%);padding:46px 24px;border:3px dashed rgba(255,255,255,.75);border-radius:24px;text-align:center;color:#fff}.krista-inbox-drop strong{font-size:26px;display:block}.krista-inbox-drop span{display:block;margin-top:8px;opacity:.8}
.krista-inbox-modal-bg{position:fixed;inset:0;z-index:40010;display:none;place-items:center;padding:18px;background:rgba(0,0,0,.52)}.krista-inbox-modal-bg.open{display:grid}.krista-inbox-modal{width:min(760px,100%);max-height:92vh;overflow:auto;background:#fff;border-radius:20px;padding:20px;box-shadow:0 25px 80px rgba(0,0,0,.3)}.krista-inbox-head{display:flex;justify-content:space-between;gap:14px}.krista-inbox-head h2{margin:0}.krista-inbox-reco{margin:14px 0;padding:13px;border-radius:12px;background:#edf6ef;border:1px solid #cbe0d0}.krista-inbox-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px}.krista-inbox-meta div{padding:8px 0;border-bottom:1px solid #eee}.krista-inbox-assignee{margin-top:14px;padding:12px;border:1px solid #d9e5dc;border-radius:12px;background:#f7fbf8}.krista-inbox-assignee label{display:block;margin-bottom:6px}.krista-inbox-assignee select{width:100%;background:#fff}.krista-inbox-routes{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.krista-inbox-routes button{background:#fff;color:#222;border:1px solid #ccc}.krista-inbox-routes button.recommended{background:#27713d;color:#fff;border-color:#27713d}.krista-inbox-routes button:disabled{opacity:.5;cursor:wait}.krista-inbox-route-status{margin-top:10px;padding:9px 11px;border-radius:9px;font-size:12px;display:none}.krista-inbox-route-status.show{display:block;background:#eef7ee;color:#145829}.krista-inbox-route-status.error{display:block;background:#fde7e7;color:#8b1f1f}.krista-inbox-preview{white-space:pre-wrap;margin-top:14px;padding:12px;border-radius:12px;background:#f7f7f4;font-size:12px;max-height:220px;overflow:auto}.krista-inbox-pending{margin-top:12px;padding:11px;border-radius:11px;background:#edf6ef;border:1px solid #cbe0d0}.krista-inbox-pending a{font-weight:800}.krista-inbox-pending button{padding:4px 7px;margin-left:6px}@media(max-width:700px){.krista-inbox-meta{grid-template-columns:1fr}.krista-inbox-button span{display:none}}
`;
    document.head.appendChild(s);
  }

  function installDom(){
    if(document.getElementById("kristaInboxModalBg"))return;
    document.body.insertAdjacentHTML("beforeend",`<div id="kristaInboxDrop" class="krista-inbox-drop"><div><strong>📥 Hier ablegen</strong><span>KRISTINE liest die Datei und fragt danach, wohin sie gehört.</span></div></div><div id="kristaInboxModalBg" class="krista-inbox-modal-bg"><div class="krista-inbox-modal"><div class="krista-inbox-head"><div><h2>📥 KRISTINE Eingang</h2><div id="kristaInboxFile" class="small"></div></div><button id="kristaInboxClose" type="button" class="secondary">Schließen</button></div><div id="kristaInboxContent"></div></div></div><input id="kristaInboxPicker" type="file" multiple hidden>`);
    document.getElementById("kristaInboxClose").onclick=closeModal;
    document.getElementById("kristaInboxModalBg").onclick=e=>{if(e.target.id==="kristaInboxModalBg")closeModal()};
    document.getElementById("kristaInboxPicker").onchange=e=>importFiles(e.target.files);
  }
  function closeModal(){document.getElementById("kristaInboxModalBg")?.classList.remove("open")}

  function installButton(){
    const top=document.querySelector(".krista-shell-main");if(!top)return;
    if(document.getElementById("kristaInboxButton"))return;
    const b=document.createElement("button");b.id="kristaInboxButton";b.type="button";b.className="krista-inbox-button";
    b.innerHTML="📥 <span>EINGANG</span>";b.title="Mail, Foto, PDF oder Dokument in KRISTINE ziehen";
    b.onclick=()=>document.getElementById("kristaInboxPicker")?.click();
    top.insertBefore(b,top.querySelector(".krista-user")||null);
  }

  function assigneeChoices(){
    const source=document.getElementById("tAssigneeSelect");
    const options=source?[...source.options].filter(o=>o.value):[];
    let preferred=options.find(o=>String(o.dataset.name||o.textContent||"").trim().toLowerCase()==="alexander krista")||options.find(o=>/^alex(?:ander)?\b/i.test(String(o.dataset.name||o.textContent||"").trim()));
    return {options,preferred};
  }
  function assigneeOptionsHtml(){
    const {options,preferred}=assigneeChoices();
    return options.length?options.map(o=>{const name=String(o.dataset.name||o.textContent||"").trim();return `<option value="${esc(o.value)}" ${preferred&&o.value===preferred.value?'selected':''}>${esc(name)}</option>`}).join(""):'<option value="">– Mitarbeiter auswählen –</option>';
  }
  function selectedAssignee(){
    const s=document.getElementById("kristaInboxAssignee");
    if(s?.value)return {id:s.value,name:String(s.selectedOptions?.[0]?.textContent||"").trim()};
    const {preferred}=assigneeChoices();return preferred?{id:preferred.value,name:String(preferred.dataset.name||preferred.textContent||"").trim()}:{id:"",name:""};
  }

  async function importFiles(list){
    for(const file of [...(list||[])]){
      if(file.size>12*1024*1024){alert(file.name+" ist größer als 12 MB.");continue}
      try{
        const data=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result||"").split(",").pop());r.onerror=no;r.readAsDataURL(file)});
        showBusy(file.name);
        const result=await api("/kristine/api/inbox/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:file.name,type:file.type,data})});
        showAnalysis(result.item);
      }catch(e){alert("Eingang: "+e.message)}
    }
    const picker=document.getElementById("kristaInboxPicker");if(picker)picker.value="";
  }
  function showBusy(name){
    current=null;document.getElementById("kristaInboxFile").textContent=name;
    document.getElementById("kristaInboxContent").innerHTML='<div class="krista-inbox-reco">KRISTINE liest und analysiert …</div>';
    document.getElementById("kristaInboxModalBg").classList.add("open");
  }
  function showAnalysis(item){
    current=item;routing=false;
    const a=item.analysis||{},rec=a.recommended||"filing",pct=Math.round(Number(a.confidence||0)*100);
    document.getElementById("kristaInboxFile").textContent=item.name;
    document.getElementById("kristaInboxContent").innerHTML=`<div class="krista-inbox-reco"><strong>KRISTINE empfiehlt: ${esc(ROUTES[rec]||"Ablage")}</strong> · ${pct}%<br><span class="small">${esc((a.reasons||[]).join(" · ")||"Inhalt wurde analysiert.")}</span></div><div class="krista-inbox-meta"><div><strong>Betreff</strong><br>${esc(a.subject||"–")}</div><div><strong>Fällig/Termin</strong><br>${esc(a.dueDate||"–")}</div><div><strong>Kontakt</strong><br>${esc(a.contactName||"–")}</div><div><strong>Telefon</strong><br>${esc(a.contactPhone||"–")}</div><div><strong>E-Mail</strong><br>${esc(a.contactEmail||"–")}</div><div><strong>Erkannt</strong><br>${esc(a.product||a.colorName||"–")}</div></div><div class="krista-inbox-assignee"><label><strong>Aufgabe für</strong></label><select id="kristaInboxAssignee">${assigneeOptionsHtml()}</select><div class="small" style="margin-top:5px">Standard: Alexander Krista · bei Bedarf ändern.</div></div><div class="krista-inbox-routes">${Object.keys(ROUTES).map(r=>`<button type="button" class="${r===rec?'recommended':''}" onclick="return window.KristineInboxV2.route('${r}',event)">${ROUTES[r]}</button>`).join("")}</div><div id="kristaInboxRouteStatus" class="krista-inbox-route-status"></div>${a.excerpt?`<div class="krista-inbox-preview">${esc(a.excerpt)}</div>`:""}`;
    document.getElementById("kristaInboxModalBg").classList.add("open");
  }
  function routeStatus(text,error=false){const el=document.getElementById("kristaInboxRouteStatus");if(!el)return;el.textContent=text||"";el.className="krista-inbox-route-status "+(text?(error?"error":"show"):"")}
  function disableRoutes(v){document.querySelectorAll("#kristaInboxContent .krista-inbox-routes button").forEach(b=>b.disabled=!!v)}
  async function persistRoute(item,route,assignee){return api(`/kristine/api/inbox/${encodeURIComponent(item.id)}/route`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({route,assigneeId:assignee?.id||"",assigneeName:assignee?.name||""})})}

  function setValue(id,value){const el=document.getElementById(id);if(!el||value===undefined||value===null||value==="")return;el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))}
  function fillTask(item,assignee){
    const a=item.analysis||{};
    if(typeof window.showTab==="function")window.showTab("tasks");location.hash="tasks";
    setValue("tTitle",a.title||a.subject||item.name);setValue("tDueDate",a.dueDate);setValue("tContactName",a.contactName);setValue("tContactPhone",a.contactPhone);setValue("tContactEmail",a.contactEmail);
    if(assignee?.id){setValue("tAssigneeSelect",assignee.id);setValue("tAssigneeId",assignee.id);setValue("tAssigneeName",assignee.name)}
    const details=[a.summary,a.excerpt&&a.excerpt!==a.summary?a.excerpt:"",`📎 Original im KRISTINE-Eingang: ${item.name}`].filter(Boolean).join("\n\n");setValue("tReminder",details.slice(0,8000));
    const other=document.querySelector('input[name="taskType"][value="Sonstiges"]');if(other){other.checked=true;other.dispatchEvent(new Event("change",{bubbles:true}))}
    addPending({id:item.id,name:item.name});closeModal();
    document.querySelector("#tasks .task-create-card")?.scrollIntoView({behavior:"smooth",block:"start"});
  }

  async function route(route,event){
    event?.preventDefault?.();event?.stopPropagation?.();
    if(!current||routing||!ROUTES[route])return false;
    const item=current;const assignee=route==="task"?selectedAssignee():null;
    if(route==="task"){
      fillTask(item,assignee);
      persistRoute(item,route,assignee).catch(e=>console.warn("KRISTINE Eingang Routing",e));
      return false;
    }
    routing=true;disableRoutes(true);routeStatus(`${ROUTES[route]} wird übernommen …`);
    try{await persistRoute(item,route,assignee);routeStatus(`${ROUTES[route]} ist vorgemerkt. Die Fachfunktion wird als nächster Schritt angeschlossen.`)}catch(e){routeStatus(`Konnte nicht übernommen werden: ${e.message||e}`,true)}finally{routing=false;disableRoutes(false)}
    return false;
  }

  function renderPending(){
    const card=document.querySelector("#tasks .task-create-card");if(!card)return;
    let box=document.getElementById("kristaInboxPending");
    if(!box){box=document.createElement("div");box.id="kristaInboxPending";box.className="krista-inbox-pending";card.querySelector(".actions")?.before(box)}
    const rows=pending();const html=rows.length?`<strong>📎 Anhänge für diese Aufgabe</strong><br>${rows.map(x=>`<a target="_blank" rel="noopener" href="${tokenUrl(`/kristine/api/inbox/${encodeURIComponent(x.id)}/file`)}">${esc(x.name)}</a><button type="button" class="secondary" data-remove-inbox="${esc(x.id)}">×</button>`).join("<br>")}`:"";
    box.style.display=rows.length?"block":"none";
    const key=JSON.stringify(rows);
    if(box.dataset.renderKey!==key){box.innerHTML=html;box.dataset.renderKey=key;box.querySelectorAll("[data-remove-inbox]").forEach(b=>b.onclick=()=>savePending(rows.filter(x=>x.id!==b.dataset.removeInbox)))}
  }

  async function taskIds(){try{const s=await api("/kristine/api/bootstrap");return new Set((s.tasks||[]).map(x=>String(x.id)))}catch{return new Set()}}
  async function newestTask(before){try{const s=await api("/kristine/api/bootstrap");return (s.tasks||[]).filter(x=>!before.has(String(x.id))).sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")))[0]||null}catch{return null}}
  function hookTaskSave(){
    if(window.__kristaInboxV2TaskHook||typeof window.addTask!=="function")return;
    window.__kristaInboxV2TaskHook=true;const original=window.addTask;
    window.addTask=async function(){const rows=pending();const before=rows.length?await taskIds():new Set();const result=await original.apply(this,arguments);if(rows.length){const created=await newestTask(before);if(created){for(const item of rows){try{await api(`/kristine/api/inbox/${encodeURIComponent(item.id)}/link-task`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:created.id})})}catch(e){console.warn("Anhang konnte nicht verknüpft werden",e)}}savePending([])}}return result};
  }

  function dragOn(){dragDepth++;document.getElementById("kristaInboxDrop")?.classList.add("open")}
  function dragOff(){dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)document.getElementById("kristaInboxDrop")?.classList.remove("open")}
  function boot(){
    if(!location.pathname.toLowerCase().includes("/kristine"))return;
    installCss();installDom();installButton();renderPending();hookTaskSave();
    window.addEventListener("hashchange",()=>{setTimeout(()=>{installButton();renderPending();hookTaskSave()},0)});
    document.addEventListener("dragenter",e=>{if(e.dataTransfer?.types?.includes("Files"))dragOn()});
    document.addEventListener("dragleave",e=>{if(e.dataTransfer?.types?.includes("Files"))dragOff()});
    document.addEventListener("dragover",e=>{if(e.dataTransfer?.types?.includes("Files")){e.preventDefault();e.dataTransfer.dropEffect="copy"}});
    document.addEventListener("drop",e=>{if(e.dataTransfer?.files?.length){e.preventDefault();dragDepth=0;document.getElementById("kristaInboxDrop")?.classList.remove("open");importFiles(e.dataTransfer.files)}});
    console.info("KRISTINE Eingang V2",VERSION);
  }

  window.KristineInboxV2={route,version:VERSION};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
