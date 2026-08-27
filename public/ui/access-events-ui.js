"use strict";

(() => {
  const terminalFallback = {"1":"Haupteingang","2":"Lager","3":"Büro 1.OG"};
  let events = [];
  let filter = "all";

  function esc(v){return String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]))}
  function fmt(v){try{return new Intl.DateTimeFormat("de-AT",{dateStyle:"short",timeStyle:"medium"}).format(new Date(v))}catch{return String(v||"")}}
  function token(){return new URLSearchParams(location.search).get("token")||""}
  function apiUrl(p){const t=token();return p+(t?(p.includes("?")?"&":"?")+"token="+encodeURIComponent(t):"")}
  async function loadEvents(){
    try{
      const headers={}; if(token())headers["X-Admin-Token"]=token();
      const r=await fetch(apiUrl("/admin/api/access/access-events"),{headers,cache:"no-store"});
      const d=await r.json();
      if(!r.ok)throw new Error(d?.error||r.statusText);
      events=Array.isArray(d.events)?d.events:[];
      render();
    }catch(e){
      const box=document.getElementById("accessEventsList");
      if(box)box.innerHTML='<div class="empty">Zutritte konnten nicht geladen werden: '+esc(e.message)+'</div>';
    }
  }
  function label(outcome){
    if(outcome==="allowed")return ["✅","Zutritt erlaubt","ok"];
    if(outcome==="denied")return ["❌","Abgewiesen","bad"];
    if(outcome==="unknown")return ["⚠️","Unbekannter Chip","warn"];
    return ["🔑","Chip erkannt",""];
  }
  function render(){
    const box=document.getElementById("accessEventsList"); if(!box)return;
    const rows=events.filter(e=>filter==="all"||e.outcome===filter);
    box.innerHTML=rows.length?rows.map(e=>{
      const [icon,text,cls]=label(e.outcome);
      const door=e.terminalName||terminalFallback[String(e.terminalId||"")]||"Leser";
      const reason=e.reason?`<div class="access-reason">${esc(e.reason)}</div>`:"";
      return `<div class="access-event-row"><div class="access-main"><strong>${icon} ${esc(text)}</strong><span>${esc(door)}</span></div><div class="access-person">${esc(e.name||"Unbekannter Chip")}</div><div class="access-meta">${fmt(e.at)} · Chip ${esc(e.internalChipNo||"—")} · ID ${esc(e.hardwareId||"—")}</div>${reason}</div>`;
    }).join(""):'<div class="empty">Noch keine passenden Zutrittsereignisse.</div>';
    document.querySelectorAll("[data-access-filter]").forEach(b=>b.classList.toggle("active",b.dataset.accessFilter===filter));
  }
  function install(){
    const tabs=document.querySelector(".tabs");
    const historyBtn=tabs?.querySelector('[data-tab="history"]');
    if(!tabs||!historyBtn||document.querySelector('[data-tab="access-events"]'))return;

    const btn=document.createElement("button");
    btn.dataset.tab="access-events";
    btn.textContent="Zutritte";
    tabs.insertBefore(btn,historyBtn);

    const history=document.getElementById("tab-history");
    const section=document.createElement("section");
    section.id="tab-access-events";
    section.className="hidden";
    section.innerHTML=`<div class="toolbar access-filterbar"><button data-access-filter="all" class="active">Alle</button><button data-access-filter="allowed">Erlaubt</button><button data-access-filter="denied">Abgewiesen</button><button data-access-filter="unknown">Unbekannt</button><button id="accessEventsRefresh">↻ Aktualisieren</button></div><div id="accessEventsList" class="history"></div>`;
    history.parentNode.insertBefore(section,history);

    const style=document.createElement("style");
    style.textContent=`.access-filterbar button.active{background:#173d2a;color:#fff;border-color:#173d2a}.access-event-row{padding:12px 0;border-bottom:1px solid #ece9e0}.access-event-row:last-child{border-bottom:0}.access-main{display:flex;gap:10px;justify-content:space-between;align-items:center}.access-main span{font-size:12px;color:#5f665f}.access-person{font-weight:850;margin-top:3px}.access-meta,.access-reason{font-size:11px;color:#777;margin-top:3px}.access-reason{color:#8b4c45}`;
    document.head.appendChild(style);

    const originalShowTab=window.showTab;
    window.showTab=function(id){
      if(id==="access-events"){
        try{ if(typeof currentTab!=="undefined") currentTab=id; }catch{}
        document.querySelectorAll("[data-tab]").forEach(b=>b.classList.toggle("active",b.dataset.tab===id));
        for(const x of ["active","reserve","groups","history"])document.getElementById("tab-"+x)?.classList.add("hidden");
        section.classList.remove("hidden");
        loadEvents();
        return;
      }
      section.classList.add("hidden");
      if(typeof originalShowTab==="function")originalShowTab(id);
    };
    document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>window.showTab(b.dataset.tab));
    section.querySelectorAll("[data-access-filter]").forEach(b=>b.onclick=()=>{filter=b.dataset.accessFilter;render()});
    document.getElementById("accessEventsRefresh").onclick=loadEvents;
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});
  else setTimeout(install,0);
})();
