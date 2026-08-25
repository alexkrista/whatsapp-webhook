"use strict";

const fsp = require("fs/promises");
const path = require("path");
const kristine = require("./kristine");

const OFFICE_JOB_ID = "022";
const OFFICE_JOB_NAME = "Büroarbeiten";
const OFFICE_NAMES = new Set(["bettina", "dunja"]);
const OFFICE_MODELS = new Set(["office-bettina", "office-dunja"]);

function normalize(value) {
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
    .filter(Boolean).map(normalize);
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

function dayEvents(events, id, date) {
  return (Array.isArray(events) ? events : []).filter(row =>
    String(row?.employeeId || "") === String(id) &&
    String(row?.date || "") === String(date) &&
    ["start","weiter","pause","mittag","ende","fertig","stop","stopp"].includes(String(row?.type || "").toLowerCase())
  ).sort((a,b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.at || "").localeCompare(String(b.at || "")));
}

function status(events, employee, date) {
  const rows = dayEvents(events, employeeId(employee), date);
  const last = rows.at(-1) || null;
  const type = String(last?.type || "").toLowerCase();
  const mode = ["start","weiter"].includes(type) ? "working"
    : type === "pause" ? "pause"
    : type === "mittag" ? "lunch"
    : ["ende","fertig","stop","stopp"].includes(type) ? "finished_day"
    : "idle";
  const firstStart = rows.find(row => ["start","weiter"].includes(String(row?.type || "").toLowerCase())) || null;
  const lastEnd = [...rows].reverse().find(row => ["ende","fertig","stop","stopp"].includes(String(row?.type || "").toLowerCase())) || null;
  return { mode, startAt:firstStart?.at || "", endAt:lastEnd?.at || "" };
}

function makeEvent(employee, date, type, at) {
  return {
    id:`office_wa_${type}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    employeeId:employeeId(employee),
    employeeName:employeeName(employee),
    date,
    type,
    at,
    actualAt:localTime(),
    adjusted:false,
    command:type === "start" ? "start" : "feierabend",
    jobId:OFFICE_JOB_ID,
    jobName:OFFICE_JOB_NAME,
    source:"whatsapp-office-022",
    createdAt:new Date().toISOString(),
  };
}

function officeState(employee, date, mode) {
  return {
    employeeId:employeeId(employee),
    employeeName:employeeName(employee),
    mode,
    activeAssignmentKey:null,
    activeJobOverride:{date, jobId:OFFICE_JOB_ID, jobName:OFFICE_JOB_NAME, city:""},
    pending:null,
    timeline:[],
  };
}

const originalRegisterKristine = kristine.registerKristine;
if (typeof originalRegisterKristine === "function" && !originalRegisterKristine.__kgoOfficeWhatsApp) {
  const wrapped = function(app, deps = {}) {
    const instance = originalRegisterKristine(app, deps);
    if (!instance || typeof instance.handleMessage !== "function") return instance;

    const originalHandleMessage = instance.handleMessage.bind(instance);
    const dataDir = deps.dataDir || process.env.DATA_DIR || "/var/data";
    const timeEventsFile = path.join(dataDir, "_kristine", "time-events.json");
    const readEmployees = deps.readEmployees;

    instance.handleMessage = async function(args = {}) {
      try {
        const people = typeof readEmployees === "function" ? await readEmployees().catch(() => []) : [];
        const employee = (people || []).find(row => employeeId(row) === String(args.employeeId || "")) || null;
        if (!isOfficeEmployee(employee)) return originalHandleMessage(args);

        const text = normalize(args.text || "");
        const isStart = ["start","arbeitsbeginn","einstempeln","arbeit starten"].includes(text);
        const isEnd = ["feierabend","ende","fertig","stop","stopp","ausstempeln"].includes(text);
        const isStatus = ["status","zeit","arbeitszeit"].includes(text);
        if (!isStart && !isEnd && !isStatus) return originalHandleMessage(args);

        const date = String(args.date || localDate());
        let events = await readJson(timeEventsFile, []);
        if (!Array.isArray(events)) events = [];
        const before = status(events, employee, date);

        if (isStart) {
          if (["working","pause","lunch"].includes(before.mode)) {
            return {
              reply:`✅ Bürozeit läuft bereits${before.startAt ? ` seit ${before.startAt} Uhr` : ""}.\n📍 ${OFFICE_JOB_ID} ${OFFICE_JOB_NAME}`,
              buttons:[],
              state:officeState(employee, date, before.mode),
            };
          }
          const at = localTime();
          events.push(makeEvent(employee, date, "start", at));
          await writeJson(timeEventsFile, events);
          return {
            reply:`✅ Bürozeit gestartet um ${at} Uhr.\n📍 ${OFFICE_JOB_ID} ${OFFICE_JOB_NAME}`,
            buttons:[],
            state:officeState(employee, date, "working"),
          };
        }

        if (isEnd) {
          if (!["working","pause","lunch"].includes(before.mode)) {
            return {
              reply:`ℹ️ Für heute ist keine offene Bürozeit vorhanden.\n📍 ${OFFICE_JOB_ID} ${OFFICE_JOB_NAME}`,
              buttons:[],
              state:officeState(employee, date, before.mode),
            };
          }
          const at = localTime();
          events.push(makeEvent(employee, date, "ende", at));
          await writeJson(timeEventsFile, events);
          return {
            reply:`✅ Ausgestempelt um ${at} Uhr. Schönen Feierabend!\n📍 ${OFFICE_JOB_ID} ${OFFICE_JOB_NAME}`,
            buttons:[],
            state:officeState(employee, date, "finished_day"),
          };
        }

        const label = ["working","pause","lunch"].includes(before.mode)
          ? `Bürozeit läuft${before.startAt ? ` seit ${before.startAt} Uhr` : ""}.`
          : before.mode === "finished_day"
            ? `Heute ausgestempelt${before.endAt ? ` um ${before.endAt} Uhr` : ""}.`
            : "Heute noch nicht eingestempelt.";
        return {
          reply:`${label}\n📍 ${OFFICE_JOB_ID} ${OFFICE_JOB_NAME}`,
          buttons:before.mode === "idle" ? ["Start"] : [],
          state:officeState(employee, date, before.mode),
        };
      } catch (error) {
        console.error("KGO Büro WhatsApp Routing fehlgeschlagen", error?.message || error);
        return originalHandleMessage(args);
      }
    };

    console.log("✅ KGO Büro WhatsApp-Routing aktiv · Bettina/Dunja · 022 Büroarbeiten");
    return instance;
  };
  wrapped.__kgoOfficeWhatsApp = true;
  kristine.registerKristine = wrapped;
}
