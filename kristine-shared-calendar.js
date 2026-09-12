"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const TIME_ZONE = "Europe/Berlin";
const SOURCE = "kristine_shared_calendar";

function normalize(value) {
  return String(value || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isoDate(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function isWeekday(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function absenceType(event) {
  const text = normalize([event?.subject, ...(event?.categories || [])].join(" "));
  if (/\bsonderurlaub\b/.test(text)) return { cardType:"urlaub", label:"Sonderurlaub" };
  if (/\b(zeitausgleich|za)\b/.test(text)) return { cardType:"za", label:"Zeitausgleich" };
  if (/\b(krank|krankenstand)\b/.test(text)) return { cardType:"krank", label:"Krank" };
  if (/\b(urlaub|ferien)\b/.test(text)) return { cardType:"urlaub", label:"Urlaub" };
  return null;
}

function employeeAliases(employee) {
  const full = normalize(employee?.name || employee?.employeeName);
  const nickname = normalize(employee?.nickname || employee?.rufname);
  const parts = full.split(" ").filter(Boolean);
  const aliases = new Set([full, nickname]);
  if (parts.length > 1) {
    aliases.add(`${parts[0]} ${parts[parts.length - 1]}`);
    aliases.add(`${parts[parts.length - 1]} ${parts[0]}`);
  }
  return [...aliases].filter(alias => alias.length >= 3).sort((a, b) => b.length - a.length);
}

function matchEmployee(event, employees) {
  const subject = ` ${normalize(event?.subject)} `;
  const matches = [];
  for (const employee of employees || []) {
    if (employee?.active === false) continue;
    const alias = employeeAliases(employee).find(candidate => subject.includes(` ${candidate} `));
    if (alias) matches.push({ employee, score:alias.length });
  }
  matches.sort((a, b) => b.score - a.score);
  if (!matches.length) return { reason:"Mitarbeitername fehlt oder wurde nicht erkannt" };
  if (matches.length > 1 && matches[0].score === matches[1].score) return { reason:"Mitarbeitername ist nicht eindeutig" };
  return { employee:matches[0].employee };
}

function eventDates(event) {
  const start = isoDate(event?.start?.dateTime);
  const end = isoDate(event?.end?.dateTime);
  if (!start) return [];
  let exclusiveEnd;
  if (event?.isAllDay) exclusiveEnd = end && end > start ? end : addDays(start, 1);
  else {
    const endTime = String(event?.end?.dateTime || "").slice(11, 19);
    exclusiveEnd = end && end > start ? (endTime && endTime !== "00:00:00" ? addDays(end, 1) : end) : addDays(start, 1);
  }
  const dates = [];
  for (let date = start; date < exclusiveEnd && dates.length < 370; date = addDays(date, 1)) {
    if (isWeekday(date)) dates.push(date);
  }
  return dates;
}

function cleanGraphUrl(value) {
  const url = new URL(value, GRAPH_ROOT);
  if (url.origin !== new URL(GRAPH_ROOT).origin) throw new Error("Ungültige Microsoft-Graph-Folgeseite.");
  return url.toString();
}

function installKristineSharedCalendar(app, deps = {}) {
  const dataDir = deps.dataDir || process.env.DATA_DIR || "/var/data";
  const requireAdmin = deps.requireAdmin;
  const accessToken = deps.accessToken;
  const readEmployees = deps.readEmployees;
  const mailbox = String(deps.mailbox || process.env.KRISTINE_MAILBOX_ADDRESS || "kristine@krista.at").trim().toLowerCase();
  const fetchImpl = deps.fetch || global.fetch;
  const logger = deps.logger || console;
  const root = path.join(dataDir, "_kristine");
  const assignmentsFile = path.join(root, "assignments.json");
  const stateFile = path.join(root, "shared-calendar-state.json");
  let queue = Promise.resolve();

  const allowed = (req, res) => typeof requireAdmin !== "function" ? true : requireAdmin(req, res);
  const readJson = async (file, fallback) => fsp.readFile(file, "utf8").then(JSON.parse).catch(() => fallback);
  const atomicJson = async (file, value) => {
    await fsp.mkdir(path.dirname(file), { recursive:true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(temporary, file);
  };
  const serialized = action => {
    const result = queue.then(action, action);
    queue = result.catch(() => {});
    return result;
  };
  const today = () => typeof deps.today === "function" ? deps.today() : new Date().toISOString().slice(0, 10);

  async function graphEvents(from, to) {
    if (typeof accessToken !== "function") throw new Error("Outlook-Zugriff ist nicht eingerichtet.");
    const params = new URLSearchParams({
      startDateTime:`${from}T00:00:00`, endDateTime:`${addDays(to, 1)}T00:00:00`,
      "$select":"id,subject,start,end,isAllDay,lastModifiedDateTime,isCancelled,categories,seriesMasterId,type",
      "$top":"500",
    });
    let next = `${GRAPH_ROOT}/users/${encodeURIComponent(mailbox)}/calendarView?${params}`;
    const events = [];
    while (next && events.length < 5000) {
      const response = await fetchImpl(cleanGraphUrl(next), {
        headers:{ Authorization:`Bearer ${await accessToken()}`, Prefer:`outlook.timezone=\"${TIME_ZONE}\"` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 403) throw new Error(`Kein Kalenderzugriff auf ${mailbox}. Bitte \"Lesen und Verwalten\" prüfen und Microsoft neu verbinden.`);
        throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
      }
      events.push(...(Array.isArray(body.value) ? body.value : []));
      next = body["@odata.nextLink"] || "";
    }
    return events;
  }

  function calendarRows(events, employees) {
    const rows = [], unmatched = [];
    for (const event of events) {
      if (event?.isCancelled) continue;
      const type = absenceType(event);
      if (!type) continue;
      const matched = matchEmployee(event, employees);
      const dates = eventDates(event);
      if (!matched.employee || !dates.length) {
        unmatched.push({ id:String(event?.id || ""), subject:String(event?.subject || "Ohne Betreff"), reason:matched.reason || "Datum fehlt" });
        continue;
      }
      const employee = matched.employee;
      for (const date of dates) {
        const key = `${event.id}|${date}|${employee.id || employee.employeeId}`;
        rows.push({
          id:`kcal_${crypto.createHash("sha1").update(key).digest("hex").slice(0, 22)}`,
          date, cardType:type.cardType, jobId:"", jobName:type.label, city:"", address:"", contactName:"", contactPhone:"",
          employeeId:String(employee.id || employee.employeeId || ""), employeeName:String(employee.name || employee.employeeName || ""),
          vehicle:"", from:"", to:"", hours:7.8,
          note:`Kristine-Kalender: ${String(event.subject || type.label).slice(0, 300)}`,
          source:SOURCE, externalEventId:String(event.id || ""), externalSeriesMasterId:String(event.seriesMasterId || ""),
          externalLastModified:String(event.lastModifiedDateTime || ""), syncedAt:new Date().toISOString(),
        });
      }
    }
    return { rows, unmatched };
  }

  async function sync() {
    return serialized(async () => {
      const anchor = today(), from = addDays(anchor, -30), to = addDays(anchor, 400);
      try {
        const [events, employees, assignments] = await Promise.all([
          graphEvents(from, to),
          typeof readEmployees === "function" ? readEmployees() : [],
          readJson(assignmentsFile, []),
        ]);
        const parsed = calendarRows(events, employees);
        const manual = (Array.isArray(assignments) ? assignments : []).filter(row => row?.source !== SOURCE || String(row.date || "") < from || String(row.date || "") > to);
        const manualKeys = new Set(manual.map(row => `${row.date}|${row.employeeId}|${row.cardType || row.type || ""}`));
        const imported = parsed.rows.filter(row => !manualKeys.has(`${row.date}|${row.employeeId}|${row.cardType}`));
        const combined = [...manual, ...imported].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.employeeName || "").localeCompare(String(b.employeeName || ""), "de"));
        await atomicJson(assignmentsFile, combined);
        const state = { mailbox, lastSuccessAt:new Date().toISOString(), lastError:"", from, to, eventCount:events.length, importedCount:imported.length, unmatched:parsed.unmatched.slice(0, 50) };
        await atomicJson(stateFile, state);
        return state;
      } catch (error) {
        const previous = await readJson(stateFile, {});
        const state = { ...previous, mailbox, lastAttemptAt:new Date().toISOString(), lastError:String(error?.message || error).slice(0, 1000) };
        await atomicJson(stateFile, state);
        throw error;
      }
    });
  }

  app.get("/kristine/api/shared-calendar/status", async (req, res) => {
    if (!allowed(req, res)) return;
    res.json({ ok:true, mailbox, syntax:"Urlaub – Vorname Nachname", ...await readJson(stateFile, {}) });
  });
  app.post("/kristine/api/shared-calendar/sync", async (req, res) => {
    if (!allowed(req, res)) return;
    try { res.json({ ok:true, ...await sync() }); }
    catch (error) { res.status(502).json({ ok:false, error:String(error?.message || error) }); }
  });

  if (deps.autoStart !== false) {
    const first = setTimeout(() => sync().catch(error => logger.warn("KRISTINE Kalender-Abruf fehlgeschlagen", error?.message || error)), 20000);
    first.unref?.();
    const timer = setInterval(() => sync().catch(error => logger.warn("KRISTINE Kalender-Abruf fehlgeschlagen", error?.message || error)), 5 * 60 * 1000);
    timer.unref?.();
  }

  return { sync, calendarRows };
}

module.exports = { installKristineSharedCalendar, absenceType, matchEmployee, eventDates };
