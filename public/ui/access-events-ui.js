"use strict";

(() => {
  const terminalFallback = {"1":"Haupteingang","2":"Lager","3":"Büro 1.OG"};
  let events = [];
  let filter = "all";
  let chipFilter = "";
  let historyChip = null;
  function unknownChip(e){return e.unknownChip === true || e.outcome === "unknown" || /^unbekannter chip$/i.test(String(e.name||"").trim());}
  function eventMatches(e,kind){return kind==="all" || (kind==="unknown" ? unknownChip(e) : e.outcome===kind);}
  function chronological(rows){return rows.slice().sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0));}
  function chips(){try{return typeof data!=="undefined" && Array.isArray(data.chips) ? data.chips : [];}catch{return [];}}
  function resolveChip(e){
    // Hardware-ID hat Vorrang: keine fremde Schlüsselmaske bei wiederverwendeter Nummer.
    if(e.hardwareId)return chips().find(c=>String(c.hardwareId||"")===String(e.hardwareId))||null;
    return chips().find(c=>String(c.internalChipNo)===String(e.internalChipNo))||null;
  }

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
    if(hardwareId && e.hardwareId)return String(e.hardwareId)===String(hardwareId);
    return Boolean(chipNo && String(e.internalChipNo||"")===String(chipNo));
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
      events=chronological(Array.isArray(d.events)?d.events:[]);
      render();
      augmentChipLists();
      if(historyChip)renderChipHistory(historyChip);
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
    const rows=events.filter(e=>eventMatches(e,filter)&&(!chipFilter||String(e.internalChipNo||"")===String(chipFilter)));
    box.innerHTML=rows.length?rows.map((e,index)=>{
      const [icon,text]=label(unknownChip(e)&&!["allowed","denied"].includes(e.outcome)?"unknown":e.outcome);
      const reason=e.reason?`<div class="access-reason">${esc(e.reason)}</div>`:"";
      return `<button type="button" class="access-event-row access-event-link" data-event-index="${index}"><div class="access-main"><strong>${icon} ${esc(text)}</strong><span>${esc(doorLabel(e))}</span></div><div class="access-person">${esc(e.name||"Unbekannter Chip")}</div><div class="access-meta">${fmt(e.at)} · Chip ${esc(e.internalChipNo||"—")} · ID ${esc(e.hardwareId||"—")}</div>${reason}<span class="access-open">Schlüssel & Historie öffnen →</span></button>`;
    }).join(""):'<div class="empty">Noch keine passenden Zutrittsereignisse.</div>';
    box.querySelectorAll("[data-event-index]").forEach(button=>{button.onclick=()=>openEvent(rows[Number(button.dataset.eventIndex)]);});
    document.querySelectorAll("[data-access-filter]").forEach(b=>b.classList.toggle("active",b.dataset.accessFilter===filter));
    const chipButton=document.getElementById("accessChipFilter");
    if(chipButton){chipButton.classList.toggle("hidden",!chipFilter);chipButton.textContent=chipFilter?`Chip ${chipFilter} ×`:""}
  }


  function historyMarkup(chip){
    const rows=events.filter(e=>sameEventChip(e,chip.internalChipNo,chip.hardwareId));
    return '<h3>Zutrittshistorie</h3><p class="access-meta">Gespeicherte Ereignisse · neueste zuerst. „Chip erkannt“ bestätigt keine Türfreigabe.</p>'+
      (rows.length?rows.map(e=>{const [icon,text]=label(unknownChip(e)&&!["allowed","denied"].includes(e.outcome)?"unknown":e.outcome);return '<div class="access-event-row"><strong>'+esc(icon+' '+text)+'</strong><div>'+esc(fmt(e.at))+' · '+esc(doorLabel(e))+'</div>'+(e.reason?'<small>'+esc(e.reason)+'</small>':'')+'</div>';}).join(""):'<p>Keine gespeicherten Ereignisse zu diesem Chip.</p>');
  }
  function renderChipHistory(chip){
    const editor=document.getElementById("chipEditor");if(!editor)return;
    let box=document.getElementById("chipAccessHistory");
    if(!box){box=document.createElement("section");box.id="chipAccessHistory";editor.appendChild(box);}
    box.innerHTML=historyMarkup(chip);
  }
  function openEvent(event){
    if(!event)return;
    const chip=resolveChip(event);
    if(chip && typeof window.openEditor==="function"){window.openEditor(chip.internalChipNo);return;}
    // Ohne Stammsatz nur Details zeigen; Klick legt keinen Chip an und ändert keine Rechte.
    let detail=document.getElementById("accessMissingChip");
    if(!detail){detail=document.createElement("dialog");detail.id="accessMissingChip";document.body.appendChild(detail);}
    detail.innerHTML='<h2>Schlüssel nicht in der aktuellen Chipliste</h2><p>Chip '+esc(event.internalChipNo||"—")+' · ID '+esc(event.hardwareId||"—")+'</p><p>Zu diesem Ereignis gibt es derzeit keinen passenden Stammsatz zum Bearbeiten.</p>'+historyMarkup(event)+'<button type="button">Schließen</button>';
    detail.querySelector("button").onclick=()=>detail.close();
    detail.showModal();
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
    section.innerHTML=`<div class="toolbar access-filterbar"><button data-access-filter="all" class="active">Alle</button><button data-access-filter="allowed">Erlaubt</button><button data-access-filter="denied">Abgewiesen</button><button data-access-filter="unknown">Unbekannt</button><button id="accessChipFilter" class="hidden"></button><button id="accessEventsRefresh">↻ Aktualisieren</button></div><p class="access-meta">„Erlaubt“ und „Abgewiesen“ zeigen nur ausdrücklich bestätigte Ergebnisse. „Unbekannt“ umfasst noch unbenannte Chips. Aktualisieren lädt gespeicherte Daten.</p><div id="accessEventsList" class="history"></div>`;
    history.parentNode.insertBefore(section,history);

    const style=document.createElement("style");
    style.textContent=`
      .access-filterbar button.active{background:#173d2a;color:#fff;border-color:#173d2a}
      .access-event-row{padding:12px 0;border-bottom:1px solid #ece9e0}.access-event-row:last-child{border-bottom:0}
      .access-event-link{display:block;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid #ece9e0;border-radius:0;color:inherit;font:inherit;cursor:pointer}.access-event-link:hover,.access-event-link:focus-visible{background:#edf4ee;outline:2px solid #53755b}.access-open{display:block;font-size:12px;color:#244c36;margin-top:7px}#chipAccessHistory{margin:16px;padding:12px;border-top:1px solid #ddd;max-height:35vh;overflow:auto}#accessMissingChip{max-width:650px;width:calc(100vw - 48px);max-height:80vh;overflow:auto;border:1px solid #ddd;border-radius:16px;padding:20px}
      .access-main{display:flex;gap:10px;justify-content:space-between;align-items:center}.access-main span{font-size:12px;color:#5f665f}
      .access-person{font-weight:850;margin-top:3px}.access-meta,.access-reason{font-size:11px;color:#777;margin-top:3px}.access-reason{color:#8b4c45}
      .thead,.chiprow{grid-template-columns:minmax(230px,1.25fr) 80px 125px minmax(135px,.7fr) minmax(210px,1fr) minmax(200px,.9fr) 105px}
      .last-access-btn{border:0;background:transparent;padding:0;text-align:left;font-size:11px;font-weight:850;color:#244c36;cursor:pointer;line-height:1.25}
      .last-access-btn span{display:block;color:#777;font-weight:600;margin-top:3px}.last-access-none{font-size:11px;color:#999}
      @media(max-width:1000px){.chiprow{grid-template-columns:1fr 1fr}.chiprow>div:first-child{grid-column:1/-1}}
    `;
    document.head.appendChild(style);

    const originalEditor=window.openEditor;
    if(typeof originalEditor==="function")window.openEditor=function(id){
      originalEditor(id);
      historyChip=chips().find(c=>String(c.internalChipNo)===String(id))||null;
      if(historyChip){renderChipHistory(historyChip);loadEvents();}
    };
    const originalClose=window.closeEditor;
    if(typeof originalClose==="function")window.closeEditor=function(){historyChip=null;return originalClose();};
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
