"use strict";

(function(){
  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
  function installStyle(){
    if(document.getElementById("kristaBeulenStyle"))return;
    const s=document.createElement("style");s.id="kristaBeulenStyle";s.textContent=`
      .krista-planning-workspace #planningCardsPanel .pool-list{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:6px!important}
      .krista-planning-workspace #planningCardsPanel .pool-card{width:100%!important;min-width:0!important;padding:8px!important}
      .krista-planning-workspace #planningCardsPanel .pool-card strong{font-size:11px!important;line-height:1.2!important}
      .krista-planning-workspace #planningCardsPanel .pool-card .small{font-size:10px!important}
      #controlAlerts .krista-unknown-trigger{cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;font-weight:800}
      #kristaUnknownJobs{margin-top:10px;display:grid;gap:6px}
      #kristaUnknownJobs[hidden]{display:none!important}
      .krista-unknown-row{background:#fff;border:1px solid #dbe6d9;border-radius:10px;padding:9px 10px;display:grid;grid-template-columns:minmax(140px,1fr) minmax(180px,2fr) auto;gap:8px;align-items:center}
      .krista-unknown-row small{color:#707070}.krista-unknown-row button{padding:6px 8px}
      #taskList .krista-task-row{cursor:pointer;transition:box-shadow .12s ease,transform .12s ease}
      #taskList .krista-task-row:hover{box-shadow:0 3px 13px rgba(0,0,0,.08);transform:translateY(-1px)}
      @media(max-width:1000px){.krista-planning-workspace #planningCardsPanel .pool-list{display:grid!important;grid-template-columns:repeat(2,minmax(150px,1fr))!important;overflow:visible!important}.krista-planning-workspace #planningCardsPanel .pool-card{min-width:0!important}}
      @media(max-width:620px){.krista-planning-workspace #planningCardsPanel .pool-list{grid-template-columns:1fr!important}.krista-unknown-row{grid-template-columns:1fr}}
    `;document.head.appendChild(s);
  }
  function unknownItems(){
    const out=[];
    try{Object.values(data?.states||{}).forEach(state=>(state?.timeline||[]).forEach(x=>{if(x?.type==="assignment_deviation")out.push({state,x})}))}catch{}
    return out;
  }
  function unknownLabel(item){const x=item.x||{};return x.jobName||x.siteName||x.site||x.jobId||x.assignment||x.text||x.name||"Unbekannte Baustelle"}
  function enhanceUnknown(){
    const box=document.getElementById("controlAlerts");if(!box)return;
    const items=unknownItems();if(!items.length){document.getElementById("kristaUnknownJobs")?.remove();return}
    const target=[...box.querySelectorAll("span")].find(el=>/unbekannte Baustelle/i.test(el.textContent||""));if(!target)return;
    target.classList.add("krista-unknown-trigger");target.title="Anklicken und Baustellen anzeigen";
    let list=document.getElementById("kristaUnknownJobs");if(!list){list=document.createElement("div");list.id="kristaUnknownJobs";list.hidden=true;box.appendChild(list)}
    list.innerHTML=items.map((item,i)=>{const st=item.state||{},x=item.x||{};const employee=st.employeeName||st.name||st.employeeId||"Mitarbeiter";const date=x.date||x.at||x.time||"";return `<div class="krista-unknown-row"><div><strong>${esc(employee)}</strong><br><small>${esc(date)}</small></div><div><strong>${esc(unknownLabel(item))}</strong><br><small>${esc(x.note||x.reason||"Zuordnung prüfen")}</small></div><button type="button" class="secondary" data-unknown-open="${i}">Mitarbeiter öffnen</button></div>`}).join("");
    target.onclick=()=>{list.hidden=!list.hidden};
    list.querySelectorAll("[data-unknown-open]").forEach(btn=>btn.onclick=()=>{const item=items[Number(btn.dataset.unknownOpen)];const id=item?.state?.employeeId;if(id&&typeof window.openEmployeeActionModal==="function")window.openEmployeeActionModal(String(id))});
  }
  function taskIdFromRow(row){const b=row.querySelector('button[onclick*="openTaskListModal"]');const m=String(b?.getAttribute("onclick")||"").match(/openTaskListModal\('([^']+)'\)/);return m?.[1]||""}
  function enhanceTaskRows(){
    document.querySelectorAll("#taskList .krista-task-row").forEach(row=>{
      const id=taskIdFromRow(row);if(!id||row.dataset.kristaClick)return;
      row.dataset.kristaClick="1";row.dataset.taskId=id;
      row.addEventListener("click",e=>{if(e.target.closest("button,a,input,select,textarea"))return;if(typeof window.openTaskListModal==="function")window.openTaskListModal(id)});
    });
  }
  function wrapFunctions(){
    if(typeof window.renderControl==="function"&&!window.renderControl.__kristaBeulen){const old=window.renderControl;const wrapped=function(){const v=old.apply(this,arguments);setTimeout(enhanceUnknown,0);return v};wrapped.__kristaBeulen=true;window.renderControl=wrapped}
    if(typeof window.renderTasks==="function"&&!window.renderTasks.__kristaBeulen){const old=window.renderTasks;const wrapped=function(){const v=old.apply(this,arguments);setTimeout(enhanceTaskRows,0);return v};wrapped.__kristaBeulen=true;window.renderTasks=wrapped}
  }
  function install(){installStyle();wrapFunctions();enhanceUnknown();enhanceTaskRows();setTimeout(wrapFunctions,300);setTimeout(()=>{enhanceUnknown();enhanceTaskRows()},600)}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
  setInterval(()=>{wrapFunctions();enhanceUnknown();enhanceTaskRows()},3000);
})();
