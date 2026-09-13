"use strict";

(function(){
  const VERSION="2026-09-13-collection-3";
  const token=new URLSearchParams(location.search).get("token")||"";
  let jobs=[];
  let jobsById=new Map(),groupsByJobId=new Map(),refreshSerial=0;
  const num=value=>{const n=Number(value);return Number.isFinite(n)?n:0};
  const esc=value=>String(value??"").replace(/[&<>\"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char]));
  const hours=value=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:1}).format(num(value))+" h";
  const money=value=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(num(value));
  const tokenUrl=path=>{const url=new URL(path,location.origin);if(token)url.searchParams.set("token",token);return url.pathname+url.search+url.hash};
  async function api(path,options={}){const response=await fetch(tokenUrl(path),options),text=await response.text();let data;try{data=JSON.parse(text)}catch{}if(!response.ok||data?.ok===false)throw new Error(data?.error||text||response.statusText);return data}
  const currentId=()=>decodeURIComponent(location.hash.slice(1));
  const byId=id=>jobsById.get(String(id));
  function jobUrl(id){const url=new URL(location.href);url.hash=encodeURIComponent(String(id));return url.pathname+url.search+url.hash}
  function openJob(id){if(String(id)===currentId())return;location.href=jobUrl(id);location.reload()}

  function installCss(){if(document.getElementById("collectionCss"))return;const style=document.createElement("style");style.id="collectionCss";style.textContent=`
    .collection-badge{display:inline-flex;margin-left:8px;padding:3px 7px;border-radius:999px;background:#e9f1f7;color:#315f80;font-size:10px;font-weight:900;vertical-align:middle}.collection-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:10px}.collection-kpi{border:1px solid #d9ded9;border-radius:14px;background:#f8fbf8;padding:14px}.collection-kpi span{display:block;color:#687069;font-size:10px;font-weight:850;text-transform:uppercase}.collection-kpi strong{display:block;margin-top:5px;font-size:22px}.collection-list{display:grid;gap:8px}.collection-row{display:grid;grid-template-columns:90px minmax(220px,1fr) 110px 110px 95px auto;gap:10px;align-items:center;border:1px solid #e1ddd4;border-radius:12px;padding:11px;background:#fbfaf6}.collection-row.main{border-color:#86ae91;background:#f0f7f1}.collection-row small{display:block;color:#707670;margin-top:3px}.collection-row button{border:1px solid #aeb9b0;border-radius:8px;background:#fff;padding:7px 9px;font-weight:800;cursor:pointer}.collection-row .remove{color:#93413a;border-color:#dab7b3}.collection-note{margin-top:10px;color:#707670;font-size:11px}.collection-parent{margin:0 0 12px;padding:10px 12px;border:1px solid #b8cfbe;border-radius:11px;background:#eef6ef}.collection-parent button{margin-left:8px;border:1px solid #79a085;border-radius:8px;background:#fff;padding:6px 9px;font-weight:850;cursor:pointer}@media(max-width:850px){.collection-grid{grid-template-columns:1fr 1fr}.collection-row{grid-template-columns:70px 1fr auto}.collection-row>:nth-child(3),.collection-row>:nth-child(4),.collection-row>:nth-child(5){display:none}}
  `;document.head.appendChild(style)}

  function memberRows(job){
    const ids=[job?.jobId,...(job?.collectionSummary?.jobIds||[]),...(job?.collectionMemberJobIds||[])];
    return [...new Set(ids.filter(id=>id!==undefined&&id!==null&&String(id)!=="").map(String))].map(byId).filter(Boolean);
  }
  function setJobs(rows){
    jobs=Array.isArray(rows)?rows.filter(job=>job?.jobId!==undefined&&job?.jobId!==null):[];
    jobsById=new Map(jobs.map(job=>[String(job.jobId),job]));
    groupsByJobId=new Map();
    for(const head of jobs){
      const members=memberRows(head);if(members.length<2)continue;
      const group={head,members};
      for(const member of members){
        const id=String(member.jobId);
        if(!groupsByJobId.has(id))groupsByJobId.set(id,[]);
        groupsByJobId.get(id).push(group);
      }
    }
  }
  const groupsFor=id=>groupsByJobId.get(String(id))||[];
  const groupCount=groups=>new Set(groups.flatMap(group=>group.members.map(job=>String(job.jobId)))).size;
  const groupLabel=groups=>`Vereint · ${groupCount(groups)} Baustellen`;

  function installUnionCss(){
    if(document.getElementById("collectionUnionCss"))return;
    const style=document.createElement("style");style.id="collectionUnionCss";
    style.textContent=`
      .job-name .collection-badge{display:flex;width:max-content;max-width:100%;margin:5px 0 0;white-space:normal}
      .collection-union{max-width:1480px;margin:0 auto;padding:0 22px 12px}
      .collection-union>summary{display:flex;align-items:center;gap:7px;width:fit-content;max-width:100%;min-height:36px;padding:7px 11px;border:1px solid #a9cbb3;border-radius:999px;background:#e9f4ec;color:#235e38;font:800 12px/1.4 system-ui;cursor:pointer;list-style:none}
      .collection-union>summary::-webkit-details-marker{display:none}
      .collection-union>summary::after{content:"⌄";margin-left:4px;font-size:17px;line-height:1}
      .collection-union[open]>summary::after{transform:rotate(180deg)}
      .collection-union>summary:focus-visible,.collection-member:focus-visible{outline:3px solid #619dff;outline-offset:3px}
      .collection-union-content{max-width:860px;max-height:40vh;overflow:auto;margin-top:10px;padding:12px;border:1px solid #b8cfbe;border-radius:12px;background:#fffefa;color:#202520;box-shadow:0 6px 16px #0002}
      .collection-union-note{margin:0 0 9px;color:#656b65;font-size:12px;line-height:1.4}
      .collection-union-group-title{margin:12px 0 7px;font-size:13px}
      .collection-members{display:grid;gap:6px;list-style:none;margin:0;padding:0}
      .collection-member{display:grid;grid-template-columns:minmax(70px,auto) minmax(0,1fr) auto;align-items:center;gap:10px;min-height:44px;padding:9px 11px;border:1px solid #e1ddd4;border-radius:9px;background:#fbfaf6;color:#252925;text-decoration:none;font:500 13px/1.4 system-ui;overflow-wrap:anywhere}
      .collection-member:hover{border-color:#79a085;background:#f0f7f1}
      .collection-member-number{color:#235e38;text-decoration:underline;text-underline-offset:3px}
      .collection-member[aria-current="page"]{border-color:#79a085;background:#e9f4ec;font-weight:900}
      .collection-member-state{color:#235e38;font-size:11px;font-weight:800}
      @media(max-width:760px){.collection-union{padding:0 10px 10px}.collection-union-content{padding:8px}.collection-member{grid-template-columns:minmax(62px,auto) minmax(0,1fr);gap:5px 8px}.collection-member-state{grid-column:2}}
    `;document.head.appendChild(style);
  }
  function groupMarkup(groups,id){
    return groups.map(group=>`${groups.length>1?`<h3 class="collection-union-group-title">Sammelmappe #${esc(group.head.jobId)} · ${esc(group.head.name||"Ohne Bezeichnung")}</h3>`:""}<ul class="collection-members">${group.members.map(entry=>{
      const current=String(entry.jobId)===String(id);
      return `<li><a class="collection-member" href="${esc(jobUrl(entry.jobId))}" data-collection-link="${esc(entry.jobId)}"${current?' aria-current="page"':""}><span class="collection-member-number">#${esc(entry.jobId)}</span><span class="collection-member-name">${esc(entry.name||"Ohne Bezeichnung")}</span>${current?'<span class="collection-member-state">Aktuell geöffnet</span>':""}</a></li>`;
    }).join("")}</ul>`).join("");
  }
  function renderUnion(job){
    const previous=document.getElementById("collectionUnion"),id=String(job?.jobId||""),groups=groupsFor(id);
    const wasOpen=previous?.dataset.jobId===id&&previous.open;
    previous?.remove();
    const header=document.querySelector("#detail .detail-top");if(!header||!groups.length)return;
    const details=document.createElement("details");details.id="collectionUnion";details.className="collection-union";details.dataset.jobId=id;details.open=!!wasOpen;
    details.innerHTML=`<summary><span aria-hidden="true">📁</span><span>Sammelmappe · ${groupLabel(groups)}</span></summary><nav class="collection-union-content" aria-label="Vereinte Baustellen"><p class="collection-union-note">Diese Baustellen gehören zur selben Sammelmappe. Jede Einzelakte ist unten erreichbar.</p>${groupMarkup(groups,id)}</nav>`;
    details.querySelectorAll("[data-collection-link]").forEach(link=>link.addEventListener("click",event=>{
      if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
      event.preventDefault();openJob(link.dataset.collectionLink);
    }));
    header.appendChild(details);
  }
  function renderBadges(){
    document.querySelectorAll(".job-row[data-job]").forEach(row=>{
      const groups=groupsFor(row.dataset.job),name=row.querySelector(".job-name"),badge=name?.querySelector(".collection-badge");
      if(!groups.length){badge?.remove();return;}
      if(!name)return;
      const label=`📁 Sammelmappe · ${groupLabel(groups)}`;
      if(badge){if(badge.textContent!==label)badge.textContent=label;return;}
      const el=document.createElement("span");el.className="collection-badge";el.textContent=label;name.appendChild(el);
    });
  }
  function liveHours(job){const summary=window.BaustellenLiveHours?.summary?.(job.jobId);return num(summary?.total||job?.collectionSummary?.actualHours||job?.calculation?.actualHours)}
  function summary(job){const all=memberRows(job),server=job.collectionSummary||{},stats=server.totalStats||{};return {all,hours:liveHours(job),contract:num(server.contractAmount),photos:num(stats.images),materialPositions:num(server.materialPositions),materialValue:num(server.materialValue),regieAmount:num(server.regieAmount)}}

  function renderPanel(job,panel){
    const s=summary(job),rows=s.all.map((entry,index)=>{const ownHours=num(entry.calculation?.actualHours),amount=num(entry.contractAmount||entry.calculation?.contractAmount),photos=num(entry.totalStats?.images),materials=num(entry.materialSummary?.positions);return `<div class="collection-row ${index===0?'main':''}"><strong>#${esc(entry.jobId)}</strong><div><strong>${esc(entry.name||"Ohne Bezeichnung")}</strong><small>${index===0?'Hauptakte · gemeinsame Sicht':'vollständige Einzelakte'}</small></div><span>${hours(ownHours)}</span><span>${money(amount)}</span><span><span data-collection-photo-count="${esc(entry.jobId)}">…</span> Fotos · ${materials} Mat.</span><div><button type="button" data-collection-open="${esc(entry.jobId)}">Öffnen</button>${index?` <button type="button" class="remove" data-collection-remove="${esc(entry.jobId)}">Lösen</button>`:""}</div></div>`}).join("");
    panel.innerHTML=`<div class="bk-grid"><div class="bk-card bk-wide"><div class="bk-section-title"><div><h3>Sammelmappe · gemeinsame Summen</h3><div class="bk-note">Die Einzelakten bleiben vollständig und getrennt. Hier wird nur gemeinsam ausgewertet.</div></div><span class="bk-source">${s.all.length} Einzelakten</span></div><div class="collection-grid"><div class="collection-kpi"><span>Iststunden gesamt</span><strong data-collection-hours>${hours(s.hours)}</strong></div><div class="collection-kpi"><span>Auftragsvolumen</span><strong>${money(s.contract)}</strong></div><div class="collection-kpi"><span>Fotos gesamt</span><strong data-collection-photo-total>…</strong></div><div class="collection-kpi"><span>Material</span><strong>${s.materialPositions} Pos.</strong><small>${money(s.materialValue)} erfasster Materialwert</small></div></div><div class="collection-grid"><div class="collection-kpi"><span>Regie gesamt</span><strong>${money(s.regieAmount)}</strong></div></div></div><div class="bk-card bk-wide"><div class="bk-section-title"><h3>Einzelakten</h3><button type="button" id="collectionDissolve" class="remove">Sammelmappe auflösen</button></div><div class="collection-list">${rows}</div><div class="collection-note">Auflösen entfernt nur die gemeinsame Zuordnung. Keine Akte, kein Foto und kein Dokument wird gelöscht.</div></div></div>`;
    panel.querySelectorAll("[data-collection-open]").forEach(button=>button.onclick=()=>openJob(button.dataset.collectionOpen));
    panel.querySelectorAll("[data-collection-remove]").forEach(button=>button.onclick=()=>removeMember(job,button.dataset.collectionRemove));
    panel.querySelector("#collectionDissolve")?.addEventListener("click",()=>saveMembers(job,[]));
    Promise.all(s.all.map(async entry=>{
      const result=await api(`/admin/api/job/${encodeURIComponent(entry.jobId)}/media?scope=single`);
      return {id:String(entry.jobId),media:(result.media||[]).filter(item=>item.kind==="photo")};
    })).then(results=>{
      if(!panel.isConnected)return;
      const byId=new Map(results.map(result=>[result.id,result.media.length]));
      panel.querySelectorAll("[data-collection-photo-count]").forEach(el=>el.textContent=String(byId.get(el.dataset.collectionPhotoCount)||0));
      const total=panel.querySelector("[data-collection-photo-total]");
      if(total)total.textContent=String(new Set(results.flatMap(result=>result.media.map(item=>item.file))).size);
    }).catch(()=>{
      if(!panel.isConnected)return;
      panel.querySelectorAll("[data-collection-photo-count],[data-collection-photo-total]").forEach(el=>el.textContent="–");
    });
  }

  async function saveMembers(job,memberJobIds){
    const action=memberJobIds.length?"Diese Einzelakte aus der Sammelmappe lösen?":"Sammelmappe auflösen? Alle Einzelakten bleiben erhalten.";if(!confirm(action))return;
    const kept=new Set([String(job.jobId),...memberJobIds.map(String)]),keptProjects=new Set();for(const id of kept){const entry=byId(id);if(entry?.wwProjectNumber)keptProjects.add(String(entry.wwProjectNumber));if(entry?.wwProjectIndex)keptProjects.add(`i:${Number(entry.wwProjectIndex)}`)}const links=memberJobIds.length?(job.wwProjectLinks||[]).filter(link=>keptProjects.has(String(link.projectNumber||""))||keptProjects.has(`i:${Number(link.projectIndex||0)}`)):[];
    try{await api(`/admin/api/job/${encodeURIComponent(job.jobId)}/collection`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({memberJobIds,wwProjectLinks:links})});location.reload()}catch(error){alert("Nicht gespeichert: "+error.message)}
  }
  function removeMember(job,memberId){saveMembers(job,(job.collectionMemberJobIds||[]).filter(id=>String(id)!==String(memberId)))}

  function render(){
    const id=currentId(),job=byId(id),tabs=document.querySelector(".bk-tabs");
    renderBadges();renderUnion(job);
    const oldTab=document.querySelector("[data-bk-tab='collection']"),oldPanel=document.querySelector("[data-bk-panel='collection']");
    const wasActive=oldTab?.classList.contains("active"),keepActive=wasActive&&oldPanel?.dataset.collectionJobId===id;
    oldTab?.remove();oldPanel?.remove();document.querySelector(".collection-parent")?.remove();
    const ownGroup=groupsFor(id).find(group=>String(group.head.jobId)===id);
    if(wasActive&&(!keepActive||!ownGroup))window.BaustellenKnowledgeHub?.tab?.("overview");
    if(job&&tabs&&ownGroup){
      const button=document.createElement("button");button.type="button";button.dataset.bkTab="collection";button.textContent=`Einzelakten (${ownGroup.members.length})`;tabs.appendChild(button);
      const panel=document.createElement("section");panel.className="bk-panel";panel.dataset.bkPanel="collection";panel.dataset.collectionJobId=id;tabs.parentElement.appendChild(panel);
      button.onclick=()=>{window.BaustellenKnowledgeHub?.tab?.("collection");renderPanel(job,panel)};renderPanel(job,panel);
      if(keepActive)window.BaustellenKnowledgeHub?.tab?.("collection");
    }
  }

  async function refresh(){const serial=++refreshSerial;try{const data=await api("/admin/api/jobs");if(serial!==refreshSerial)return;setJobs(data.jobs||[]);render()}catch(error){console.warn("Sammelmappe",error)}}
  function install(){
    installCss();installUnionCss();
    document.addEventListener("krista:baustellen-rendered",event=>{++refreshSerial;setJobs(event.detail?.jobs||[]);render()});
    document.addEventListener("krista:baustelle-opened",render);
    document.addEventListener("krista:baustelle-closed",render);
    refresh();
    // The badge does not depend on the asynchronously loaded knowledge hub.
    let tries=0;const wait=setInterval(()=>{if(document.querySelector(".bk-tabs")){clearInterval(wait);render()}else if(++tries>80)clearInterval(wait)},100);
    window.addEventListener("hashchange",()=>setTimeout(render,0));
    window.addEventListener("krista:live-hours-updated",()=>{const job=byId(currentId()),el=document.querySelector("[data-collection-hours]");if(job&&el)el.textContent=hours(liveHours(job))});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
  window.BaustellenCollections={version:VERSION,refresh};
})();
