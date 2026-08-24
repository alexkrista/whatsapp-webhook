"use strict";

(function(){
  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
  function ensureScript(src,key){if(document.querySelector(`script[${key}]`))return;const s=document.createElement("script");s.src=src;s.setAttribute(key,"1");s.defer=true;document.head.appendChild(s)}
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
  function installTimeModelLayoutFix(){
    if(document.getElementById("kristaTimeModelLayoutFix"))return;
    const s=document.createElement("style");s.id="kristaTimeModelLayoutFix";s.textContent=`
      #scheduleModelList,.tm2-card,.tm2-block,.tm2-rows,.tm2-row,.tm2-head,.tm2-block-head,.tm2-savebar{min-width:0!important;max-width:100%!important;box-sizing:border-box!important}
      .tm2-card{overflow:hidden!important}
      .tm2-head>div:first-child,.tm2-block-head>div:first-child{min-width:0!important}
      .tm2-head-actions,.tm2-fixed-toggle{flex:0 0 auto!important}
      .tm2-row{grid-template-columns:minmax(205px,1.55fr) repeat(6,minmax(76px,.7fr)) minmax(72px,.55fr) 32px!important;gap:6px!important}
      .tm2-row.has-activity{grid-template-columns:minmax(190px,1.25fr) repeat(6,minmax(68px,.58fr)) minmax(130px,1fr) minmax(68px,.5fr) 32px!important;gap:6px!important}
      .tm2-days{min-width:0!important;flex-wrap:nowrap!important;gap:4px!important;overflow:visible!important}
      .tm2-day{width:30px!important;min-width:30px!important;height:30px!important;font-size:12px!important}
      .tm2-field{min-width:0!important;max-width:100%!important}
      .tm2-field label{font-size:9px!important;white-space:nowrap!important}
      .tm2-field input,.tm2-field select{display:block!important;min-width:0!important;max-width:100%!important;width:100%!important;padding:6px!important;font-size:12px!important;box-sizing:border-box!important}
      .tm2-net{min-width:0!important;padding:7px 5px!important;font-size:12px!important}
      .tm2-remove{width:30px!important;min-width:30px!important;height:30px!important}
      .tm2-block-head{flex-wrap:wrap!important}
      .tm2-savebar{flex-wrap:wrap!important;padding-right:0!important}
      @media(max-width:1050px){
        .tm2-row,.tm2-row.has-activity{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:8px!important}
        .tm2-days{grid-column:1/-1!important}
        .tm2-row.has-activity .tm2-activity{grid-column:1/3!important}
        .tm2-net{align-self:end!important}
        .tm2-remove{align-self:end!important;justify-self:end!important}
      }
      @media(max-width:700px){
        .tm2-row,.tm2-row.has-activity{grid-template-columns:1fr 1fr!important}
        .tm2-days{grid-column:1/-1!important;flex-wrap:wrap!important}
        .tm2-row.has-activity .tm2-activity{grid-column:1/-1!important}
        .tm2-fixed-toggle{width:100%!important}
      }
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
  function install(){installStyle();installTimeModelLayoutFix();ensureScript("/public/ui/kristine-time-models-v2.js","data-krista-time-models-v2");ensureScript("/public/ui/kristine-planning-card-tools.js","data-krista-planning-card-tools");ensureScript("/public/ui/kristine-task-save-guard.js?v=20260824-0751","data-krista-task-save-guard");wrapFunctions();enhanceUnknown();enhanceTaskRows();setTimeout(()=>{installTimeModelLayoutFix();wrapFunctions()},300);setTimeout(()=>{enhanceUnknown();enhanceTaskRows()},600)}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
  setInterval(()=>{wrapFunctions();enhanceUnknown();enhanceTaskRows()},3000);
})();
