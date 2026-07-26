"use strict";

const state = {
  token: new URLSearchParams(location.search).get("token") || "",
  bootstrap: null,
  gpsImport: null,
  groups: [],
  dayRows: [],
  segments: [],
  activeDate: "",
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
  }catch(error){ toast(`Startfehler: ${error.message}`,true); }
}

function renderEmployees(){
  const employees=state.bootstrap?.employees||[];
  const select=$("employeeSelect");
  select.innerHTML='<option value="">Mitarbeiter wählen</option>'+employees.map(e=>`<option value="${esc(e.id||e.employeeId)}">${esc(e.name||e.employeeName)}</option>`).join("");
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
  select.innerHTML='<option value="">GPS-Fahrer wählen</option>'+dateGroups.map(g=>`<option value="${esc(g.key)}">${esc(g.driverName)} · ${g.trips} Fahrten · ${esc(g.licensePlate||g.vehicleName||"")}</option>`).join("");
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
    toast("Zuordnung wurde gemerkt.");
  }catch(error){toast(error.message,true)}
});

$("loadDay").addEventListener("click",loadDay);
async function loadDay(){
  const group=selectedGroup();
  const employeeId=$("employeeSelect").value;
  const date=state.activeDate;
  if(!employeeId||!date)return toast("Mitarbeiter und Tagesfolie auswählen.",true);
  if(group && group.date!==date)return toast("Der gewählte GPS-Fahrer gehört nicht zur geöffneten Tagesfolie.",true);
  try{
    const requests=[request(`/kristine/api/segments/${encodeURIComponent(employeeId)}/${encodeURIComponent(date)}`)];
    if(group && state.gpsImport){
      requests.unshift(request(`/kristine/api/gps/day?importId=${encodeURIComponent(state.gpsImport.id)}&driverKey=${encodeURIComponent(group.driverKey)}&date=${encodeURIComponent(date)}`));
    }
    const results=await Promise.all(requests);
    const gps=group&&state.gpsImport?results[0]:{rows:[]};
    const seg=group&&state.gpsImport?results[1]:results[0];
    state.dayRows=gps.rows||[];
    state.segments=seg.segments||[];
    renderDay(group,date);
  }catch(error){toast(`Tagesfolie konnte nicht geöffnet werden: ${error.message}`,true)}
}

function clearDay(){
  state.dayRows=[];
  state.segments=[];
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
  $("checkKristine").textContent="noch nicht geladen";
  $("checkGps").textContent=groupsForDate(state.activeDate).length?"GPS vorhanden":"noch kein GPS für diesen Tag";
}

function renderDay(group,date){
  const employee=$("employeeSelect").selectedOptions[0]?.textContent||group?.driverName||"Mitarbeiter";
  $("personBadge").textContent=initials(employee);
  $("dayTitle").textContent=`${employee} · ${deDate(date)}`;
  $("daySubtitle").textContent=group?`GPS-Fahrer: ${group.driverName} · ${group.licensePlate||group.vehicleName||"Fahrzeug nicht angegeben"}`:"KRISTINE-Zeiten ohne GPS-Kontrolle";
  renderSegments();
  renderTrips();
}
function renderSegments(){
  const box=$("kristineSegments"),rows=state.segments;
  if(!rows.length){
    box.className="timeline empty";
    box.innerHTML="Für diesen Tag wurden keine KRISTINE-Zeitblöcke gefunden.";
    $("kristineTotal").textContent="0:00 h";
    $("checkKristine").textContent="keine Zeitblöcke gefunden";
    return;
  }
  box.className="timeline";
  let work=0;
  box.innerHTML=rows.map(row=>{
    const a=minutes(row.from),b=minutes(row.to);
    if(row.type==="work"&&a!==null&&b!==null)work+=Math.max(0,b-a);
    return `<div class="segment ${row.type}"><span class="segment-dot"></span><div><strong>${esc(row.from)}–${esc(row.to||"offen")}</strong><small>${row.type==="work"?esc(row.jobName||"Arbeitszeit"):row.type==="lunch"?"Mittag":"Pause"}</small></div><b>${a!==null&&b!==null?durationLabel(b-a):"–"}</b></div>`;
  }).join("");
  $("kristineTotal").textContent=durationLabel(work);
  $("checkKristine").textContent=`${rows.length} Zeitblöcke · ${durationLabel(work)}`;
}
function renderTrips(){
  const box=$("gpsTrips"),rows=state.dayRows;
  if(!rows.length){
    box.className="trips empty";
    box.textContent="Keine GPS-Fahrten für diese Tagesfolie.";
    $("checkGps").textContent=groupsForDate(state.activeDate).length?"GPS-Fahrer noch nicht gewählt":"noch kein GPS für diesen Tag";
    return;
  }
  box.className="trips";
  box.innerHTML=rows.map(row=>`<div class="trip"><div class="trip-top"><strong>${esc(row.startTime)}–${esc(row.arrivalTime)}</strong><label class="private-check"><input type="checkbox" data-row="${esc(row.id)}" ${row.isPrivate?"checked":""}> Privatfahrt</label></div><div class="trip-route"><div><strong title="${esc(row.startLocation)}">${esc(row.startLocation||"Start unbekannt")}</strong><small>${esc(row.startTime)}</small></div><div class="route-arrow">→</div><div><strong title="${esc(row.stopLocation)}">${esc(row.stopLocation||"Ziel unbekannt")}</strong><small>Ankunft ${esc(row.arrivalTime)}${row.departureTime?` · weiter ${esc(row.departureTime)}`:""}</small></div></div><div class="trip-meta"><span>${km(row.distanceKm)}</span><span>Fahrt ${secondsLabel(row.travelSeconds)}</span><span>Aufenthalt ${secondsLabel(row.staySeconds)}</span></div></div>`).join("");
  box.querySelectorAll('input[data-row]').forEach(input=>input.addEventListener("change",()=>markPrivate(input.dataset.row,input.checked)));
  updateGpsTotals();
}
function updateGpsTotals(){
  const rows=state.dayRows;
  const dist=rows.reduce((s,r)=>s+Number(r.distanceKm||0),0);
  const priv=rows.filter(r=>r.isPrivate).reduce((s,r)=>s+Number(r.distanceKm||0),0);
  $("gpsTripCount").textContent=String(rows.length);
  $("gpsDistance").textContent=km(dist);
  $("gpsPrivate").textContent=km(priv);
  $("checkGps").textContent=`${rows.length} Fahrten · ${km(dist)} · ${km(priv)} privat`;
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

init();
