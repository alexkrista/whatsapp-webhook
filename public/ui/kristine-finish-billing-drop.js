"use strict";

(function(){
  if(!location.pathname.toLowerCase().includes("/kristine"))return;

  const VERSION="2026-08-24-finish-billing-1";
  const token=new URLSearchParams(location.search).get("token")||"";
  let activeJobId="";
  let activeSummary=null;
  let installTimer=null;

  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
  const hours=v=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:1}).format(num(v))+" h";
  const money=v=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(num(v));
  const esc=v=>String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const tokenUrl=p=>{const u=new URL(p,location.origin);if(token)u.searchParams.set("token",token);return u.pathname+u.search+u.hash};
  async function api(p,o={}){const r=await fetch(tokenUrl(p),o);const t=await r.text();let d;try{d=JSON.parse(t)}catch{}if(!r.ok)throw new Error(d?.error||t||r.statusText);return d}

  function hmMinutes(v){const m=String(v||"").match(/^(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):null}
  function assignmentHours(a){const explicit=num(a?.hours??a?.plannedHours??a?.durationHours);if(explicit>0)return explicit;const f=hmMinutes(a?.from),t=hmMinutes(a?.to);return f!==null&&t!==null&&t>f?(t-f)/60:0}
  function assignmentRows(bootstrap){if(Array.isArray(bootstrap?.assignments))return bootstrap.assignments;try{return Array.isArray(data?.assignments)?data.assignments:[]}catch{return[]}}
  function payloadJobId(payload){
    const raw=String(payload||"");
    if(raw.startsWith("pooljob:"))return raw.slice(8);
    if(raw.startsWith("pooltype:"))return"";
    try{const a=(data?.assignments||[]).find(row=>String(row?.id||"")===raw);return String(a?.jobId||"")}catch{return""}
  }
  function todayIso(){try{return typeof localDateISO==="function"?localDateISO():new Date().toISOString().slice(0,10)}catch{return new Date().toISOString().slice(0,10)}}
  async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(next<items.length){const i=next++;try{out[i]=await fn(items[i])}catch{out[i]=null}}}await Promise.all(Array.from({length:Math.min(limit,Math.max(1,items.length))},worker));return out}

  function liveHoursForJob(bootstrap,jobId){
    const events=Array.isArray(bootstrap?.timeEvents)?bootstrap.timeEvents:[];
    const states=bootstrap?.states||{};
    const groups=new Map();
    events.forEach((event,index)=>{
      const employeeId=String(event?.employeeId||""),date=String(event?.date||"").slice(0,10),minute=hmMinutes(event?.at);
      if(!employeeId||!date||minute===null)return;
      const key=employeeId+"|"+date;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...event,_index:index,_minute:minute});
    });
    let total=0;
    for(const [key,rows] of groups){
      rows.sort((a,b)=>a._minute-b._minute||String(a.createdAt||"").localeCompare(String(b.createdAt||""))||a._index-b._index);
      const [employeeId,date]=key.split("|");
      for(let i=0;i<rows.length;i++){
        const row=rows[i];if(!["start","weiter"].includes(String(row.type||"").toLowerCase())||String(row.jobId||"")!==String(jobId))continue;
        let end=rows[i+1]?._minute??null;
        if(end===null&&date===String(bootstrap?.today||todayIso())&&["working","pause","lunch"].includes(String(states?.[employeeId]?.mode||""))){const d=new Date();end=d.getHours()*60+d.getMinutes()+d.getSeconds()/60}
        if(end!==null&&end>row._minute&&end-row._minute<18*60)total+=(end-row._minute)/60;
      }
    }
    return total;
  }

  function installCss(){
    if(document.getElementById("kristaFinishBillingCss"))return;
    const s=document.createElement("style");s.id="kristaFinishBillingCss";s.textContent=`
      .kf-drop{margin-top:10px;border:2px dashed #bda66f;background:linear-gradient(135deg,#fffaf0,#f6f1e5);border-radius:14px;padding:12px 14px;display:flex;gap:11px;align-items:center;min-height:70px;transition:.16s ease;cursor:default}.kf-drop.dragover{border-color:#27713d;background:#eaf5ec;box-shadow:inset 0 0 0 2px rgba(39,113,61,.10);transform:translateY(-1px)}.kf-drop-icon{width:42px;height:42px;border-radius:12px;background:#27713d;color:#fff;display:grid;place-items:center;font-size:20px;font-weight:950;flex:none}.kf-drop-copy{min-width:0}.kf-drop-copy strong{display:block;font-size:14px}.kf-drop-copy span{display:block;font-size:11px;color:#6f6a5d;margin-top:2px}.kf-drop-tags{margin-left:auto;display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}.kf-tag{font-size:9px;font-weight:850;border-radius:999px;background:#fff;border:1px solid #ddd4c2;padding:4px 7px;color:#655c4d}
      .kf-backdrop{position:fixed;inset:0;z-index:820;display:none;place-items:center;padding:18px;background:rgba(11,15,12,.58)}.kf-backdrop.open{display:grid}.kf-modal{width:min(980px,100%);max-height:94vh;overflow:auto;background:#f7f5ef;border-radius:19px;box-shadow:0 24px 90px rgba(0,0,0,.34)}.kf-head{position:sticky;top:0;z-index:3;background:#17211b;color:#fff;padding:16px 18px;display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.kf-eyebrow{text-transform:uppercase;letter-spacing:.1em;font-size:9px;color:rgba(255,255,255,.55);font-weight:900}.kf-head h2{margin:4px 0 0;font-size:20px}.kf-head p{margin:3px 0 0;color:rgba(255,255,255,.68);font-size:11px}.kf-close{border:0;background:transparent;color:#fff;font-size:25px;padding:0 5px}.kf-body{padding:16px}.kf-loading{padding:30px;text-align:center;color:#6b706b}.kf-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:10px}.kf-metric{background:#fff;border:1px solid #ddd9cf;border-radius:12px;padding:10px;min-width:0}.kf-metric span{display:block;font-size:9px;color:#777;font-weight:850;text-transform:uppercase}.kf-metric strong{display:block;font-size:17px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kf-metric small{display:block;font-size:9px;color:#777;margin-top:2px}.kf-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.kf-card{background:#fff;border:1px solid #ddd9cf;border-radius:14px;padding:13px;min-width:0}.kf-card h3{margin:0 0 8px;font-size:13px}.kf-line{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #eeeae2;font-size:11px}.kf-line:last-child{border-bottom:0}.kf-line span{color:#6e736e}.kf-line strong{text-align:right}.kf-warning{margin-top:8px;border-radius:10px;background:#fff3d7;border:1px solid #ead39c;padding:8px 9px;color:#74551d;font-size:10px;line-height:1.4}.kf-good{background:#edf7ef;border-color:#bfdbc5;color:#2d613a}.kf-materials{display:flex;gap:5px;flex-wrap:wrap}.kf-material{background:#f5f3ed;border:1px solid #e0dcd2;border-radius:999px;padding:5px 8px;font-size:9.5px}.kf-special{margin-top:7px;padding:8px 9px;background:#faf5e7;border-radius:9px;font-size:10px;color:#6d5a33;line-height:1.4}.kf-checks{margin-top:10px;background:#fff;border:1px solid #d8d4cb;border-radius:14px;padding:12px}.kf-checks h3{margin:0 0 8px;font-size:13px}.kf-check{display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px solid #eeeae2}.kf-check:last-child{border-bottom:0}.kf-check input{width:auto;min-width:auto;margin-top:2px}.kf-check strong{display:block;font-size:11px}.kf-check span{display:block;color:#717671;font-size:9.5px;margin-top:2px}.kf-actions{position:sticky;bottom:0;background:#f7f5ef;border-top:1px solid #ddd9cf;padding:12px 16px;display:flex;gap:8px;justify-content:flex-end;align-items:center}.kf-msg{margin-right:auto;font-size:10px;color:#27713d;font-weight:800}.kf-actions button,.kf-actions a{border-radius:10px;padding:9px 12px;font-weight:850;font-size:11px;text-decoration:none}.kf-secondary{background:#fff;color:#202020;border:1px solid #ccc7bd}.kf-primary{background:#27713d;color:#fff;border:1px solid #27713d}.kf-primary:disabled{opacity:.4;cursor:not-allowed}.kf-error{color:#9d2525}
      @media(max-width:760px){.kf-drop-tags{display:none}.kf-metrics{grid-template-columns:1fr 1fr}.kf-grid{grid-template-columns:1fr}.kf-body{padding:10px}.kf-actions{flex-wrap:wrap}.kf-msg{width:100%;margin:0}.kf-actions button,.kf-actions a{flex:1;text-align:center}}
    `;document.head.appendChild(s);
  }

  function installModal(){
    if(document.getElementById("kfBackdrop"))return;
    document.body.insertAdjacentHTML("beforeend",`<div id="kfBackdrop" class="kf-backdrop" aria-hidden="true"><section class="kf-modal" role="dialog" aria-modal="true"><div class="kf-head"><div><div class="kf-eyebrow">Baustellenabschluss · aus Arbeit wird Abrechnung</div><h2 id="kfTitle">Baustelle abschließen</h2><p id="kfSubtitle">KRISTINE prüft vorher alles, was bereits zur Baustelle vorhanden ist.</p></div><button id="kfClose" class="kf-close" type="button">×</button></div><div id="kfBody" class="kf-body"><div class="kf-loading">Abschlussdaten werden gesammelt …</div></div><div class="kf-actions"><span id="kfMsg" class="kf-msg"></span><a id="kfOpenJob" class="kf-secondary" href="#" target="_blank">Baustelle öffnen</a><button id="kfCancel" class="kf-secondary" type="button">Abbrechen</button><button id="kfFinish" class="kf-primary" type="button" disabled>✓ Fertig → Abrechnung</button></div></section></div>`);
    const close=()=>closeModal();
    document.getElementById("kfClose").onclick=close;document.getElementById("kfCancel").onclick=close;
    document.getElementById("kfBackdrop").addEventListener("click",e=>{if(e.target.id==="kfBackdrop")close()});
    document.getElementById("kfFinish").onclick=finishJob;
  }

  function ensureDropzone(){
    const pools=document.querySelector("#planningCardsPanel .planning-pools");if(!pools)return;
    if(document.getElementById("kfFinishDrop"))return;
    const zone=document.createElement("div");zone.id="kfFinishDrop";zone.className="kf-drop";zone.innerHTML=`<div class="kf-drop-icon">✓€</div><div class="kf-drop-copy"><strong>Fertig / Abrechnen</strong><span>Baustellenkarte hierher ziehen → Abschlussprüfung</span></div><div class="kf-drop-tags"><span class="kf-tag">Stunden</span><span class="kf-tag">Fotos</span><span class="kf-tag">Material</span><span class="kf-tag">Regie</span></div>`;
    pools.insertAdjacentElement("afterend",zone);
    zone.addEventListener("dragover",e=>{e.preventDefault();zone.classList.add("dragover");try{e.dataTransfer.dropEffect="move"}catch{}});
    zone.addEventListener("dragleave",e=>{if(!zone.contains(e.relatedTarget))zone.classList.remove("dragover")});
    zone.addEventListener("drop",async e=>{e.preventDefault();e.stopPropagation();zone.classList.remove("dragover");let payload="";try{payload=e.dataTransfer.getData("text/plain")||""}catch{}const jobId=payloadJobId(payload);if(!jobId){try{if(typeof toast==="function")toast("Bitte eine Baustellenkarte in Fertig / Abrechnen ziehen.");else alert("Bitte eine Baustellenkarte hineinziehen.")}catch{}return}await openCloseout(jobId)});
  }

  function closeModal(){const b=document.getElementById("kfBackdrop");if(!b)return;b.classList.remove("open");b.setAttribute("aria-hidden","true");activeJobId="";activeSummary=null;document.getElementById("kfMsg").textContent=""}
  function openModal(){const b=document.getElementById("kfBackdrop");b.classList.add("open");b.setAttribute("aria-hidden","false")}

  function regieIsFinal(status){return /freigegeben|approved|gesendet|sent|abgeschlossen/i.test(String(status||""))}
  function materialLabel(m){return [m?.name,String(m?.quantity||"").trim(),String(m?.unit||"").trim()].filter(Boolean).join(" ").trim()}

  async function collectSummary(jobId){
    const [jobsRes,bootstrap,daysRes,materialRes]=await Promise.all([
      api("/admin/api/jobs"),api("/kristine/api/bootstrap").catch(()=>({})),api(`/admin/api/job/${encodeURIComponent(jobId)}/days`).catch(()=>({detailed:[]})),api("/kristine/api/material-requests").catch(()=>({requests:[]}))
    ]);
    const job=(jobsRes.jobs||[]).find(j=>String(j.jobId)===String(jobId));if(!job)throw new Error("Baustelle nicht gefunden.");
    if(String(job.status||"").startsWith("Angebot"))throw new Error("Diese Baustelle ist noch ein Angebot. Erst Auftrag anlegen, dann abschließen.");
    if(job.status==="Geschlossen")throw new Error("Diese Baustelle ist bereits geschlossen.");

    const days=daysRes.detailed||[];
    const regies=(await mapLimit(days,5,async d=>{const r=await api(`/admin/api/job/${encodeURIComponent(jobId)}/day/${encodeURIComponent(d.day)}/regie`);return{day:d.day,regie:r.regie||r}})).filter(Boolean);
    const assignments=assignmentRows(bootstrap),today=String(bootstrap.today||todayIso());
    const future=assignments.filter(a=>String(a.jobId||"")===String(jobId)&&String(a.date||"").slice(0,10)>today);
    const futureHours=future.reduce((s,a)=>s+assignmentHours(a),0);
    const live=liveHoursForJob(bootstrap,jobId),calc=job.calculation||{},serverActual=num(calc.orderHours??calc.actualHours),actual=Math.max(live,serverActual),target=num(calc.calculatedHours);
    const totalPhotos=days.reduce((s,d)=>s+num(d.stats?.images),0),latest=days[0]||null,latestPhotos=num(latest?.stats?.images);
    const materials=[],special=[],seen=new Set();let regieHours=0,regieDays=0,regieOpen=0;
    for(const row of regies){const r=row.regie||{};let dayHasRegie=false;for(const e of r.employees||[]){const h=num(e.regieHours);regieHours+=h;if(h>0)dayHasRegie=true}if(dayHasRegie){regieDays++;if(!regieIsFinal(r.status))regieOpen++}for(const m of r.materials||[]){const label=materialLabel(m);if(label&&!seen.has(label.toLowerCase())){seen.add(label.toLowerCase());materials.push(label)}}if(String(r.specialMaterial||"").trim())special.push(`${row.day}: ${String(r.specialMaterial).trim()}`)}
    const openTasks=(bootstrap.tasks||[]).filter(t=>String(t.jobId||"")===String(jobId)&&String(t.status||"")!=="done");
    const openMaterial=(materialRes.requests||[]).filter(r=>String(r.jobId||"")===String(jobId)&&String(r.status||"")==="open");
    return{job,bootstrap,days,regies,today,future,futureHours,actual,target,totalPhotos,latest,latestPhotos,materials,special,regieHours,regieDays,regieOpen,openTasks,openMaterial};
  }

  function renderSummary(s){
    activeSummary=s;const j=s.job,progress=s.target>0?s.actual/s.target*100:0;
    document.getElementById("kfTitle").textContent=`#${j.jobId} · ${j.name||"Baustelle"}`;
    document.getElementById("kfSubtitle").textContent=`Status: ${j.status||"–"} · Abschlussprüfung vor „Fertig – nicht abgerechnet“`;
    document.getElementById("kfOpenJob").href=tokenUrl(`/kristine/baustellen#${encodeURIComponent(j.jobId)}`);
    const warnings=[];
    if(s.future.length)warnings.push(`${s.future.length} zukünftige Einteilung(en) · ${hours(s.futureHours)}`);
    if(s.openTasks.length)warnings.push(`${s.openTasks.length} offene Aufgabe(n)`);
    if(s.openMaterial.length)warnings.push(`${s.openMaterial.length} offene Materialmeldung(en)`);
    if(s.regieOpen)warnings.push(`${s.regieOpen} Regiebericht(e) noch nicht freigegeben`);
    if(!s.totalPhotos)warnings.push("keine Fotos dokumentiert");
    const materialHtml=s.materials.length?s.materials.slice(0,18).map(x=>`<span class="kf-material">${esc(x)}</span>`).join(""):'<span class="small">Noch keine strukturierte Materialposition vorhanden.</span>';
    document.getElementById("kfBody").innerHTML=`
      <div class="kf-metrics"><div class="kf-metric"><span>IST / SOLL</span><strong>${hours(s.actual)} / ${hours(s.target)}</strong><small>${s.target?Math.round(progress)+" % verbraucht":"kein Soll hinterlegt"}</small></div><div class="kf-metric"><span>Fotos</span><strong>${s.totalPhotos}</strong><small>${s.latest?`letzter Bautag ${esc(s.latest.day)} · ${s.latestPhotos}`:"kein Bautag"}</small></div><div class="kf-metric"><span>Material</span><strong>${s.materials.length}</strong><small>${s.special.length} Sondermaterial-Notiz(en)</small></div><div class="kf-metric"><span>Regie</span><strong>${hours(s.regieHours)}</strong><small>${s.regieDays} Tag(e) · ${s.regieOpen} offen</small></div><div class="kf-metric"><span>Zukunft</span><strong>${hours(s.futureHours)}</strong><small>${s.future.length} Einteilung(en)</small></div></div>
      <div class="kf-grid"><div class="kf-card"><h3>📷 Fotos & Dokumentation</h3><div class="kf-line"><span>Fotos gesamt</span><strong>${s.totalPhotos}</strong></div><div class="kf-line"><span>Letzter dokumentierter Bautag</span><strong>${s.latest?esc(s.latest.day):"–"}</strong></div><div class="kf-line"><span>Fotos am letzten Bautag</span><strong>${s.latestPhotos}</strong></div>${s.totalPhotos?'<div class="kf-warning kf-good">Fotos sind der Baustelle zugeordnet. Abschlussfotos bitte unten noch bewusst bestätigen.</div>':'<div class="kf-warning">Keine Fotos gefunden. Abschluss ist trotzdem möglich, muss unten aber ausdrücklich bestätigt werden.</div>'}</div>
      <div class="kf-card"><h3>🧾 Regie & offene Punkte</h3><div class="kf-line"><span>Regiestunden</span><strong>${hours(s.regieHours)}</strong></div><div class="kf-line"><span>Regietage</span><strong>${s.regieDays}</strong></div><div class="kf-line"><span>Noch nicht final</span><strong>${s.regieOpen}</strong></div><div class="kf-line"><span>Offene Aufgaben</span><strong>${s.openTasks.length}</strong></div><div class="kf-line"><span>Offene Materialmeldungen</span><strong>${s.openMaterial.length}</strong></div></div>
      <div class="kf-card"><h3>🎨 Materialliste der Baustelle</h3><div class="kf-materials">${materialHtml}</div>${s.special.length?`<div class="kf-special"><strong>Sondermaterial / Oberflächenwissen</strong><br>${s.special.slice(0,8).map(esc).join("<br>")}</div>`:""}</div>
      <div class="kf-card"><h3>📅 Planung & Übergang</h3><div class="kf-line"><span>Zukünftige Einteilungen</span><strong>${s.future.length}</strong></div><div class="kf-line"><span>Noch eingeplant</span><strong>${hours(s.futureHours)}</strong></div><div class="kf-line"><span>Zielstatus</span><strong>Fertig – nicht abgerechnet</strong></div>${warnings.length?`<div class="kf-warning"><strong>KRISTINE sieht noch:</strong><br>${warnings.map(x=>"• "+esc(x)).join("<br>")}</div>`:'<div class="kf-warning kf-good">Keine offensichtlichen offenen Punkte gefunden.</div>'}</div></div>
      <div class="kf-checks"><h3>Abschluss bestätigen</h3><label class="kf-check"><input id="kfCheckDone" type="checkbox"><span><strong>Baustelle ist technisch fertig</strong><span>Die operative Arbeit auf der Baustelle ist abgeschlossen.</span></span></label><label class="kf-check"><input id="kfCheckPhotos" type="checkbox"><span><strong>Abschlussfotos sind vollständig</strong><span>Oder: Es sind für diese Baustelle keine weiteren Abschlussfotos erforderlich.</span></span></label><label class="kf-check"><input id="kfCheckMaterial" type="checkbox"><span><strong>Material und Sondermaterial sind vollständig</strong><span>Verwendete Produkte und oberflächenrelevante Besonderheiten sind dokumentiert.</span></span></label><label class="kf-check"><input id="kfCheckRegie" type="checkbox"><span><strong>Regie ist vollständig</strong><span>Offene Regieleistungen sind erfasst oder bewusst nicht erforderlich.</span></span></label>${s.future.length?`<label class="kf-check"><input id="kfRemoveFuture" type="checkbox" checked><span><strong>Zukünftige Einteilungen entfernen</strong><span>Nur Einteilungen nach heute werden entfernt. Historische Planung bleibt erhalten.</span></span></label>`:""}</div>`;
    document.querySelectorAll("#kfBody input[type=checkbox]").forEach(x=>x.addEventListener("change",updateFinishButton));updateFinishButton();
  }

  function updateFinishButton(){const required=["kfCheckDone","kfCheckPhotos","kfCheckMaterial","kfCheckRegie"];const ok=required.every(id=>document.getElementById(id)?.checked===true);const b=document.getElementById("kfFinish");if(b)b.disabled=!ok}

  async function openCloseout(jobId){
    installModal();activeJobId=String(jobId);activeSummary=null;openModal();document.getElementById("kfTitle").textContent=`#${jobId} · Abschlussprüfung`;document.getElementById("kfBody").innerHTML='<div class="kf-loading">KRISTINE sammelt Stunden, Fotos, Material, Regie und offene Punkte …</div>';document.getElementById("kfFinish").disabled=true;document.getElementById("kfMsg").textContent="";
    try{renderSummary(await collectSummary(jobId))}catch(e){document.getElementById("kfBody").innerHTML=`<div class="kf-warning kf-error">${esc(e.message)}</div>`;document.getElementById("kfFinish").disabled=true}
  }

  async function finishJob(){
    if(!activeSummary||!activeJobId)return;const btn=document.getElementById("kfFinish"),msg=document.getElementById("kfMsg");btn.disabled=true;msg.classList.remove("kf-error");msg.textContent="Abschluss wird gespeichert …";
    try{
      const removeFuture=document.getElementById("kfRemoveFuture")?.checked===true;
      await api(`/admin/api/job/${encodeURIComponent(activeJobId)}/meta`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"Fertig – nicht abgerechnet"})});
      if(removeFuture&&activeSummary.future.length){
        try{if(Array.isArray(data?.assignments)){const today=activeSummary.today;data.assignments=data.assignments.filter(a=>!(String(a.jobId||"")===String(activeJobId)&&String(a.date||"").slice(0,10)>today));if(typeof saveAssignments==="function")await saveAssignments(true)}}catch(error){console.warn("Zukunftsplanung konnte nicht entfernt werden",error)}
      }
      try{const j=(masterJobs||[]).find(x=>String(x.jobId)===String(activeJobId));if(j)j.status="Fertig – nicht abgerechnet"}catch{}
      try{if(typeof renderPlanningPools==="function")renderPlanningPools();if(typeof renderPlanning==="function")renderPlanning()}catch{}
      msg.textContent="✓ Fertig. Baustelle steht jetzt zur Abrechnung bereit.";
      try{if(typeof toast==="function")toast("✓ Baustelle fertig · bereit zur Abrechnung")}catch{}
      setTimeout(closeModal,900);
    }catch(e){msg.textContent="Fehler: "+e.message;msg.classList.add("kf-error");btn.disabled=false}
  }

  function init(){installCss();installModal();ensureDropzone();installTimer=setInterval(ensureDropzone,800);window.addEventListener("beforeunload",()=>installTimer&&clearInterval(installTimer),{once:true});window.KristineFinishBilling={version:VERSION,open:openCloseout}}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();
