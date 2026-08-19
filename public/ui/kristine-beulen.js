"use strict";

(function(){
  let escalationState={};
  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
  function tokenHeaders(){const token=new URLSearchParams(location.search).get("token");return token?{"x-admin-token":token}:{}}
  function installStyle(){
    if(document.getElementById("kristaBeulenStyle"))return;
    const s=document.createElement("style");s.id="kristaBeulenStyle";s.textContent=`
      .krista-planning-workspace #planningCardsPanel .pool-list{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:6px!important}
      .krista-planning-workspace #planningCardsPanel .pool-card{width:100%!important;min-width:0!important;padding:8px!important}
      .krista-planning-workspace #planningCardsPanel .pool-card strong{font-size:11px!important;line-height:1.2!important}
      .krista-planning-workspace #planningCardsPanel .pool-card .small{font-size:10px!important}
      #controlAlerts .krista-unknown-trigger{cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;font-weight:800}
      #kristaUnknownJobs{margin-top:10px;display:grid;gap:6px}
      #kristaUnknownJobs[hidden]{display:none!important}.krista-unknown-row{background:#fff;border:1px solid #dbe6d9;border-radius:10px;padding:9px 10px;display:grid;grid-template-columns:minmax(140px,1fr) minmax(180px,2fr) auto;gap:8px;align-items:center}.krista-unknown-row small{color:#707070}.krista-unknown-row button{padding:6px 8px}
      #taskList .krista-task-row{cursor:pointer}.krista-task-escalation-badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 6px;font-size:10px;font-weight:900;margin-right:4px;background:#e9eee8;color:#245b32}.krista-task-escalation-badge.level2{background:#fff2cf;color:#765300}.krista-task-escalation-badge.level3{background:#ffe0df;color:#8a1616}
      .krista-escalation-panel{margin-top:14px;padding:12px;border:1px solid #dedbd4;border-radius:12px;background:#faf9f6}.krista-escalation-panel strong{display:block;margin-bottom:8px}.krista-escalation-buttons{display:flex;gap:7px;flex-wrap:wrap}.krista-escalation-buttons button{padding:8px 10px}.krista-escalation-buttons button.active{box-shadow:0 0 0 2px #27713d inset}.krista-escalation-note{font-size:11px;color:#666;margin-top:8px;line-height:1.4}
      @media(max-width:1000px){.krista-planning-workspace #planningCardsPanel .pool-list{display:grid!important;grid-template-columns:repeat(2,minmax(150px,1fr))!important;overflow:visible!important}.krista-planning-workspace #planningCardsPanel .pool-card{min-width:0!important}}
      @media(max-width:620px){.krista-planning-workspace #planningCardsPanel .pool-list{grid-template-columns:1fr!important}.krista-unknown-row{grid-template-columns:1fr}}
    `;document.head.appendChild(s);
  }
  function unknownItems(){
    const out=[];
    try{Object.values(data?.states||{}).forEach(state=>(state?.timeline||[]).forEach(x=>{if(x?.type!=="assignment_deviation")return;out.push({state,x})}))}catch{}
    return out;
  }
  function unknownLabel(item){const x=item.x||{};return x.jobName||x.siteName||x.site||x.jobId||x.assignment||x.text||x.name||"Unbekannte Baustelle"}
  function enhanceUnknown(){
    const box=document.getElementById("controlAlerts");if(!box)return;
    const items=unknownItems();if(!items.length){document.getElementById("kristaUnknownJobs")?.remove();return}
    const spans=[...box.querySelectorAll("span")];const target=spans.find(el=>/unbekannte Baustelle/i.test(el.textContent||""));if(!target)return;
    target.classList.add("krista-unknown-trigger");target.title="Anklicken und Baustellen anzeigen";
    let list=document.getElementById("kristaUnknownJobs");if(!list){list=document.createElement("div");list.id="kristaUnknownJobs";list.hidden=true;box.appendChild(list)}
    list.innerHTML=items.map((item,i)=>{const st=item.state||{},x=item.x||{};const employee=st.employeeName||st.name||st.employeeId||"Mitarbeiter";const date=x.date||x.at||x.time||"";return `<div class="krista-unknown-row"><div><strong>${esc(employee)}</strong><br><small>${esc(date)}</small></div><div><strong>${esc(unknownLabel(item))}</strong><br><small>${esc(x.note||x.reason||"Zuordnung prüfen")}</small></div><button type="button" class="secondary" data-unknown-open="${i}">Mitarbeiter öffnen</button></div>`}).join("");
    target.onclick=()=>{list.hidden=!list.hidden};
    list.querySelectorAll("[data-unknown-open]").forEach(btn=>btn.onclick=()=>{const item=items[Number(btn.dataset.unknownOpen)];const id=item?.state?.employeeId;if(id&&typeof window.openEmployeeActionModal==="function")window.openEmployeeActionModal(String(id))});
  }
  async function loadEscalations(){
    try{const r=await fetch("/kristine/api/task-escalations",{cache:"no-store",headers:tokenHeaders()});const d=await r.json();if(r.ok&&d.ok){escalationState=d.escalations||{};enhanceTaskRows()}}catch{}
  }
  function taskIdFromRow(row){const b=row.querySelector('button[onclick*="openTaskListModal"]');const m=String(b?.getAttribute("onclick")||"").match(/openTaskListModal\('([^']+)'\)/);return m?.[1]||""}
  function levelFor(id){return Math.max(1,Math.min(3,Number(escalationState?.[id]?.level||1)))}
  function enhanceTaskRows(){
    document.querySelectorAll("#taskList .krista-task-row").forEach(row=>{
      const id=taskIdFromRow(row);if(!id)return;row.dataset.taskId=id;
      const sub=row.querySelector(".krista-task-sub");if(sub&&!sub.querySelector(".krista-task-escalation-badge")){const level=levelFor(id),badge=document.createElement("span");badge.className=`krista-task-escalation-badge level${level}`;badge.textContent=level===1?"1 · Wiederholung":level===2?"2 · täglich WA":"3 · stündlich WA";sub.prepend(badge)}
      if(!row.dataset.kristaClick){row.dataset.kristaClick="1";row.addEventListener("click",e=>{if(e.target.closest("button,a,input,select,textarea"))return;if(typeof window.openTaskListModal==="function")window.openTaskListModal(id)})}
    });
  }
  async function setLevel(taskId,level){
    try{const r=await fetch("/kristine/api/task-escalations",{method:"PUT",headers:{"Content-Type":"application/json",...tokenHeaders()},body:JSON.stringify({taskId,level})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||"Speichern fehlgeschlagen");escalationState=d.escalations||escalationState;decorateModal(taskId);enhanceTaskRows()}catch(e){alert("Eskalation konnte nicht gespeichert werden: "+e.message)}
  }
  function decorateModal(taskId){
    const list=document.getElementById("taskModalList");if(!list||!taskId)return;
    const item=list.querySelector(".task-modal-item");if(!item)return;
    let panel=item.querySelector(".krista-escalation-panel");if(!panel){panel=document.createElement("div");panel.className="krista-escalation-panel";item.appendChild(panel)}
    const level=levelFor(taskId);panel.innerHTML=`<strong>Eskalation / Wiederholung</strong><div class="krista-escalation-buttons"><button type="button" class="secondary ${level===1?'active':''}" data-level="1">1 · Wiederholung</button><button type="button" class="secondary ${level===2?'active':''}" data-level="2">2 · täglich WhatsApp</button><button type="button" class="danger ${level===3?'active':''}" data-level="3">3 · stündlich WhatsApp</button></div><div class="krista-escalation-note">Stufe 1: keine automatische WA-Eskalation. Stufe 2: einmal täglich. Stufe 3: stündlich während 07:00–18:00 Uhr, solange die Aufgabe offen ist.</div>`;
    panel.querySelectorAll("[data-level]").forEach(b=>b.onclick=()=>setLevel(taskId,Number(b.dataset.level)));
  }
  function wrapFunctions(){
    if(typeof window.renderControl==="function"&&!window.renderControl.__kristaBeulen){const old=window.renderControl;const wrapped=function(){const v=old.apply(this,arguments);setTimeout(enhanceUnknown,0);return v};wrapped.__kristaBeulen=true;window.renderControl=wrapped}
    if(typeof window.renderTasks==="function"&&!window.renderTasks.__kristaBeulen){const old=window.renderTasks;const wrapped=function(){const v=old.apply(this,arguments);setTimeout(enhanceTaskRows,0);return v};wrapped.__kristaBeulen=true;window.renderTasks=wrapped}
    if(typeof window.openTaskListModal==="function"&&!window.openTaskListModal.__kristaBeulen){const old=window.openTaskListModal;const wrapped=function(id=""){const v=old.apply(this,arguments);if(id)setTimeout(()=>decorateModal(id),0);return v};wrapped.__kristaBeulen=true;window.openTaskListModal=wrapped}
  }
  function install(){installStyle();wrapFunctions();enhanceUnknown();enhanceTaskRows();loadEscalations();setTimeout(wrapFunctions,300);setTimeout(()=>{enhanceUnknown();enhanceTaskRows()},600)}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
  setInterval(()=>{wrapFunctions();enhanceUnknown();enhanceTaskRows()},3000);
})();
