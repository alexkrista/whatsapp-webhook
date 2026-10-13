"use strict";
(function(){
  if(!/\/kristine\/?$/.test(location.pathname))return;
  const style=document.createElement("style");
  style.textContent=".portal-activity-row{display:block;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid #ddd;padding:9px 12px;cursor:pointer;color:inherit;font:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.portal-activity-new{font-weight:750}.portal-activity-dialog{border:1px solid #aaa;border-radius:14px;max-width:min(760px,94vw);max-height:85vh;padding:20px}.portal-activity-dialog button{cursor:pointer}.portal-activity-history{max-height:60vh;overflow:auto}.portal-activity-person{border-bottom:1px solid #ddd;padding:10px 0}.portal-activity-person summary{cursor:pointer;line-height:1.5}.portal-activity-person summary small{display:block;color:#666}.portal-activity-movement{padding:6px 12px;overflow-wrap:anywhere;font-size:14px}.portal-activity-visit{margin:12px 0 4px;padding:7px 12px;background:#f2f4f2;font-weight:650}";
  document.head.append(style);
  let entries=[];
  const params=url=>{const u=new URL(url,location.origin),token=new URLSearchParams(location.search).get("token");if(token)u.searchParams.set("token",token);return u.pathname+u.search};
  const request=async(url,init)=>{const r=await fetch(params(url),{credentials:"same-origin",cache:"no-store",...init});if(!r.ok)throw Error("Portalaktivitäten nicht abrufbar");return r.json()};
  const label=e=>new Date(e.at).toLocaleString("de-AT",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})+" · "+e.customer+" · "+e.jobId+" · "+e.action+(e.detail?" "+e.detail:"");
  const dialog=document.createElement("dialog");dialog.className="portal-activity-dialog";
  dialog.innerHTML='<h3>Kundenportal-Protokoll</h3><div class="portal-activity-history"></div><p><button type="button">Schließen</button></p>';
  dialog.querySelector("button").onclick=()=>dialog.close();document.body.append(dialog);
  const stamp=at=>new Date(at).toLocaleString("de-AT",{timeZone:"Europe/Vienna",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
  function people(){
    const groups=new Map();
    for(const entry of [...entries].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))){
      const key=entry.customer||"Unbekannter Besucher";
      if(!groups.has(key))groups.set(key,{customer:key,entries:[],visits:[]});
      const person=groups.get(key);let visit=person.visits.at(-1);
      if(!visit||Date.parse(entry.at)-Date.parse(visit.end)>30*60000){visit={start:entry.at,end:entry.at,entries:[]};person.visits.push(visit);}
      visit.end=entry.at;visit.entries.push(entry);person.entries.push(entry);
    }
    return [...groups.values()].sort((a,b)=>Date.parse(b.entries.at(-1).at)-Date.parse(a.entries.at(-1).at));
  }
  const summary=person=>person.customer+" · Beginn "+stamp(person.visits.at(-1).start)+" · "+person.visits.length+" Besuch"+(person.visits.length===1?"":"e")+" · "+person.entries.filter(e=>!e.read).length+" neu";
  async function markRead(person){
    const ids=person.entries.filter(e=>!e.read).map(e=>e.id);
    if(!ids.length)return;
    try{await request("/admin/api/customer-portal/activity/read",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids})});
      const known=new Set(ids);entries.forEach(e=>{if(known.has(e.id))e.read=true});render();
    }catch{ /* Keep unread entries visible if acknowledgement fails. */ }
  }
  function personDetails(person,open=false){
    const block=document.createElement("details");block.className="portal-activity-person";
    const head=document.createElement("summary");head.textContent=summary(person);
    const hint=document.createElement("small");hint.textContent=[...new Set(person.entries.map(e=>e.jobId))].join(", ")+" · "+person.entries.length+" Bewegungen";head.append(hint);block.append(head);
    for(const visit of [...person.visits].reverse()){
      const title=document.createElement("div");title.className="portal-activity-visit";title.textContent="Beginn "+stamp(visit.start)+" · letzte Bewegung "+stamp(visit.end);block.append(title);
      for(const entry of visit.entries){const line=document.createElement("div");line.className="portal-activity-movement";line.textContent=stamp(entry.at)+" · "+entry.jobId+" · "+entry.action+(entry.detail?" · "+entry.detail:"");block.append(line);}
    }
    block.addEventListener("toggle",()=>{if(block.open)void markRead(person)});block.open=open;return block;
  }
  function openHistory(customer){
    const wrap=dialog.querySelector(".portal-activity-history");wrap.replaceChildren();
    for(const person of people())wrap.append(personDetails(person,person.customer===customer));
    dialog.showModal();
  }
  function render(){
    const taskList=document.getElementById("taskList");if(!taskList)return;
    let section=document.getElementById("portalActivityTasks");
    if(!section){section=document.createElement("details");section.id="portalActivityTasks";section.className="krista-task-group";section.open=true;taskList.parentElement.insertBefore(section,taskList);}
    const unread=entries.filter(e=>!e.read),groups=people();
    section.replaceChildren();
    const head=document.createElement("summary");head.textContent="👁 Kundenportal-Besuche · "+groups.length+" Personen · "+unread.length+" neu";section.append(head);
    const body=document.createElement("div");section.append(body);
    for(const person of groups){const row=document.createElement("button");row.className="portal-activity-row"+(person.entries.some(e=>!e.read)?" portal-activity-new":"");row.textContent=summary(person);row.onclick=()=>openHistory(person.customer);body.append(row);}
    if(!groups.length){const row=document.createElement("button");row.className="portal-activity-row";row.textContent="Noch keine Kundenportal-Besuche";row.onclick=()=>openHistory();body.append(row);}
  }
  async function refresh(){try{const data=await request("/admin/api/customer-portal/activity");entries=data.items||[];render();}catch{}}
  const observer=new MutationObserver(()=>{if(document.getElementById("taskList"))render()});
  observer.observe(document.body,{childList:true,subtree:false});
  refresh();setInterval(refresh,30000);
})();
