"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const cron = require("node-cron");
const expressPath = require.resolve("express");
const originalExpress = require("express");

const OFFICE_JOB_ID = "022";
const OFFICE_JOB_NAME = "Büroarbeiten";
const OFFICE_FIRST_NAMES = new Set(["bettina", "dunja"]);

function registerKgoOffice(app) {
  const dataDir = process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "https://protokoll.krista.at").replace(/\/$/, "");
  const employeesFile = path.join(dataDir, "_system", "employees.json");
  const timeEventsFile = path.join(dataDir, "_kristine", "time-events.json");
  const reminderStateFile = path.join(dataDir, "_kristine", "office-clock-reminders.json");
  const senderConfigFile = path.join(dataDir, "_kristine", "whatsapp-sender.json");

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (String(token) !== String(adminToken)) {
      res.status(403).json({ ok:false, error:"Forbidden" });
      return false;
    }
    return true;
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
    const names = [employee.nickname, employee.rufname, employee.firstName, employee.vorname, employee.name, employee.employeeName]
      .filter(Boolean).map(normalizeName);
    return names.some(name => OFFICE_FIRST_NAMES.has(name.split(/\s+/)[0] || ""));
  }

  async function employees() {
    const rows = await readJson(employeesFile, []);
    return Array.isArray(rows) ? rows : [];
  }

  async function officeEmployeeById(id) {
    const employee = (await employees()).find(row => employeeId(row) === String(id || "")) || null;
    return isOfficeEmployee(employee) ? employee : null;
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

  function dayRelevantEvents(events, id, date) {
    return (Array.isArray(events) ? events : []).filter(row =>
      String(row?.employeeId || "") === String(id) &&
      String(row?.date || "") === String(date) &&
      ["start","weiter","pause","mittag","ende","fertig","stop","stopp"].includes(String(row?.type || "").toLowerCase())
    );
  }

  function officeStatusFromEvents(events, employee, date = localDate()) {
    const id = employeeId(employee);
    const rows = dayRelevantEvents(events, id, date);
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
      ok:true,
      office:true,
      employeeId:id,
      employeeName:employeeName(employee),
      date,
      jobId:OFFICE_JOB_ID,
      jobName:OFFICE_JOB_NAME,
      mode,
      startAt:start?.at || "",
      endAt:end?.at || "",
      eventCount:rows.length,
      state:{
        employeeId:id,
        employeeName:employeeName(employee),
        mode,
        activeJobOverride:{ date, jobId:OFFICE_JOB_ID, jobName:OFFICE_JOB_NAME, city:"" },
        timeline:[],
      },
    };
  }

  async function officeStatus(id, date = localDate()) {
    const employee = await officeEmployeeById(id);
    if (!employee) return { ok:true, office:false, employeeId:String(id || ""), date };
    const events = await readJson(timeEventsFile, []);
    return officeStatusFromEvents(events, employee, date);
  }

  function newEvent({ employee, date, type, at }) {
    return {
      id:`office_${type}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
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
      source:"kgo-office",
      createdAt:new Date().toISOString(),
    };
  }

  async function clockEmployee(employee, action, requestedAt = "") {
    const date = localDate();
    let events = await readJson(timeEventsFile, []);
    if (!Array.isArray(events)) events = [];
    const before = officeStatusFromEvents(events, employee, date);

    if (action === "start") {
      if (["working","pause","lunch"].includes(before.mode)) return { ...before, changed:false, reply:"Bürozeit läuft bereits." };
      events.push(newEvent({ employee, date, type:"start", at:localTime() }));
      await writeJson(timeEventsFile, events);
      const after = officeStatusFromEvents(events, employee, date);
      return { ...after, changed:true, reply:`Bürozeit gestartet · ${OFFICE_JOB_ID} ${OFFICE_JOB_NAME}.` };
    }

    if (action === "end") {
      if (!["working","pause","lunch"].includes(before.mode)) return { ...before, changed:false, reply:"Bürozeit ist nicht offen." };
      const now = localTime();
      const at = String(requestedAt || now).trim();
      const endMinutes = hmMinutes(at);
      const nowMinutes = hmMinutes(now);
      const startMinutes = hmMinutes(before.startAt);
      if (endMinutes === null) throw new Error("Bitte eine gültige Endzeit eingeben.");
      if (startMinutes !== null && endMinutes < startMinutes) throw new Error(`Endzeit darf nicht vor ${before.startAt} liegen.`);
      if (nowMinutes !== null && endMinutes > nowMinutes) throw new Error("Endzeit darf nicht in der Zukunft liegen.");
      events.push(newEvent({ employee, date, type:"ende", at }));
      await writeJson(timeEventsFile, events);
      const after = officeStatusFromEvents(events, employee, date);
      return { ...after, changed:true, reply:`Ausgestempelt · Ende ${at} Uhr.` };
    }

    throw new Error("Unbekannte Büro-Zeitaktion.");
  }

  app.get("/kristine/api/office-status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json(await officeStatus(req.query.employeeId, String(req.query.date || localDate()))); }
    catch (error) { res.status(500).json({ ok:false, error:String(error?.message || error) }); }
  });

  app.post("/kristine/api/office-clock", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employee = await officeEmployeeById(req.body?.employeeId);
      if (!employee) return res.status(400).json({ ok:false, error:"Büromodus ist nur für Bettina und Dunja freigeschaltet." });
      res.json(await clockEmployee(employee, String(req.body?.action || "").toLowerCase(), req.body?.at));
    } catch (error) {
      res.status(400).json({ ok:false, error:String(error?.message || error) });
    }
  });

  // Büro hat bewusst keinen Tagesabschluss und keine automatische 17:00-Korrektur.
  // Diese Route liegt vor dem normalen Morning-Check und fängt nur Bettina/Dunja ab.
  app.post("/kristine/api/morning-check", async (req, res, next) => {
    try {
      const employee = await officeEmployeeById(req.body?.employeeId);
      if (!employee) return next();
      if (!requireAdmin(req, res)) return;
      const today = String(req.body?.date || localDate());
      const yesterdayDate = new Date(`${today}T12:00:00Z`);
      yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
      return res.json({
        ok:true, officeMode:true, today, yesterday:yesterdayDate.toISOString().slice(0,10),
        hadWork:false, forgotClockOut:false, autoClosed:false, autoClosedAt:null,
        dayCloseMissing:false, dayCloseIncomplete:false, needsAttention:false,
      });
    } catch (error) { return next(); }
  });

  // Falls KGO doch den normalen Message-Endpunkt verwendet: Start/Feierabend im Büro
  // bleiben Ein-Klick-Aktionen und laufen nie in den Baustellen-/Tagesabschlussdialog.
  app.post("/kristine/api/message", async (req, res, next) => {
    try {
      const employee = await officeEmployeeById(req.body?.employeeId);
      if (!employee) return next();
      const text = normalizeName(req.body?.text || "");
      let action = "";
      if (["start","arbeitsbeginn","einstempeln"].includes(text)) action = "start";
      if (["feierabend","ende","fertig","stop","stopp","ausstempeln"].includes(text)) action = "end";
      if (!action) return next();
      if (!requireAdmin(req, res)) return;
      const result = await clockEmployee(employee, action, req.body?.at);
      return res.json({ ...result, buttons:[], state:result.state });
    } catch (error) {
      return res.status(400).json({ ok:false, error:String(error?.message || error) });
    }
  });

  function normalizePhone(value) {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("0")) digits = `43${digits.slice(1)}`;
    return digits;
  }

  async function activeSenderId() {
    const env = String(process.env.PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.KRISTINE_PHONE_NUMBER_ID || "").trim();
    if (env) return env;
    const saved = await readJson(senderConfigFile, {});
    return String(saved?.phoneNumberId || "").trim();
  }

  async function sendReminder(employee) {
    const token = String(process.env.WHATSAPP_TOKEN || "").trim();
    const senderId = await activeSenderId();
    const phone = normalizePhone(employee?.phone);
    if (!token || !senderId || !phone) return { sent:false, reason:"whatsapp_not_configured" };
    const url = new URL("/public/kristine-go.html", publicBaseUrl);
    url.searchParams.set("employeeId", employeeId(employee));
    url.searchParams.set("officePrompt", "1");
    if (adminToken) url.searchParams.set("token", adminToken);
    const text = `⏰ Du bist in KRISTINE noch eingestempelt.\n\nVergessen auszutempeln? Wann war Ende?\nBitte kurz in KGO prüfen:\n${url.href}`;
    const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(senderId)}/messages`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
      body:JSON.stringify({ messaging_product:"whatsapp", recipient_type:"individual", to:phone, type:"text", text:{ preview_url:false, body:text } }),
    });
    if (!response.ok) throw new Error(`Meta ${response.status}: ${await response.text().catch(() => "")}`);
    return { sent:true };
  }

  async function runOfficeReminder() {
    const date = localDate();
    const [people, events, rawState] = await Promise.all([
      employees(), readJson(timeEventsFile, []), readJson(reminderStateFile, {})
    ]);
    const state = rawState && typeof rawState === "object" ? rawState : {};
    state[date] = state[date] && typeof state[date] === "object" ? state[date] : {};
    for (const employee of people.filter(isOfficeEmployee)) {
      const id = employeeId(employee);
      if (!id || state[date][id]?.sent) continue;
      const status = officeStatusFromEvents(events, employee, date);
      if (!["working","pause","lunch"].includes(status.mode)) continue;
      try {
        const result = await sendReminder(employee);
        state[date][id] = { sent:Boolean(result.sent), at:new Date().toISOString(), reason:result.reason || "" };
        console.log("⏰ KGO Büro 12:15", { employee:employeeName(employee), sent:Boolean(result.sent), reason:result.reason || "" });
      } catch (error) {
        state[date][id] = { sent:false, attemptedAt:new Date().toISOString(), error:String(error?.message || error) };
        console.error("KGO Büro Erinnerung fehlgeschlagen", employeeName(employee), error?.message || error);
      }
    }
    await writeJson(reminderStateFile, state);
  }

  cron.schedule("15 12 * * 1-5", () => runOfficeReminder().catch(error => console.error("KGO Büro 12:15 Fehler", error)), {
    timezone:"Europe/Vienna"
  });

  console.log("✅ KGO Büro-Modus registriert · Bettina/Dunja · 022 Büroarbeiten · Erinnerung 12:15");
}

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  const originalUse = app.use.bind(app);
  let registered = false;
  app.use = function patchedUse(...useArgs) {
    const result = originalUse(...useArgs);
    if (!registered) {
      registered = true;
      try { registerKgoOffice(app); }
      catch (error) { console.error("KGO Büro-Modus konnte nicht registriert werden:", error?.message || error); }
    }
    return result;
  };
  return app;
}

Object.assign(wrappedExpress, originalExpress);
wrappedExpress.application = originalExpress.application;
wrappedExpress.request = originalExpress.request;
wrappedExpress.response = originalExpress.response;
require.cache[expressPath].exports = wrappedExpress;
