"use strict";

// KRISTA: 07:00 Startprüfung + 08:00 Chefstatus
// Build 0023.17: Erinnerungen nur an tatsächlichen Arbeitstagen.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const TZ = "Europe/Vienna";
const DAILY_TARGET_HOURS = 7.8;
const OFFICIAL_START = "07:00";

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("de-AT", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}
function localIsoDate(date = new Date()) { const p = localParts(date); return `${p.year}-${p.month}-${p.day}`; }
function localHm(date = new Date()) { const p = localParts(date); return `${p.hour}:${p.minute}`; }
function normalizePhone(value) { return String(value || "").replace(/\D/g, ""); }
async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; } }
async function writeJson(file, value) { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, JSON.stringify(value, null, 2), "utf8"); }
function minutesFromHm(hm) { const m = String(hm || "").match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function clampStartTime(hm) { const value = minutesFromHm(hm), official = minutesFromHm(OFFICIAL_START); return value == null ? hm : value < official ? OFFICIAL_START : hm; }
function activeEmployees(employees) { return (Array.isArray(employees) ? employees : []).filter((e) => e && e.active !== false && normalizePhone(e.phone)); }
function rowsForDate(rows, date) { return (Array.isArray(rows) ? rows : []).filter((r) => String(r.date) === String(date)); }
function employeeRows(rows, employeeId) { return rows.filter((r) => String(r.employeeId) === String(employeeId)); }
function cardType(row) {
  const explicit = String(row?.cardType || row?.type || "").trim().toLowerCase();
  if (explicit) return explicit;
  return String(row?.jobId || row?.jobName || "").toLowerCase().replace(/^_+|_+$/g, "");
}
function currentAssignments(assignments, employeeId, date) {
  return employeeRows(rowsForDate(assignments, date), employeeId).sort((a,b) => String(a.from || "").localeCompare(String(b.from || "")));
}
function currentAssignment(assignments, employeeId, date) {
  return currentAssignments(assignments, employeeId, date).find((row) => !isAbsenceCard(row)) || currentAssignments(assignments, employeeId, date)[0] || null;
}
function absenceFor(absences, assignments, employeeId, date) {
  const explicit = rowsForDate(absences, date).find((r) => String(r.employeeId) === String(employeeId));
  if (explicit) return explicit;
  return currentAssignments(assignments, employeeId, date).find(isAbsenceCard) || null;
}
function isAbsenceCard(row) {
  const type = cardType(row);
  return ["urlaub","vacation","krank","sick","za","zeitausgleich","feiertag","holiday","betriebsurlaub"].includes(type);
}
function timeState(events, employeeId, date) {
  const list = employeeRows(rowsForDate(events, date), employeeId).sort((a,b) => String(a.at || a.time || "").localeCompare(String(b.at || b.time || "")));
  if (!list.length) return { state:"missing", firstStart:null, events:[] };
  const start = list.find((e) => ["start","weiter"].includes(String(e.type || e.command || "").toLowerCase()));
  const type = String(list.at(-1)?.type || list.at(-1)?.command || "").toLowerCase();
  let state = "working";
  if (["pause","mittag"].includes(type)) state = "pause";
  if (["ende","fertig","stopp","stop"].includes(type)) state = "ended";
  return { state, firstStart:start?.at || start?.time || null, events:list };
}
function lateNoticeFor(rows, employeeId, date) { return rowsForDate(rows,date).filter((r)=>String(r.employeeId)===String(employeeId)).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0] || null; }
function absenceLabel(absence) {
  const type = cardType(absence);
  const labels = {urlaub:"Urlaub",vacation:"Urlaub",krank:"Krank",sick:"Krank",za:"Zeitausgleich",zeitausgleich:"Zeitausgleich",feiertag:"Feiertag",holiday:"Feiertag",betriebsurlaub:"Betriebsurlaub"};
  return labels[type] || absence?.label || absence?.type || "Abwesend";
}
function jobLabel(a) { return a?.jobName || a?.jobId || a?.siteCode || "keine Baustelle"; }
function dateAtNoon(date) { const d = new Date(`${date}T12:00:00`); return Number.isNaN(d.getTime()) ? new Date() : d; }
function weekdayNumber(date) { return dateAtNoon(date).getDay(); }
function isWeekend(date) { return [0,6].includes(weekdayNumber(date)); }
function dateInRange(date, row) { return String(row?.from || row?.start || row?.date || "") <= date && String(row?.to || row?.end || row?.date || "") >= date; }
function unwrapArray(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}
function isHoliday(date, holidays) { return holidays.some((h) => String(h?.date || h?.day || "") === date); }
function companyVacationFor(date, vacations) { return vacations.find((v) => dateInRange(date,v)) || null; }
function worktimeScheduleFor(employee, date, models) {
  const d = dateAtNoon(date), weekday = d.getDay();
  if ([0,6].includes(weekday)) return { isWorkDay:false, reason:"Wochenende" };
  const model = models.find((m)=>String(m.id)===String(employee?.worktimeModelId)) || models.find((m)=>String(m.id)==="krista-standard") || models[0];
  if (!model) return { isWorkDay:true, reason:"" };
  if (Array.isArray(model.seasons)) {
    const month = d.getMonth()+1;
    const season = model.seasons.find((s)=>Array.isArray(s.months)&&s.months.map(Number).includes(month));
    const day = season?.weekdays?.[String(weekday)];
    if (day?.free === true || Number(day?.targetHours) === 0) return { isWorkDay:false, reason:"Arbeitsmodell: frei" };
  }
  if (Array.isArray(model.days)) {
    const names=["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
    const day=model.days.find((x)=>String(x.dayName)===names[weekday]);
    if (day && day.isWorkDay === false) return { isWorkDay:false, reason:"Arbeitsmodell: frei" };
  }
  return { isWorkDay:true, reason:"" };
}
function nonWorkContext({ employee, assignments, absences, holidays, companyVacations, worktimeModels, date }) {
  const absence = absenceFor(absences, assignments, employee.id, date);
  if (absence) return { nonWork:true, reason:absenceLabel(absence), absence };
  const vacation = companyVacationFor(date, companyVacations);
  if (vacation) return { nonWork:true, reason:vacation.reason || vacation.name || "Betriebsurlaub" };
  if (isHoliday(date, holidays)) return { nonWork:true, reason:holidays.find((h)=>String(h.date||h.day)===date)?.name || "Feiertag" };
  const schedule = worktimeScheduleFor(employee,date,worktimeModels);
  if (!schedule.isWorkDay) return { nonWork:true, reason:schedule.reason || (isWeekend(date)?"Wochenende":"frei") };
  return { nonWork:false, reason:"" };
}
function statusForEmployee({ employee, assignments, absences, events, lateNotices, holidays, companyVacations, worktimeModels, date }) {
  const assignment=currentAssignment(assignments,employee.id,date), time=timeState(events,employee.id,date), late=lateNoticeFor(lateNotices,employee.id,date);
  if (["working","pause","ended"].includes(time.state)) {
    const suffix=time.state==="pause"?" – Pause":time.state==="ended"?" – bereits beendet":"";
    return {lamp:"green",icon:"🟢",category:"started",employee,assignment,text:`${employee.name} – ${jobLabel(assignment)}${suffix}`};
  }
  const nonWork=nonWorkContext({employee,assignments,absences,holidays,companyVacations,worktimeModels,date});
  if (nonWork.nonWork) return {lamp:"green",icon:"🔵",category:"non_work",employee,assignment,text:`${employee.name} – ${nonWork.reason}`,reason:nonWork.reason};
  if (late) { const expected=late.expectedTime?`, ca. ${late.expectedTime}`:""; return {lamp:"yellow",icon:"🟡",category:"late",employee,assignment,text:`${employee.name} – kommt später${expected} – ${jobLabel(assignment)}`}; }
  return {lamp:"red",icon:"🔴",category:"missing",employee,assignment,text:`${employee.name} – nicht angemeldet – ${jobLabel(assignment)}`};
}
function buildChefReport(statuses,date) {
  const green=statuses.filter((s)=>s.category==="started"), free=statuses.filter((s)=>s.category==="non_work"), yellow=statuses.filter((s)=>s.lamp==="yellow"), red=statuses.filter((s)=>s.lamp==="red");
  const lines=[`📋 Morgenstatus KRISTA – ${date}`,"",`🟢 ${green.length} gestartet/in Ordnung`,`🔵 ${free.length} heute frei/abwesend`,`🟡 ${yellow.length} später angekündigt`,`🔴 ${red.length} ohne Anmeldung/Rückmeldung`];
  if (free.length) { lines.push("","🔵 Frei / abwesend:"); for (const s of free) lines.push(`• ${s.text}`); }
  if (yellow.length) { lines.push("","🟡 Später:"); for (const s of yellow) lines.push(`• ${s.text}`); }
  if (red.length) { lines.push("","🔴 Offen:"); for (const s of red) lines.push(`• ${s.text}`); }
  if (!yellow.length && !red.length) lines.push("","✅ Keine offenen Punkte.");
  return lines.join("\n");
}
function reminderText(employee,assignment) { return [`Guten Morgen ${employee.name}.`,`Du bist heute auf ${jobLabel(assignment)} eingeteilt.`,"","Ich habe noch keinen Arbeitsbeginn erhalten.","Kommst du heute später?"].join("\n"); }

async function registerMorningStatus({dataDir,readEmployees,sendWhatsApp,chefPhone,phoneNumberId,logger=console}) {
  if (!dataDir) throw new Error("registerMorningStatus: dataDir fehlt");
  if (typeof readEmployees!=="function") throw new Error("registerMorningStatus: readEmployees fehlt");
  if (typeof sendWhatsApp!=="function") throw new Error("registerMorningStatus: sendWhatsApp fehlt");
  const kristineDir=path.join(dataDir,"_kristine"), systemDir=path.join(dataDir,"_system");
  const files={
    assignments:path.join(kristineDir,"assignments.json"), absences:path.join(kristineDir,"absences.json"), events:path.join(kristineDir,"time-events.json"), lateNotices:path.join(kristineDir,"late-notices.json"), scheduler:path.join(kristineDir,"scheduler-state.json"),
    holidays:path.join(systemDir,"holidays.json"), companyVacations:path.join(systemDir,"company-vacations.json"), worktimeModels:path.join(systemDir,"worktime-models.json")
  };
  async function loadState() {
    const [employees,assignments,absences,events,lateNotices,scheduler,holidayRaw,vacationRaw,modelRaw]=await Promise.all([
      readEmployees(),readJson(files.assignments,[]),readJson(files.absences,[]),readJson(files.events,[]),readJson(files.lateNotices,[]),readJson(files.scheduler,{}),readJson(files.holidays,[]),readJson(files.companyVacations,[]),readJson(files.worktimeModels,[])
    ]);
    return {employees,assignments,absences,events,lateNotices,scheduler,holidays:unwrapArray(holidayRaw,["holidays"]),companyVacations:unwrapArray(vacationRaw,["vacations"]),worktimeModels:unwrapArray(modelRaw,["models"])};
  }
  async function saveRun(key,date,scheduler){scheduler[key]=date;await writeJson(files.scheduler,scheduler);}
  async function runSevenOClock(date=localIsoDate(),force=false){
    const state=await loadState(); if(!force&&state.scheduler.startReminder===date)return{skipped:true};
    const statuses=activeEmployees(state.employees).map((employee)=>statusForEmployee({employee,...state,date}));
    const missing=statuses.filter((s)=>s.category==="missing");
    for(const status of missing){await sendWhatsApp({phoneNumberId,to:normalizePhone(status.employee.phone),reply:reminderText(status.employee,status.assignment),buttons:["Start","Komme später","Heute nicht"]}).catch((error)=>logger.error("07:00 Erinnerung fehlgeschlagen",status.employee.name,error));}
    await saveRun("startReminder",date,state.scheduler);
    logger.log("KRISTA 07:00 Prüfung",{date,reminded:missing.length,suppressed:statuses.filter((s)=>s.category==="non_work").length});
    return{sent:missing.length,suppressed:statuses.filter((s)=>s.category==="non_work").length,statuses};
  }
  async function runEightOClock(date=localIsoDate(),force=false){
    const state=await loadState(); if(!force&&state.scheduler.chefReport===date)return{skipped:true};
    const statuses=activeEmployees(state.employees).map((employee)=>statusForEmployee({employee,...state,date}));
    const report=buildChefReport(statuses,date);
    if(normalizePhone(chefPhone)) await sendWhatsApp({phoneNumberId,to:normalizePhone(chefPhone),reply:report}); else logger.warn("CHEF_PHONE fehlt – Chefbericht nur im Log:",report);
    await saveRun("chefReport",date,state.scheduler); return{sent:true,statuses,report};
  }
  const timer=setInterval(async()=>{try{const hm=localHm(),date=localIsoDate();if(hm==="07:00")await runSevenOClock(date);if(hm==="08:00")await runEightOClock(date);}catch(error){logger.error("KRISTA Morgenstatus Scheduler:",error);}},60_000); timer.unref?.();
  return{runSevenOClock,runEightOClock,clampStartTime,dailyTargetHours:DAILY_TARGET_HOURS,files};
}
module.exports={registerMorningStatus,clampStartTime,DAILY_TARGET_HOURS,OFFICIAL_START};
