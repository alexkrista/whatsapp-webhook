"use strict";

(function(){
  const VERSION="2026-09-03-live-hours-8";
  const LOCAL_BRAIN_HOURS="http://127.0.0.1:5051/api/outgoing/project-hours";
  const token=new URLSearchParams(location.search).get("token")||"";
  let jobs=[];
  let bootstrap={};
  let liveByJob=new Map();
  let peopleByJob=new Map();
  let wwByJob=new Map();
  const reconciliationDrafts=new Map();
  const wwErrors=new Map();
  let timer=null;
  let patchQueued=false;

  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
  const hours=v=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:1}).format(num(v))+" h";
  const money=v=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(num(v));
  const dateLabel=v=>{const s=String(v||"").slice(0,10),m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}.${m[2]}.${m[1]}`:(s||"–")};
  const nameKey=v=>String(v||"").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  const canonicalPersonName=v=>({"mandi-faes":"Manuel Faes","edi-mock":"Edmund Mock","cathrin-grabherr":"Anna Cathrin Grabherr","cathrin-anna-grabherr":"Anna Cathrin Grabherr"})[nameKey(v)]||String(v||"").trim();
  const finkNumber=(employee,row={})=>String(row?.finkzeitPersonnelNumber||row?.finkzeitPersonalNumber||row?.personalnummerFinkzeit||row?.personnelNumber||employee?.finkzeitPersonnelNumber||employee?.finkzeitPersonalNumber||employee?.personalnummerFinkzeit||employee?.personnelNumber||employee?.personalNumber||"").trim();
  const identity=(fink,name,fallback="")=>fink?`fink:${fink}`:nameKey(name)?`name:${nameKey(name)}`:`ma:${fallback||"unbekannt"}`;
  const tokenUrl=p=>{const u=new URL(p,location.origin);if(token)u.searchParams.set("token",token);return u.pathname+u.search+u.hash};
  async function api(p){const r=await fetch(tokenUrl(p));const t=await r.text();let d;try{d=JSON.parse(t)}catch{}if(!r.ok)throw new Error(d?.error||t||r.statusText);return d}
  async function apiWrite(p,body){const r=await fetch(tokenUrl(p),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const t=await r.text();let d;try{d=JSON.parse(t)}catch{}if(!r.ok)throw new Error(d?.error||t||r.statusText);return d}
  async function loadWwHours(jobId){
    if(!token)return null;
    const r=await fetch(LOCAL_BRAIN_HOURS,{method:"POST",headers:{Accept:"application/json","Content-Type":"application/json","X-Krista-Token":token},body:JSON.stringify({projectNumber:String(jobId)})});
    const t=await r.text();let d;try{d=JSON.parse(t)}catch{}if(!r.ok||!d?.ok)throw new Error(d?.error||t||r.statusText);
    const payload=d.hours||{},days=new Map((payload.days||[]).map(row=>[String(row.date||"").slice(0,10),num(row.hours)])),grouped=new Map();
    const sourceRows=(payload.rows||[]).length?payload.rows:(payload.days||[]).map(row=>({date:row.date,hours:row.hours,employeeName:"WinWorker gesamt"}));
    for(const row of sourceRows){const date=String(row.date||"").slice(0,10),fink=String(row.finkNumber||"").trim(),employeeName=String(row.employeeName||"WinWorker gesamt").trim(),personIdentity=identity(fink,employeeName,row.maIndex),key=`${date}|${personIdentity}`,current=grouped.get(key)||{key,date,identity:personIdentity,finkNumber:fink,maIndex:row.maIndex??null,employeeName,hours:0};current.hours+=num(row.hours??row.netHours);grouped.set(key,current)}
    const rows=[...grouped.values()].map(row=>({...row,hours:Math.max(0,row.hours-.25)})).sort((a,b)=>a.date.localeCompare(b.date)||a.employeeName.localeCompare(b.employeeName,"de")),netDays=new Map();for(const row of rows)netDays.set(row.date,num(netDays.get(row.date))+row.hours);
    return {found:!!payload.found,totalHours:rows.reduce((sum,row)=>sum+row.hours,0),days:netDays,rows,pauseDeductionHours:.25};
  }

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

        const current=liveByJob.get(jobId)||{totalHours:0,segments:0,days:new Map(),dayPeople:new Map()};
        current.totalHours+=duration;current.segments++;current.days.set(date,num(current.days.get(date))+duration);liveByJob.set(jobId,current);

        if(!peopleByJob.has(jobId))peopleByJob.set(jobId,new Map());
        const people=peopleByJob.get(jobId);
        const employee=employees.get(employeeId)||{};
        const name=String(row.employeeName||employee.nickname||employee.name||employee.employeeName||employeeId);
        const fink=finkNumber(employee,row),personIdentity=identity(fink,name,employeeId);
        const person=people.get(employeeId)||{employeeId,identity:personIdentity,finkNumber:fink,name,hours:0,days:new Set()};
        person.hours+=duration;person.days.add(date);people.set(employeeId,person);
        if(!current.dayPeople.has(date))current.dayPeople.set(date,new Map());
        const dayPeople=current.dayPeople.get(date),dayPerson=dayPeople.get(personIdentity)||{employeeId,identity:personIdentity,finkNumber:fink,name,hours:0};
        dayPerson.hours+=duration;dayPeople.set(personIdentity,dayPerson);
      }
    }
    for(const current of liveByJob.values()){
      current.days=new Map();current.totalHours=0;
      for(const [date,dayPeople] of current.dayPeople){let dayTotal=0;for(const person of dayPeople.values()){person.hours=Math.max(0,person.hours-.25);dayTotal+=person.hours}current.days.set(date,dayTotal);current.totalHours+=dayTotal}
    }
    for(const people of peopleByJob.values())for(const person of people.values())person.hours=Math.max(0,person.hours-.25*person.days.size);
  }

  function liveOrderHours(j){
    if(!j)return 0;
    const live=num(liveByJob.get(String(j.jobId))?.totalHours);
    const regie=num(calc(j).actualRegieHours);
    return Math.max(oldOrderHours(j),Math.max(0,live-regie));
  }
  function matchingKristinePerson(krDayPeople,wwRow){
    if(!krDayPeople)return null;
    if(krDayPeople.has(wwRow.identity))return krDayPeople.get(wwRow.identity);
    const wanted=nameKey(canonicalPersonName(wwRow.employeeName));return [...krDayPeople.values()].find(person=>(wwRow.finkNumber&&person.finkNumber===wwRow.finkNumber)||(wanted&&nameKey(canonicalPersonName(person.name))===wanted))||null;
  }
  function suggestedExclusions(ww,kr){
    const selected=new Set();for(const row of ww?.rows||[]){if(matchingKristinePerson(kr?.dayPeople?.get(row.date),row))selected.add(row.key)}return selected;
  }
  function selectedExclusions(j,ww,kr){
    const jobId=String(j?.jobId||"");
    if(reconciliationDrafts.has(jobId))return reconciliationDrafts.get(jobId);
    if(j?.hoursCutoverDate)return new Set((ww?.rows||[]).filter(row=>row.date>=String(j.hoursCutoverDate)).map(row=>row.key));
    if(j?.hoursOverlapResolvedAt)return new Set(Array.isArray(j.hoursOverlapExcludedWwKeys)?j.hoursOverlapExcludedWwKeys:[]);
    return suggestedExclusions(ww,kr);
  }
  function fusion(j){
    const jobId=String(j?.jobId||""),ww=wwByJob.get(jobId),kr=liveByJob.get(jobId),kristineTotal=liveOrderHours(j);
    if(!ww?.found)return {total:kristineTotal,ww:0,kristine:kristineTotal,overlaps:[],excluded:new Set(),source:"KRISTINE"};
    const krDays=kr?.days||new Map(),rawKr=num(kr?.totalHours),scale=rawKr>0?kristineTotal/rawKr:0;
    const overlaps=[...ww.days.keys()].filter(day=>krDays.has(day)).sort();
    const excluded=selectedExclusions(j,ww,kr),legacyCutover=String(j?.hoursCutoverDate||"");
    let wwHours=0,kristineHours=0;
    if(legacyCutover&&!reconciliationDrafts.has(jobId)){for(const [day,value] of ww.days)if(day<legacyCutover)wwHours+=num(value);for(const [day,value] of krDays)if(day>=legacyCutover)kristineHours+=num(value)*scale}
    else{wwHours=(ww.rows||[]).reduce((sum,row)=>sum+(excluded.has(row.key)?0:num(row.hours)),0);kristineHours=kristineTotal}
    return {total:wwHours+kristineHours,ww:wwHours,kristine:kristineHours,overlaps,excluded,source:"WW + KRISTINE",legacyCutover};
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
      const actual=fusion(j).total,target=targetHours(j);
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
    const fused=fusion(j),actual=fused.total,target=targetHours(j),remaining=Math.max(0,target-actual),pct=target>0?actual/target*100:0;
    const dh=document.getElementById("detailHours"),dn=document.getElementById("detailHoursNote"),op=document.getElementById("detailOpen"),bar=document.getElementById("detailProgress"),note=document.getElementById("detailProgressNote");
    if(dh)dh.textContent=`${hours(actual)} / ${hours(target)}`;
    if(dn)dn.textContent=target>0?`${Math.round(pct)} % verbraucht · ${fused.source}`:`${fused.source} · keine Sollstunden hinterlegt`;
    if(op)op.textContent=hours(remaining);
    if(bar){bar.style.width=Math.min(100,Math.max(0,pct))+"%";bar.style.background=pct>100?"var(--red)":"var(--green)"}
    if(note)note.textContent=target>0?`${hours(actual)} von ${hours(target)} · ${Math.round(pct)} % · live gebucht`:"Noch keine Stundenkalkulation hinterlegt.";
    const info=document.getElementById("detailInfo");
    if(info){for(const label of info.querySelectorAll(".label")){const value=label.nextElementSibling;if(!value)continue;if(label.textContent.trim()==="Offene Stunden")value.textContent=hours(remaining);if(label.textContent.trim()==="Auftragsbestand")value.textContent=money(remaining*90)}}
  }

  function pulseItem(label){return [...document.querySelectorAll("#bcShell .bc-pulse-item")].find(el=>String(el.querySelector("span")?.textContent||"").trim()===label)||null}
  function radarButton(label){return [...document.querySelectorAll("#bcShell .bc-radar button")].find(el=>String(el.querySelector("span")?.textContent||"").includes(label))||null}
  function escapeHtml(v){return String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
  function installReconciliationCss(){
    if(document.getElementById("hoursReconciliationCss"))return;const style=document.createElement("style");style.id="hoursReconciliationCss";style.textContent=`
      .hr-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.hr-head h3{margin:0 0 4px}.hr-actions{display:flex;gap:7px;flex-wrap:wrap}.hr-actions button{min-height:36px;border:1px solid #cbc8bf;border-radius:9px;background:#fff;color:#252925;padding:8px 11px;font:800 11px/1 system-ui;cursor:pointer}.hr-actions button.primary{background:#2f7d4a;color:#fff;border-color:#2f7d4a}.hr-ranges{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:13px}.hr-range{border:1px solid #e1ddd4;border-radius:11px;background:#fbfaf6;padding:11px}.hr-range span{display:block;color:#707670;font-size:10px;font-weight:850;text-transform:uppercase}.hr-range strong{display:block;margin-top:4px;font-size:14px}.hr-days{display:grid;gap:9px;margin-top:12px}.hr-day{border:1px solid #ddd9cf;border-radius:12px;overflow:hidden}.hr-day-head{display:flex;justify-content:space-between;gap:8px;padding:9px 11px;background:#f3f1eb;font-size:12px}.hr-person{display:grid;grid-template-columns:minmax(230px,1fr) minmax(260px,1.4fr);gap:10px;align-items:center;padding:9px 11px;border-top:1px solid #ece8df;font-size:12px}.hr-person label{display:flex;gap:8px;align-items:flex-start;font-weight:800;cursor:pointer}.hr-person input{margin-top:2px}.hr-match{color:#656b65}.hr-match strong{color:#2f7d4a}.hr-note{margin-top:10px;padding:9px 11px;border-radius:10px;background:#edf4ee;color:#315b3d;font-size:11px;line-height:1.45}.hr-note.warn{background:#fff3df;color:#7b5923}.hr-status{font-size:11px;color:#707670;margin-top:9px}.hr-empty{margin-top:12px;padding:12px;border:1px dashed #d5d0c6;border-radius:10px;color:#707670;font-size:12px}@media(max-width:760px){.hr-ranges{grid-template-columns:1fr}.hr-person{grid-template-columns:1fr}}
    `;document.head.appendChild(style);
  }
  function sourceRange(days){const dates=[...(days?.keys?.()||[])].filter(Boolean).sort();return {first:dates[0]||"",last:dates[dates.length-1]||""}}
  function renderHoursReconciliation(j){
    const host=document.getElementById("bkHours"),grid=host?.querySelector(".bk-grid");if(!grid)return;
    const jobId=String(j?.jobId||""),ww=wwByJob.get(jobId),kr=liveByJob.get(jobId),result=fusion(j),error=wwErrors.get(jobId)||"",selected=result.excluded||new Set(),wwRange=sourceRange(ww?.days),krRange=sourceRange(kr?.days);
    let card=document.getElementById("hoursReconciliation");if(!card){card=document.createElement("div");card.id="hoursReconciliation";card.className="bk-card bk-wide";grid.prepend(card)}
    const signature=JSON.stringify({jobId,error,ww:ww?.totalHours,wwRows:(ww?.rows||[]).map(row=>[row.key,row.hours]),kr:kr?.totalHours,overlaps:result.overlaps,selected:[...selected].sort(),resolved:j?.hoursOverlapResolvedAt||"",cutover:j?.hoursCutoverDate||""});if(card.dataset.signature===signature)return;card.dataset.signature=signature;
    const ranges=`<div class="hr-ranges"><div class="hr-range"><span>WinWorker-Daten</span><strong>${ww?.found?`${dateLabel(wwRange.first)} bis ${dateLabel(wwRange.last)}`:"noch nicht geladen"}</strong><small>${ww?.found?hours(ww.totalHours):"WW am PC abgleichen"}</small></div><div class="hr-range"><span>KRISTINE-Daten</span><strong>${krRange.first?`ab ${dateLabel(krRange.first)}`:"noch keine Stunden"}</strong><small>${krRange.last?`bis ${dateLabel(krRange.last)} · ${hours(kr?.totalHours)}`:""}</small></div><div class="hr-range"><span>Überschneidungen</span><strong>${result.overlaps.length} Tag(e)</strong><small>${result.overlaps.length?result.overlaps.map(dateLabel).join(", "):"keine doppelten Tage"}</small></div></div>`;
    const days=result.overlaps.map(date=>{const wwRows=(ww?.rows||[]).filter(row=>row.date===date),krPeople=kr?.dayPeople?.get(date)||new Map(),wwTotal=num(ww?.days?.get(date)),krTotal=num(kr?.days?.get(date));return `<div class="hr-day"><div class="hr-day-head"><strong>${dateLabel(date)}</strong><span>WW ${hours(wwTotal)} · KRISTINE ${hours(krTotal)}</span></div>${wwRows.map(row=>{const match=matchingKristinePerson(krPeople,row),krList=[...krPeople.values()].map(person=>`${person.name} ${hours(person.hours)}`).join(" · ");return `<div class="hr-person"><label><input type="checkbox" data-hr-key="${escapeHtml(row.key)}" ${selected.has(row.key)?"checked":""}><span>${escapeHtml(row.employeeName||"WinWorker")} · WW ${hours(row.hours)}<br><small>als doppelt markieren – WW nicht zusätzlich zählen</small></span></label><div class="hr-match">${match?`Passend in KRISTINE: <strong>${escapeHtml(match.name)} · ${hours(match.hours)}</strong>`:`KRISTINE an diesem Tag: ${escapeHtml(krList||"keine Mitarbeiterdetails")}`}</div></div>`}).join("")}</div>`}).join("");
    const saved=j?.hoursOverlapResolvedAt&&!j?.hoursCutoverDate?`Zuletzt geprüft ${new Date(j.hoursOverlapResolvedAt).toLocaleString("de-AT")}.`:"Noch nicht endgültig bestätigt.";
    const legacy=j?.hoursCutoverDate?`<div class="hr-note warn">Der frühere pauschale Stichtag ${dateLabel(j.hoursCutoverDate)} ist noch gespeichert. Sobald du diese Liste speicherst, wird er durch die genaue Mitarbeiter-Auswahl ersetzt.</div>`:"";
    card.innerHTML=`<div class="hr-head"><div><h3>WW / KRISTINE Stundenabgleich</h3><div class="bk-note">Die Daten bleiben je Quelle sichtbar. Nur angehakte WinWorker-Zeilen gelten als doppelt und werden nicht zusätzlich gezählt.</div></div><div class="hr-actions"><button type="button" id="hrRefresh">WW jetzt abgleichen</button>${result.overlaps.length?'<button type="button" class="primary" id="hrSave">Auswahl speichern</button>':""}</div></div>${ranges}${error?`<div class="hr-note warn">WW-Abgleich nicht möglich: ${escapeHtml(error)}</div>`:""}${legacy}${days?`<div class="hr-days">${days}</div>`:`<div class="hr-empty">${ww?.found?"Keine Tage mit Stunden in beiden Systemen gefunden.":"Mit „WW jetzt abgleichen“ werden die WinWorker-Stunden für diese Baustelle direkt vom Büro-PC geholt."}</div>`}<div id="hrStatus" class="hr-status">${escapeHtml(saved)}</div>`;
    card.querySelector("#hrRefresh")?.addEventListener("click",async event=>{const button=event.currentTarget,status=card.querySelector("#hrStatus");button.disabled=true;status.textContent="WinWorker wird live gelesen …";try{const fresh=await loadWwHours(jobId);if(fresh)wwByJob.set(jobId,fresh);wwErrors.delete(jobId);reconciliationDrafts.delete(jobId);patchAll()}catch(e){wwErrors.set(jobId,e.message);button.disabled=false;status.textContent="Abgleich nicht möglich: "+e.message;card.dataset.signature="";renderHoursReconciliation(j)}});
    card.querySelectorAll("[data-hr-key]").forEach(input=>input.addEventListener("change",()=>{const draft=new Set(reconciliationDrafts.get(jobId)||selected);if(input.checked)draft.add(input.dataset.hrKey);else draft.delete(input.dataset.hrKey);reconciliationDrafts.set(jobId,draft);const button=card.querySelector("#hrSave"),status=card.querySelector("#hrStatus");if(button)button.textContent=`Auswahl speichern (${draft.size})`;if(status)status.textContent="Auswahl geändert – bitte speichern.";patchRows();patchTopKpis();patchCockpit(jobId)}));
    card.querySelector("#hrSave")?.addEventListener("click",async event=>{const button=event.currentTarget,status=card.querySelector("#hrStatus"),draft=new Set(reconciliationDrafts.get(jobId)||selected),expected=[...draft].sort();button.disabled=true;status.textContent="Auswahl wird gespeichert …";try{const response=await apiWrite(`/admin/api/job/${encodeURIComponent(jobId)}/hours-overlap`,{excludedWwKeys:expected});const saved=Array.isArray(response.excludedWwKeys)?response.excludedWwKeys:[];if(JSON.stringify([...saved].sort())!==JSON.stringify(expected))throw new Error("Der Server hat die Auswahl nicht vollständig übernommen.");j.hoursCutoverDate="";j.hoursOverlapExcludedWwKeys=saved;j.hoursOverlapResolvedAt=response.resolvedAt||new Date().toISOString();reconciliationDrafts.set(jobId,new Set(saved));card.dataset.signature="";patchAll()}catch(e){button.disabled=false;button.textContent=`Auswahl speichern (${draft.size})`;status.textContent="Speichern nicht möglich: "+e.message}});
  }

  function patchCockpit(id){
    const j=job(id),shell=document.getElementById("bcShell");if(!j||!shell)return;
    const fused=fusion(j),actual=fused.total,target=targetHours(j),remaining=Math.max(0,target-actual);
    const ist=pulseItem("Iststunden");if(ist){const strong=ist.querySelector("strong"),small=ist.querySelector("small");if(strong)strong.textContent=hours(actual);if(small)small.textContent=target?`${Math.round(actual/target*100)} % · ${fused.source}`:fused.source}
    const rest=pulseItem("Reststunden");if(rest){const strong=rest.querySelector("strong");if(strong)strong.textContent=hours(remaining)}
    const rb=radarButton("Stunden");if(rb){const strong=rb.querySelector("strong"),small=rb.querySelector("small"),dot=rb.querySelector(".bc-source-dot");if(strong)strong.textContent=hours(actual);if(small)small.textContent=actual>0?"live zugeordnet":"noch keine Buchung";if(dot)dot.classList.toggle("missing",actual<=0)}

    const card=[...shell.querySelectorAll(".bc-card")].find(c=>/Menschen\s*&\s*Baustellenwissen/i.test(c.querySelector("h3")?.textContent||""));
    const host=card?.querySelector(".bc-people-row");
    const people=[...(peopleByJob.get(String(id))?.values()||[])].sort((a,b)=>b.hours-a.hours);
    if(host&&people.length)host.innerHTML=people.slice(0,8).map(p=>`<div class="bc-person"><strong>${escapeHtml(p.name)}</strong><span>${hours(p.hours)}</span><small>${p.days.size} Tag(e) · KRISTINE</small></div>`).join("");
  }

  function patchAll(){patchRows();patchTopKpis();const id=decodeURIComponent(location.hash.slice(1));if(id){const current=job(id);patchBaseDetail(id);patchCockpit(id);if(current)renderHoursReconciliation(current)}}
  function queuePatch(){if(patchQueued)return;patchQueued=true;setTimeout(()=>{patchQueued=false;patchAll()},80)}

  function personDayHours(jobId){
    const id=String(jobId||""),j=job(id),ww=wwByJob.get(id),kr=liveByJob.get(id),out=new Map(),legacyCutover=String(j?.hoursCutoverDate||""),excluded=selectedExclusions(j,ww,kr),rawKr=num(kr?.totalHours),kristineTotal=liveOrderHours(j),scale=rawKr>0?kristineTotal/rawKr:0,add=(date,name,hours,source)=>{const canonical=canonicalPersonName(name),key=`${date}|${nameKey(canonical)}`,current=out.get(key)||{date,name:canonical,hours:0,source};current.hours+=num(hours);current.source=current.source===source?source:"WW + KRISTINE";out.set(key,current)};
    for(const [date,people] of kr?.dayPeople||[])if(!legacyCutover||date>=legacyCutover)for(const person of people.values())add(date,person.name,person.hours*scale,"KRISTINE");
    for(const row of ww?.rows||[])if(legacyCutover?row.date<legacyCutover:!excluded.has(row.key))add(row.date,row.employeeName,row.hours,"WinWorker");
    return [...out.values()];
  }

  async function refresh(){
    try{const [j,b]=await Promise.all([api("/admin/api/jobs"),api("/kristine/api/bootstrap")]);jobs=j.jobs||[];bootstrap=b||{};buildLiveMaps();const id=decodeURIComponent(location.hash.slice(1));if(id){try{const ww=await loadWwHours(id);if(ww)wwByJob.set(String(id),ww);wwErrors.delete(String(id))}catch(e){wwErrors.set(String(id),e.message);console.warn("WinWorker-Stunden",e)}}patchAll()}catch(e){console.warn("Baustellen Live-Stunden",e)}
  }

  function install(){
    if(!location.pathname.toLowerCase().includes("baustellen.html")&&!location.pathname.toLowerCase().includes("/kristine/baustellen"))return;installReconciliationCss();
    const list=document.getElementById("jobList"),detail=document.getElementById("detail");
    if(list)new MutationObserver(queuePatch).observe(list,{subtree:true,childList:true});
    if(detail)new MutationObserver(queuePatch).observe(detail,{subtree:true,childList:true});
    window.addEventListener("hashchange",()=>setTimeout(refresh,120));
    document.addEventListener("click",e=>{const row=e.target.closest?.(".job-row[data-job]");if(row)setTimeout(queuePatch,250)},true);
    refresh();timer=setInterval(refresh,60000);window.addEventListener("beforeunload",()=>timer&&clearInterval(timer),{once:true});
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);else install();
  window.BaustellenLiveHours={version:VERSION,refresh,personDayHours};
})();
