"use strict";

const state = {
  token: new URLSearchParams(location.search).get("token") || "",
  bootstrap: null,
  gpsImport: null,
  groups: [],
  dayRows: [],
  passengerRows: [],
  segments: [],
  originalSegments: [],
  correction: null,
  activeDate: "",
  saveTimer: null,
  phase: "times",
  teamCandidates: [],
  teamJobs: [],
  dayQueue: [],
  activeEmployeeId: "",
  dietOverride: null,
  release: null,
};

const $ = id => document.getElementById(id);
const api = path => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(state.token)}`;

function toast(message, error=false){
  const el=$("toast");
  el.textContent=message;
  el.style.background=error?"#8e302d":"#17211b";
  el.classList.add("show");
  setTimeout(()=>el.classList.remove("show"),2800);
}
function esc(value){ return String(value ?? "").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch])); }
function initials(name){ return String(name||"?").split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase()||"?"; }
function minutes(hm){ const m=String(hm||"").match(/^(\d{1,2}):(\d{2})$/); return m?Number(m[1])*60+Number(m[2]):null; }
function durationLabel(total){ total=Math.max(0,Math.round(total||0)); return `${Math.floor(total/60)}:${String(total%60).padStart(2,"0")} h`; }
function secondsLabel(seconds){ return durationLabel(Math.round(Number(seconds||0)/60)); }
function deDate(iso){
  if(!iso)return "";
  return new Intl.DateTimeFormat("de-AT",{weekday:"long",day:"2-digit",month:"long",year:"numeric"}).format(new Date(`${iso}T12:00:00`));
}
function shortDate(iso){
  if(!iso)return "";
  return new Intl.DateTimeFormat("de-AT",{day:"2-digit",month:"2-digit",year:"numeric"}).format(new Date(`${iso}T12:00:00`));
}
function km(value){ return `${Number(value||0).toLocaleString("de-AT",{minimumFractionDigits:1,maximumFractionDigits:1})} km`; }
function addDays(iso, delta){
  const d=new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate()+delta);
  return d.toISOString().slice(0,10);
}
function uniqueDates(){ return [...new Set(state.groups.map(g=>g.date).filter(Boolean))].sort(); }
function groupsForDate(date){ return state.groups.filter(g=>g.date===date); }

function hmFromMinutes(total){
  total=Math.max(0,Math.round(Number(total)||0));
  return `${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;
}

/* Mittag ist im KRISTOOL immer mindestens 60 Minuten.
   Fehlt Zeit, wird der Mittag verlängert und ALLES danach gleich weit nach hinten geschoben. */
function enforceMinimumLunch(rows){
  const list=rows||[];
  const noonStart=11*60, noonEnd=14*60+30;
  const isLunchCandidate=row=>{
    if(!row)return false;
    if(row.type==="lunch")return true;
    if(row.type!=="pause")return false;
    const from=minutes(row.from),to=minutes(row.to);
    if(from===null||to===null||to<=from)return false;
    const reason=String(row.reason||"").toLowerCase();
    return reason.includes("mittag") || (from<noonEnd && to>noonStart);
  };
  const shiftFollowing=(fromIndex,delta)=>{
    for(let j=fromIndex;j<list.length;j++){
      const next=list[j];
      const nf=minutes(next.from),nt=minutes(next.to);
      if(nf!==null)next.from=hmFromMinutes(nf+delta);
      if(nt!==null)next.to=hmFromMinutes(nt+delta);
    }
  };

  // 1) Bestehende Mittag-/Pause im Mittagsfenster auf exakt mindestens 60 Min verlängern.
  const lunchIndex=list.findIndex(isLunchCandidate);
  if(lunchIndex>=0){
    const row=list[lunchIndex];
    const from=minutes(row.from),to=minutes(row.to);
    const duration=to-from;
    if(duration>=60)return {changed:false,totalShift:0,mode:"already_ok"};
    const delta=60-duration;
    row.type="lunch";
    row.to=hmFromMinutes(to+delta);
    shiftFollowing(lunchIndex+1,delta);
    return {changed:true,totalShift:delta,mode:"extended"};
  }

  // 2) Keine Mittagspause vorhanden:
  //    Arbeitsblock, der 12:00 umfasst, teilen, 60 Min Mittag einfügen
  //    und den restlichen Tag um 60 Min nach hinten schieben.
  const noon=12*60;
  const workIndex=list.findIndex(row=>{
    if(row.type!=="work")return false;
    const from=minutes(row.from),to=minutes(row.to);
    return from!==null&&to!==null&&from<noon&&to>noon;
  });
  if(workIndex<0)return {changed:false,totalShift:0,mode:"no_midday_work"};

  const work=list[workIndex];
  const originalTo=minutes(work.to);
  const after={
    ...work,
    id:`${work.id||"seg"}_after_lunch_${Date.now()}`,
    from:hmFromMinutes(noon+60),
    to:hmFromMinutes(originalTo+60)
  };
  work.to=hmFromMinutes(noon);
  const lunch={
    id:`seg_lunch_${Date.now()}`,
    type:"lunch",
    from:hmFromMinutes(noon),
    to:hmFromMinutes(noon+60),
    jobId:"",
    jobName:"",
    reason:"Mittag",
    billingType:""
  };

  // Alle bereits folgenden Segmente ebenfalls +60 verschieben.
  shiftFollowing(workIndex+1,60);
  list.splice(workIndex+1,0,lunch,after);

  // Der alte Arbeitsblock-Nachmittag steckt nun in "after"; falls direkt danach
  // dasselbe alte Segment durch Split-Logik doppelt wäre, gibt es keines – wir
  // haben nur den einen bestehenden Block geteilt.
  return {changed:true,totalShift:60,mode:"inserted"};
}

/* Kleine maschinenlesbare Zusatzinfo im bestehenden Korrektur-Notizfeld.
   Dadurch brauchen wir für die drei Häkchen KEINE neue Backend-Datei/API. */
const DIET_MARKER_RE=/\s*\[\[DIET:taggeld=(auto|0|1);fl=(auto|0|1);ch=(auto|0|1)\]\]\s*$/i;

function buildDietSummaryRows(employees,from,to,dayRows){
  const active=reportEmployeesForPeriod(employees,from,to);
  return active.map(employee=>{
    const employeeId=String(employee.id||employee.employeeId||"");
    const rows=(dayRows||[]).filter(row=>
      String(row.employeeId||row.id||"")===employeeId &&
      String(row.date||"")>=from &&
      String(row.date||"")<=to &&
      dateWithinEmployment(employee,row.date)
    );
    const sumMinutes=key=>rows.reduce((sum,row)=>sum+Math.max(0,Number(row[key]||0)),0);
    const sumFlag=key=>rows.reduce((sum,row)=>sum+(Number(row[key]||0)>0?1:0),0);
    return {
      personnelNumber:employeePersonnelNumber(employee)===999999?"":employeePersonnelNumber(employee),
      employeeId,
      name:employee.name||employee.employeeName||employeeId,
      taggeld:sumFlag("dietDay"),
      flMinutes:sumMinutes("flMinutes"),
      flDays:sumFlag("flDay"),
      chMinutes:sumMinutes("chMinutes"),
      chDays:sumFlag("chDay")
    };
  });
}
function formatReportMinutes(value){
  const n=Math.max(0,Math.round(Number(value||0)));
  return n?`${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`:"–";
}


function employeePersonnelNumber(employee){
  const raw=employee?.personnelNumber??employee?.personalNumber??employee?.employeeNumber??employee?.persNr??employee?.personnelNo??"";
  const n=Number(String(raw).replace(/[^\d]/g,""));
  return Number.isFinite(n)&&n>0?n:999999;
}
function employeeEntryDate(employee){
  return String(employee?.entryDate||employee?.employmentStart||employee?.startDate||employee?.eintrittsdatum||"").slice(0,10);
}
function employeeExitDate(employee){
  return String(employee?.exitDate||employee?.employmentEnd||employee?.endDate||employee?.austrittsdatum||"").slice(0,10);
}
function dateWithinEmployment(employee,date){
  const d=String(date||"").slice(0,10);
  const from=employeeEntryDate(employee),to=employeeExitDate(employee);
  if(from&&d<from)return false;
  if(to&&d>to)return false; // Austrittstag selbst bleibt enthalten
  return true;
}
function clampPeriodToEmployment(employee,from,to){
  const entry=employeeEntryDate(employee),exit=employeeExitDate(employee);
  const start=entry&&entry>from?entry:from;
  const end=exit&&exit<to?exit:to;
  return start<=end?{from:start,to:end}:null;
}
function reportEmployeesForPeriod(employees,from,to){
  return (employees||[])
    .filter(employee=>clampPeriodToEmployment(employee,from,to))
    .sort((a,b)=>employeePersonnelNumber(a)-employeePersonnelNumber(b)||String(a.name||"").localeCompare(String(b.name||""),"de"));
}

function parseDietOverride(note){
  const match=String(note||"").match(DIET_MARKER_RE);
  if(!match)return {taggeld:"auto",fl:"auto",ch:"auto"};
  return {taggeld:match[1].toLowerCase(),fl:match[2].toLowerCase(),ch:match[3].toLowerCase()};
}
function visibleCorrectionNote(note){ return String(note||"").replace(DIET_MARKER_RE,"").trim(); }
function correctionNoteWithDiet(note){
  const o=state.dietOverride||{taggeld:"auto",fl:"auto",ch:"auto"};
  return `${String(note||"").trim()} [[DIET:taggeld=${o.taggeld||"auto"};fl=${o.fl||"auto"};ch=${o.ch||"auto"}]]`.trim();
}
function checkedFromOverride(value,automatic){
  return value==="1"?true:value==="0"?false:Boolean(automatic);
}
function overrideFromCheckbox(checked,automatic){
  return checked===Boolean(automatic)?"auto":(checked?"1":"0");
}
function jobAssignmentForSegment(row){
  const assignments=state.bootstrap?.assignments||[];
  const id=String(row.jobId||"").trim();
  const name=String(row.jobName||"").trim().toLowerCase();
  const sameDay=assignments.filter(a=>String(a.date||a.day||"").slice(0,10)===String(state.activeDate||""));
  return sameDay.find(a=>id&&String(a.jobId||"")===id)
    ||sameDay.find(a=>name&&String(a.jobName||"").trim().toLowerCase()===name)
    ||assignments.find(a=>id&&String(a.jobId||"")===id)
    ||assignments.find(a=>name&&String(a.jobName||"").trim().toLowerCase()===name)
    ||null;
}
function segmentLocationText(row){
  const a=jobAssignmentForSegment(row)||{};
  return [a.address,a.city,a.country,a.countryCode,a.jobName,row.jobName].filter(Boolean).join(" ");
}
function countryForSegment(row){
  const text=segmentLocationText(row)
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase();
  if(/liechtenstein|lichtenstein|\bfl[-\s]?\d{4}\b|\b94(?:8[5-9]|9[0-8])\b/.test(text))return "FL";
  if(/schweiz|switzerland|suisse|svizzera|\bch[-\s]?\d{4}\b/.test(text))return "CH";
  return "";
}
function hasForeignSiteWork(rows=state.segments){
  return (rows||[]).some(row=>row.type==="work"&&["FL","CH"].includes(countryForSegment(row)));
}
function isInternalWork(row){
  const text=[row.jobName,row.reason,segmentLocationText(row)].filter(Boolean).join(" ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase();
  return /\b(buro|buero|firma|werkstatt|lager|intern)\b/.test(text);
}

function currentEmployeeMaster(){
  const id=String($("employeeSelect")?.value||"");
  return (state.bootstrap?.employees||[]).find(row=>String(row.id||row.employeeId||"")===id)||null;
}
function currentAllowanceModel(){
  const item=activeQueueItem();
  const employee=currentEmployeeMaster();
  const direct=String(employee?.dailyAllowanceModel||item?.dailyAllowanceModel||"").trim().toLowerCase();
  if(["maler","buak","site6","none"].includes(direct))return direct;
  if(item?.buak===true)return "buak";
  return /\bmaler\b/i.test(String(employee?.role||""))?"maler":"none";
}
function allowanceForMinutes(model,siteMinutes){
  const m=Math.max(0,Number(siteMinutes||0));
  if(model==="buak"){
    if(m>=540)return {eligible:true,type:"buak_gross",label:"BUAK groß",rule:"ab 9:00 h Baustelle"};
    if(m>=180)return {eligible:true,type:"buak_klein",label:"BUAK klein",rule:"ab 3:00 h Baustelle"};
    return {eligible:false,type:"buak",label:"BUAK",rule:"klein ab 3:00 h · groß ab 9:00 h"};
  }
  if(model==="site6")return {eligible:m>=360,type:"site6",label:"Baustelle ≥ 6 Std.",rule:"ab 6:00 h Baustelle"};
  if(model==="maler")return {eligible:m>180,type:"maler",label:"Maler · Taggeld",rule:"bestehende Maler-Regel > 3:00 h"};
  return {eligible:false,type:"none",label:"Kein Taggeld",rule:"für diese Mitarbeitergruppe kein Taggeld"};
}
function dietCalculation(){
  let siteMinutes=0,flMinutes=0,chMinutes=0;
  for(const row of state.segments||[]){
    if(row.type!=="work")continue;
    const from=minutes(row.from),to=minutes(row.to);
    if(from===null||to===null||to<=from)continue;
    const dur=to-from;
    if(!isInternalWork(row))siteMinutes+=dur;
    const country=countryForSegment(row);
    if(country==="FL")flMinutes+=dur;
    if(country==="CH")chMinutes+=dur;
  }
  const allowanceModel=currentAllowanceModel();
  const allowance=allowanceForMinutes(allowanceModel,siteMinutes);
  return {
    siteMinutes,flMinutes,chMinutes,
    allowanceModel,allowance,
    taggeldAutomatic:allowance.eligible,
    flAutomatic:flMinutes>0,
    chAutomatic:chMinutes>0
  };
}
function renderDietPanel(){
  const panel=$("dietPanel");
  if(!panel)return;
  const employeeId=$("employeeSelect")?.value||"";
  if(!employeeId||!state.segments.length){
    panel.innerHTML='<div class="diet-empty">Tagesfolie öffnen – danach werden Taggeld und FL/CH automatisch berechnet.</div>';
    return;
  }
  const c=dietCalculation();
  const o=state.dietOverride||{taggeld:"auto",fl:"auto",ch:"auto"};
  const taggeld=checkedFromOverride(o.taggeld,c.taggeldAutomatic);
  const fl=checkedFromOverride(o.fl,c.flAutomatic);
  const ch=checkedFromOverride(o.ch,c.chAutomatic);
  panel.innerHTML=`
    <div class="diet-head">
      <div><p class="eyebrow">DIÄTEN & ENTSENDUNG</p><h3>Automatisch aus geprüften Zeitblöcken</h3></div>
      <small>Haken raus = für diesen Mitarbeiter/Tag nicht übernehmen</small>
    </div>
    <div class="diet-grid">
      <label class="diet-item">
        <input type="checkbox" data-diet-key="taggeld" ${taggeld?"checked":""}>
        <span><b>Taggeld · ${esc(c.allowance.label)}</b><strong>${taggeld?"1":"0"}</strong><small>${durationLabel(c.siteMinutes)} Baustelle · ${esc(c.allowance.rule)}</small></span>
      </label>
      <label class="diet-item">
        <input type="checkbox" data-diet-key="fl" ${fl?"checked":""}>
        <span><b>Liechtenstein</b><strong>${fl?"1":"0"} Tag · ${durationLabel(c.flMinutes)}</strong><small>FL-Stunden aus Baustellenadresse</small></span>
      </label>
      <label class="diet-item">
        <input type="checkbox" data-diet-key="ch" ${ch?"checked":""}>
        <span><b>Schweiz</b><strong>${ch?"1":"0"} Tag · ${durationLabel(c.chMinutes)}</strong><small>CH-Stunden aus Baustellenadresse</small></span>
      </label>
    </div>`;
  panel.querySelectorAll("input[data-diet-key]").forEach(input=>{
    input.addEventListener("change",()=>{
      const key=input.dataset.dietKey;
      const automatic=key==="taggeld"?c.taggeldAutomatic:key==="fl"?c.flAutomatic:c.chAutomatic;
      state.dietOverride=state.dietOverride||{taggeld:"auto",fl:"auto",ch:"auto"};
      state.dietOverride[key]=overrideFromCheckbox(input.checked,automatic);
      const truthPill=document.querySelector(".kristine-card .pill, .kristine-card header .pill");
  if(truthPill && absenceLabel){
    truthPill.textContent=absenceLabel.toUpperCase();
    truthPill.classList.remove("gps","open");
  }
  renderDietPanel();
      scheduleCorrectionSave(80);
    });
  });
}

async function request(path, options={}){
  const response=await fetch(api(path),{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
  const data=await response.json().catch(()=>({ok:false,error:`HTTP ${response.status}`}));
  if(!response.ok||data.ok===false) throw new Error(data.error||`HTTP ${response.status}`);
  return data;
}


function dietReportPeriod(dateISO=state.activeDate){
  const d=new Date(`${dateISO}T12:00:00`);
  let from,to;
  if(d.getDate()>=16){
    from=new Date(d.getFullYear(),d.getMonth(),16,12);
    to=new Date(d.getFullYear(),d.getMonth()+1,15,12);
  }else{
    from=new Date(d.getFullYear(),d.getMonth()-1,16,12);
    to=new Date(d.getFullYear(),d.getMonth(),15,12);
  }
  const iso=x=>`${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
  return {from:iso(from),to:iso(to)};
}

function dietMinutesLabel(total){
  total=Math.max(0,Math.round(Number(total)||0));
  return total ? `${Math.floor(total/60)}:${String(total%60).padStart(2,"0")}` : "–";
}

function dietPrintReport(data,{mode="summary",popup=null}={}){
  const escape=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const dateLabel=iso=>new Intl.DateTimeFormat("de-AT",{weekday:"short",day:"2-digit",month:"2-digit",year:"numeric"}).format(new Date(`${iso}T12:00:00`));
  const periodLabel=`${shortDate(data.from)} – ${shortDate(data.to)}`;
  const totalsFor=employee=>(employee.rows||[]).reduce((sum,row)=>({
    taggeld:sum.taggeld+Number(row.taggeld||0),
    flMinutes:sum.flMinutes+Number(row.flMinutes||0),
    flDay:sum.flDay+Number(row.flDay||0),
    chMinutes:sum.chMinutes+Number(row.chMinutes||0),
    chDay:sum.chDay+Number(row.chDay||0),
  }),{taggeld:0,flMinutes:0,flDay:0,chMinutes:0,chDay:0});

  const employees=[...(data.employees||[])].sort((a,b)=>{
    const na=Number(String(a.personalNumber||"").replace(/\D/g,""))||999999;
    const nb=Number(String(b.personalNumber||"").replace(/\D/g,""))||999999;
    return na-nb||String(a.employeeName||"").localeCompare(String(b.employeeName||""),"de");
  });

  const summaryRows=employees.map(employee=>{
    const total=totalsFor(employee);
    return `<tr>
      <td>${escape(employee.personalNumber||"–")}</td>
      <td>${escape(employee.employeeName)}<br><small>${escape(({maler:"Maler · Taggeld",buak:"BUAK",site6:"Baustelle ≥ 6 Std.",none:"Kein Taggeld"})[employee.dailyAllowanceModel]||"")}</small></td>
      <td>${total.taggeld||"–"}</td>
      <td>${dietMinutesLabel(total.flMinutes)}</td>
      <td>${total.flDay||"–"}</td>
      <td>${dietMinutesLabel(total.chMinutes)}</td>
      <td>${total.chDay||"–"}</td>
    </tr>`;
  }).join("");

  const overall=employees.reduce((sum,e)=>{
    const t=totalsFor(e);
    sum.taggeld+=t.taggeld;sum.flMinutes+=t.flMinutes;sum.flDay+=t.flDay;sum.chMinutes+=t.chMinutes;sum.chDay+=t.chDay;
    return sum;
  },{taggeld:0,flMinutes:0,flDay:0,chMinutes:0,chDay:0});

  const summaryPage=`<section class="diet-page summary-page">
    <header><div><small>FARBEN KRISTA · DIÄTEN & ENTSENDUNG</small><h1>Zusammenfassung</h1></div><strong>${escape(periodLabel)}</strong></header>
    <table class="summary-table">
      <thead><tr><th>Pers.Nr.</th><th>Name</th><th>Taggeld</th><th>FL Std.</th><th>FL Tage</th><th>CH Std.</th><th>CH Tage</th></tr></thead>
      <tbody>${summaryRows}</tbody>
      <tfoot><tr><th></th><th>GESAMT</th><th>${overall.taggeld||"–"}</th><th>${dietMinutesLabel(overall.flMinutes)}</th><th>${overall.flDay||"–"}</th><th>${dietMinutesLabel(overall.chMinutes)}</th><th>${overall.chDay||"–"}</th></tr></tfoot>
    </table>
  </section>`;

  const detailPages=mode==="detail"?employees.map(employee=>{
    const total=totalsFor(employee);
    const body=(employee.rows||[]).map(row=>`<tr>
      <td>${escape(dateLabel(row.date))}</td><td>${row.taggeld||"–"}</td><td>${dietMinutesLabel(row.flMinutes)}</td><td>${row.flDay||"–"}</td><td>${dietMinutesLabel(row.chMinutes)}</td><td>${row.chDay||"–"}</td>
    </tr>`).join("");
    return `<section class="diet-page">
      <header><div><small>FARBEN KRISTA · DIÄTENNACHWEIS</small><h1>${escape(employee.personalNumber?employee.personalNumber+" · ":"")}${escape(employee.employeeName)}</h1></div><strong>${escape(periodLabel)}</strong></header>
      <table><thead><tr><th>Datum</th><th>Taggeld</th><th>FL Std.</th><th>FL Tag</th><th>CH Std.</th><th>CH Tag</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><th>SUMME</th><th>${total.taggeld}</th><th>${dietMinutesLabel(total.flMinutes)}</th><th>${total.flDay}</th><th>${dietMinutesLabel(total.chMinutes)}</th><th>${total.chDay}</th></tr></tfoot>
      </table>
    </section>`;
  }).join(""):"";

  popup=popup||window.open("","_blank");
  if(!popup)return toast("Popup blockiert – bitte Popups für KRISTOOL erlauben.",true);
  popup.document.open();
  popup.document.write(`<!doctype html><html lang="de"><head><meta charset="utf-8">
    <title>Diäten ${escape(data.from)} bis ${escape(data.to)}</title>
    <style>
      @page{size:A4 portrait;margin:10mm}*{box-sizing:border-box}
      body{font-family:Arial,Helvetica,sans-serif;color:#202620;margin:0}
      .diet-page{page-break-after:always;min-height:276mm;padding:0 1mm}.diet-page:last-child{page-break-after:auto}
      header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:3px solid #1f5134;padding:0 0 7px;margin:0 0 8px}
      header small{font-size:8.5px;letter-spacing:.13em;color:#647168;font-weight:700}h1{font-size:18px;color:#1f5134;margin:3px 0 0}header strong{font-size:11px;white-space:nowrap}
      table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9.5px}
      th,td{height:6.15mm;padding:2.4px 6px;border-bottom:1px solid #dde2de;text-align:right}
      th:first-child,td:first-child{text-align:left;width:31%}
      thead th{background:#eaf1ec;color:#234b32;font-weight:800}tbody tr:nth-child(even){background:#fafafa}
      tfoot th{font-weight:900;border-top:2px solid #789180;background:#f1f5f2}
      .summary-table th:nth-child(1),.summary-table td:nth-child(1){width:11%;text-align:left}
      .summary-table th:nth-child(2),.summary-table td:nth-child(2){width:31%;text-align:left}
      .summary-page h1{font-size:22px}
      @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
    </style></head><body>${summaryPage}${detailPages}</body></html>`);
  popup.document.close();
  popup.focus();
  setTimeout(()=>popup.print(),250);
}

function openDietReport(){
  const period=dietReportPeriod();
  $("dietFrom").value=period.from;
  $("dietTo").value=period.to;
  document.querySelector('input[name="dietMode"][value="summary"]').checked=true;
  $("dietReportStatus").textContent="Standard: nur Zusammenfassung.";
  $("dietReportModal").hidden=false;
}
function closeDietReport(){ $("dietReportModal").hidden=true; }
async function createDietReport(){
  const from=$("dietFrom").value,to=$("dietTo").value;
  if(!from||!to||from>to)return toast("Zeitraum prüfen.",true);
  const mode=document.querySelector('input[name="dietMode"]:checked')?.value||"summary";
  // Wichtig: Popup direkt im echten Klick öffnen. Nach einem await blockiert Chrome es sonst.
  const popup=window.open("","_blank");
  if(!popup)return toast("Popup blockiert – bitte Popups für KRISTOOL erlauben.",true);
  popup.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Diätenbericht</title></head><body style="font-family:Arial;padding:30px">Diätenbericht wird erstellt …</body></html>');
  popup.document.close();

  const btn=$("createDietReport");btn.disabled=true;btn.textContent="Bericht wird erstellt …";
  try{
    const data=await request(`/kristine/api/diet-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    dietPrintReport(data,{mode,popup});
    closeDietReport();
  }catch(error){
    try{popup.close()}catch{}
    toast(`Diätenbericht: ${error.message}`,true);
  }finally{btn.disabled=false;btn.textContent="PDF öffnen"}
}

// 0023.52 · Mitarbeiter-Arbeitslogik
function employeeLogicDefaults(employee){
  const id=String(employee?.id||employee?.employeeId||"");
  const saved=(state.bootstrap?.employeeWorkRules||{})[id]||{};
  return {
    activityMode:["productive","partial","unproductive"].includes(saved.activityMode)
      ? saved.activityMode
      : "productive",
    buak:saved.buak===true
  };
}

function renderEmployeeLogic(){
  const list=$("employeeLogicList");
  if(!list)return;
  const employees=(state.bootstrap?.employees||[]).filter(e=>e.active!==false);
  list.innerHTML=employees.map(employee=>{
    const id=String(employee.id||employee.employeeId||"");
    const rule=employeeLogicDefaults(employee);
    const fink=employee.finkzeitPersonnelNumber||
      employee.finkzeitPersonalNumber||
      employee.personalnummerFinkzeit||
      employee.personnelNumber||
      employee.personalNumber||"";
    return `<div class="logic-row" data-employee-id="${esc(id)}">
      <div class="logic-person">
        <strong>${esc(employee.name||employee.employeeName||id)}</strong>
        <small>${fink?`Finkzeit ${esc(fink)}`:"keine Finkzeit-Nr."}</small>
      </div>
      <label>TÄTIGKEIT
        <select data-logic-field="activityMode">
          <option value="productive" ${rule.activityMode==="productive"?"selected":""}>Produktiv</option>
          <option value="partial" ${rule.activityMode==="partial"?"selected":""}>Teilproduktiv</option>
          <option value="unproductive" ${rule.activityMode==="unproductive"?"selected":""}>Unproduktiv</option>
        </select>
      </label>
      <label class="logic-buak">
        <input type="checkbox" data-logic-field="buak" ${rule.buak?"checked":""}> BUAK
      </label>
    </div>`;
  }).join("");
}

function openEmployeeLogic(){
  renderEmployeeLogic();
  const status=$("employeeLogicStatus");
  if(status)status.textContent="Produktiv / BUAK Nein ist Standard.";
  const modal=$("employeeLogicModal");
  if(modal)modal.hidden=false;
}

function closeEmployeeLogic(){
  const modal=$("employeeLogicModal");
  if(modal)modal.hidden=true;
}

async function saveEmployeeLogic(){
  const rules={};
  document.querySelectorAll(".logic-row[data-employee-id]").forEach(row=>{
    const id=String(row.dataset.employeeId||"");
    if(!id)return;
    rules[id]={
      activityMode:row.querySelector("[data-logic-field='activityMode']")?.value||"productive",
      buak:row.querySelector("[data-logic-field='buak']")?.checked===true
    };
  });

  const button=$("saveEmployeeLogic");
  if(button){button.disabled=true;button.textContent="Speichert …";}
  try{
    const data=await request("/kristine/api/employee-work-rules",{
      method:"PUT",
      body:JSON.stringify({rules})
    });
    state.bootstrap.employeeWorkRules=data.rules||{};
    const status=$("employeeLogicStatus");
    if(status)status.textContent="Gespeichert.";
    toast("Mitarbeiter-Arbeitslogik gespeichert.");
  }catch(error){
    const status=$("employeeLogicStatus");
    if(status)status.textContent=error.message;
    toast(`Arbeitslogik: ${error.message}`,true);
  }finally{
    if(button){button.disabled=false;button.textContent="Arbeitslogik speichern";}
  }
}

async function init(){
  try{
    const data=await request("/kristine/api/bootstrap");
    state.bootstrap=data;
    state.gpsImport=data.gpsImport||null;
    state.groups=state.gpsImport?.groups||[];
    const queryDate=new URLSearchParams(location.search).get("date");
    state.activeDate=/^\d{4}-\d{2}-\d{2}$/.test(queryDate||"")?queryDate:(data.today||new Date().toISOString().slice(0,10));
    $("dateSelect").value=state.activeDate;
    renderEmployees();
    renderImport();
    renderDateHeading();
    refreshDriversForActiveDate();
    await loadDayQueue();
  }catch(error){ toast(`Startfehler: ${error.message}`,true); }
}

function renderEmployees(){
  const employees=state.bootstrap?.employees||[];
  const select=$("employeeSelect");
  select.innerHTML='<option value="">Mitarbeiter wählen</option>'+employees.map(e=>`<option value="${esc(e.id||e.employeeId)}">${esc(e.nickname?`${e.nickname} ${String(e.name||"").split(/\s+/).slice(1).join(" ")}`:(e.name||e.employeeName))}</option>`).join("");
}


async function loadDayQueue(){
  if(!state.activeDate)return;
  try{
    const data=await request(`/kristine/api/day-queue/${encodeURIComponent(state.activeDate)}`);
    state.dayQueue=data.items||[];
    renderDayQueue();
  }catch(error){
    console.warn("Tagesarbeitsliste konnte nicht geladen werden:",error);
    state.dayQueue=[];
    renderDayQueue();
  }
}

function activeQueueItem(){
  const id=String($("employeeSelect")?.value||state.activeEmployeeId||"");
  return (state.dayQueue||[]).find(item=>String(item.employeeId)===id)||null;
}
function absenceSyntheticSegment(item){
  const type=String(item?.absenceType||"").toLowerCase();
  if(!["urlaub","krank","feiertag","arzt","za"].includes(type))return null;
  const label=type==="urlaub"?"Urlaub":type==="krank"?"Krank":type==="feiertag"?"Feiertag":type==="arzt"?"Arzt":"ZA";

  // Arzt ist KEINE automatische Ganztags-Abwesenheit:
  // Es zählt nur die bestätigte Dauer. Von/Bis muss deshalb im Büro eingetragen werden.
  if(type==="arzt"){
    return {
      id:`absence_${item.employeeId}_${state.activeDate}_${type}`,
      type:"up",
      from:"",
      to:"",
      jobId:"",
      jobName:label,
      reason:label,
      billingType:"",
      syntheticAbsence:true,
      lockedAbsence:false,
      absenceType:type,
      paidAbsence:true,
      countsAsWorkTime:true,
      requiresConfirmation:true
    };
  }

  return {
    id:`absence_${item.employeeId}_${state.activeDate}_${type}`,
    type:"up",
    from:"07:00",
    to:"14:48",
    jobId:"",
    jobName:label,
    reason:label,
    billingType:"",
    syntheticAbsence:true,
    lockedAbsence:true,
    absenceType:type,
    paidAbsence:["urlaub","krank","feiertag"].includes(type),
    countsAsWorkTime:["urlaub","krank","feiertag"].includes(type),
    countsAgainstOvertime:type==="za"
  };
}
function applyAbsenceToDaySegments(){
  const synthetic=absenceSyntheticSegment(activeQueueItem());
  if(!synthetic)return false;
  if((state.segments||[]).length)return false;
  state.segments=[synthetic];
  state.originalSegments=[{...synthetic}];
  return true;
}

function queueStatus(item){
  const absence=String(item.absenceType||item.cardType||"").toLowerCase();
  const isAbsent=["urlaub","krank","feiertag","arzt","za"].includes(absence);
  const gpsCount=Number(item.gpsTripCount||item.tripCount||0);
  if(isAbsent&&gpsCount>0)return {label:`${absence.toUpperCase()} + GPS`,cls:"warning"};
  if(isAbsent)return {
    label:absence==="urlaub"?"Urlaub":
      absence==="krank"?"Krank":
      absence==="feiertag"?"Feiertag":
      absence==="arzt"?"Arzt":"ZA",
    cls:"absence"
  };
  if(item.released)return {label:"Freigegeben",cls:"released"};
  if(item.role==="driver"){
    const plates=(item.vehicles||[]).map(vehicle=>vehicle.licensePlate).filter(Boolean);
    return {
      label:plates.length?plates.join(", "):`${item.ownTripCount||0} Fahrten`,
      cls:"driver"
    };
  }
  if(item.passengerDrivers?.length){
    return {
      label:`Mit ${item.passengerDrivers.join(", ")}`,
      cls:"prepared"
    };
  }
  if(item.copiedCorrection){
    return {label:"Team vorbereitet",cls:"corrected"};
  }
  if(item.segmentCount){
    return {label:"Zeit vorhanden",cls:"prepared"};
  }
  return {label:"noch zuordnen",cls:"waiting"};
}

function setQueueSummaryCard(id,stateValue){
  const strong=$(id); if(!strong)return;
  const card=strong.closest("span");
  if(!card)return;
  card.classList.remove("status-ok","status-open","status-na");
  card.classList.add(stateValue==="ok"?"status-ok":stateValue==="open"?"status-open":"status-na");
}
function applyQueueSummaryStatus(drivers,team){
  const driverState=drivers.length===0?"na":drivers.every(item=>item.released===true)?"ok":"open";
  const teamState=team.length===0?"na":team.every(item=>item.released===true)?"ok":"open";

  setQueueSummaryCard("queueDriverCount",driverState);
  setQueueSummaryCard("queueTeamCount",teamState);

  // Regie wird erst mit dem fertigen Regiemodul wirklich ausgewertet.
  $("queuePreparedCount").textContent="–";
  setQueueSummaryCard("queuePreparedCount","na");

  const required=[driverState,teamState].filter(x=>x!=="na");
  const dayDone=required.length>0 && required.every(x=>x==="ok");
  document.querySelector(".date-workbench")?.classList.toggle("day-complete",dayDone);
}

function renderDayQueue(){
  const drivers=state.dayQueue
    .filter(item=>item.role==="driver")
    .sort((a,b)=>a.employeeName.localeCompare(b.employeeName,"de"));
  const team=state.dayQueue
    .filter(item=>item.role!=="driver")
    .sort((a,b)=>{
      const aPrepared=Boolean(a.passengerDrivers?.length||a.copiedCorrection||a.segmentCount);
      const bPrepared=Boolean(b.passengerDrivers?.length||b.copiedCorrection||b.segmentCount);
      return Number(bPrepared)-Number(aPrepared)||a.employeeName.localeCompare(b.employeeName,"de");
    });

  $("queueDriverCount").textContent=drivers.length;
  $("queueTeamCount").textContent=team.length;
  $("queuePreparedCount").textContent="–";

  const renderItem=item=>{
    const status=queueStatus(item);
    const detail=item.role==="driver"
      ? `${item.ownTripCount||0} Fahrten${item.distanceKm?` · ${km(item.distanceKm)}`:""}`
      : item.passengerDrivers?.length
        ? `Mitfahrer zugeordnet${item.segmentCount?` · ${item.segmentCount} Zeitblöcke`:""}`
        : item.segmentCount
          ? `${item.segmentCount} KRISTINE-Zeitblöcke`
          : "Noch keiner Fahrer-Tagesfolie zugeordnet";
    return `<button class="work-queue-item ${item.released?"released":"unreleased"} ${state.activeEmployeeId===String(item.employeeId)?"active":""}"
      data-employee-id="${esc(item.employeeId)}"
      data-driver-key="${esc(item.driverKey||"")}">
      <span class="queue-avatar">${esc(initials(item.employeeName))}</span>
      <span class="queue-copy">
        <strong>${esc(item.employeeName)}</strong>
        <small>${esc(detail)}</small>
      </span>
      <span class="queue-state ${status.cls}">${esc(status.label)}</span>
    </button>`;
  };

  $("driverWorkQueue").innerHTML=drivers.length
    ? drivers.map(renderItem).join("")
    : `<div class="queue-empty">Für diese Tagesfolie wurden keine Fahrer erkannt.</div>`;

  $("teamWorkQueue").innerHTML=team.length
    ? team.map(renderItem).join("")
    : `<div class="queue-empty">Alle Mitarbeiter fahren heute selbst oder es gibt keine weiteren Teammitglieder.</div>`;

  document.querySelectorAll(".work-queue-item").forEach(button=>{
    button.addEventListener("click",()=>openQueueEmployee(button.dataset.employeeId,button.dataset.driverKey));
  });
  applyQueueSummaryStatus(drivers,team);
}
async function openQueueEmployee(employeeId,driverKey=""){
  if(!employeeId)return toast("Dieser Fahrer konnte keinem Mitarbeiter zugeordnet werden.",true);
  state.activeEmployeeId=String(employeeId);
  $("employeeSelect").value=String(employeeId);
  const group=groupsForDate(state.activeDate).find(row=>
    (driverKey&&row.driverKey===driverKey)||String(row.employeeId||"")===String(employeeId)
  );
  $("driverSelect").value=group?.key||"";
  renderDayQueue();
  await loadDay();
}

function renderImport(){
  const imp=state.gpsImport;
  const banner=$("sourceBanner");
  if(!imp){
    banner.querySelector(".dot").className="dot grey";
    banner.querySelector("strong").textContent="Noch kein GPS-Bericht übernommen";
    banner.querySelector("small").textContent="Wähle zuerst die Tagesfolie und übernimm danach den passenden GPS-Bericht.";
    $("sourceMetrics").innerHTML="";
    return;
  }
  banner.querySelector(".dot").className="dot green";
  banner.querySelector("strong").textContent=`${imp.filename} übernommen`;
  banner.querySelector("small").textContent=`Importiert ${new Date(imp.importedAt).toLocaleString("de-AT")}`;
  $("sourceMetrics").innerHTML=`<span><strong>${imp.rowCount}</strong> Fahrten</span><span><strong>${new Set(imp.groups.map(g=>g.driverKey)).size}</strong> Fahrer</span><span><strong>${uniqueDates().length}</strong> Tage</span>`;
}

function renderDateHeading(){
  const date=state.activeDate;
  $("activeDateLabel").textContent=deDate(date);
  $("activeDateShort").textContent=shortDate(date);
  const hasGps=groupsForDate(date).length>0;
  $("dateGpsState").textContent=hasGps?"GPS vorhanden":"noch kein GPS für diesen Tag";
  $("dateGpsState").className=hasGps?"date-state ok":"date-state open";
  const url=new URL(location.href);
  url.searchParams.set("date",date);
  history.replaceState(null,"",url);
}

function setActiveDate(date,{load=false}={}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||"")))return;
  state.activeDate=date;
  $("dateSelect").value=date;
  clearDay();
  renderDateHeading();
  refreshDriversForActiveDate();
  hideDateMismatch();
  loadDayQueue();
  if(load && $("employeeSelect").value) loadDay();
}

function refreshDriversForActiveDate(){
  const select=$("driverSelect");
  const dateGroups=groupsForDate(state.activeDate);
  if(!state.gpsImport){
    select.innerHTML='<option value="">Bitte zuerst GPS übernehmen</option>';
    return;
  }
  if(!dateGroups.length){
    select.innerHTML=`<option value="">Keine GPS-Daten am ${esc(shortDate(state.activeDate))}</option>`;
    return;
  }
  select.innerHTML='<option value="">GPS-Fahrer wählen</option>'+dateGroups.map(g=>{
    const plates=(g.vehicles||[]).map(v=>v.licensePlate).filter(Boolean);
    const vehicleLabel=plates.length?[...new Set(plates)].join(", "):(g.licensePlate||g.vehicleName||"");
    return `<option value="${esc(g.key)}">${esc(g.driverName)} · ${g.trips} Fahrten · ${esc(vehicleLabel)}</option>`;
  }).join("");
  if(dateGroups.length===1){
    select.value=dateGroups[0].key;
    applyGroup(dateGroups[0]);
  }
}

function selectedGroup(){ return state.groups.find(g=>g.key===$("driverSelect").value)||null; }
function applyGroup(group){
  if(!group)return;
  if(group.employeeId) $("employeeSelect").value=group.employeeId;
}
$("driverSelect").addEventListener("change",()=>applyGroup(selectedGroup()));

function showDateMismatch(dates){
  const panel=$("dateMismatch");
  const active=state.activeDate;
  panel.hidden=false;
  panel.innerHTML=`
    <div class="mismatch-icon">📅</div>
    <div class="mismatch-copy">
      <strong>Der GPS-Bericht gehört zu ${dates.length===1?"einem anderen Tag":"anderen Tagen"}.</strong>
      <p>Geöffnete Tagesfolie: <b>${esc(deDate(active))}</b></p>
      <div class="date-choice-list">
        ${dates.map(date=>`<button class="date-choice" data-date="${esc(date)}">Tagesfolie ${esc(shortDate(date))} öffnen</button>`).join("")}
        <button class="date-choice cancel" data-cancel="1">Tagesfolie ${esc(shortDate(active))} behalten</button>
      </div>
    </div>`;
  panel.querySelectorAll("button[data-date]").forEach(button=>button.addEventListener("click",()=>{
    setActiveDate(button.dataset.date);
    toast(`Tagesfolie auf ${shortDate(button.dataset.date)} gewechselt.`);
  }));
  panel.querySelector("button[data-cancel]")?.addEventListener("click",()=>{
    hideDateMismatch();
    toast("GPS-Bericht gespeichert. Die geöffnete Tagesfolie bleibt unverändert.");
  });
}
function hideDateMismatch(){ const panel=$("dateMismatch"); panel.hidden=true; panel.innerHTML=""; }

async function importFile(file){
  if(!file)return;
  if(!file.name.toLowerCase().endsWith(".csv")) return toast("Bitte eine CSV-Datei auswählen.",true);
  try{
    const content=await file.text();
    toast("GPS-Bericht wird übernommen …");
    const data=await request("/kristine/api/gps/import",{method:"POST",body:JSON.stringify({filename:file.name,content})});
    state.gpsImport=data.import;
    state.groups=data.import.groups||[];
    renderImport();
    renderDateHeading();
    refreshDriversForActiveDate();
    await loadDayQueue();
    const dates=uniqueDates();
    if(dates.includes(state.activeDate)){
      hideDateMismatch();
      toast(`${data.import.rowCount} GPS-Fahrten übernommen. Tagesfolie ${shortDate(state.activeDate)} ist bereit.`);
    }else{
      showDateMismatch(dates);
      toast(`${data.import.rowCount} GPS-Fahrten erkannt – Datum bitte prüfen.`);
    }
  }catch(error){ toast(`GPS konnte nicht übernommen werden: ${error.message}`,true); }
}

$("chooseFile").addEventListener("click",()=>$("csvFile").click());
$("csvFile").addEventListener("change",e=>importFile(e.target.files?.[0]));
const drop=$("dropZone");
["dragenter","dragover"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.add("drag")}));
["dragleave","drop"].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.remove("drag")}));
drop.addEventListener("drop",e=>importFile(e.dataTransfer.files?.[0]));

$("dateSelect").addEventListener("change",e=>setActiveDate(e.target.value));
$("previousDay").addEventListener("click",()=>setActiveDate(addDays(state.activeDate,-1)));
$("nextDay").addEventListener("click",()=>setActiveDate(addDays(state.activeDate,1)));
$("todayDay").addEventListener("click",()=>setActiveDate(state.bootstrap?.today||new Date().toISOString().slice(0,10)));


$("saveMapping").addEventListener("click",async()=>{
  const group=selectedGroup(), employeeId=$("employeeSelect").value;
  if(!group||!employeeId)return toast("GPS-Fahrer und Mitarbeiter auswählen.",true);
  const option=$("employeeSelect").selectedOptions[0];
  try{
    const data=await request(`/kristine/api/gps/imports/${encodeURIComponent(state.gpsImport.id)}/mapping`,{method:"PUT",body:JSON.stringify({driverKey:group.driverKey,employeeId,employeeName:option.textContent})});
    state.gpsImport=data.import;
    state.groups=data.import.groups;
    renderImport();
    refreshDriversForActiveDate();
    const refreshed=groupsForDate(state.activeDate).find(g=>g.driverKey===group.driverKey);
    if(refreshed){ $("driverSelect").value=refreshed.key; applyGroup(refreshed); }
    await loadDayQueue();
    toast("Zuordnung wurde gemerkt.");
  }catch(error){toast(error.message,true)}
});

$("loadDay").addEventListener("click",loadDay);
async function loadDay(){
  const group=selectedGroup();
  const employeeId=$("employeeSelect").value;
  state.activeEmployeeId=String(employeeId||"");
  const date=state.activeDate;
  if(!employeeId||!date)return toast("Mitarbeiter und Tagesfolie auswählen.",true);
  if(group && group.date!==date)return toast("Der gewählte GPS-Fahrer gehört nicht zur geöffneten Tagesfolie.",true);
  try{
    const requests=[request(`/kristine/api/segments/${encodeURIComponent(employeeId)}/${encodeURIComponent(date)}`)];
    if(state.gpsImport){
      requests.unshift(request(`/kristine/api/gps/employee-day?importId=${encodeURIComponent(state.gpsImport.id)}&employeeId=${encodeURIComponent(employeeId)}&date=${encodeURIComponent(date)}`));
    }
    const results=await Promise.all(requests);
    const gps=state.gpsImport?results[0]:{ownRows:[],passengerRows:[]};
    const seg=state.gpsImport?results[1]:results[0];
    state.dayRows=gps.ownRows||[];
    state.passengerRows=gps.passengerRows||[];
    state.segments=(seg.segments||[]).map(row=>({...row}));
    state.originalSegments=(seg.originalSegments||seg.segments||[]).map(row=>({...row}));
    state.correction=seg.correction||null;
    state.dietOverride=parseDietOverride(state.correction?.note||"");
    applyAbsenceToDaySegments();
    const lunchFix=hasForeignSiteWork(state.segments)
      ? enforceMinimumLunch(state.segments)
      : {changed:false,totalShift:0};
    renderDay(group,date);
    await loadRelease();
    if(lunchFix.changed){
      const action=lunchFix.mode==="inserted"?"60 Minuten Mittag automatisch eingefügt":"Mittag auf 60 Minuten verlängert";
      toast(`FL/CH-Tag: ${action} · Tagesende +${lunchFix.totalShift} min.`);
      renderSegments();
      scheduleCorrectionSave(120);
    }
  }catch(error){toast(`Tagesfolie konnte nicht geöffnet werden: ${error.message}`,true)}
}

function clearDay(){
  state.dayRows=[];
  state.passengerRows=[];
  state.segments=[];
  state.originalSegments=[];
  state.correction=null;
  state.dietOverride=null;
  state.release=null;
  renderRelease();
  $("personBadge").textContent="?";
  $("dayTitle").textContent=`Tagesfolie ${deDate(state.activeDate)}`;
  $("daySubtitle").textContent="Mitarbeiter auswählen und Tagesfolie öffnen.";
  $("kristineSegments").className="timeline empty";
  $("kristineSegments").textContent="Noch keine Tagesfolie geöffnet.";
  $("gpsTrips").className="trips empty";
  $("gpsTrips").textContent=groupsForDate(state.activeDate).length?"GPS-Daten vorhanden – Fahrer wählen.":"Für diesen Tag wurden noch keine GPS-Daten übernommen.";
  $("kristineTotal").textContent="–";
  $("gpsTripCount").textContent="–";
  $("gpsDistance").textContent="–";
  $("gpsPrivate").textContent="–";
  $("gpsVehicles").hidden=true;
  $("gpsVehicles").innerHTML="";
  $("correctionToolbar").hidden=true;
  $("segmentActions").hidden=true;
  $("correctionHistory").hidden=true;
  $("correctionHistory").innerHTML="";
  $("checkKristine").textContent="noch nicht geladen";
  $("checkGps").textContent=groupsForDate(state.activeDate).length?"GPS vorhanden":"noch kein GPS für diesen Tag";
  $("teamTransfer").hidden=true;
  $("teamTransferBody").hidden=true;
  state.teamCandidates=[];
}


function absenceLabelForItem(item){
  const type=String(item?.absenceType||"").toLowerCase();
  return type==="urlaub"?"Urlaub":
    type==="krank"?"Krank":
    type==="feiertag"?"Feiertag":
    type==="arzt"?"Arzt":
    type==="za"?"ZA":"";
}
function renderDay(group,date){
  const absenceLabel=absenceLabelForItem(activeQueueItem());
  const employee=$("employeeSelect").selectedOptions[0]?.textContent||group?.driverName||"Mitarbeiter";
  $("personBadge").textContent=initials(employee);
  $("dayTitle").textContent=`${employee} · ${deDate(date)}`;
  if(state.dayRows.length){
    const drivers=[...new Set(state.dayRows.map(row=>row.effectiveDriver?.employeeName||row.assignedEmployeeName||row.driverName).filter(Boolean))];
    const vehicles=[...new Set(state.dayRows.map(row=>row.licensePlate||row.vehicleName).filter(Boolean))];
    $("daySubtitle").textContent=`GPS-Fahrer: ${drivers.join(", ")} · ${vehicles.join(", ")||"Fahrzeug nicht angegeben"}`;
  }else if(state.passengerRows.length){
    const drivers=[...new Set(state.passengerRows.map(row=>row.driver?.employeeName).filter(Boolean))];
    $("daySubtitle").textContent=`Mitgefahren mit ${drivers.join(", ")}`;
  }else $("daySubtitle").textContent="KRISTINE-Zeiten ohne eigene GPS-Fahrt";
  renderSegments();
  renderTrips();
  setPhase("times");
  renderDayQueue();
  loadTeamCandidates();
  renderDietPanel();
}
function normalizeTimeInput(value){
  let raw=String(value||"").trim().replace(/[^0-9:]/g,"");
  if(/^\d{3,4}$/.test(raw)) raw=raw.padStart(4,"0").replace(/^(\d{2})(\d{2})$/,"$1:$2");
  if(/^\d{1,2}:\d{1,2}$/.test(raw)){
    const [h,m]=raw.split(":").map(Number);
    if(h>=0&&h<=23&&m>=0&&m<=59)return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }
  return null;
}
function cloneSegments(rows){ return (rows||[]).map(row=>({...row})); }
function workMinutes(rows){
  return (rows||[]).reduce((sum,row)=>{
    const a=minutes(row.from),b=minutes(row.to);
    if(a===null||b===null)return sum;
    const duration=Math.max(0,b-a);

    // Produktive Baustellenarbeit zählt als Arbeitszeit.
    if(row.type==="work")return sum+duration;

    // UP = unproduktive, aber grundsätzlich bezahlte Arbeitszeit.
    // Beispiele: Büro, Werkstatt, Schulung, Arzt laut Bestätigung usw.
    // Ausnahme: ZA ist bewusst KEINE Arbeitszeit.
    if(row.type==="up"){
      const reason=String(row.reason||row.jobName||row.absenceType||"").toLowerCase();
      const isZA=row.countsAgainstOvertime===true || /zeitausgleich|(^|[^a-z])za([^a-z]|$)/.test(reason);
      if(isZA)return sum;
      return sum+duration;
    }

    // Pause / Mittag zählen nicht als Arbeitszeit.
    return sum;
  },0);
}
const KRISTOOL_FINK_REASONS=[
  ["022","Büro"],["900","Urlaub"],["901","Krank"],["902","Arzt"],
  ["903","Berufsschule"],["904","Feiertag"],["905","Schulung extern"],
  ["909","Schulung intern"],["911","Sonderurlaub"],["912","Musterung"],
  ["913","Werkstatt"],["917","Firma aufräumen"],["918","Lehrlingswettbewerb"],
  ["927","Betriebsausflug"],["930","Zeitausgleich"],["945","Quarantäne"],
  ["946","Kurzarbeit"],["9999","Sanierung"]
];

function segmentLabel(type){
  return type==="work"?"Arbeitszeit":type==="lunch"?"Mittag":type==="up"?"Unproduktiv":"Pause";
}
function availableJobs(){
  const map=new Map();
  for(const a of state.bootstrap?.assignments||[]){
    const jobId=String(a.jobId||"").trim();
    const jobName=String(a.jobName||"").trim();
    if(!jobId&&!jobName)continue;
    const key=jobId||jobName.toLowerCase();
    if(!map.has(key))map.set(key,{jobId,jobName:jobName||jobId});
  }
  for(const row of [...state.originalSegments,...state.segments]){
    if(row.type!=="work")continue;
    const jobId=String(row.jobId||"").trim();
    const jobName=String(row.jobName||"").trim();
    if(!jobId&&!jobName)continue;
    const key=jobId||jobName.toLowerCase();
    if(!map.has(key))map.set(key,{jobId,jobName:jobName||jobId});
  }
  return [...map.values()].sort((a,b)=>
    String(a.jobName||"").localeCompare(String(b.jobName||""),"de",{numeric:true})
  );
}
function jobOptions(row){
  const selectedId=String(row.jobId||"");
  const selectedName=String(row.jobName||"");
  const jobs=availableJobs();
  const has=jobs.some(j=>(selectedId&&String(j.jobId)===selectedId)||(!selectedId&&selectedName&&j.jobName===selectedName));
  const legacy=!has&&(selectedId||selectedName)
    ? `<option value="${esc(selectedId)}" data-name="${esc(selectedName)}" selected>${esc([selectedId,selectedName].filter(Boolean).join(" · "))}</option>`
    : "";
  return `<option value="">– Baustelle wählen –</option>${legacy}`+
    jobs.map(j=>`<option value="${esc(j.jobId)}" data-name="${esc(j.jobName)}" ${selectedId&&String(j.jobId)===selectedId?"selected":(!selectedId&&selectedName===j.jobName?"selected":"")}>${esc([j.jobId,j.jobName].filter(Boolean).join(" · "))}</option>`).join("");
}
function finkReasonOptions(row){
  const selected=String(row.reason||"");
  const known=KRISTOOL_FINK_REASONS.some(([,label])=>label===selected);
  const legacy=selected&&!known?`<option value="${esc(selected)}" selected>${esc(selected)} · bisheriger Wert</option>`:"";
  return `<option value="">– Finkzeit-Art wählen –</option>${legacy}`+
    KRISTOOL_FINK_REASONS.map(([code,label])=>`<option value="${esc(label)}" ${label===selected?"selected":""}>${esc(code+" · "+label)}</option>`).join("");
}
function segmentContext(row,index){
  if(row.type==="work"){
    const billing=row.billingType==="regie"?"regie":"normal";
    return `<div class="segment-context work-context">
      <label>Baustelle<select class="segment-job" data-index="${index}" ${row.lockedAbsence?"disabled":""}>${jobOptions(row)}</select></label>
      <label>Verrechnung<select class="segment-billing" data-index="${index}" ${row.lockedAbsence?"disabled":""}>
        <option value="normal" ${billing==="normal"?"selected":""}>Normal</option>
        <option value="regie" ${billing==="regie"?"selected":""}>Regie</option>
      </select></label>
    </div>`;
  }
  if(row.type==="pause"||row.type==="lunch"){
    return `<div class="segment-context"><span class="fink-code-badge">003 · Pause / Mittag</span></div>`;
  }
  if(row.type==="up"){
    return `<div class="segment-context up-context">
      <label>Finkzeit / Abwesenheit<select class="segment-fink-reason" data-index="${index}">${finkReasonOptions(row)}</select></label>
    </div>`;
  }
  return "";
}
function originalForSegment(row,index){
  return state.originalSegments.find(item=>item.id===row.id)||state.originalSegments[index]||null;
}
function renderSegments(){
  const box=$("kristineSegments"),rows=state.segments;
  if(!rows.length){
    box.className="timeline empty";
    box.innerHTML="Für diesen Tag wurden keine KRISTINE-Zeitblöcke gefunden.";
    $("kristineTotal").textContent="0:00 h";
    $("checkKristine").textContent="keine Zeitblöcke gefunden";
    $("correctionToolbar").hidden=true;
    $("segmentActions").hidden=false;
    renderCorrectionHistory();
    renderDietPanel();
    return;
  }
  $("correctionToolbar").hidden=false;
  $("segmentActions").hidden=false;
  $("correctionReason").value=state.correction?.reason||"";
  $("correctionNote").value=visibleCorrectionNote(state.correction?.note||"");
  box.className="timeline correction-list";
  box.innerHTML=rows.map((row,index)=>{
    const original=originalForSegment(row,index);
    const changed=!original||
      original.from!==row.from||original.to!==row.to||original.type!==row.type||
      String(original.jobId||"")!==String(row.jobId||"")||
      String(original.jobName||"")!==String(row.jobName||"")||
      String(original.reason||"")!==String(row.reason||"")||
      String(original.billingType||"normal")!==String(row.billingType||"normal");
    return `<div class="segment-editor ${row.type} ${changed?"changed":""} ${row.requiresConfirmation?"requires-confirmation":""}" data-index="${index}" ${row.lockedAbsence?"":"draggable=\"true\""}>
      <div class="source-line"><span class="segment-dot"></span><div><b>${row.requiresConfirmation?"BESTÄTIGUNG":"Original"}</b><strong>${row.requiresConfirmation&&!row.from?"Von/Bis eintragen":`${esc(original?.from||row.from)}–${esc(original?.to||row.to||"offen")}`}</strong><small>${esc(original?.jobName||row.jobName||segmentLabel(original?.type||row.type))}</small></div><span class="source-duration">${row.requiresConfirmation&&!row.from?"nur bestätigte Dauer":durationLabel(Math.max(0,(minutes(original?.to)-minutes(original?.from))||0))}</span></div>
      <div class="office-line">
        <div class="office-title"><b>${row.lockedAbsence?"Büro":"↕ Büro"}</b><span>${changed?"KORRIGIERT":"UNVERÄNDERT"}</span></div>
        <select class="segment-type" data-index="${index}" aria-label="Art"><option value="work" ${row.type==="work"?"selected":""}>Arbeit</option><option value="pause" ${row.type==="pause"?"selected":""}>Pause</option><option value="lunch" ${row.type==="lunch"?"selected":""}>Mittag</option><option value="up" ${row.type==="up"?"selected":""}>Unproduktiv</option></select>
        <input class="time-input" data-field="from" data-index="${index}" value="${esc(row.from)}" inputmode="numeric" aria-label="Von">
        <span>–</span>
        <input class="time-input" data-field="to" data-index="${index}" value="${esc(row.to||"")}" inputmode="numeric" aria-label="Bis">
        ${row.lockedAbsence?"":`<button class="remove-segment danger-remove" data-index="${index}" title="Zeitblock löschen" aria-label="Zeitblock löschen">×</button>`}
        <strong class="office-duration">${durationLabel(Math.max(0,(minutes(row.to)-minutes(row.from))||0))}</strong>
        ${segmentContext(row,index)}
      </div>
    </div>`;
  }).join("");
  bindSegmentEditors();
  bindSegmentDragDrop();
  updateCorrectionTotals();
  renderCorrectionHistory();
  renderDietPanel();
}

let segmentDragIndex=null;
function moveSegment(fromIndex,toIndex){
  if(fromIndex===toIndex)return;
  const rows=state.segments||[];
  if(fromIndex<0||toIndex<0||fromIndex>=rows.length||toIndex>=rows.length)return;
  if(rows[fromIndex]?.lockedAbsence)return;
  const [row]=rows.splice(fromIndex,1);
  rows.splice(toIndex,0,row);
  renderSegments();
  scheduleCorrectionSave(80);
}
function bindSegmentDragDrop(){
  document.querySelectorAll(".segment-editor[draggable='true']").forEach(editor=>{
    editor.addEventListener("dragstart",event=>{
      segmentDragIndex=Number(editor.dataset.index);
      editor.classList.add("dragging");
      event.dataTransfer.effectAllowed="move";
      try{event.dataTransfer.setData("text/plain",String(segmentDragIndex));}catch{}
    });
    editor.addEventListener("dragend",()=>{
      segmentDragIndex=null;
      document.querySelectorAll(".segment-editor").forEach(x=>x.classList.remove("dragging","drag-over"));
    });
    editor.addEventListener("dragover",event=>{
      event.preventDefault();
      if(segmentDragIndex===null)return;
      editor.classList.add("drag-over");
      event.dataTransfer.dropEffect="move";
    });
    editor.addEventListener("dragleave",()=>editor.classList.remove("drag-over"));
    editor.addEventListener("drop",event=>{
      event.preventDefault();
      editor.classList.remove("drag-over");
      if(segmentDragIndex===null)return;
      moveSegment(segmentDragIndex,Number(editor.dataset.index));
    });
  });
}

function bindSegmentEditors(){
  document.querySelectorAll(".time-input").forEach(input=>{
    input.addEventListener("input",()=>{
      const index=Number(input.dataset.index), field=input.dataset.field;
      state.segments[index][field]=input.value;
      updateCorrectionTotals();
    });
    input.addEventListener("keydown",event=>{
      if(event.key==="Enter"){ event.preventDefault(); input.blur(); }
      if(event.key==="Escape"){ renderSegments(); }
    });
    input.addEventListener("blur",()=>{
      const normalized=normalizeTimeInput(input.value);
      if(!normalized){ toast("Bitte eine gültige Uhrzeit eingeben, z. B. 14:15.",true); return renderSegments(); }
      state.segments[Number(input.dataset.index)][input.dataset.field]=normalized;
      input.value=normalized;
      if(hasForeignSiteWork(state.segments))enforceMinimumLunch(state.segments);
      renderSegments();
      scheduleCorrectionSave(80);
    });
  });
  document.querySelectorAll(".segment-type").forEach(select=>select.addEventListener("change",()=>{
    const row=state.segments[Number(select.dataset.index)];
    row.type=select.value;
    if(row.type==="work"){
      row.reason="";
      row.billingType=row.billingType==="regie"?"regie":"normal";
    }else if(row.type==="up"){
      row.jobId=""; row.jobName=""; row.billingType="";
      if(!row.reason)row.reason="Werkstatt";
    }else{
      row.jobId=""; row.jobName=""; row.reason=""; row.billingType="";
    }
    if(row.type==="lunch"&&hasForeignSiteWork(state.segments))enforceMinimumLunch(state.segments);
    renderSegments();
    scheduleCorrectionSave(80);
  }));
  document.querySelectorAll(".segment-job").forEach(select=>select.addEventListener("change",()=>{
    const row=state.segments[Number(select.dataset.index)];
    row.jobId=select.value;
    row.jobName=select.selectedOptions[0]?.dataset.name||select.selectedOptions[0]?.textContent?.replace(/^\s*[^·]+·\s*/,"")||"";
    if(hasForeignSiteWork(state.segments))enforceMinimumLunch(state.segments);
    renderSegments();
    scheduleCorrectionSave(80);
  }));
  document.querySelectorAll(".segment-billing").forEach(select=>select.addEventListener("change",()=>{
    const row=state.segments[Number(select.dataset.index)];
    row.billingType=select.value==="regie"?"regie":"normal";
    scheduleCorrectionSave(80);
  }));
  document.querySelectorAll(".segment-fink-reason").forEach(select=>select.addEventListener("change",()=>{
    const row=state.segments[Number(select.dataset.index)];
    row.reason=select.value;
    scheduleCorrectionSave(80);
  }));
  document.querySelectorAll(".remove-segment").forEach(button=>button.addEventListener("click",()=>{
    const index=Number(button.dataset.index);
    const row=state.segments[index];
    const label=row?.type==="lunch"?"Mittag":row?.type==="pause"?"Pause":row?.type==="up"?"Unproduktiv":"Arbeitsblock";
    const time=[row?.from,row?.to].filter(Boolean).join("–");
    if(!confirm(`${label}${time?` ${time}`:""} wirklich löschen?`))return;
    state.segments.splice(index,1);
    renderSegments();
    scheduleCorrectionSave(80);
  }));
}
function updateCorrectionTotals(){
  const office=workMinutes(state.segments), original=workMinutes(state.originalSegments);
  $("kristineTotal").textContent=durationLabel(office);
  const diff=office-original;
  $("checkKristine").textContent=`Original ${durationLabel(original)} · Büro ${durationLabel(office)}${diff?` · ${diff>0?"+":""}${diff} min`:" · unverändert"}`;
  document.querySelectorAll(".segment-editor").forEach((editor,index)=>{
    const row=state.segments[index];
    const duration=editor.querySelector(".office-duration");
    if(duration)duration.textContent=durationLabel(Math.max(0,(minutes(row.to)-minutes(row.from))||0));
  });
}
function scheduleCorrectionSave(delay=450){
  if((state.segments||[]).length && (state.segments||[]).every(row=>row.lockedAbsence))return;
  clearTimeout(state.saveTimer);
  state.saveTimer=setTimeout(saveCorrection,delay);
}
async function saveCorrection(){
  const employeeId=$("employeeSelect").value;
  if(!employeeId)return;
  const invalid=state.segments.some(row=>!normalizeTimeInput(row.from)||!normalizeTimeInput(row.to));
  if(invalid)return;
  const employeeName=$("employeeSelect").selectedOptions[0]?.textContent||employeeId;
  try{
    const data=await request(`/kristine/api/segments/${encodeURIComponent(employeeId)}/${encodeURIComponent(state.activeDate)}`,{
      method:"PUT",
      body:JSON.stringify({employeeName,segments:state.segments,reason:$("correctionReason").value,note:correctionNoteWithDiet($("correctionNote").value),correctedBy:"Bettina / Büro"})
    });
    state.segments=cloneSegments(data.segments);
    state.originalSegments=cloneSegments(data.originalSegments||state.originalSegments);
    state.correction=data.correction||state.correction;
    state.dietOverride=parseDietOverride(state.correction?.note||correctionNoteWithDiet($("correctionNote").value));
    renderSegments();
    loadTeamCandidates();
    loadDayQueue();
    toast("Korrektur automatisch gespeichert.");
  }catch(error){ toast(`Korrektur nicht gespeichert: ${error.message}`,true); }
}
function renderCorrectionHistory(){
  const box=$("correctionHistory"),history=state.correction?.history||[];
  if(!history.length){ box.hidden=true; box.innerHTML=""; return; }
  const last=history.at(-1);
  box.hidden=false;
  box.innerHTML=`<strong>Letzte Korrektur</strong><span>${esc(last.by||state.correction.updatedBy||"Büro")} · ${new Date(last.at||state.correction.updatedAt).toLocaleString("de-AT")}${last.reason?` · ${esc(last.reason)}`:""}</span>`;
}
$("correctionReason").addEventListener("change",()=>scheduleCorrectionSave(100));
$("correctionNote").addEventListener("change",()=>scheduleCorrectionSave(100));
$("addWorkSegment").addEventListener("click",()=>addSegment("work"));
$("addPauseSegment").addEventListener("click",()=>addSegment("pause"));
$("addUpSegment")?.addEventListener("click",()=>addSegment("up"));
$("resetSegments").addEventListener("click",()=>{
  state.segments=cloneSegments(state.originalSegments);
  renderSegments();
  scheduleCorrectionSave(80);
});
function addSegment(type){
  const last=state.segments.at(-1);
  const from=last?.to||"07:00";
  const to=minutes(from)!==null?`${String(Math.floor((minutes(from)+30)/60)).padStart(2,"0")}:${String((minutes(from)+30)%60).padStart(2,"0")}`:"07:30";
  state.segments.push({
    id:`seg_${Date.now()}`,type,from,to,
    jobId:type==="work"?(last?.jobId||""):"",
    jobName:type==="work"?(last?.jobName||"Arbeitszeit"):"",
    reason:type==="up"?"Werkstatt":"",
    billingType:type==="work"?(last?.billingType==="regie"?"regie":"normal"):""
  });
  renderSegments();
}
function mapsUrl(row){
  const start=row.startLat&&row.startLng?`${row.startLat},${row.startLng}`:row.startLocation;
  const stop=row.stopLat&&row.stopLng?`${row.stopLat},${row.stopLng}`:row.stopLocation;
  if(!start||!stop)return "";
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(start)}&destination=${encodeURIComponent(stop)}&travelmode=driving`;
}
function employeeOptions(selectedId=""){
  const employees=state.bootstrap?.employees||[];
  return employees.map(employee=>{
    const id=String(employee.id||employee.employeeId||"");
    const name=String(employee.nickname?`${employee.nickname} ${String(employee.name||"").split(/\s+/).slice(1).join(" ")}`:(employee.name||employee.employeeName||id));
    return `<option value="${esc(id)}" ${id===String(selectedId)?"selected":""}>${esc(name)}</option>`;
  }).join("");
}
function openGpsDialog(title,html){
  $("gpsDialogTitle").textContent=title;
  $("gpsDialogBody").innerHTML=html;
  $("gpsDialog").hidden=false;
  document.body.classList.add("dialog-open");
}
function closeGpsDialog(){
  $("gpsDialog").hidden=true;
  $("gpsDialogBody").innerHTML="";
  document.body.classList.remove("dialog-open");
}
document.querySelectorAll("[data-close-dialog]").forEach(el=>el.addEventListener("click",closeGpsDialog));
function rideCard(row,{passenger=false}={}){
  const url=mapsUrl(row);
  const driver=row.effectiveDriver||row.driver||{employeeName:row.assignedEmployeeName||row.driverName};
  if(passenger){
    return `<div class="passenger-relation">
      <div class="passenger-relation-icon">🚐</div>
      <div class="passenger-relation-copy">
        <span>Mitgefahren mit</span>
        <strong>${esc(driver.employeeName||"Kollege")}</strong>
        <small>${esc(row.licensePlate||"ohne Kennzeichen")}${row.vehicleName?` · ${esc(row.vehicleName)}`:""}</small>
      </div>
    </div>`;
  }
  const passengerCount=(row.passengers||[]).length;
  return `<div class="trip"><div class="trip-top"><strong>${esc(row.startTime)}–${esc(row.arrivalTime)}</strong><span class="plate-chip">${esc(row.licensePlate||"ohne Kennzeichen")}</span><label class="private-check"><input type="checkbox" data-row="${esc(row.id)}" ${row.isPrivate?"checked":""}> Privatfahrt</label></div><div class="trip-driver"><span>Fahrer: <strong>${esc(driver.employeeName||row.driverName||"nicht zugeordnet")}</strong></span><button class="trip-tool" data-driver-row="${esc(row.id)}">Fahrer ändern</button><button class="trip-tool" data-passenger-row="${esc(row.id)}">Mitfahrer${passengerCount?` (${passengerCount})`:""}</button></div><div class="trip-route"><div><strong title="${esc(row.startLocation)}">${esc(row.startLocation||"Start unbekannt")}</strong><small>${esc(row.startTime)}</small></div><div class="route-arrow">→</div><div><strong title="${esc(row.stopLocation)}">${esc(row.stopLocation||"Ziel unbekannt")}</strong><small>Ankunft ${esc(row.arrivalTime)}${row.departureTime?` · weiter ${esc(row.departureTime)}`:""}</small></div></div><div class="trip-meta"><span>${km(row.distanceKm)}</span><span>Fahrt ${secondsLabel(row.travelSeconds)}</span><span>Aufenthalt ${secondsLabel(row.staySeconds)}</span>${url?`<a class="map-link" href="${esc(url)}" target="_blank" rel="noopener">🗺 Karte</a>`:""}</div></div>`;
}

function passengerRelations(rows){
  const relations=new Map();
  for(const row of rows||[]){
    const driver=row.effectiveDriver||row.driver||{employeeName:row.assignedEmployeeName||row.driverName};
    const driverName=String(driver.employeeName||"Kollege").trim();
    const driverId=String(driver.employeeId||row.assignedEmployeeId||driverName);
    const plate=String(row.licensePlate||"ohne Kennzeichen").trim();
    const vehicleName=String(row.vehicleName||"").trim();
    const key=`${driverId}::${plate}::${vehicleName}`;
    if(!relations.has(key)){
      relations.set(key,{
        ...row,
        effectiveDriver:{...driver,employeeName:driverName},
        relationCount:0
      });
    }
    relations.get(key).relationCount+=1;
  }
  return [...relations.values()];
}

function renderTrips(){
  const box=$("gpsTrips"),rows=state.dayRows,passengers=state.passengerRows;
  if(!rows.length&&!passengers.length){
    box.className="trips empty";
    box.textContent="Keine GPS-Fahrt und keine Mitfahrt für diese Tagesfolie.";
    $("gpsVehicles").hidden=true;
    $("checkGps").textContent=groupsForDate(state.activeDate).length?"keine Fahrt diesem Mitarbeiter zugeordnet":"noch kein GPS für diesen Tag";
    updateGpsTotals();
    return;
  }
  const vehicles=new Map();
  rows.forEach(row=>{
    const key=`${row.licensePlate||"ohne Kennzeichen"}|${row.vehicleName||""}`;
    if(!vehicles.has(key))vehicles.set(key,{licensePlate:row.licensePlate||"ohne Kennzeichen",vehicleName:row.vehicleName||"",trips:0,km:0});
    const vehicle=vehicles.get(key);
    vehicle.trips+=1;
    vehicle.km+=Number(row.distanceKm||0);
  });
  $("gpsVehicles").hidden=!vehicles.size;
  $("gpsVehicles").innerHTML=vehicles.size
    ? `<strong>Eigene Fahrzeuge an diesem Tag</strong>${[...vehicles.values()].map(vehicle=>`<span><b>${esc(vehicle.licensePlate)}</b>${vehicle.vehicleName?` · ${esc(vehicle.vehicleName)}`:""}<small>${vehicle.trips} Bewegungen${vehicle.km?` · ${km(vehicle.km)}`:""}</small></span>`).join("")}`
    : "";
  box.className="trips";
  const relations=passengerRelations(passengers);
  box.innerHTML=`${rows.length?`<div class="trip-section-title">Eigene Fahrten</div>${rows.map(row=>rideCard(row)).join("")}`:""}${relations.length?`<div class="trip-section-title">Mitgefahren</div><div class="passenger-relations">${relations.map(row=>rideCard(row,{passenger:true})).join("")}</div>`:""}`;
  box.querySelectorAll('input[data-row]').forEach(input=>input.addEventListener("change",()=>markPrivate(input.dataset.row,input.checked)));
  box.querySelectorAll('[data-driver-row]').forEach(button=>button.addEventListener("click",()=>editRideDriver(button.dataset.driverRow)));
  box.querySelectorAll('[data-passenger-row]').forEach(button=>button.addEventListener("click",()=>editRidePassengers(button.dataset.passengerRow)));
  updateGpsTotals();
}
function editRideDriver(rowId){
  const row=state.dayRows.find(item=>item.id===rowId); if(!row)return;
  const current=row.effectiveDriver?.employeeId||row.assignedEmployeeId||"";
  openGpsDialog("Fahrer dieser Fahrt ändern",`<p class="dialog-note"><strong>${esc(row.startTime)}–${esc(row.arrivalTime)}</strong> · ${esc(row.licensePlate||"ohne Kennzeichen")}<br>${esc(row.startLocation)} → ${esc(row.stopLocation)}</p><label class="dialog-field">Tatsächlicher Fahrer<select id="dialogDriver"><option value="">nicht zugeordnet</option>${employeeOptions(current)}</select></label><label class="dialog-check"><input type="checkbox" id="dialogDriverScope"> Alle Fahrten mit diesem Kennzeichen an diesem Tag ebenfalls zuordnen</label><div class="dialog-warning">Privatfahrten werden nach der Änderung dem neuen Fahrer zugerechnet.</div><button class="btn primary dialog-save" id="saveRideDriver">Fahrer übernehmen</button>`);
  $("saveRideDriver").addEventListener("click",()=>saveRideDriver(row));
}
async function saveRideDriver(row){
  const employeeId=$("dialogDriver").value;
  const employeeName=$("dialogDriver").selectedOptions[0]?.textContent||"";
  const scope=$("dialogDriverScope").checked;
  const targets=scope?state.dayRows.filter(item=>item.date===row.date&&String(item.licensePlate||"")===String(row.licensePlate||"")):[row];
  try{
    for(const target of targets){
      await request(`/kristine/api/gps/imports/${encodeURIComponent(state.gpsImport.id)}/rows/${encodeURIComponent(target.id)}`,{method:"PUT",body:JSON.stringify({assignedEmployeeId:employeeId,assignedEmployeeName:employeeName})});
    }
    closeGpsDialog(); toast(scope?`${targets.length} Fahrten wurden neu zugeordnet.`:"Fahrer wurde geändert."); await loadDay();
  }catch(error){toast(error.message,true)}
}
function editRidePassengers(rowId){
  const row=state.dayRows.find(item=>item.id===rowId); if(!row)return;
  const selected=new Set((row.passengers||[]).map(item=>String(item.employeeId)));
  const driverId=String(row.effectiveDriver?.employeeId||row.assignedEmployeeId||"");
  const checks=(state.bootstrap?.employees||[]).map(employee=>{
    const id=String(employee.id||employee.employeeId||""); const name=String(employee.nickname?`${employee.nickname} ${String(employee.name||"").split(/\s+/).slice(1).join(" ")}`:(employee.name||employee.employeeName||id));
    if(!id||id===driverId)return "";
    return `<label class="passenger-option"><input type="checkbox" value="${esc(id)}" data-name="${esc(name)}" ${selected.has(id)?"checked":""}><span>${esc(name)}</span></label>`;
  }).join("");
  openGpsDialog("Mitfahrer festlegen",`<p class="dialog-note"><strong>${esc(row.startTime)}–${esc(row.arrivalTime)}</strong> · ${esc(row.licensePlate||"ohne Kennzeichen")}<br>Fahrer: ${esc(row.effectiveDriver?.employeeName||row.driverName)}</p><div class="passenger-list">${checks||"Keine weiteren Mitarbeiter vorhanden."}</div><button class="btn primary dialog-save" id="saveRidePassengers">Mitfahrer übernehmen</button>`);
  $("saveRidePassengers").addEventListener("click",()=>saveRidePassengers(row));
}
async function saveRidePassengers(row){
  const passengers=[...$("gpsDialogBody").querySelectorAll('.passenger-option input:checked')].map(input=>({employeeId:input.value,employeeName:input.dataset.name}));
  try{
    const data=await request(`/kristine/api/gps/imports/${encodeURIComponent(state.gpsImport.id)}/rows/${encodeURIComponent(row.id)}`,{method:"PUT",body:JSON.stringify({passengers})});
    row.passengers=data.row.passengers||passengers;
    closeGpsDialog(); renderTrips(); toast(passengers.length?`${passengers.length} Mitfahrer gespeichert.`:"Mitfahrer entfernt.");
  }catch(error){toast(error.message,true)}
}
function updateGpsTotals(){
  const rows=state.dayRows;
  const dist=rows.reduce((s,r)=>s+Number(r.distanceKm||0),0);
  const priv=rows.filter(r=>r.isPrivate).reduce((s,r)=>s+Number(r.distanceKm||0),0);
  $("gpsTripCount").textContent=String(rows.length);
  $("gpsDistance").textContent=km(dist);
  $("gpsPrivate").textContent=km(priv);
  const relations=passengerRelations(state.passengerRows);
  const rideText=relations.length
    ? ` · mitgefahren mit ${relations.map(row=>(row.effectiveDriver||row.driver||{}).employeeName||"Kollege").join(", ")}`
    : "";
  $("checkGps").textContent=`${rows.length} eigene Fahrten${rideText} · ${km(dist)} · ${km(priv)} privat`;
}
async function markPrivate(rowId,isPrivate){
  try{
    await request(`/kristine/api/gps/imports/${encodeURIComponent(state.gpsImport.id)}/rows/${encodeURIComponent(rowId)}`,{method:"PUT",body:JSON.stringify({isPrivate})});
    const row=state.dayRows.find(r=>r.id===rowId);
    if(row)row.isPrivate=isPrivate;
    updateGpsTotals();
    toast(isPrivate?"Fahrt als privat markiert.":"Privat-Markierung entfernt.");
  }catch(error){toast(error.message,true)}
}




function ensureCompactReleaseControls(){
  const card=$("releaseCard");
  if(!card)return;

  const legacy=[...document.querySelectorAll("[data-release-check]")];
  legacy.forEach(input=>{
    const row=input.closest("label")||input.parentElement;
    if(row)row.style.display="none";
  });

  let master=$("releaseMasterCheck");
  if(!master){
    const label=document.createElement("label");
    label.className="release-master-check";
    label.style.cssText="display:flex;align-items:center;gap:10px;padding:12px 14px;margin:12px 0;border:1px solid #d9ddd9;border-radius:10px;background:#f6faf6;cursor:pointer;font-weight:800";
    label.innerHTML='<input id="releaseMasterCheck" type="checkbox" style="width:auto;cursor:pointer"> <span>Angaben geprüft und vollständig</span>';
    const reviewer=$("releaseReviewer");
    (reviewer?.closest("label")||reviewer||$("releaseAndNext"))?.before(label);
    master=$("releaseMasterCheck");
    master?.addEventListener("change",renderRelease);
  }

  let free=$("releaseModelFreeCheck");
  if(!free){
    const label=document.createElement("label");
    label.id="releaseModelFreeWrap";
    label.style.cssText="display:none;align-items:center;gap:10px;padding:10px 14px;margin:8px 0;border:1px solid #ddd;border-radius:10px;background:#f8f8f8;cursor:pointer";
    label.innerHTML='<input id="releaseModelFreeCheck" type="checkbox" style="width:auto;cursor:pointer"> <span><strong>Heute laut Arbeitszeitmodell kein Arbeitstag</strong><br><small>0:00 h · keine Abwesenheit und kein ZA</small></span>';
    const masterWrap=$("releaseMasterCheck")?.closest("label");
    masterWrap?.after(label);
    free=$("releaseModelFreeCheck");
    free?.addEventListener("change",renderRelease);
  }

  const item=activeQueueItem();
  const hasRealTime=(state.segments||[]).some(row=>row.from&&row.to);
  const showFree=Boolean(item?.scheduledFree)&&!hasRealTime;
  const wrap=$("releaseModelFreeWrap");
  if(wrap)wrap.style.display=showFree?"flex":"none";
  if(!showFree&&free)free.checked=false;

  return {master,free,showFree};
}
function releaseChecks(){
  const {master}=ensureCompactReleaseControls()||{};
  const checked=Boolean(master?.checked);
  // Backend-Kompatibilität: bisherige sechs Kontrollpunkte bleiben gespeichert,
  // die Oberfläche verlangt aber nur noch eine Bestätigung.
  return {
    times:checked,
    gps:checked,
    regie:checked,
    diet:checked,
    completeness:checked,
    final:checked
  };
}

function releaseComplete(){
  const controls=ensureCompactReleaseControls()||{};
  if(!controls.master?.checked)return false;

  const item=activeQueueItem();
  const absence=String(item?.absenceType||"").toLowerCase();

  // Ganztägig eindeutig: direkt prüfbar.
  if(["urlaub","krank","feiertag","za"].includes(absence))return true;

  // Arzt: nur die tatsächlich bestätigte Dauer zählt.
  if(absence==="arzt"){
    return (state.segments||[]).some(row=>
      row.type==="up" &&
      String(row.reason||row.jobName||"").toLowerCase().includes("arzt") &&
      minutes(row.from)!==null &&
      minutes(row.to)!==null &&
      minutes(row.to)>minutes(row.from)
    );
  }

  const hasTime=(state.segments||[]).some(row=>row.from&&row.to);
  if(hasTime)return true;

  // Dunja / Gerald / Judith etc.: planmäßig 0 Stunden.
  // Sie dürfen trotzdem arbeiten; dann greift oben hasTime.
  if(controls.showFree)return Boolean(controls.free?.checked);

  return false;
}

function releaseQueueIndex(){
  const id=String($("employeeSelect")?.value||"");
  return state.dayQueue.findIndex(item=>String(item.employeeId)===id);
}
function releaseDateTime(value){
  if(!value)return "–";
  try{return new Intl.DateTimeFormat("de-AT",{dateStyle:"short",timeStyle:"short"}).format(new Date(value));}catch{return value}
}
function renderRelease(){
  const card=$("releaseCard"); if(!card)return;
  const compactControls=ensureCompactReleaseControls()||{};
  const release=state.release;
  const released=Boolean(release?.released);
  card.classList.toggle("released",released);
  const pill=$("releasePill");
  pill.textContent=released?"FREIGEGEBEN":"NICHT FREIGEGEBEN";
  pill.className=`pill ${released?"released":"open"}`;
  $("releaseBy").textContent=released?(release.reviewer||"–"):"–";
  $("releaseAt").textContent=released?releaseDateTime(release.releasedAt):"wird bei Freigabe gesetzt";
  if(released&&release.reviewer)$("releaseReviewer").value=release.reviewer;
  if(released)$("releaseNote").value=release.note||"";
  const audit=$("releaseAuditCompact");
  if(audit)audit.hidden=!released;
  const saved=release?.checks||{};
  const savedValues=Object.values(saved);
  const savedComplete=savedValues.length? savedValues.every(Boolean) : released;
  if(compactControls.master){
    if(released)compactControls.master.checked=savedComplete;
    compactControls.master.disabled=released;
    compactControls.master.closest("label").style.cursor=released?"default":"pointer";
  }
  if(compactControls.free){
    compactControls.free.disabled=released;
    compactControls.free.closest("label").style.cursor=released?"default":"pointer";
  }
  document.querySelectorAll("[data-release-check]").forEach(input=>{input.disabled=released;});
  $("releaseReviewer").disabled=released;
  $("releaseNote").disabled=released;
  const btn=$("releaseAndNext");
  btn.disabled=released||!releaseComplete()||!$("employeeSelect")?.value;
  btn.textContent=released?"✓ Bereits freigegeben":"✓ Freigeben & nächster MA";
  // Kein irreführender roter Verbots-Cursor: klickbar = Hand, gesperrt = neutral.
  btn.style.cursor=btn.disabled?"default":"pointer";
  const idx=releaseQueueIndex(), total=state.dayQueue.length;
  $("releasePosition").textContent=idx>=0?`Mitarbeiter ${idx+1} von ${total} · ${$("employeeSelect").selectedOptions[0]?.textContent||""}`:"Mitarbeiter auswählen";
  $("previousEmployee").disabled=idx<=0;
  $("nextEmployee").disabled=idx<0||idx>=total-1;
}
async function loadRelease(){
  const employeeId=$("employeeSelect")?.value;
  const requestedEmployeeId=String(employeeId||"");

  // Jeder Mitarbeiter startet mit seiner eigenen, leeren Prüfliste.
  // Die Haken vom zuvor geöffneten Mitarbeiter dürfen nicht im DOM hängen bleiben.
  document.querySelectorAll("[data-release-check]").forEach(input=>{
    input.checked=false;
    input.disabled=false;
  });
  ensureCompactReleaseControls();
  if($("releaseMasterCheck")){$("releaseMasterCheck").checked=false;$("releaseMasterCheck").disabled=false}
  if($("releaseModelFreeCheck")){$("releaseModelFreeCheck").checked=false;$("releaseModelFreeCheck").disabled=false}

  state.release=null;
  renderRelease();
  if(!employeeId||!state.activeDate){state.release=null;renderRelease();return}
  try{
    const data=await request(`/kristine/api/day-release/${encodeURIComponent(employeeId)}/${encodeURIComponent(state.activeDate)}`);
    if(String($("employeeSelect")?.value||"")!==requestedEmployeeId)return;
    state.release=data.release||null;
  }catch(error){state.release=null;console.warn("Freigabestatus konnte nicht geladen werden:",error)}
  renderRelease();
}
async function navigateRelease(direction,{unreleasedOnly=false}={}){
  const idx=releaseQueueIndex(); if(idx<0)return;
  let target=null;
  if(unreleasedOnly){
    for(let step=1;step<=state.dayQueue.length;step++){
      const candidate=state.dayQueue[(idx+step)%state.dayQueue.length];
      if(candidate&&!candidate.released){target=candidate;break}
    }
  }else target=state.dayQueue[idx+direction]||null;
  if(target)await openQueueEmployee(target.employeeId,target.driverKey||"");
  else toast(unreleasedOnly?"Alle Mitarbeiter dieses Tages sind freigegeben.":"Kein weiterer Mitarbeiter.");
}
async function saveReleaseAndNext(){
  const employeeId=$("employeeSelect")?.value;
  const employeeName=$("employeeSelect")?.selectedOptions[0]?.textContent||employeeId;
  const reviewer=$("releaseReviewer").value.trim();
  if(!releaseComplete())return toast("Bitte alle Kontrollpunkte bestätigen.",true);
  if(!reviewer)return toast("Bitte Name der Kontrolle eintragen.",true);
  try{
    const data=await request(`/kristine/api/day-release/${encodeURIComponent(employeeId)}/${encodeURIComponent(state.activeDate)}`,{
      method:"PUT",
      body:JSON.stringify({employeeName,reviewer,note:$("releaseNote").value.trim(),checks:releaseChecks()})
    });
    state.release=data.release;
    const q=state.dayQueue.find(item=>String(item.employeeId)===String(employeeId)); if(q)q.released=true;
    renderDayQueue(); renderRelease();
    toast(`${employeeName} kontrolliert und freigegeben.`);
    await navigateRelease(1,{unreleasedOnly:true});
  }catch(error){toast(`Freigabe nicht gespeichert: ${error.message}`,true)}
}
document.addEventListener("change",event=>{
  if(event.target?.matches?.("[data-release-check]"))renderRelease();
});
document.addEventListener("click",event=>{
  if(event.target?.id==="releaseAndNext")saveReleaseAndNext();
  if(event.target?.id==="previousEmployee")navigateRelease(-1);
  if(event.target?.id==="nextEmployee")navigateRelease(1);
});

function setPhase(phase){
  if(!["times","regie","release"].includes(phase)) phase="times";
  state.phase=phase;
  const grid=$("comparisonGrid");
  grid.classList.remove("phase-times","phase-regie","phase-release");
  grid.classList.add(`phase-${phase}`);
  document.querySelectorAll(".phase-button").forEach(button=>{
    button.classList.toggle("active",button.dataset.phase===phase);
  });
  if($("dietPanel"))$("dietPanel").hidden=phase!=="release";
  if(phase==="release"){renderDietPanel();renderRelease();}
}
document.querySelectorAll(".phase-button").forEach(button=>{
  button.addEventListener("click",()=>setPhase(button.dataset.phase));
});

function selectedEmployee(){
  const option=$("employeeSelect").selectedOptions[0];
  return {
    employeeId:String($("employeeSelect").value||""),
    employeeName:String(option?.textContent||"").trim()
  };
}
function currentWorkJobs(){
  const jobs=new Map();
  state.segments.filter(row=>row.type==="work"&&row.jobId).forEach(row=>{
    jobs.set(String(row.jobId),String(row.jobName||row.jobId));
  });
  return [...jobs].map(([jobId,jobName])=>({jobId,jobName}));
}
async function loadTeamCandidates(){
  const source=selectedEmployee();
  const teamBox=$("teamTransfer");
  const candidatesBox=$("teamCandidates");
  if(!source.employeeId||!state.activeDate||!state.segments.length){
    teamBox.hidden=true;
    state.teamCandidates=[];
    return;
  }
  try{
    const data=await request(`/kristine/api/team-candidates/${encodeURIComponent(source.employeeId)}/${encodeURIComponent(state.activeDate)}`);
    state.teamCandidates=data.candidates||[];
    state.teamJobs=data.sourceJobs||currentWorkJobs();
    teamBox.hidden=!state.teamCandidates.length;
    if(teamBox.hidden){
      $("teamTransferBody").hidden=true;
      return;
    }
    candidatesBox.innerHTML=state.teamCandidates.map(candidate=>`
      <label class="team-candidate">
        <input type="checkbox" value="${esc(candidate.employeeId)}" data-name="${esc(candidate.employeeName)}">
        <span>
          <strong>${esc(candidate.employeeName)}</strong>
          <small>${candidate.segmentCount?`${candidate.segmentCount} vorhandene Zeitblöcke`:"noch keine Zeitblöcke"} · persönliche GPS-Daten bleiben unverändert</small>
        </span>
        <span class="shared-job">${esc((candidate.sharedJobs||[]).map(job=>job.jobName||job.jobId).join(", ")||"gleiche Baustelle")}</span>
      </label>`).join("");
  }catch(error){
    teamBox.hidden=true;
    state.teamCandidates=[];
    console.warn("Teamabgleich konnte nicht vorbereitet werden:",error);
  }
}
$("toggleTeamTransfer").addEventListener("click",()=>{
  const body=$("teamTransferBody");
  body.hidden=!body.hidden;
  $("toggleTeamTransfer").textContent=body.hidden?"Für Team übernehmen":"Teamabgleich schließen";
});
$("applyTeamCorrection").addEventListener("click",async()=>{
  const source=selectedEmployee();
  const selected=[...$("teamCandidates").querySelectorAll('input[type="checkbox"]:checked')];
  if(!selected.length)return toast("Bitte mindestens einen Mitarbeiter auswählen.",true);
  if(!state.segments.length)return toast("Es sind keine Zeitblöcke zum Übernehmen vorhanden.",true);
  const button=$("applyTeamCorrection");
  button.disabled=true;
  button.textContent="Tagesfolien werden vorbereitet …";
  const results=[];
  for(const input of selected){
    const employeeId=input.value;
    const employeeName=input.dataset.name;
    const stamp=Date.now();
    const copiedSegments=state.segments.map((segment,index)=>({
      ...segment,
      id:`team_${employeeId}_${state.activeDate}_${stamp}_${index}`
    }));
    try{
      await request(`/kristine/api/segments/${encodeURIComponent(employeeId)}/${encodeURIComponent(state.activeDate)}`,{
        method:"PUT",
        body:JSON.stringify({
          employeeName,
          segments:copiedSegments,
          reason:state.correction?.reason||$("correctionReason").value||"Für Team übernommen",
          note:state.correction?.note||$("correctionNote").value||`Zeitkorrektur von ${source.employeeName} für das Baustellenteam vorbereitet.`,
          correctedBy:"Bettina / Büro",
          copiedFrom:source
        })
      });
      results.push({employeeName,ok:true});
    }catch(error){
      results.push({employeeName,ok:false,error:error.message});
    }
  }
  button.disabled=false;
  button.textContent="Ausgewählte Tagesfolien vorbereiten";
  const ok=results.filter(row=>row.ok);
  const failed=results.filter(row=>!row.ok);
  const old=$("teamTransferBody").querySelector(".team-result");
  if(old)old.remove();
  const note=document.createElement("div");
  note.className="team-result";
  note.textContent=failed.length
    ? `${ok.length} Tagesfolien vorbereitet, ${failed.length} konnten nicht übernommen werden.`
    : `${ok.length} Tagesfolien vorbereitet. Persönliche GPS-Daten blieben unverändert.`;
  $("teamTransferBody").appendChild(note);
  await loadDayQueue();
  toast(failed.length?`${ok.length} übernommen · ${failed.length} prüfen`:`Für ${ok.length} Mitarbeiter übernommen.`,Boolean(failed.length));
});

init();



document.querySelectorAll("[data-diet-preset]").forEach(button=>button.addEventListener("click",()=>{
  const d=new Date(`${state.activeDate}T12:00:00`);
  if(button.dataset.dietPreset==="period"){
    const p=dietReportPeriod();$("dietFrom").value=p.from;$("dietTo").value=p.to;
  }else{
    const iso=x=>`${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
    $("dietFrom").value=iso(new Date(d.getFullYear(),d.getMonth(),1,12));
    $("dietTo").value=iso(new Date(d.getFullYear(),d.getMonth()+1,0,12));
  }
}));

// 0023.52: robuste Event-Delegation für dynamische/neu gerenderte Kopfbuttons.
document.addEventListener("click",(event)=>{
  const button=event.target.closest?.("#openEmployeeLogic,#openDietReport");
  if(!button)return;
  event.preventDefault();
  if(button.id==="openEmployeeLogic")openEmployeeLogic();
  if(button.id==="openDietReport")openDietReport();
});


// 0023.52 · robuste Modals: Öffnen, Schließen, Speichern, PDF.
document.addEventListener("click",event=>{
  const target=event.target;
  const button=target?.closest?.(
    "#openEmployeeLogic,#closeEmployeeLogic,#saveEmployeeLogic,"+
    "#openDietReport,#closeDietReport,#createDietReport"
  );

  if(button){
    event.preventDefault();
    if(button.id==="openEmployeeLogic") return openEmployeeLogic();
    if(button.id==="closeEmployeeLogic") return closeEmployeeLogic();
    if(button.id==="saveEmployeeLogic") return saveEmployeeLogic();
    if(button.id==="openDietReport") return openDietReport();
    if(button.id==="closeDietReport") return closeDietReport();
    if(button.id==="createDietReport") return createDietReport();
  }

  if(target?.id==="employeeLogicModal")closeEmployeeLogic();
  if(target?.id==="dietReportModal")closeDietReport();
});

document.addEventListener("keydown",event=>{
  if(event.key!=="Escape")return;
  if($("employeeLogicModal")&&!$("employeeLogicModal").hidden)closeEmployeeLogic();
  if($("dietReportModal")&&!$("dietReportModal").hidden)closeDietReport();
});
