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

async function request(path, options={}){
  const response=await fetch(api(path),{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
  const data=await response.json().catch(()=>({ok:false,error:`HTTP ${response.status}`}));
  if(!response.ok||data.ok===false) throw new Error(data.error||`HTTP ${response.status}`);
  return data;
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
function queueStatus(item){
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
  $("queuePreparedCount").textContent=team.filter(item=>item.passengerDrivers?.length||item.copiedCorrection).length;

  const renderItem=item=>{
    const status=queueStatus(item);
    const detail=item.role==="driver"
      ? `${item.ownTripCount||0} Fahrten${item.distanceKm?` · ${km(item.distanceKm)}`:""}`
      : item.passengerDrivers?.length
        ? `Mitfahrer zugeordnet${item.segmentCount?` · ${item.segmentCount} Zeitblöcke`:""}`
        : item.segmentCount
          ? `${item.segmentCount} KRISTINE-Zeitblöcke`
          : "Noch keiner Fahrer-Tagesfolie zugeordnet";
    return `<button class="work-queue-item ${state.activeEmployeeId===String(item.employeeId)?"active":""}"
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
    renderDay(group,date);
  }catch(error){toast(`Tagesfolie konnte nicht geöffnet werden: ${error.message}`,true)}
}

function clearDay(){
  state.dayRows=[];
  state.passengerRows=[];
  state.segments=[];
  state.originalSegments=[];
  state.correction=null;
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

function renderDay(group,date){
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
    return sum+(row.type==="work"&&a!==null&&b!==null?Math.max(0,b-a):0);
  },0);
}
function segmentLabel(type){ return type==="work"?"Arbeitszeit":type==="lunch"?"Mittag":"Pause"; }
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
    return;
  }
  $("correctionToolbar").hidden=false;
  $("segmentActions").hidden=false;
  $("correctionReason").value=state.correction?.reason||"";
  $("correctionNote").value=state.correction?.note||"";
  box.className="timeline correction-list";
  box.innerHTML=rows.map((row,index)=>{
    const original=originalForSegment(row,index);
    const changed=!original||original.from!==row.from||original.to!==row.to||original.type!==row.type;
    return `<div class="segment-editor ${row.type} ${changed?"changed":""}" data-index="${index}">
      <div class="source-line"><span class="segment-dot"></span><div><b>Original</b><strong>${esc(original?.from||row.from)}–${esc(original?.to||row.to||"offen")}</strong><small>${esc(original?.jobName||row.jobName||segmentLabel(original?.type||row.type))}</small></div><span class="source-duration">${durationLabel(Math.max(0,(minutes(original?.to)-minutes(original?.from))||0))}</span></div>
      <div class="office-line">
        <div class="office-title"><b>Büro</b><span>${changed?"KORRIGIERT":"UNVERÄNDERT"}</span></div>
        <select class="segment-type" data-index="${index}" aria-label="Art"><option value="work" ${row.type==="work"?"selected":""}>Arbeit</option><option value="pause" ${row.type==="pause"?"selected":""}>Pause</option><option value="lunch" ${row.type==="lunch"?"selected":""}>Mittag</option></select>
        <input class="time-input" data-field="from" data-index="${index}" value="${esc(row.from)}" inputmode="numeric" aria-label="Von">
        <span>–</span>
        <input class="time-input" data-field="to" data-index="${index}" value="${esc(row.to||"")}" inputmode="numeric" aria-label="Bis">
        <button class="remove-segment" data-index="${index}" title="Zeitblock entfernen">×</button>
        <strong class="office-duration">${durationLabel(Math.max(0,(minutes(row.to)-minutes(row.from))||0))}</strong>
      </div>
    </div>`;
  }).join("");
  bindSegmentEditors();
  updateCorrectionTotals();
  renderCorrectionHistory();
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
      scheduleCorrectionSave(80);
    });
  });
  document.querySelectorAll(".segment-type").forEach(select=>select.addEventListener("change",()=>{
    state.segments[Number(select.dataset.index)].type=select.value;
    renderSegments();
    scheduleCorrectionSave(80);
  }));
  document.querySelectorAll(".remove-segment").forEach(button=>button.addEventListener("click",()=>{
    state.segments.splice(Number(button.dataset.index),1);
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
      body:JSON.stringify({employeeName,segments:state.segments,reason:$("correctionReason").value,note:$("correctionNote").value,correctedBy:"Bettina / Büro"})
    });
    state.segments=cloneSegments(data.segments);
    state.originalSegments=cloneSegments(data.originalSegments||state.originalSegments);
    state.correction=data.correction||state.correction;
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
$("resetSegments").addEventListener("click",()=>{
  state.segments=cloneSegments(state.originalSegments);
  renderSegments();
  scheduleCorrectionSave(80);
});
function addSegment(type){
  const last=state.segments.at(-1);
  const from=last?.to||"07:00";
  const to=minutes(from)!==null?`${String(Math.floor((minutes(from)+30)/60)).padStart(2,"0")}:${String((minutes(from)+30)%60).padStart(2,"0")}`:"07:30";
  state.segments.push({id:`seg_${Date.now()}`,type,from,to,jobId:last?.jobId||"",jobName:type==="work"?(last?.jobName||"Arbeitszeit"):""});
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


function setPhase(phase){
  if(!["times","regie","release"].includes(phase)) phase="times";
  state.phase=phase;
  const grid=$("comparisonGrid");
  grid.classList.remove("phase-times","phase-regie","phase-release");
  grid.classList.add(`phase-${phase}`);
  document.querySelectorAll(".phase-button").forEach(button=>{
    button.classList.toggle("active",button.dataset.phase===phase);
  });
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
