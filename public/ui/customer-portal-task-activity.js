"use strict";
(function(){
  if(!/\/kristine\/?$/.test(location.pathname))return;
  const style=document.createElement("style");
  style.textContent=".portal-activity-row{display:block;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid #ddd;padding:9px 12px;cursor:pointer;color:inherit;font:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.portal-activity-new{font-weight:750}.portal-activity-dialog{border:1px solid #aaa;border-radius:14px;max-width:min(760px,94vw);max-height:85vh;padding:20px}.portal-activity-dialog button{cursor:pointer}.portal-activity-history{max-height:60vh;overflow:auto}";
  document.head.append(style);
  let entries=[];
  const params=url=>{const u=new URL(url,location.origin),token=new URLSearchParams(location.search).get("token");if(token)u.searchParams.set("token",token);return u.pathname+u.search};
  const request=async(url,init)=>{const r=await fetch(params(url),{credentials:"same-origin",cache:"no-store",...init});if(!r.ok)throw Error("Portalaktivitäten nicht abrufbar");return r.json()};
  const label=e=>new Date(e.at).toLocaleString("de-AT",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})+" · "+e.customer+" · "+e.jobId+" · "+e.action+(e.detail?" "+e.detail:"");
  const dialog=document.createElement("dialog");dialog.className="portal-activity-dialog";
  dialog.innerHTML='<h3>Kundenportal-Protokoll</h3><div class="portal-activity-history"></div><p><button type="button">Schließen</button></p>';
  dialog.querySelector("button").onclick=()=>dialog.close();document.body.append(dialog);
  async function openHistory(){
    const wrap=dialog.querySelector(".portal-activity-history");wrap.replaceChildren();
    for(const e of entries){
      const line=document.createElement("div");line.style.padding="7px 0";line.textContent=label(e);wrap.append(line);
    }
    dialog.showModal();
    const unread=entries.filter(e=>!e.read).map(e=>e.id);
    if(unread.length)await request("/admin/api/customer-portal/activity/read",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:unread})});
    await refresh();
  }
  function render(){
    const taskList=document.getElementById("taskList");if(!taskList)return;
    let section=document.getElementById("portalActivityTasks");
    if(!section){section=document.createElement("details");section.id="portalActivityTasks";section.className="krista-task-group";section.open=true;taskList.parentElement.insertBefore(section,taskList);}
    const unread=entries.filter(e=>!e.read);
    section.replaceChildren();
    const head=document.createElement("summary");head.textContent="👁 Kundenportal-Aktivitäten · "+unread.length+" neu";section.append(head);
    const body=document.createElement("div");section.append(body);
    for(const e of unread.slice(0,30)){const row=document.createElement("button");row.className="portal-activity-row portal-activity-new";row.textContent=label(e);row.onclick=openHistory;body.append(row);}
    if(!unread.length){const row=document.createElement("button");row.className="portal-activity-row";row.textContent="Protokoll öffnen · keine neuen Aktivitäten";row.onclick=openHistory;body.append(row);}
  }
  async function refresh(){try{const data=await request("/admin/api/customer-portal/activity");entries=data.items||[];render();}catch{}}
  const observer=new MutationObserver(()=>{if(document.getElementById("taskList"))render()});
  observer.observe(document.body,{childList:true,subtree:false});
  refresh();setInterval(refresh,30000);
})();
