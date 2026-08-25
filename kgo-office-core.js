"use strict";

const fsp = require("fs/promises");
const path = require("path");
const cron = require("node-cron");
const kristine = require("./kristine");

const OFFICE_JOB_ID = "022";
const OFFICE_JOB_NAME = "Büroarbeiten";
const OFFICE_NAMES = new Set(["bettina", "dunja"]);
const OFFICE_MODELS = new Set(["office-bettina", "office-dunja"]);
let reminderInstalled = false;

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function employeeId(employee) {
  return String(employee?.id || employee?.employeeId || "").trim();
}

function employeeName(employee) {
  return String(employee?.nickname || employee?.rufname || employee?.name || employee?.employeeName || employeeId(employee) || "Mitarbeiter").trim();
}

function isOfficeEmployee(employee) {
  if (!employee || employee.active === false) return false;
  if (OFFICE_MODELS.has(String(employee.worktimeModelId || "").trim().toLowerCase())) return true;
  const names = [employee.nickname, employee.rufname, employee.firstName, employee.vorname, employee.name, employee.employeeName]
    .filter(Boolean).map(normalizeName);
  return names.some(name => name.split(/\s+/).some(token => OFFICE_NAMES.has(token)));
}

function viennaParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("de-AT", {
    timeZone:"Europe/Vienna", year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23"
  }).formatToParts(date).map(part => [part.type, part.value]));
}

function localDate(date = new Date()) {
  const p = viennaParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function localTime(date = new Date()) {
  const p = viennaParts(date);
  return `${p.hour}:${p.minute}`;
}

function hmMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]), m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `43${digits.slice(1)}`;
  return digits;
}

function installOfficeRoutes(app, deps = {}) {
  const dataDir = deps.dataDir || process.env.DATA_DIR || "/var/data";
  const requireAdmin = deps.requireAdmin;
  const readEmployees = deps.readEmployees;
  const sendWhatsApp = deps.sendWhatsApp;
  const phoneNumberId = deps.phoneNumberId || process.env.PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.KRISTINE_PHONE_NUMBER_ID || "";
  const timeEventsFile = path.join(dataDir, "_kristine", "time-events.json");
  const reminderFile = path.join(dataDir, "_kristine", "office-clock-reminders.json");
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "https://protokoll.krista.at").replace(/\/$/, "");
  const adminToken = String(process.env.ADMIN_TOKEN || "");

  const allowed = (req, res) => typeof requireAdmin !== "function" ? true : requireAdmin(req, res);

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); }
    catch { return fallback; }
  }

  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive:true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  async function people() {
    return typeof readEmployees === "function" ? (await readEmployees().catch(() => [])) : [];
  }

  async function officeEmployeeById(id) {
    const employee = (await people()).find(row => employeeId(row) === String(id || "")) || null;
    return isOfficeEmployee(employee) ? employee : null;
  }

  function dayEvents(events, id, date) {
    return (Array.isArray(events) ? events : []).filter(row =>
      String(row?.employeeId || "") === String(id) &&
      String(row?.date || "") === String(date) &&
      ["start","weiter","pause","mittag","ende","fertig","stop","stopp"].includes(String(row?.type || "").toLowerCase())
    ).sort((a,b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.at || "").localeCompare(String(b.at || "")));
  }

  function statusFromEvents(events, employee, date = localDate()) {
    const id = employeeId(employee);
    const rows = dayEvents(events, id, date);
    const last = rows.at(-1) || null;
    const type = String(last?.type || "").toLowerCase();
    const mode = ["start","weiter"].includes(type) ? "working"
      : type === "pause" ? "pause"
      : type === "mittag" ? "lunch"
      : ["ende","fertig","stop","stopp"].includes(type) ? "finished_day"
      : "idle";
    const start = [...rows].reverse().find(row => ["start","weiter"].includes(String(row?.type || "").toLowerCase())) || null;
    const end = [...rows].reverse().find(row => ["ende","fertig","stop","stopp"].includes(String(row?.type || "").toLowerCase())) || null;
    return {
      ok:true, office:true, employeeId:id, employeeName:employeeName(employee), date,
      jobId:OFFICE_JOB_ID, jobName:OFFICE_JOB_NAME, mode,
      startAt:start?.at || "", endAt:end?.at || "", eventCount:rows.length,
      state:{
        employeeId:id, employeeName:employeeName(employee), mode,
        activeJobOverride:{ date, jobId:OFFICE_JOB_ID, jobName:OFFICE_JOB_NAME, city:"" }, timeline:[]
      }
    };
  }

  function makeEvent(employee, date, type, at) {
    return {
      id:`office_${type}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
      employeeId:employeeId(employee), employeeName:employeeName(employee), date, type, at,
      actualAt:localTime(), adjusted:false, command:type === "start" ? "start" : "feierabend",
      jobId:OFFICE_JOB_ID, jobName:OFFICE_JOB_NAME, source:"kgo-office-core", createdAt:new Date().toISOString()
    };
  }

  async function officeStatus(employee, date = localDate()) {
    const events = await readJson(timeEventsFile, []);
    return statusFromEvents(events, employee, date);
  }

  async function clock(employee, action, requestedAt = "") {
    const date = localDate();
    let events = await readJson(timeEventsFile, []);
    if (!Array.isArray(events)) events = [];
    const before = statusFromEvents(events, employee, date);

    if (action === "start") {
      if (["working","pause","lunch"].includes(before.mode)) return { ...before, changed:false, reply:"Bürozeit läuft bereits." };
      events.push(makeEvent(employee, date, "start", localTime()));
      await writeJson(timeEventsFile, events);
      return { ...statusFromEvents(events, employee, date), changed:true, reply:`Bürozeit gestartet · ${OFFICE_JOB_ID} ${OFFICE_JOB_NAME}.` };
    }

    if (action === "end") {
      if (!["working","pause","lunch"].includes(before.mode)) return { ...before, changed:false, reply:"Bürozeit ist nicht offen." };
      const now = localTime();
      const at = String(requestedAt || now).trim();
      const endMin = hmMinutes(at), nowMin = hmMinutes(now), startMin = hmMinutes(before.startAt);
      if (endMin === null) throw new Error("Bitte eine gültige Endzeit eingeben.");
      if (startMin !== null && endMin < startMin) throw new Error(`Endzeit darf nicht vor ${before.startAt} liegen.`);
      if (nowMin !== null && endMin > nowMin) throw new Error("Endzeit darf nicht in der Zukunft liegen.");
      events.push(makeEvent(employee, date, "ende", at));
      await writeJson(timeEventsFile, events);
      return { ...statusFromEvents(events, employee, date), changed:true, reply:`Ausgestempelt · Ende ${at} Uhr.` };
    }
    throw new Error("Unbekannte Büro-Zeitaktion.");
  }

  app.get("/kristine/api/office-status", async (req, res, next) => {
    try {
      const employee = await officeEmployeeById(req.query.employeeId);
      if (!employee) return next();
      if (!allowed(req, res)) return;
      return res.json(await officeStatus(employee, String(req.query.date || localDate())));
    } catch (error) { return res.status(500).json({ok:false,error:String(error?.message || error)}); }
  });

  app.post("/kristine/api/office-clock", async (req, res, next) => {
    try {
      const employee = await officeEmployeeById(req.body?.employeeId);
      if (!employee) return next();
      if (!allowed(req, res)) return;
      return res.json(await clock(employee, String(req.body?.action || "").toLowerCase(), req.body?.at));
    } catch (error) { return res.status(400).json({ok:false,error:String(error?.message || error)}); }
  });

  app.post("/kristine/api/message", async (req, res, next) => {
    try {
      const employee = await officeEmployeeById(req.body?.employeeId);
      if (!employee) return next();
      const text = normalizeName(req.body?.text || "");
      const action = ["start","arbeitsbeginn","einstempeln"].includes(text) ? "start"
        : ["feierabend","ende","fertig","stop","stopp","ausstempeln"].includes(text) ? "end" : "";
      if (!action) return next();
      if (!allowed(req, res)) return;
      const result = await clock(employee, action, req.body?.at);
      return res.json({ ...result, buttons:[], state:result.state });
    } catch (error) { return res.status(400).json({ok:false,error:String(error?.message || error)}); }
  });

  app.post("/kristine/api/morning-check", async (req, res, next) => {
    try {
      const employee = await officeEmployeeById(req.body?.employeeId);
      if (!employee) return next();
      if (!allowed(req, res)) return;
      const today = String(req.body?.date || localDate());
      const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
      return res.json({
        ok:true, officeMode:true, today, yesterday:d.toISOString().slice(0,10), hadWork:false,
        forgotClockOut:false, autoClosed:false, autoClosedAt:null,
        dayCloseMissing:false, dayCloseIncomplete:false, needsAttention:false
      });
    } catch (error) { return next(); }
  });

  async function sendReminder(employee) {
    if (typeof sendWhatsApp !== "function") return {sent:false,reason:"sender_missing"};
    const phone = normalizePhone(employee?.phone);
    if (!phone) return {sent:false,reason:"phone_missing"};
    const url = new URL("/public/kristine-go.html", publicBaseUrl);
    url.searchParams.set("employeeId", employeeId(employee));
    url.searchParams.set("officePrompt", "1");
    if (adminToken) url.searchParams.set("token", adminToken);
    await sendWhatsApp({
      phoneNumberId,
      to:phone,
      reply:`⏰ Du bist in KRISTINE noch eingestempelt.\n\nVergessen auszutempeln? Wann war Ende?\nBitte kurz in KGO prüfen:\n${url.href}`
    });
    return {sent:true};
  }

  async function runReminder() {
    const date = localDate();
    const [employees, events, stored] = await Promise.all([people(), readJson(timeEventsFile, []), readJson(reminderFile, {})]);
    const reminderState = stored && typeof stored === "object" ? stored : {};
    reminderState[date] = reminderState[date] && typeof reminderState[date] === "object" ? reminderState[date] : {};
    for (const employee of employees.filter(isOfficeEmployee)) {
      const id = employeeId(employee);
      if (!id || reminderState[date][id]?.sent) continue;
      const status = statusFromEvents(events, employee, date);
      if (!["working","pause","lunch"].includes(status.mode)) continue;
      try {
        const result = await sendReminder(employee);
        reminderState[date][id] = {sent:Boolean(result.sent),at:new Date().toISOString(),reason:result.reason || ""};
      } catch (error) {
        reminderState[date][id] = {sent:false,attemptedAt:new Date().toISOString(),error:String(error?.message || error)};
      }
    }
    await writeJson(reminderFile, reminderState);
  }

  if (!reminderInstalled) {
    reminderInstalled = true;
    cron.schedule("15 12 * * 1-5", () => runReminder().catch(error => console.error("KGO Büro 12:15 Fehler", error)), {timezone:"Europe/Vienna"});
  }

  console.log("✅ KGO Büro-Core registriert · Bettina/Dunja · 022 Büroarbeiten");
}

const originalRegisterKristine = kristine.registerKristine;
if (typeof originalRegisterKristine === "function" && !originalRegisterKristine.__kgoOfficeCore) {
  const wrapped = function(app, deps) {
    installOfficeRoutes(app, deps || {});
    return originalRegisterKristine(app, deps);
  };
  wrapped.__kgoOfficeCore = true;
  kristine.registerKristine = wrapped;
}
