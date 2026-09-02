"use strict";

(function(){
  const VERSION="2026-08-23-live-hours-1";
  const token=new URLSearchParams(location.search).get("token")||"";
  let jobs=[];
  let bootstrap={};
  let liveByJob=new Map();
  let peopleByJob=new Map();
  let timer=null;
  let patchQueued=false;

  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
  const hours=v=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:1}).format(num(v))+" h";
  const money=v=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(num(v));
  const tokenUrl=p=>{const u=new URL(p,location.origin);if(token)u.searchParams.set("token",token);return u.pathname+u.search+u.hash};
  async function api(p){const r=await fetch(tokenUrl(p));const t=await r.text();let d;try{d=JSON.parse(t)}catch{}if(!r.ok)throw new Error(d?.error||t||r.statusText);return d}

  function hmMinutes(v){const m=String(v||"").match(/^(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):null}
  function nowMinutes(){const d=new Date();return d.getHours()*60+d.getMinutes()+d.getSeconds()/60}
  function job(id){return jobs.find(j=>String(j.jobId)===String(id))||null}
  function calc(j){return j?.calculation||{}}
  function targetHours(j){return num(calc(j).calculatedHours)}
  function oldTotalHours(j){return num(calc(j).actualHours)}
  function oldOrderHours(j){const c=calc(j);const direct=Number(c.orderHours);return Number.isFinite(direct)?Math.max(0,direct):Math.max(0,oldTotalHours(j)-num(c.actualRegieHours))}

  function buildLiveMaps(){
    liveByJob=new Map();peopleByJob=new Map();
    const events=Array.isArray(bootstrap?.timeEvents)?bootstrap.timeEvents:[];
    const states=bootstrap?.states||{};
    const employees=new Map((bootstrap?.employees||[]).map(e=>[String(e.id||e.employeeId||""),e]));
    const groups=new Map();

    events.forEach((event,index)=>{
      const employeeId=String(event?.employeeId||"");
      const date=String(event?.date||"").slice(0,10);
      const minute=hmMinutes(event?.at);
      if(!employeeId||!date||minute===null)return;
      const key=employeeId+"|"+date;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({...event,_index:index,_minute:minute});
    });

    for(const [key,rows] of groups){
      rows.sort((a,b)=>a._minute-b._minute||String(a.createdAt||"").localeCompare(String(b.createdAt||""))||a._index-b._index);
      const [employeeId,date]=key.split("|");
      const state=states?.[employeeId]||{};
      for(let i=0;i<rows.length;i++){
        const row=rows[i];
        if(!["start","weiter"].includes(String(row.type||"").toLowerCase()))continue;
        const jobId=String(row.jobId||"").trim();
        if(!jobId)continue;
        const start=row._minute;
        const next=rows[i+1];
        let end=next?._minute??null;
        if(end===null&&date===String(bootstrap?.today||"")&&["working","pause","lunch"].includes(String(state?.mode||"")))end=nowMinutes();
        if(end===null||end<=start)continue;
        const duration=(end-start)/60;
        if(duration<=0||duration>18)continue;

        const current=liveByJob.get(jobId)||{totalHours:0,segments:0,days:new Set()};
        current.totalHours+=duration;current.segments++;current.days.add(date);liveByJob.set(jobId,current);

        if(!peopleByJob.has(jobId))peopleByJob.set(jobId,new Map());
        const people=peopleByJob.get(jobId);
        const employee=employees.get(employeeId)||{};
        const name=String(row.employeeName||employee.nickname||employee.name||employee.employeeName||employeeId);
        const person=people.get(employeeId)||{employeeId,name,hours:0,days:new Set()};
        person.hours+=duration;person.days.add(date);people.set(employeeId,person);
      }
    }
  }

  function liveOrderHours(j){
    if(!j)return 0;
    const live=num(liveByJob.get(String(j.jobId))?.totalHours);
    const regie=num(calc(j).actualRegieHours);
    return Math.max(oldOrderHours(j),Math.max(0,live-regie));
  }
  function openHours(j){
    const status=String(j?.status||"");
    const target=targetHours(j),actual=liveOrderHours(j);
    if(status==="Auftrag")return Math.max(0,target);
    if(status==="Laufend")return Math.max(0,target-actual);
    return 0;
  }

  function patchRows(){
    document.querySelectorAll(".job-row[data-job]").forEach(row=>{
      const j=job(row.dataset.job);if(!j)return;
      const actual=liveOrderHours(j),target=targetHours(j);
      const el=row.querySelector(".hours");
      if(el){el.textContent=`${hours(actual)} / ${hours(target)}`;el.classList.toggle("over",target>0&&actual>target)}
      const sub=row.querySelector(".job-sub");
      if(sub){const planned=(sub.textContent.match(/eingeplant\s+(.+)$/i)||[])[1]||"";sub.textContent=`${j.status||""} · ${hours(actual)} / ${hours(target)}${planned?" · eingeplant "+planned:""}`}
    });
  }

  function patchTopKpis(){
    const totalOpen=jobs.reduce((s,j)=>s+openHours(j),0);
    const cap=num(bootstrap?.company?.weeklyProductiveHours||bootstrap?.company?.weeklyCapacityHours)||312;
    const h=document.getElementById("kpiHours"),b=document.getElementById("kpiBacklog"),w=document.getElementById("kpiWeeks");
    if(h)h.textContent=hours(totalOpen);
    if(b)b.textContent=money(totalOpen*90);
    if(w)w.textContent=(totalOpen/cap).toLocaleString("de-AT",{maximumFractionDigits:1})+" Wochen";
  }

  function patchBaseDetail(id){
    const j=job(id);if(!j)return;
    const actual=liveOrderHours(j),target=targetHours(j),remaining=openHours(j),pct=target>0?actual/target*100:0;
    const dh=document.getElementById("detailHours"),dn=document.getElementById("detailHoursNote"),op=document.getElementById("detailOpen"),bar=document.getElementById("detailProgress"),note=document.getElementById("detailProgressNote");
    if(dh)dh.textContent=`${hours(actual)} / ${hours(target)}`;
    if(dn)dn.textContent=target>0?`${Math.round(pct)} % verbraucht · live aus KRISTINE`:"live aus KRISTINE · keine Sollstunden hinterlegt";
    if(op)op.textContent=hours(remaining);
    if(bar){bar.style.width=Math.min(100,Math.max(0,pct))+"%";bar.style.background=pct>100?"var(--red)":"var(--green)"}
    if(note)note.textContent=target>0?`${hours(actual)} von ${hours(target)} · ${Math.round(pct)} % · live gebucht`:"Noch keine Stundenkalkulation hinterlegt.";
    const info=document.getElementById("detailInfo");
    if(info){for(const label of info.querySelectorAll(".label")){const value=label.nextElementSibling;if(!value)continue;if(label.textContent.trim()==="Offene Stunden")value.textContent=hours(remaining);if(label.textContent.trim()==="Auftragsbestand")value.textContent=money(remaining*90)}}
  }

  function pulseItem(label){return [...document.querySelectorAll("#bcShell .bc-pulse-item")].find(el=>String(el.querySelector("span")?.textContent||"").trim()===label)||null}
  function radarButton(label){return [...document.querySelectorAll("#bcShell .bc-radar button")].find(el=>String(el.querySelector("span")?.textContent||"").includes(label))||null}
  function escapeHtml(v){return String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}

  function patchCockpit(id){
    const j=job(id),shell=document.getElementById("bcShell");if(!j||!shell)return;
    const actual=liveOrderHours(j),target=targetHours(j),remaining=Math.max(0,target-actual);
    const ist=pulseItem("Iststunden");if(ist){const strong=ist.querySelector("strong"),small=ist.querySelector("small");if(strong)strong.textContent=hours(actual);if(small)small.textContent=target?`${Math.round(actual/target*100)} % verbraucht · live`:"live aus KRISTINE"}
    const rest=pulseItem("Reststunden");if(rest){const strong=rest.querySelector("strong");if(strong)strong.textContent=hours(remaining)}
    const rb=radarButton("Stunden");if(rb){const strong=rb.querySelector("strong"),small=rb.querySelector("small"),dot=rb.querySelector(".bc-source-dot");if(strong)strong.textContent=hours(actual);if(small)small.textContent=actual>0?"live zugeordnet":"noch keine Buchung";if(dot)dot.classList.toggle("missing",actual<=0)}

    const card=[...shell.querySelectorAll(".bc-card")].find(c=>/Menschen\s*&\s*Baustellenwissen/i.test(c.querySelector("h3")?.textContent||""));
    const host=card?.querySelector(".bc-people-row");
    const people=[...(peopleByJob.get(String(id))?.values()||[])].sort((a,b)=>b.hours-a.hours);
    if(host&&people.length)host.innerHTML=people.slice(0,8).map(p=>`<div class="bc-person"><strong>${escapeHtml(p.name)}</strong><span>${hours(p.hours)}</span><small>${p.days.size} Tag(e) · live aus KRISTINE</small></div>`).join("");
  }

  function patchAll(){patchRows();patchTopKpis();const id=decodeURIComponent(location.hash.slice(1));if(id){patchBaseDetail(id);patchCockpit(id)}}
  function queuePatch(){if(patchQueued)return;patchQueued=true;setTimeout(()=>{patchQueued=false;patchAll()},80)}

  async function refresh(){
    try{const [j,b]=await Promise.all([api("/admin/api/jobs"),api("/kristine/api/bootstrap")]);jobs=j.jobs||[];bootstrap=b||{};buildLiveMaps();patchAll()}catch(e){console.warn("Baustellen Live-Stunden",e)}
  }

  function install(){
    if(!location.pathname.toLowerCase().includes("baustellen.html")&&!location.pathname.toLowerCase().includes("/kristine/baustellen"))return;
    const list=document.getElementById("jobList"),detail=document.getElementById("detail");
    if(list)new MutationObserver(queuePatch).observe(list,{subtree:true,childList:true});
    if(detail)new MutationObserver(queuePatch).observe(detail,{subtree:true,childList:true});
    window.addEventListener("hashchange",()=>setTimeout(refresh,120));
    document.addEventListener("click",e=>{const row=e.target.closest?.(".job-row[data-job]");if(row)setTimeout(queuePatch,250)},true);
    refresh();timer=setInterval(refresh,60000);window.addEventListener("beforeunload",()=>timer&&clearInterval(timer),{once:true});
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);else install();
  window.BaustellenLiveHours={version:VERSION,refresh};
})();
