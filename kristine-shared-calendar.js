"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const TIME_ZONE = "Europe/Berlin";
const SOURCE = "kristine_shared_calendar";
const MANAGED_MARKER = "KRISTINE";

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

function validDate(value) {
  const date = isoDate(value);
  if (!date) return "";
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? "" : date;
}

function timeFromMinutes(value) {
  const minutes = Math.max(0, Math.min((24 * 60) - 1, Number(value) || 0));
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function annualDate(original, year) {
  const suffix = validDate(original).slice(4);
  return suffix ? validDate(`${year}${suffix}`) : "";
}

function assignmentType(row) {
  const explicit = normalize(row?.cardType);
  if (["urlaub", "krank"].includes(explicit)) return explicit;
  if (explicit && !["site", "arbeit"].includes(explicit)) return explicit;
  const raw = normalize([row?.jobId, row?.jobName].join(" "));
  if (/\b(krank|krankenstand)\b/.test(raw)) return "krank";
  if (/\b(urlaub|ferien|sonderurlaub)\b/.test(raw)) return "urlaub";
  return "site";
}

function syncId(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 32);
}

function desiredCalendarEntries({ from, to, assignments = [], employees = [], jobs = [] }) {
  const desired = [];
  const add = row => {
    const date = validDate(row.date);
    if (!date || date < from || date > to) return;
    const key = String(row.key || "");
    desired.push({ ...row, date, syncId:syncId(key) });
  };

  for (const row of assignments) {
    const type = assignmentType(row);
    if (!["urlaub", "krank", "feiertag", "betriebsurlaub"].includes(type) || row?.source === SOURCE) continue;
    if (["feiertag", "betriebsurlaub"].includes(type)) {
      add({ key:`holiday:${type}:${row.date}`, date:row.date, subject:type === "feiertag" ? "Feiertag" : "Betriebsurlaub", kind:type, showAs:"free", allDay:true });
      continue;
    }
    const employee = String(row.employeeName || "Mitarbeiter").trim();
    add({ key:`absence:${row.id || `${row.date}:${row.employeeId}:${type}`}`, date:row.date, subject:`${type === "krank" ? "Krank" : "Urlaub"} · ${employee}`, kind:type, showAs:"free", allDay:true });
  }

  const fromYear = Number(from.slice(0, 4)), toYear = Number(to.slice(0, 4));
  for (const employee of employees) {
    if (employee?.active === false) continue;
    const employeeId = String(employee.id || employee.employeeId || employee.name || "");
    const employeeName = String(employee.name || employee.employeeName || "Mitarbeiter").trim();
    for (let year = fromYear; year <= toYear; year += 1) {
      const birthday = annualDate(employee.birthDate, year);
      if (birthday) add({ key:`birthday:${employeeId}:${year}`, date:birthday, subject:`Geburtstag · ${employeeName}`, kind:"birthday", showAs:"free", allDay:true });
      const employmentStart = validDate(employee.employmentStart), anniversary = annualDate(employmentStart, year), years = year - Number(employmentStart.slice(0, 4));
      if (anniversary && years >= 0) add({ key:`anniversary:${employeeId}:${year}`, date:anniversary, subject:years ? `${years}. Eintrittsjahrestag · ${employeeName}` : `Eintritt · ${employeeName}`, kind:"anniversary", showAs:"free", allDay:true });
    }
  }

  const starts = new Map();
  for (const job of jobs) {
    const jobId = String(job.jobId || job.number || "").trim(), date = validDate(job.startDate);
    if (jobId && date) starts.set(jobId, { date, name:String(job.name || jobId).trim() });
  }
  for (const row of assignments) {
    if (assignmentType(row) !== "site") continue;
    const jobId = String(row.jobId || row.jobName || "").trim(), date = validDate(row.date);
    if (!jobId || !date) continue;
    const current = starts.get(jobId);
    if (!current || date < current.date) starts.set(jobId, { date, name:String(row.jobName || current?.name || jobId).trim() });
  }
  const startsPerDay = new Map();
  for (const [jobId, start] of [...starts].sort((a, b) => a[1].date.localeCompare(b[1].date) || a[0].localeCompare(b[0], "de"))) {
    const position = startsPerDay.get(start.date) || 0, startMinutes = (6 * 60) + (position * 15);
    startsPerDay.set(start.date, position + 1);
    add({ key:`job-start:${jobId}`, date:start.date, subject:`Baustellenstart · #${jobId} · ${start.name}`, kind:"job-start", showAs:"free", startTime:timeFromMinutes(startMinutes), endTime:timeFromMinutes(startMinutes + 15) });
  }

  const unique = new Map();
  for (const row of desired) {
    const natural = `${row.kind}|${row.date}|${normalize(row.subject)}`;
    if (!unique.has(natural)) unique.set(natural, row);
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.subject.localeCompare(b.subject, "de"));
}

function installKristineSharedCalendar(app, deps = {}) {
  const dataDir = deps.dataDir || process.env.DATA_DIR || "/var/data";
  const requireAdmin = deps.requireAdmin;
  const accessToken = deps.accessToken;
  const readEmployees = deps.readEmployees;
  const readJobs = deps.readJobs;
  const mailbox = String(deps.mailbox || process.env.KRISTINE_MAILBOX_ADDRESS || "kristine@krista.at").trim().toLowerCase();
  const fetchImpl = deps.fetch || global.fetch;
  const logger = deps.logger || console;
  const root = path.join(dataDir, "_kristine");
  const assignmentsFile = path.join(root, "assignments.json");
  const stateFile = path.join(root, "shared-calendar-state.json");
  const outboundFile = path.join(root, "shared-calendar-outbound.json");
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
      "$select":"id,subject,start,end,isAllDay,lastModifiedDateTime,isCancelled,categories,seriesMasterId,type,bodyPreview",
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

  async function graphWrite(method, eventId, payload) {
    if (typeof accessToken !== "function") throw new Error("Outlook-Zugriff ist nicht eingerichtet.");
    const suffix = eventId ? `/${encodeURIComponent(eventId)}` : "";
    const response = await fetchImpl(`${GRAPH_ROOT}/users/${encodeURIComponent(mailbox)}/events${suffix}`, {
      method,
      headers:{ Authorization:`Bearer ${await accessToken()}`, "Content-Type":"application/json" },
      ...(payload ? { body:JSON.stringify(payload) } : {}),
    });
    if (response.status === 404) return { notFound:true };
    const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 403) throw new Error(`Kein Schreibzugriff auf ${mailbox}. Bitte "Lesen und Verwalten" prüfen.`);
      throw new Error(String(body?.error?.message || `Microsoft Graph HTTP ${response.status}`));
    }
    return body;
  }

  function markerFromEvent(event) {
    return String(event?.bodyPreview || "").match(/\[KRISTINE:([a-f0-9]{32})\]/i)?.[1]?.toLowerCase() || "";
  }

  function eventNaturalKey(subject, date) {
    return `${normalize(subject)}|${validDate(date)}`;
  }

  function outboundPayload(row, creating) {
    const allDay = row.allDay === true;
    const payload = {
      subject:row.subject,
      body:{ contentType:"text", content:`[${MANAGED_MARKER}:${row.syncId}]\nAutomatisch aus KRISTINE synchronisiert.` },
      start:{ dateTime:`${row.date}T${allDay ? "00:00:00" : `${row.startTime || "07:00"}:00`}`, timeZone:TIME_ZONE },
      end:{ dateTime:`${allDay ? addDays(row.date, 1) : row.date}T${allDay ? "00:00:00" : `${row.endTime || "07:30"}:00`}`, timeZone:TIME_ZONE },
      isAllDay:allDay,
      showAs:row.showAs,
    };
    if (creating) payload.transactionId = row.syncId;
    return payload;
  }

  function outboundFingerprint(row) {
    return crypto.createHash("sha256").update(JSON.stringify([row.subject, row.date, row.showAs, row.allDay === true, row.startTime || "", row.endTime || ""])).digest("hex");
  }

  async function reconcileOutbound({ from, to, events, assignments, employees, jobs }) {
    const desired = desiredCalendarEntries({ from, to, assignments, employees, jobs });
    const previous = await readJson(outboundFile, []);
    const previousBySyncId = new Map((Array.isArray(previous) ? previous : []).map(row => [String(row.syncId || ""), row]));
    const markedBySyncId = new Map(events.map(event => [markerFromEvent(event), event]).filter(([id]) => id));
    const naturalEvents = new Map(events.filter(event => !event?.isCancelled).map(event => [eventNaturalKey(event.subject, event.start?.dateTime), event]));
    const next = [], counters = { outboundCount:desired.length, outboundCreated:0, outboundUpdated:0, outboundRemoved:0, outboundLinked:0 };

    for (const row of desired) {
      const fingerprint = outboundFingerprint(row);
      let stored = previousBySyncId.get(row.syncId), event = markedBySyncId.get(row.syncId);
      if (!event && stored?.eventId) event = events.find(candidate => String(candidate.id) === String(stored.eventId));
      if (!event && !stored) {
        const natural = naturalEvents.get(eventNaturalKey(row.subject, row.date));
        if (natural) {
          next.push({ ...row, fingerprint, eventId:String(natural.id), owned:false, syncedAt:new Date().toISOString() });
          counters.outboundLinked += 1;
          continue;
        }
      }
      if (event && stored?.fingerprint === fingerprint) {
        next.push({ ...stored, ...row, fingerprint, eventId:String(event.id), syncedAt:new Date().toISOString() });
        continue;
      }
      if (stored?.owned === false && event) {
        next.push({ ...stored, ...row, fingerprint, eventId:String(event.id), syncedAt:new Date().toISOString() });
        continue;
      }
      if (event) {
        const updated = await graphWrite("PATCH", event.id, outboundPayload(row, false));
        if (!updated.notFound) {
          next.push({ ...row, fingerprint, eventId:String(event.id), owned:true, syncedAt:new Date().toISOString() });
          counters.outboundUpdated += 1;
          continue;
        }
      }
      const created = await graphWrite("POST", "", outboundPayload(row, true));
      next.push({ ...row, fingerprint, eventId:String(created.id || ""), owned:true, syncedAt:new Date().toISOString() });
      counters.outboundCreated += 1;
    }

    const desiredIds = new Set(desired.map(row => row.syncId));
    for (const stored of Array.isArray(previous) ? previous : []) {
      if (desiredIds.has(String(stored.syncId || ""))) continue;
      if (stored.date < from || stored.date > to) { next.push(stored); continue; }
      if (stored.owned !== false && stored.eventId) await graphWrite("DELETE", stored.eventId);
      counters.outboundRemoved += stored.owned === false ? 0 : 1;
    }
    await atomicJson(outboundFile, next);
    return counters;
  }

  function calendarRows(events, employees) {
    const rows = [], unmatched = [];
    for (const event of events) {
      if (event?.isCancelled) continue;
      if (markerFromEvent(event)) continue;
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
        const [events, employees, assignments, jobs] = await Promise.all([
          graphEvents(from, to),
          typeof readEmployees === "function" ? readEmployees() : [],
          readJson(assignmentsFile, []),
          typeof readJobs === "function" ? readJobs() : [],
        ]);
        const parsed = calendarRows(events, employees);
        const manual = (Array.isArray(assignments) ? assignments : []).filter(row => row?.source !== SOURCE || String(row.date || "") < from || String(row.date || "") > to);
        const manualKeys = new Set(manual.map(row => `${row.date}|${row.employeeId}|${row.cardType || row.type || ""}`));
        const imported = parsed.rows.filter(row => !manualKeys.has(`${row.date}|${row.employeeId}|${row.cardType}`));
        const combined = [...manual, ...imported].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.employeeName || "").localeCompare(String(b.employeeName || ""), "de"));
        await atomicJson(assignmentsFile, combined);
        const outbound = await reconcileOutbound({ from, to, events, assignments:combined, employees, jobs });
        const state = { mailbox, lastSuccessAt:new Date().toISOString(), lastError:"", from, to, eventCount:events.length, importedCount:imported.length, ...outbound, unmatched:parsed.unmatched.slice(0, 50) };
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

  return { sync, calendarRows, desiredCalendarEntries };
}

module.exports = { installKristineSharedCalendar, absenceType, matchEmployee, eventDates, desiredCalendarEntries };
