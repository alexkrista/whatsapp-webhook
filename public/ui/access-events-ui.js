"use strict";

(() => {
  const terminalFallback = {"1":"Haupteingang","2":"Lager","3":"Büro 1.OG"};
  let events = [];
  let filter = "all";
  let chipFilter = "";

  function esc(v){return String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]))}
  function fmt(v){try{return new Intl.DateTimeFormat("de-AT",{dateStyle:"short",timeStyle:"medium"}).format(new Date(v))}catch{return String(v||"")}}
  function compactDate(v){
    if(!v)return "—";
    try{
      const d=new Date(v),now=new Date();
      const same=d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate();
      const time=new Intl.DateTimeFormat("de-AT",{hour:"2-digit",minute:"2-digit"}).format(d);
      if(same)return `Heute ${time}`;
      const day=new Intl.DateTimeFormat("de-AT",{day:"2-digit",month:"2-digit"}).format(d);
      return `${day} ${time}`;
    }catch{return String(v||"")}
  }
  function token(){return new URLSearchParams(location.search).get("token")||""}
  function apiUrl(p){const t=token();return p+(t?(p.includes("?")?"&":"?")+"token="+encodeURIComponent(t):"")}
  function sameEventChip(e,chipNo,hardwareId){
    return Boolean((chipNo&&String(e.internalChipNo||"")===String(chipNo))||(hardwareId&&String(e.hardwareId||"")===String(hardwareId)));
  }
  function lastAllowed(chipNo,hardwareId){
    return events.find(e=>e.outcome==="allowed"&&sameEventChip(e,chipNo,hardwareId))||null;
  }
  function doorLabel(e){return e?.terminalName||terminalFallback[String(e?.terminalId||"")]||"Leser"}

  async function loadEvents(){
    try{
      const headers={}; if(token())headers["X-Admin-Token"]=token();
      const r=await fetch(apiUrl("/admin/api/access/access-events"),{headers,cache:"no-store"});
      const d=await r.json();
      if(!r.ok)throw new Error(d?.error||r.statusText);
      events=Array.isArray(d.events)?d.events:[];
      render();
      augmentChipLists();
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
    const rows=events.filter(e=>(filter==="all"||e.outcome===filter)&&(!chipFilter||String(e.internalChipNo||"")===String(chipFilter)));
    box.innerHTML=rows.length?rows.map(e=>{
      const [icon,text]=label(e.outcome);
      const reason=e.reason?`<div class="access-reason">${esc(e.reason)}</div>`:"";
      return `<div class="access-event-row"><div class="access-main"><strong>${icon} ${esc(text)}</strong><span>${esc(doorLabel(e))}</span></div><div class="access-person">${esc(e.name||"Unbekannter Chip")}</div><div class="access-meta">${fmt(e.at)} · Chip ${esc(e.internalChipNo||"—")} · ID ${esc(e.hardwareId||"—")}</div>${reason}</div>`;
    }).join(""):'<div class="empty">Noch keine passenden Zutrittsereignisse.</div>';
    document.querySelectorAll("[data-access-filter]").forEach(b=>b.classList.toggle("active",b.dataset.accessFilter===filter));
    const chipButton=document.getElementById("accessChipFilter");
    if(chipButton){chipButton.classList.toggle("hidden",!chipFilter);chipButton.textContent=chipFilter?`Chip ${chipFilter} ×`:""}
  }

  function ensureHeaders(){
    document.querySelectorAll(".thead").forEach(head=>{
      if(head.querySelector('[data-last-access-head]'))return;
      const marker=document.createElement("div");
      marker.dataset.lastAccessHead="1";
      marker.textContent="Letzter Zutritt";
      const ref=head.children[3]||null;
      head.insertBefore(marker,ref);
    });
  }
  function augmentChipLists(){
    ensureHeaders();
    document.querySelectorAll("#activeList .chiprow,#reserveList .chiprow").forEach(row=>{
      if(!row.dataset.accessChip){
        row.dataset.accessChip=String(row.children[1]?.textContent||"").trim();
        row.dataset.accessHardware=String(row.children[2]?.textContent||"").trim().replace(/^—$/,'');
      }
      const chipNo=row.dataset.accessChip||"",hardwareId=row.dataset.accessHardware||"";
      const event=lastAllowed(chipNo,hardwareId);
      let cell=row.querySelector('[data-last-access-cell]');
      if(!cell){
        cell=document.createElement("div");
        cell.dataset.lastAccessCell="1";
        cell.className="last-access-cell";
        const ref=row.children[3]||null;
        row.insertBefore(cell,ref);
      }
      if(event){
        cell.innerHTML=`<div class="lab">Letzter Zutritt</div><button class="last-access-btn" type="button">${esc(compactDate(event.at))}<span>${esc(doorLabel(event))}</span></button>`;
        cell.querySelector("button").onclick=()=>{
          chipFilter=chipNo;
          filter="allowed";
          if(typeof window.showTab==="function")window.showTab("access-events");
          render();
        };
      }else{
        cell.innerHTML='<div class="lab">Letzter Zutritt</div><span class="last-access-none">— noch keiner —</span>';
      }
    });
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
    section.innerHTML=`<div class="toolbar access-filterbar"><button data-access-filter="all" class="active">Alle</button><button data-access-filter="allowed">Erlaubt</button><button data-access-filter="denied">Abgewiesen</button><button data-access-filter="unknown">Unbekannt</button><button id="accessChipFilter" class="hidden"></button><button id="accessEventsRefresh">↻ Aktualisieren</button></div><div id="accessEventsList" class="history"></div>`;
    history.parentNode.insertBefore(section,history);

    const style=document.createElement("style");
    style.textContent=`
      .access-filterbar button.active{background:#173d2a;color:#fff;border-color:#173d2a}
      .access-event-row{padding:12px 0;border-bottom:1px solid #ece9e0}.access-event-row:last-child{border-bottom:0}
      .access-main{display:flex;gap:10px;justify-content:space-between;align-items:center}.access-main span{font-size:12px;color:#5f665f}
      .access-person{font-weight:850;margin-top:3px}.access-meta,.access-reason{font-size:11px;color:#777;margin-top:3px}.access-reason{color:#8b4c45}
      .thead,.chiprow{grid-template-columns:minmax(230px,1.25fr) 80px 125px minmax(135px,.7fr) minmax(210px,1fr) minmax(200px,.9fr) 105px}
      .last-access-btn{border:0;background:transparent;padding:0;text-align:left;font-size:11px;font-weight:850;color:#244c36;cursor:pointer;line-height:1.25}
      .last-access-btn span{display:block;color:#777;font-weight:600;margin-top:3px}.last-access-none{font-size:11px;color:#999}
      @media(max-width:1000px){.chiprow{grid-template-columns:1fr 1fr}.chiprow>div:first-child{grid-column:1/-1}}
    `;
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
    section.querySelectorAll("[data-access-filter]").forEach(b=>b.onclick=()=>{filter=b.dataset.accessFilter;chipFilter="";render()});
    document.getElementById("accessChipFilter").onclick=()=>{chipFilter="";render()};
    document.getElementById("accessEventsRefresh").onclick=loadEvents;

    const lists=document.querySelectorAll("#activeList,#reserveList");
    const observer=new MutationObserver(()=>augmentChipLists());
    lists.forEach(list=>observer.observe(list,{childList:true}));
    loadEvents();
    setTimeout(augmentChipLists,250);
    setTimeout(augmentChipLists,1000);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});
  else setTimeout(install,0);
})();
