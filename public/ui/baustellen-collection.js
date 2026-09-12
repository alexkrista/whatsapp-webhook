"use strict";

(function(){
  const VERSION="2026-09-12-collection-1";
  const token=new URLSearchParams(location.search).get("token")||"";
  let jobs=[];
  const num=value=>{const n=Number(value);return Number.isFinite(n)?n:0};
  const esc=value=>String(value??"").replace(/[&<>\"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char]));
  const hours=value=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:1}).format(num(value))+" h";
  const money=value=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(num(value));
  const tokenUrl=path=>{const url=new URL(path,location.origin);if(token)url.searchParams.set("token",token);return url.pathname+url.search+url.hash};
  async function api(path,options={}){const response=await fetch(tokenUrl(path),options),text=await response.text();let data;try{data=JSON.parse(text)}catch{}if(!response.ok||data?.ok===false)throw new Error(data?.error||text||response.statusText);return data}
  const currentId=()=>decodeURIComponent(location.hash.slice(1));
  const byId=id=>jobs.find(job=>String(job.jobId)===String(id));
  function openJob(id){const url=new URL(location.href);url.hash=encodeURIComponent(String(id));location.href=url.pathname+url.search+url.hash;location.reload()}

  function installCss(){if(document.getElementById("collectionCss"))return;const style=document.createElement("style");style.id="collectionCss";style.textContent=`
    .collection-badge{display:inline-flex;margin-left:8px;padding:3px 7px;border-radius:999px;background:#e9f1f7;color:#315f80;font-size:10px;font-weight:900;vertical-align:middle}.collection-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:10px}.collection-kpi{border:1px solid #d9ded9;border-radius:14px;background:#f8fbf8;padding:14px}.collection-kpi span{display:block;color:#687069;font-size:10px;font-weight:850;text-transform:uppercase}.collection-kpi strong{display:block;margin-top:5px;font-size:22px}.collection-list{display:grid;gap:8px}.collection-row{display:grid;grid-template-columns:90px minmax(220px,1fr) 110px 110px 95px auto;gap:10px;align-items:center;border:1px solid #e1ddd4;border-radius:12px;padding:11px;background:#fbfaf6}.collection-row.main{border-color:#86ae91;background:#f0f7f1}.collection-row small{display:block;color:#707670;margin-top:3px}.collection-row button{border:1px solid #aeb9b0;border-radius:8px;background:#fff;padding:7px 9px;font-weight:800;cursor:pointer}.collection-row .remove{color:#93413a;border-color:#dab7b3}.collection-note{margin-top:10px;color:#707670;font-size:11px}.collection-parent{margin:0 0 12px;padding:10px 12px;border:1px solid #b8cfbe;border-radius:11px;background:#eef6ef}.collection-parent button{margin-left:8px;border:1px solid #79a085;border-radius:8px;background:#fff;padding:6px 9px;font-weight:850;cursor:pointer}@media(max-width:850px){.collection-grid{grid-template-columns:1fr 1fr}.collection-row{grid-template-columns:70px 1fr auto}.collection-row>:nth-child(3),.collection-row>:nth-child(4),.collection-row>:nth-child(5){display:none}}
  `;document.head.appendChild(style)}

  function memberRows(job){const ids=job?.collectionSummary?.jobIds||[job?.jobId,...(job?.collectionMemberJobIds||[])];return [...new Set(ids.map(String))].map(byId).filter(Boolean)}
  function liveHours(job){const summary=window.BaustellenLiveHours?.summary?.(job.jobId);return num(summary?.total||job?.collectionSummary?.actualHours||job?.calculation?.actualHours)}
  function summary(job){const all=memberRows(job),server=job.collectionSummary||{},stats=server.totalStats||{};return {all,hours:liveHours(job),contract:num(server.contractAmount),photos:num(stats.images),materialPositions:num(server.materialPositions),materialValue:num(server.materialValue),regieAmount:num(server.regieAmount)}}

  function renderPanel(job,panel){
    const s=summary(job),rows=s.all.map((entry,index)=>{const ownHours=num(entry.calculation?.actualHours),amount=num(entry.contractAmount||entry.calculation?.contractAmount),photos=num(entry.totalStats?.images),materials=num(entry.materialSummary?.positions);return `<div class="collection-row ${index===0?'main':''}"><strong>#${esc(entry.jobId)}</strong><div><strong>${esc(entry.name||"Ohne Bezeichnung")}</strong><small>${index===0?'Hauptakte · gemeinsame Sicht':'vollständige Einzelakte'}</small></div><span>${hours(ownHours)}</span><span>${money(amount)}</span><span>${photos} Fotos · ${materials} Mat.</span><div><button type="button" data-collection-open="${esc(entry.jobId)}">Öffnen</button>${index?` <button type="button" class="remove" data-collection-remove="${esc(entry.jobId)}">Lösen</button>`:""}</div></div>`}).join("");
    panel.innerHTML=`<div class="bk-grid"><div class="bk-card bk-wide"><div class="bk-section-title"><div><h3>Sammelakte · gemeinsame Summen</h3><div class="bk-note">Die Einzelakten bleiben vollständig und getrennt. Hier wird nur gemeinsam ausgewertet.</div></div><span class="bk-source">${s.all.length} Einzelakten</span></div><div class="collection-grid"><div class="collection-kpi"><span>Iststunden gesamt</span><strong data-collection-hours>${hours(s.hours)}</strong></div><div class="collection-kpi"><span>Auftragsvolumen</span><strong>${money(s.contract)}</strong></div><div class="collection-kpi"><span>Fotos gesamt</span><strong>${s.photos}</strong></div><div class="collection-kpi"><span>Material</span><strong>${s.materialPositions} Pos.</strong><small>${money(s.materialValue)} erfasster Materialwert</small></div></div><div class="collection-grid"><div class="collection-kpi"><span>Regie gesamt</span><strong>${money(s.regieAmount)}</strong></div></div></div><div class="bk-card bk-wide"><div class="bk-section-title"><h3>Einzelakten</h3><button type="button" id="collectionDissolve" class="remove">Sammelakte auflösen</button></div><div class="collection-list">${rows}</div><div class="collection-note">Auflösen entfernt nur die gemeinsame Zuordnung. Keine Akte, kein Foto und kein Dokument wird gelöscht.</div></div></div>`;
    panel.querySelectorAll("[data-collection-open]").forEach(button=>button.onclick=()=>openJob(button.dataset.collectionOpen));
    panel.querySelectorAll("[data-collection-remove]").forEach(button=>button.onclick=()=>removeMember(job,button.dataset.collectionRemove));
    panel.querySelector("#collectionDissolve")?.addEventListener("click",()=>saveMembers(job,[]));
  }

  async function saveMembers(job,memberJobIds){
    const action=memberJobIds.length?"Diese Einzelakte aus der Sammelakte lösen?":"Sammelakte auflösen? Alle Einzelakten bleiben erhalten.";if(!confirm(action))return;
    const kept=new Set([String(job.jobId),...memberJobIds.map(String)]),keptProjects=new Set();for(const id of kept){const entry=byId(id);if(entry?.wwProjectNumber)keptProjects.add(String(entry.wwProjectNumber));if(entry?.wwProjectIndex)keptProjects.add(`i:${Number(entry.wwProjectIndex)}`)}const links=memberJobIds.length?(job.wwProjectLinks||[]).filter(link=>keptProjects.has(String(link.projectNumber||""))||keptProjects.has(`i:${Number(link.projectIndex||0)}`)):[];
    try{await api(`/admin/api/job/${encodeURIComponent(job.jobId)}/collection`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({memberJobIds,wwProjectLinks:links})});location.reload()}catch(error){alert("Nicht gespeichert: "+error.message)}
  }
  function removeMember(job,memberId){saveMembers(job,(job.collectionMemberJobIds||[]).filter(id=>String(id)!==String(memberId)))}

  function render(){
    const id=currentId(),job=byId(id),tabs=document.querySelector(".bk-tabs");if(!job||!tabs)return;
    document.querySelectorAll(".collection-badge").forEach(el=>el.remove());document.querySelector("[data-bk-tab='collection']")?.remove();document.querySelector("[data-bk-panel='collection']")?.remove();document.querySelector(".collection-parent")?.remove();
    if(job.collectionSummary?.count>1){
      document.getElementById("detailNumber")?.insertAdjacentHTML("beforeend",`<span class="collection-badge">SAMMELAKTE · ${job.collectionSummary.count}</span>`);
      const button=document.createElement("button");button.type="button";button.dataset.bkTab="collection";button.textContent=`Einzelakten (${job.collectionSummary.count})`;tabs.appendChild(button);const panel=document.createElement("section");panel.className="bk-panel";panel.dataset.bkPanel="collection";panel.innerHTML='<div class="bk-loading">Sammelakte wird geladen …</div>';tabs.parentElement.appendChild(panel);button.onclick=()=>{window.BaustellenKnowledgeHub?.tab?.("collection");renderPanel(job,panel)};renderPanel(job,panel);
    }else if((job.collectionParentJobIds||[]).length){
      const parent=byId(job.collectionParentJobIds[0]);if(parent){const note=document.createElement("div");note.className="collection-parent";note.innerHTML=`Diese Einzelakte gehört zur Sammelakte <strong>#${esc(parent.jobId)} · ${esc(parent.name)}</strong><button type="button">Sammelakte öffnen</button>`;document.querySelector("#bkHub")?.prepend(note);note.querySelector("button").onclick=()=>openJob(parent.jobId)}
    }
    document.querySelectorAll(".job-row[data-job]").forEach(row=>{const item=byId(row.dataset.job),name=row.querySelector(".job-name");if(item?.collectionSummary?.count>1&&name&&!name.querySelector(".collection-badge"))name.insertAdjacentHTML("beforeend",` <span class="collection-badge">${item.collectionSummary.count} Akten</span>`)});
  }

  async function refresh(){try{const data=await api("/admin/api/jobs");jobs=data.jobs||[];render()}catch(error){console.warn("Sammelakte",error)}}
  function install(){installCss();let tries=0;const wait=setInterval(()=>{if(document.querySelector(".bk-tabs")){clearInterval(wait);refresh()}else if(++tries>80)clearInterval(wait)},100);window.addEventListener("hashchange",()=>setTimeout(refresh,180));window.addEventListener("krista:live-hours-updated",()=>{const job=byId(currentId()),el=document.querySelector("[data-collection-hours]");if(job&&el)el.textContent=hours(liveHours(job))})}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
  window.BaustellenCollections={version:VERSION,refresh};
})();
