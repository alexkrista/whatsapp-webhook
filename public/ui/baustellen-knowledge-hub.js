"use strict";

(function(){
  const VERSION="2026-09-02-intake-1";
  const token=new URLSearchParams(location.search).get("token")||"";
  let currentJobId="";
  let loadSerial=0;
  let cache={jobs:null,bootstrap:null};

  const esc=v=>String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
  const money=v=>new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(num(v));
  const hour=v=>new Intl.NumberFormat("de-AT",{maximumFractionDigits:2}).format(num(v))+" h";
  const fmtDate=v=>{if(!v)return "–";try{return new Date(String(v).slice(0,10)+"T12:00:00").toLocaleDateString("de-AT")}catch{return String(v)}};
  const tokenUrl=p=>{const u=new URL(p,location.origin);if(token&&u.origin===location.origin)u.searchParams.set("token",token);return u.origin===location.origin?u.pathname+u.search+u.hash:u.href};
  async function api(p,o={}){const r=await fetch(tokenUrl(p),o);const t=await r.text();let d;try{d=JSON.parse(t)}catch{}if(!r.ok)throw new Error(d?.error||t||r.statusText);return d}

  function installCss(){
    if(document.getElementById("baustellenKnowledgeCss"))return;
    const s=document.createElement("style");s.id="baustellenKnowledgeCss";s.textContent=`
      .bk-subnav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 15px;padding:9px;background:#fffefa;border:1px solid #ddd9cf;border-radius:14px;box-shadow:0 5px 18px rgba(23,33,27,.045)}
      .bk-subnav a,.bk-subnav button{display:inline-flex;align-items:center;min-height:38px;padding:8px 11px;border-radius:9px;text-decoration:none;font:850 12px/1 system-ui;color:#252925;border:1px solid #d8d4ca;background:#fff;cursor:pointer}.bk-subnav a.active{background:#2f7d4a;color:#fff;border-color:#2f7d4a}.bk-subnav .push{margin-left:auto;color:#707670;font-size:11px;padding-right:5px}
      .bk-tabs{display:flex;gap:6px;overflow-x:auto;padding:5px;margin:0 0 14px;background:#e9e6de;border-radius:13px}.bk-tabs button{border:0;border-radius:9px;background:transparent;color:#454945;min-height:38px;padding:8px 11px;font:800 12px/1 system-ui;white-space:nowrap;cursor:pointer}.bk-tabs button.active{background:#fff;color:#1f2821;box-shadow:0 2px 8px rgba(0,0,0,.08)}
      .bk-panel{display:none}.bk-panel.active{display:block}.bk-loading{padding:26px;text-align:center;color:#707670;background:#fff;border:1px solid #ddd9cf;border-radius:15px}
      .bk-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.bk-card{background:#fff;border:1px solid #ddd9cf;border-radius:15px;padding:15px;box-shadow:0 5px 18px rgba(23,33,27,.045);min-width:0}.bk-card h3{margin:0 0 11px;font-size:15px}.bk-card h4{margin:0 0 7px;font-size:13px}.bk-label{font-size:11px;color:#707670;font-weight:750}.bk-value{font-size:22px;font-weight:950;letter-spacing:-.03em;margin-top:4px}.bk-note{font-size:11px;color:#707670;margin-top:5px;line-height:1.45}.bk-wide{grid-column:1/-1}.bk-half{grid-column:span 2}.bk-third{grid-column:span 1}.bk-good{color:#2f7d4a}.bk-warn{color:#c98428}.bk-bad{color:#a84540}.bk-muted{color:#707670}
      .bk-flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;align-items:stretch}.bk-step{position:relative;background:#f8f6f0;border:1px solid #e2ded5;border-radius:12px;padding:12px}.bk-step:not(:last-child)::after{content:"›";position:absolute;right:-9px;top:50%;transform:translateY(-50%);z-index:2;font-size:22px;color:#aaa;background:#f5f4ef}.bk-step strong{display:block;font-size:17px;margin-top:3px}.bk-step small{color:#707670}
      .bk-table{width:100%;border-collapse:collapse;font-size:12px}.bk-table th,.bk-table td{padding:9px 8px;border-bottom:1px solid #ece9e2;text-align:left;vertical-align:top}.bk-table th{font-size:10px;text-transform:uppercase;color:#707670;letter-spacing:.03em}.bk-table td.num,.bk-table th.num{text-align:right;font-variant-numeric:tabular-nums}.bk-table tr:last-child td{border-bottom:0}
      .bk-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 7px;background:#efefec;font-size:10px;font-weight:850}.bk-badge.green{background:#e8f3eb;color:#235e38}.bk-badge.orange{background:#fff2dd;color:#83551c}.bk-badge.blue{background:#e9f1f7;color:#315f80}.bk-badge.purple{background:#f0ebf6;color:#654d83}
      .bk-day-list{display:grid;gap:8px}.bk-day{display:grid;grid-template-columns:100px minmax(0,1fr) auto;gap:11px;align-items:center;padding:10px 11px;border:1px solid #e2ded5;border-radius:11px;background:#fbfaf6}.bk-day strong{font-variant-numeric:tabular-nums}.bk-day-meta{font-size:11px;color:#656b65}.bk-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.bk-actions a,.bk-actions button{min-height:34px;border:1px solid #cbc8bf;background:#fff;color:#252925;border-radius:9px;padding:7px 9px;text-decoration:none;font:800 11px/1 system-ui;cursor:pointer}.bk-actions .primary{background:#2f7d4a;color:#fff;border-color:#2f7d4a}
      .bk-pdf-preview{margin-top:10px;border:1px solid #d8d4ca;border-radius:12px;overflow:hidden;background:#f4f2ec}.bk-pdf-preview iframe{display:block;width:100%;height:650px;border:0}.bk-placeholder{padding:22px;border:1px dashed #d5d0c6;background:#faf9f5;border-radius:12px;text-align:center;color:#707670;font-size:12px;line-height:1.5}
      .bk-intake-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.bk-intake-field{padding:10px;border:1px solid #e2ded5;border-radius:10px;background:#fbfaf6}.bk-intake-field strong{display:block;margin-bottom:4px;font-size:10px;text-transform:uppercase;color:#707670}.bk-intake-field div{white-space:pre-wrap;font-size:12px;line-height:1.45}.bk-intake-records{display:grid;gap:9px;margin-top:12px}.bk-intake-record{padding:11px;border-radius:11px;background:#f6f4ef;border:1px solid #e2ded5}.bk-intake-record audio{display:block;width:100%;margin:8px 0}.bk-intake-record p{white-space:pre-wrap;margin:7px 0 0;font-size:12px;line-height:1.5}.bk-intake-files{display:flex;gap:9px;flex-wrap:wrap;margin-top:12px}.bk-intake-file{width:150px;padding:8px;border:1px solid #ddd9cf;border-radius:10px;background:#fff;color:#252925;text-decoration:none;font-size:11px;font-weight:750}.bk-intake-file img{display:block;width:100%;height:95px;object-fit:cover;border-radius:7px;margin-bottom:6px}
      .bk-people{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px}.bk-person{border:1px solid #e0dcd3;border-radius:12px;background:#fbfaf6;padding:11px}.bk-person strong{display:block}.bk-person .big{font-size:20px;font-weight:950;margin:5px 0}.bk-person small{color:#707670}
      .bk-materials{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:9px}.bk-material{border:1px solid #e0dcd3;border-radius:12px;padding:11px;background:#fbfaf6}.bk-material strong{display:block}.bk-material span{font-size:12px;color:#707670}.bk-source{display:inline-flex;align-items:center;gap:6px;background:#eef5ef;color:#295f39;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:850}.bk-source.missing{background:#fff5de;color:#7b5923}.bk-divider{height:1px;background:#e8e4dc;margin:12px 0}.bk-progress{height:10px;background:#e7e4dc;border-radius:999px;overflow:hidden;margin-top:7px}.bk-progress span{display:block;height:100%;background:#2f7d4a;border-radius:999px}.bk-section-title{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 0 10px}.bk-section-title h3{margin:0}.bk-statline{display:flex;gap:12px;flex-wrap:wrap;color:#707670;font-size:11px}
      @media(max-width:1050px){.bk-grid{grid-template-columns:1fr 1fr}.bk-flow{grid-template-columns:1fr 1fr}.bk-flow .bk-step::after{display:none}.bk-half,.bk-third{grid-column:span 1}}
      @media(max-width:700px){.bk-subnav .push{display:none}.bk-grid{grid-template-columns:1fr}.bk-half,.bk-third{grid-column:auto}.bk-flow{grid-template-columns:1fr}.bk-day{grid-template-columns:1fr}.bk-actions{justify-content:flex-start}.bk-pdf-preview iframe{height:480px}.bk-table{font-size:11px}.bk-table th,.bk-table td{padding:7px 5px}}
    `;document.head.appendChild(s);
  }

  function installKrisadminSubnav(){
    const main=document.querySelector("body>main");if(!main||document.getElementById("bkSubnav"))return;
    const nav=document.createElement("div");nav.id="bkSubnav";nav.className="bk-subnav";
    const inKristine=location.pathname.toLowerCase().replace(/\/+$/,"")==="/kristine/baustellen";
    nav.innerHTML=inKristine
      ? `<a href="${tokenUrl('/kristine#control')}">🧾 Leitstand</a><a href="${tokenUrl('/kristine#planning')}">📅 Planung</a><a class="active" href="${tokenUrl('/kristine/baustellen')}">🏗 Baustellen</a><button id="sdbOpen" type="button">🛡️ Arbeitssicherheit</button><span class="push">KRISTINE · Baustellen-Wissensdrehscheibe</span>`
      : `<a class="active" href="${tokenUrl('/kristine/baustellen')}">🏗 Baustellen jetzt in KRISTINE</a><a href="${tokenUrl('/admin/ui')}">👷 Mitarbeiter / Fahrzeuge / Betrieb</a><button id="sdbOpen" type="button">🛡️ Arbeitssicherheit</button><span class="push">Alter Einstieg · bleibt vorerst erreichbar</span>`;
    main.insertBefore(nav,main.firstChild);
  }

  function installHub(){
    const body=document.querySelector("#detail .detail-body");if(!body||document.getElementById("bkHub"))return;
    const existing=body.querySelector(".detail-grid");
    const hub=document.createElement("div");hub.id="bkHub";
    hub.innerHTML=`
      <div class="bk-tabs" role="tablist">
        <button class="active" data-bk-tab="overview">Übersicht</button>
        <button data-bk-tab="economy">Wirtschaft</button>
        <button data-bk-tab="hours">Stunden & Team</button>
        <button data-bk-tab="planning">Planung</button>
        <button data-bk-tab="protocols">Protokolle & Fotos</button>
        <button data-bk-tab="regie">Regie</button>
        <button data-bk-tab="material">Material</button>
        <button data-bk-tab="invoices">Rechnungen</button>
      </div>
      <section class="bk-panel active" data-bk-panel="overview"><div id="bkOverviewHost"></div></section>
      <section class="bk-panel" data-bk-panel="economy"><div id="bkEconomy" class="bk-loading">Wirtschaft wird geladen …</div></section>
      <section class="bk-panel" data-bk-panel="hours"><div id="bkHours" class="bk-loading">Stunden und Mitarbeiter werden geladen …</div></section>
      <section class="bk-panel" data-bk-panel="planning"><div id="bkPlanning" class="bk-loading">Planung wird geladen …</div></section>
      <section class="bk-panel" data-bk-panel="protocols"><div id="bkProtocols" class="bk-loading">Bautage, Fotos und Protokolle werden geladen …</div></section>
      <section class="bk-panel" data-bk-panel="regie"><div id="bkRegie" class="bk-loading">Regieberichte werden geladen …</div></section>
      <section class="bk-panel" data-bk-panel="material"><div id="bkMaterial" class="bk-loading">Materialwissen wird geladen …</div></section>
      <section class="bk-panel" data-bk-panel="invoices"><div id="bkInvoices" class="bk-loading">Rechnungsstand wird geladen …</div></section>`;
    if(existing)body.insertBefore(hub,existing);else body.appendChild(hub);
    const overview=hub.querySelector("#bkOverviewHost");if(existing)overview.appendChild(existing);
    hub.querySelectorAll("[data-bk-tab]").forEach(b=>b.addEventListener("click",()=>selectTab(b.dataset.bkTab)));
  }

  function selectTab(name){
    document.querySelectorAll("[data-bk-tab]").forEach(b=>b.classList.toggle("active",b.dataset.bkTab===name));
    document.querySelectorAll("[data-bk-panel]").forEach(p=>p.classList.toggle("active",p.dataset.bkPanel===name));
  }

  async function baseData(force=false){
    if(force||!cache.jobs){const r=await api("/admin/api/jobs");cache.jobs=r.jobs||[]}
    if(force||!cache.bootstrap){try{cache.bootstrap=await api("/kristine/api/bootstrap")}catch{cache.bootstrap={}}}
    return cache;
  }

  function jobById(id){return (cache.jobs||[]).find(j=>String(j.jobId)===String(id))||null}
  function calc(j){return j?.calculation||{}}
  function assignmentRows(){const b=cache.bootstrap||{};for(const c of [b.assignments,b.planning?.assignments,b.data?.assignments]){if(Array.isArray(c))return c;if(c&&typeof c==="object")return Object.values(c).flat().filter(Boolean)}return []}
  function assignmentJobId(a){return String(a?.jobId??a?.siteId??a?.job?.jobId??a?.job?.id??"")}
  function hmMinutes(v){const m=String(v||"").match(/^(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):null}
  function assignmentHours(a){const explicit=num(a?.hours??a?.plannedHours??a?.durationHours);if(explicit>0)return explicit;const f=hmMinutes(a?.from??a?.startTime),t=hmMinutes(a?.to??a?.endTime);return f!==null&&t!==null&&t>f?(t-f)/60:0}
  function plannedFor(id){return assignmentRows().filter(a=>assignmentJobId(a)===String(id)).reduce((s,a)=>s+assignmentHours(a),0)}
  function futurePlanning(id){const today=new Date().toISOString().slice(0,10);return assignmentRows().filter(a=>assignmentJobId(a)===String(id)&&String(a.date||a.day||"").slice(0,10)>=today).sort((a,b)=>String(a.date||a.day||"").localeCompare(String(b.date||b.day||"")))}
  function eventRows(id){return (cache.bootstrap?.timeEvents||[]).filter(e=>String(e.jobId||"")===String(id)).sort((a,b)=>String(b.date||"").localeCompare(String(a.date||""))||String(b.at||"").localeCompare(String(a.at||"")))}
  function eventLabel(type){return ({start:"Start",weiter:"Weiter / Wechsel",pause:"Pause",mittag:"Mittag",ende:"Ende"})[type]||String(type||"Buchung")}

  async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(next<items.length){const i=next++;try{out[i]=await fn(items[i],i)}catch(e){out[i]={__error:String(e?.message||e)}}}}await Promise.all(Array.from({length:Math.min(limit,items.length||1)},worker));return out}

  async function loadJob(id){
    const serial=++loadSerial;currentJobId=String(id||"");if(!currentJobId)return;
    installHub();selectTab("overview");
    ["bkEconomy","bkHours","bkPlanning","bkProtocols","bkRegie","bkMaterial","bkInvoices"].forEach(x=>{const e=document.getElementById(x);if(e){e.className="bk-loading";e.textContent="Daten werden gesammelt und der Baustelle zugeordnet …"}});
    try{
      await baseData(true);if(serial!==loadSerial)return;
      const j=jobById(currentJobId);if(!j)throw new Error("Baustelle nicht gefunden");
      const [days,knowledge]=await Promise.all([api(`/admin/api/job/${encodeURIComponent(currentJobId)}/days`).catch(()=>({detailed:[]})),api(`/admin/api/job/${encodeURIComponent(currentJobId)}/knowledge`).catch(()=>({}))]);if(serial!==loadSerial)return;
      const details=days.detailed||[];
      const regieRows=await mapLimit(details,6,async d=>{const r=await api(`/admin/api/job/${encodeURIComponent(currentJobId)}/day/${encodeURIComponent(d.day)}/regie`);return {day:d.day,regie:r.regie||r}});if(serial!==loadSerial)return;
      renderEconomy(j,regieRows);
      renderHours(j,regieRows);
      renderPlanning(j);
      renderProtocols(j,details);
      renderRegie(j,regieRows);
      renderMaterial(j,regieRows,knowledge);
      renderInvoices(j);
    }catch(e){
      ["bkEconomy","bkHours","bkPlanning","bkProtocols","bkRegie","bkMaterial","bkInvoices"].forEach(x=>{const el=document.getElementById(x);if(el){el.className="bk-placeholder";el.textContent="Konnte nicht laden: "+e.message}});
    }
  }

  function renderEconomy(j,regies){
    const c=calc(j),contract=num(c.contractAmount??j.contractAmount),external=num(c.externalServices??j.externalServices),krista=num(c.kristaAmount),material=num(c.materialAmount),labor=num(c.laborAmount),rate=num(c.billingRate??j.billingRate),target=num(c.calculatedHours),actual=num(c.orderHours??c.actualHours),regie=num(c.actualRegieHours),planned=plannedFor(j.jobId),remaining=Math.max(0,target-actual),progress=target?actual/target*100:0;
    const source=j.orderDocument||j.orderPdf||j.contractDocument||j.contractSource||"";
    const el=document.getElementById("bkEconomy");el.className="";el.innerHTML=`
      <div class="bk-grid">
        <div class="bk-card"><div class="bk-label">Auftragssumme</div><div class="bk-value">${money(contract)}</div><div class="bk-note">${source?`<span class="bk-source">PDF / Auftrag zugeordnet</span>`:`<span class="bk-source missing">Auftrags-PDF noch nicht als Quelle gespeichert</span>`}</div></div>
        <div class="bk-card"><div class="bk-label">Kalkulierte Sollstunden</div><div class="bk-value">${hour(target)}</div><div class="bk-note">Lohnanteil ÷ ${money(rate)} / h</div></div>
        <div class="bk-card"><div class="bk-label">Iststunden Auftrag</div><div class="bk-value ${actual>target&&target?'bk-bad':''}">${hour(actual)}</div><div class="bk-note">Regie ${hour(regie)} getrennt</div></div>
        <div class="bk-card"><div class="bk-label">Noch offene Stunden</div><div class="bk-value">${hour(remaining)}</div><div class="bk-note">Planung aktuell ${hour(planned)}</div></div>
        <div class="bk-card bk-wide"><div class="bk-section-title"><h3>Vom Auftrag zu den Stunden</h3><span class="bk-source">live aus Baustellenkalkulation</span></div><div class="bk-flow">
          <div class="bk-step"><small>Auftrag brutto/netto lt. Datensatz</small><strong>${money(contract)}</strong></div>
          <div class="bk-step"><small>abzgl. Fremdleistung</small><strong>${money(external)}</strong></div>
          <div class="bk-step"><small>KRISTA-Anteil</small><strong>${money(krista)}</strong></div>
          <div class="bk-step"><small>Materialanteil</small><strong>${money(material)}</strong></div>
          <div class="bk-step"><small>Lohnanteil → Stunden</small><strong>${money(labor)} → ${hour(target)}</strong></div>
        </div><div class="bk-progress"><span style="width:${Math.min(100,progress)}%;background:${progress>100?'#a84540':'#2f7d4a'}"></span></div><div class="bk-note">${progress.toLocaleString('de-AT',{maximumFractionDigits:1})} % der kalkulierten Auftragsstunden verbraucht.</div></div>
      </div>`;
  }

  function personStats(regies){
    const map=new Map();for(const row of regies){if(!row||row.__error)continue;for(const e of row.regie?.employees||[]){const key=String(e.employeeId||e.name||"");if(!key)continue;if(!map.has(key))map.set(key,{name:e.name||key,hours:0,regie:0,days:new Set(),first:null,last:null});const p=map.get(key);p.hours+=num(e.totalHours);p.regie+=num(e.regieHours);p.days.add(row.day);if(!p.first||row.day<p.first)p.first=row.day;if(!p.last||row.day>p.last)p.last=row.day}}return [...map.values()].sort((a,b)=>b.hours-a.hours)}
  function renderHours(j,regies){
    const people=personStats(regies),events=eventRows(j.jobId),total=people.reduce((s,p)=>s+p.hours,0),regie=people.reduce((s,p)=>s+p.regie,0);
    const peopleHtml=people.length?people.map(p=>`<div class="bk-person"><strong>${esc(p.name)}</strong><div class="big">${hour(p.hours)}</div><small>${p.days.size} Arbeitstag(e) · Regie ${hour(p.regie)}<br>${fmtDate(p.first)} – ${fmtDate(p.last)}</small></div>`).join(""):'<div class="bk-placeholder">Noch keine Tageserfassungen mit Mitarbeitern vorhanden.</div>';
    const eventHtml=events.length?`<div style="overflow:auto"><table class="bk-table"><thead><tr><th>Datum</th><th>Zeit</th><th>Mitarbeiter</th><th>Buchung</th><th>Quelle</th></tr></thead><tbody>${events.slice(0,250).map(e=>`<tr><td>${fmtDate(e.date)}</td><td>${esc(e.at||'–')}</td><td>${esc(e.employeeName||e.employeeId||'–')}</td><td>${esc(eventLabel(e.type))}</td><td>${esc(e.source||'KRISTINE')}</td></tr>`).join('')}</tbody></table></div>${events.length>250?`<div class="bk-note">${events.length-250} ältere Einzelereignisse vorhanden; die Summen oben enthalten weiterhin alle zugeordneten Tageserfassungen.</div>`:''}`:'<div class="bk-placeholder">Für diese Baustelle wurden noch keine einzelnen KRISTINE-Zeitereignisse gefunden.</div>';
    const el=document.getElementById("bkHours");el.className="";el.innerHTML=`<div class="bk-grid"><div class="bk-card"><div class="bk-label">Erfasste Stunden</div><div class="bk-value">${hour(total)}</div></div><div class="bk-card"><div class="bk-label">davon Regie</div><div class="bk-value">${hour(regie)}</div></div><div class="bk-card"><div class="bk-label">Mitarbeiter auf Baustelle</div><div class="bk-value">${people.length}</div></div><div class="bk-card"><div class="bk-label">Einzelne Zeitereignisse</div><div class="bk-value">${events.length}</div></div><div class="bk-card bk-wide"><h3>Wer hat hier gearbeitet?</h3><div class="bk-people">${peopleHtml}</div></div><div class="bk-card bk-wide"><h3>Wann wurde gebucht?</h3>${eventHtml}</div></div>`;
  }

  function renderPlanning(j){
    const rows=futurePlanning(j.jobId),sum=rows.reduce((s,a)=>s+assignmentHours(a),0);
    const html=rows.length?`<div style="overflow:auto"><table class="bk-table"><thead><tr><th>Datum</th><th>Mitarbeiter</th><th>Von</th><th>Bis</th><th class="num">Stunden</th><th>Hinweis</th></tr></thead><tbody>${rows.map(a=>`<tr><td>${fmtDate(a.date||a.day)}</td><td>${esc(a.employeeName||a.name||a.employeeId||'–')}</td><td>${esc(a.from||a.startTime||'–')}</td><td>${esc(a.to||a.endTime||'–')}</td><td class="num">${hour(assignmentHours(a))}</td><td>${esc(a.note||a.description||'')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="bk-placeholder">Für diese Baustelle ist aktuell nichts mehr eingeplant.</div>';
    const el=document.getElementById("bkPlanning");el.className="";el.innerHTML=`<div class="bk-grid"><div class="bk-card"><div class="bk-label">Noch eingeplante Stunden</div><div class="bk-value">${hour(sum)}</div><div class="bk-note">ab heute</div></div><div class="bk-card"><div class="bk-label">Planungseinträge</div><div class="bk-value">${rows.length}</div></div><div class="bk-card bk-half"><h3>Nächste Einteilungen</h3>${html}</div><div class="bk-card bk-wide"><div class="bk-actions"><a class="primary" href="${tokenUrl('/kristine#planning')}">In KRISPLAN öffnen</a></div></div></div>`;
  }

  function showProtocol(url,label){
    const host=document.getElementById("bkProtocolPreview");if(!host)return;host.innerHTML=`<div class="bk-section-title"><h3>${esc(label)}</h3><button type="button" id="bkClosePreview" class="bk-badge">Vorschau schließen</button></div><iframe title="Baustellenprotokoll" src="${esc(tokenUrl(url))}"></iframe>`;host.classList.add("bk-pdf-preview");document.getElementById("bkClosePreview").onclick=()=>{host.innerHTML='';host.className=''};host.scrollIntoView({behavior:'smooth',block:'start'});
  }

  function intakeSection(j){
    const p=j.intakeProtocol||{},appointment=j.intakeAppointment||{},recordings=Array.isArray(p.recordings)?p.recordings:[],files=Array.isArray(p.files)?p.files:[];
    const fields=[["Termin",appointment.date?`${fmtDate(appointment.date)}${appointment.from?" · "+appointment.from:""}${appointment.to?"–"+appointment.to:""}`:""],["Ort",appointment.location||j.addressExtra||""],["Besprochen / Kundenwunsch",p.discussion||""],["Vereinbarte Arbeiten",p.work||""],["Preisschätzung",p.estimate||""],["Nächste Schritte",p.nextSteps||""]].filter(x=>x[1]);
    if(!fields.length&&!recordings.length&&!files.length)return"";
    const fieldHtml=fields.map(([label,value])=>`<div class="bk-intake-field"><strong>${esc(label)}</strong><div>${esc(value)}</div></div>`).join("");
    const recordingHtml=recordings.map(r=>`<div class="bk-intake-record"><strong>${r.kind==="own_memo"?"Kalkulationsprotokoll · eigene Notiz":"Gesprächsprotokoll · mit Zustimmung"}</strong>${r.recordedAt?`<div class="bk-note">${esc(new Date(r.recordedAt).toLocaleString("de-AT"))}</div>`:""}${r.audioUrl?`<audio controls preload="none" src="${esc(tokenUrl(r.audioUrl))}"></audio>`:""}${r.transcript?`<p>${esc(r.transcript)}</p>`:`<div class="bk-note">Kein Transkript vorhanden.</div>`}</div>`).join("");
    const fileHtml=files.map(f=>{const href=tokenUrl(f.url||"#"),image=String(f.mimeType||"").startsWith("image/");return `<a class="bk-intake-file" href="${esc(href)}" target="_blank" rel="noopener">${image?`<img src="${esc(href)}" alt="${esc(f.name||"Termin-Foto")}">`:"📎 "}${esc(f.name||"Anlage")}</a>`}).join("");
    return `<div class="bk-card bk-wide"><div class="bk-section-title"><h3>Vor-Ort-Termin · übernommenes Wissen</h3><span class="bk-source">automatisch aus KRISTINE</span></div>${fieldHtml?`<div class="bk-intake-fields">${fieldHtml}</div>`:""}${recordingHtml?`<div class="bk-intake-records">${recordingHtml}</div>`:""}${fileHtml?`<div class="bk-intake-files">${fileHtml}</div>`:""}</div>`;
  }

  function renderProtocols(j,days){
    const totals=days.reduce((a,d)=>{a.images+=num(d.stats?.images);a.pdfs+=num(d.stats?.pdfs);a.audio+=num(d.stats?.audio);a.items+=num(d.stats?.items);return a},{images:0,pdfs:0,audio:0,items:0});
    const rows=days.length?days.map(d=>{const photos=num(d.stats?.images),action=d.pdfExists&&d.viewUrl?`<button type="button" class="primary" data-bk-preview="${esc(d.viewUrl)}" data-bk-label="${esc('Bautag '+fmtDate(d.day))}">Protokoll ansehen</button><a href="${tokenUrl(d.downloadUrl)}">PDF</a>`:photos>0?`<button type="button" class="primary" data-bk-gallery-day="${esc(d.day)}">Fotos ansehen</button>`:'';return `<div class="bk-day"><strong>${fmtDate(d.day)}</strong><div class="bk-day-meta">🖼 ${photos} Fotos · 📄 ${num(d.stats?.pdfs)} PDFs · 🎤 ${num(d.stats?.audio)} Audio · ${num(d.stats?.items)} Einträge</div><div class="bk-actions">${action}</div></div>`}).join(''):'<div class="bk-placeholder">Noch keine Bautage dokumentiert.</div>';
    const intake=intakeSection(j),intakeRecordings=Array.isArray(j.intakeProtocol?.recordings)?j.intakeProtocol.recordings.length:0,intakeFiles=Array.isArray(j.intakeProtocol?.files)?j.intakeProtocol.files:[],intakePhotos=intakeFiles.filter(f=>String(f.mimeType||"").startsWith("image/")).length;
    const el=document.getElementById("bkProtocols");el.className="";el.innerHTML=`<div class="bk-grid"><div class="bk-card"><div class="bk-label">Bautage</div><div class="bk-value">${days.length}</div></div><div class="bk-card"><div class="bk-label">Fotos</div><div class="bk-value">${totals.images+intakePhotos}</div></div><div class="bk-card"><div class="bk-label">Dokumente/PDF</div><div class="bk-value">${totals.pdfs+intakeFiles.filter(f=>!String(f.mimeType||"").startsWith("image/")).length}</div></div><div class="bk-card"><div class="bk-label">Audio</div><div class="bk-value">${totals.audio+intakeRecordings}</div></div>${intake}<div class="bk-card bk-wide"><div class="bk-section-title"><h3>Bautage · Fotos · Protokolle</h3><span class="bk-source">Baustellenakte</span></div><div class="bk-day-list">${rows}</div><div id="bkProtocolPreview"></div></div></div>`;
    el.querySelectorAll('[data-bk-preview]').forEach(b=>b.addEventListener('click',()=>showProtocol(b.dataset.bkPreview,b.dataset.bkLabel)));
    el.querySelectorAll('[data-bk-gallery-day]').forEach(b=>b.addEventListener('click',()=>document.querySelector(`.bf-day[data-bf-day="${CSS.escape(b.dataset.bkGalleryDay)}"]`)?.scrollIntoView({behavior:'smooth',block:'start'})));
  }

  function renderRegie(j,rows){
    const entries=[];for(const row of rows){if(!row||row.__error)continue;const r=row.regie||{},emps=(r.employees||[]).filter(e=>num(e.regieHours)>0||String(e.regieDescription||'').trim());if(!emps.length&&!String(r.customerText||'').trim())continue;entries.push({day:row.day,status:r.status||'Entwurf',employees:emps,customerText:r.customerText||'',internalNote:r.internalNote||''})}
    const total=entries.reduce((s,x)=>s+x.employees.reduce((a,e)=>a+num(e.regieHours),0),0);
    const html=entries.length?entries.map(x=>`<div class="bk-card"><div class="bk-section-title"><h3>${fmtDate(x.day)}</h3><span class="bk-badge ${x.status==='Abgerechnet'?'green':x.status==='Freigegeben'?'blue':'orange'}">${esc(x.status)}</span></div>${x.employees.length?`<table class="bk-table"><thead><tr><th>Mitarbeiter</th><th class="num">Regie</th><th>Beschreibung</th></tr></thead><tbody>${x.employees.map(e=>`<tr><td>${esc(e.name||e.employeeId||'–')}</td><td class="num">${hour(e.regieHours)}</td><td>${esc(e.regieDescription||'–')}</td></tr>`).join('')}</tbody></table>`:''}${x.customerText?`<div class="bk-divider"></div><div class="bk-label">Leistungsbeschreibung</div><div class="bk-note" style="color:#303530">${esc(x.customerText)}</div>`:''}</div>`).join(''):'<div class="bk-placeholder">Noch keine Regieeinträge auf dieser Baustelle.</div>';
    const el=document.getElementById("bkRegie");el.className="";el.innerHTML=`<div class="bk-grid"><div class="bk-card"><div class="bk-label">Regiestunden gesamt</div><div class="bk-value">${hour(total)}</div></div><div class="bk-card"><div class="bk-label">Tage mit Regie</div><div class="bk-value">${entries.length}</div></div><div class="bk-card bk-wide"><div class="bk-section-title"><h3>Regie-Wissen der Baustelle</h3><span class="bk-source">aus Tageserfassung</span></div><div class="bk-grid">${html}</div></div></div>`;
  }

  function aggregateMaterials(rows){
    const map=new Map(),special=[];for(const row of rows){if(!row||row.__error)continue;const r=row.regie||{};for(const m of r.materials||[]){const name=String(m.name||'').trim();if(!name)continue;const unit=String(m.unit||'').trim();const key=(name+'|'+unit).toLowerCase();if(!map.has(key))map.set(key,{name,unit,numeric:0,raw:[],days:new Set()});const x=map.get(key),q=String(m.quantity||'').trim(),n=Number(String(q).replace(',','.'));if(Number.isFinite(n))x.numeric+=n;else if(q)x.raw.push(q);x.days.add(row.day)}if(String(r.specialMaterial||'').trim())special.push({day:row.day,text:String(r.specialMaterial).trim()})}return {items:[...map.values()].sort((a,b)=>a.name.localeCompare(b.name,'de')),special}}
  function renderMaterial(j,rows,knowledge={}){
    const a=aggregateMaterials(rows),requests=Array.isArray(knowledge.materialRequests)?knowledge.materialRequests.slice().sort((x,y)=>String(y.createdAt||'').localeCompare(String(x.createdAt||''))):[],html=a.items.length?a.items.map(m=>`<div class="bk-material"><strong>${esc(m.name)}</strong><span>${m.numeric?esc(new Intl.NumberFormat('de-AT',{maximumFractionDigits:2}).format(m.numeric)+' '+m.unit):esc(m.raw.join(' + ')+' '+m.unit)} · ${m.days.size} Tag(e)</span></div>`).join(''):'<div class="bk-placeholder">Noch kein Material auf Tageserfassungen dieser Baustelle gespeichert.</div>';
    const special=a.special.length?`<div class="bk-card bk-wide"><h3>Sondermaterial / freie Notizen</h3>${a.special.map(x=>`<div class="bk-day"><strong>${fmtDate(x.day)}</strong><div class="bk-day-meta">${esc(x.text)}</div><div></div></div>`).join('')}</div>`:'';
    const requestHtml=requests.length?`<div class="bk-card bk-wide"><div class="bk-section-title"><h3>KGO-Materialmeldungen</h3><span class="bk-source">${requests.length} der Baustelle zugeordnet</span></div><div class="bk-day-list">${requests.map(x=>{const status=({open:'Offen',stocked:'Lagernd',ordered:'Bestellt'})[x.status]||x.status||'Erfasst',when=x.createdDate||x.createdAt;return `<div class="bk-day"><strong>${fmtDate(when)}</strong><div><strong>${esc(x.materialText||'Material')}</strong><div class="bk-day-meta">${esc([x.employeeName,x.needLabel,x.note].filter(Boolean).join(' · '))}${x.responseNote?`<br>Antwort Büro: ${esc(x.responseNote)}`:''}</div></div><span class="bk-badge ${x.status==='open'?'orange':'green'}">${esc(status)}</span></div>`}).join('')}</div></div>`:'';
    const el=document.getElementById("bkMaterial");el.className="";el.innerHTML=`<div class="bk-grid"><div class="bk-card"><div class="bk-label">Materialpositionen</div><div class="bk-value">${a.items.length}</div></div><div class="bk-card"><div class="bk-label">KGO-Materialmeldungen</div><div class="bk-value">${requests.length}</div></div><div class="bk-card"><div class="bk-label">Tage mit Sondermaterial</div><div class="bk-value">${a.special.length}</div></div><div class="bk-card bk-wide"><div class="bk-section-title"><h3>Gesammeltes Materialwissen</h3><span class="bk-source">aus Tageserfassung</span></div><div class="bk-materials">${html}</div></div>${requestHtml}${special}</div>`;
  }

  function invoicedValue(j){for(const k of ['invoicedAmount','billedAmount','invoiceTotal','revenueInvoiced','invoicedNet']){const n=Number(j?.[k]??j?.calculation?.[k]);if(Number.isFinite(n))return n}return null}
  function renderInvoices(j){
    const c=calc(j),contract=num(c.contractAmount??j.contractAmount),invoiced=invoicedValue(j),open=invoiced===null?null:Math.max(0,contract-invoiced);
    const el=document.getElementById("bkInvoices");el.className="";el.innerHTML=`<div class="bk-grid"><div class="bk-card"><div class="bk-label">Auftragssumme</div><div class="bk-value">${money(contract)}</div></div><div class="bk-card"><div class="bk-label">Bereits abgerechnet</div><div class="bk-value">${invoiced===null?'–':money(invoiced)}</div><div class="bk-note">${invoiced===null?'<span class="bk-source missing">Rechnungsquelle noch nicht mit Baustelle verknüpft</span>':'<span class="bk-source">live aus Rechnungsdaten</span>'}</div></div><div class="bk-card"><div class="bk-label">Noch abzurechnen</div><div class="bk-value">${open===null?'–':money(open)}</div></div><div class="bk-card"><div class="bk-label">Abrechnungsgrad</div><div class="bk-value">${invoiced===null||!contract?'–':Math.min(100,invoiced/contract*100).toLocaleString('de-AT',{maximumFractionDigits:1})+' %'}</div></div><div class="bk-card bk-wide"><h3>Abrechnung gehört zur Baustelle</h3><div class="bk-note">Sobald Ausgangsrechnungen aus WinWorker / The Brain eindeutig über die Baustellennummer zugeordnet sind, werden hier automatisch Rechnung, Rechnungsdatum, Nettosumme, bezahlt/offen sowie <strong>bereits abgerechnet / noch abzurechnen</strong> geführt. Es wird bewusst keine zweite händische Schattenzahl angelegt.</div></div></div>`;
  }

  function hookRows(){
    document.addEventListener("click",e=>{const row=e.target.closest?.(".job-row[data-job]");if(!row)return;setTimeout(()=>loadJob(row.dataset.job),0)},true);
    window.addEventListener("hashchange",()=>{const id=decodeURIComponent(location.hash.slice(1));if(id&&document.getElementById("detail")?.classList.contains("open"))loadJob(id)});
  }

  function init(){installCss();installKrisadminSubnav();installHub();hookRows();const id=decodeURIComponent(location.hash.slice(1));if(id)setTimeout(()=>loadJob(id),250)}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
  window.BaustellenKnowledgeHub={version:VERSION,load:loadJob,tab:selectTab};
})();
