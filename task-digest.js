"use strict";

const fs = require("fs/promises");
const path = require("path");

const TZ = "Europe/Vienna";
const RETRY_MINUTES = 15;
const MESSAGE_LIMIT = 3800;
const ABSENCE_TYPES = new Set(["urlaub", "vacation", "krank", "sick", "za", "zeitausgleich", "feiertag", "holiday", "betriebsurlaub"]);

function localParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("de-AT", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date).map(part => [part.type, part.value]));
}

function localDateISO(date = new Date()) {
  const p = localParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function localHm(date = new Date()) {
  const p = localParts(date);
  return `${p.hour}:${p.minute}`;
}

function weekdayNumber(date) {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? new Date().getDay() : d.getDay();
}

function minutesFromHm(hm) {
  const m = String(hm || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

function inWindow(hm, from, to) {
  const n = minutesFromHm(hm);
  return n >= minutesFromHm(from) && n <= minutesFromHm(to);
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `43${digits.slice(1)}`;
  return digits;
}

function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isAlex(value) {
  const name = normalizeName(value);
  return name === "alexander krista" || name === "alex krista" || name.startsWith("alexander krista ") || name.startsWith("alex krista ");
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return fallback; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function unwrapArray(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function dateInRange(date, row) {
  const from = String(row?.from || row?.start || row?.date || "").slice(0, 10);
  const to = String(row?.to || row?.end || row?.date || "").slice(0, 10);
  return Boolean(from && to && from <= date && to >= date);
}

function globalNonWorkDay(date, holidays, companyVacations) {
  const weekday = weekdayNumber(date);
  if (weekday === 0 || weekday === 6) return true;
  if ((holidays || []).some(row => String(row?.date || row?.day || "").slice(0, 10) === date)) return true;
  if ((companyVacations || []).some(row => dateInRange(date, row))) return true;
  return false;
}

function employeeAbsent(employeeId, date, absences) {
  return (absences || []).some(row =>
    String(row?.employeeId || "") === String(employeeId || "") &&
    String(row?.date || row?.from || "").slice(0, 10) <= date &&
    String(row?.to || row?.date || row?.from || "").slice(0, 10) >= date &&
    ABSENCE_TYPES.has(String(row?.type || row?.cardType || "").toLowerCase())
  );
}

function taskPriorityRank(task) {
  return task?.priority === "sofort" ? 0 : task?.priority === "heute" ? 1 : 2;
}

function taskCategory(task, date) {
  const due = String(task?.dueDate || "").slice(0, 10);
  if (due && due < date) return "overdue";
  if (due === date || task?.priority === "heute" || task?.priority === "sofort") return "today";
  return "open";
}

function dueLabel(task) {
  const due = String(task?.dueDate || "").slice(0, 10);
  if (!due) return "";
  const [y, m, d] = due.split("-");
  return y && m && d ? `${d}.${m}.` : due;
}

function taskLine(task) {
  const icon = task?.priority === "sofort" ? "🔴" : task?.priority === "heute" ? "🟡" : "•";
  const site = String(task?.jobName || "").trim();
  const due = dueLabel(task);
  const suffix = [site, due].filter(Boolean).join(" · ");
  return `${icon} ${String(task?.title || "Aufgabe").trim()}${suffix ? ` · ${suffix}` : ""}`;
}

function tasksUrl() {
  const base = String(process.env.PUBLIC_BASE_URL || "https://protokoll.krista.at").replace(/\/$/, "");
  const url = new URL(`${base}/kristine`);
  const token = String(process.env.ADMIN_TOKEN || "").trim();
  if (token) url.searchParams.set("token", token);
  url.hash = "tasks";
  return url.toString();
}

function buildDigest(tasks, date, employeeName) {
  const rows = [...tasks].sort((a, b) => {
    const ca = taskCategory(a, date), cb = taskCategory(b, date);
    const order = { overdue: 0, today: 1, open: 2 };
    return order[ca] - order[cb] || taskPriorityRank(a) - taskPriorityRank(b) || String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });

  const groups = [
    ["overdue", "🔴 Überfällig"],
    ["today", "🟡 Heute"],
    ["open", "⚪ Offen"],
  ];

  const firstName = String(employeeName || "").trim().split(/\s+/)[0] || "";
  const lines = [`📌 ${firstName ? `${firstName}, d` : "D"}eine offenen Aufgaben`, "", `${rows.length} offen`];
  let included = 0;

  for (const [key, label] of groups) {
    const section = rows.filter(task => taskCategory(task, date) === key);
    if (!section.length) continue;
    const header = `\n${label} · ${section.length}`;
    if ((lines.join("\n") + header).length >= MESSAGE_LIMIT) break;
    lines.push(header);
    for (const task of section) {
      const line = taskLine(task);
      if ((lines.join("\n") + "\n" + line + "\n…").length >= MESSAGE_LIMIT) break;
      lines.push(line);
      included += 1;
    }
  }

  if (included < rows.length) lines.push("", `… und ${rows.length - included} weitere offene Aufgaben.`);
  lines.push("", "👉 Aufgaben öffnen:", tasksUrl());
  return lines.join("\n").slice(0, 4090);
}

function groupByAssignee(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = String(task?.assigneeId || task?.assigneeName || "").trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return groups;
}

function pruneState(state) {
  state.days = state.days || {};
  const keys = Object.keys(state.days).sort().reverse();
  for (const key of keys.slice(14)) delete state.days[key];
  return state;
}

async function registerTaskDigest({ dataDir, readEmployees, sendWhatsApp, chefPhone, phoneNumberId, logger = console }) {
  if (!dataDir || typeof readEmployees !== "function" || typeof sendWhatsApp !== "function") {
    logger.warn("KRISTINE Aufgaben 08:30 nicht registriert – Konfiguration unvollständig");
    return null;
  }

  const kristineDir = path.join(dataDir, "_kristine");
  const systemDir = path.join(dataDir, "_system");
  const files = {
    tasks: path.join(kristineDir, "tasks.json"),
    absences: path.join(kristineDir, "absences.json"),
    holidays: path.join(systemDir, "holidays.json"),
    companyVacations: path.join(systemDir, "company-vacations.json"),
    state: path.join(kristineDir, "task-digest-state.json"),
  };

  async function run(date = localDateISO(), force = false) {
    const [tasksRaw, employeesRaw, absencesRaw, holidaysRaw, vacationsRaw, stateRaw] = await Promise.all([
      readJson(files.tasks, []),
      readEmployees(),
      readJson(files.absences, []),
      readJson(files.holidays, []),
      readJson(files.companyVacations, []),
      readJson(files.state, {}),
    ]);

    const tasks = (Array.isArray(tasksRaw) ? tasksRaw : []).filter(task => task && task.status !== "done");
    if (!tasks.length) return { sent: 0, open: 0 };

    const employees = Array.isArray(employeesRaw) ? employeesRaw : [];
    const employeeById = new Map(employees.map(row => [String(row?.id || row?.employeeId || ""), row]));
    const absences = unwrapArray(absencesRaw, ["absences"]);
    const holidays = unwrapArray(holidaysRaw, ["holidays"]);
    const vacations = unwrapArray(vacationsRaw, ["vacations"]);
    const nonWork = globalNonWorkDay(date, holidays, vacations);
    const groups = groupByAssignee(tasks);
    const state = pruneState(stateRaw && typeof stateRaw === "object" ? stateRaw : {});
    state.days[date] = state.days[date] || { recipients: {} };

    let sent = 0;
    let failed = 0;
    let suppressed = 0;

    for (const [assigneeId, allRows] of groups) {
      const employee = employeeById.get(String(assigneeId)) || null;
      const assigneeName = String(employee?.name || employee?.employeeName || allRows[0]?.assigneeName || assigneeId);
      const urgentOnly = nonWork || employeeAbsent(assigneeId, date, absences);
      const rows = urgentOnly ? allRows.filter(task => task.priority === "sofort") : allRows;
      if (!rows.length) { suppressed += allRows.length; continue; }

      const recipientKey = String(employee?.id || employee?.employeeId || assigneeId);
      const previous = state.days[date].recipients[recipientKey];
      if (!force && previous?.status === "sent") continue;
      if (!force && previous?.status === "failed" && previous?.at) {
        const age = Date.now() - Date.parse(previous.at);
        if (Number.isFinite(age) && age >= 0 && age < RETRY_MINUTES * 60_000) continue;
      }

      let phone = normalizePhone(employee?.phone || employee?.mobile || employee?.whatsapp);
      if (!phone && isAlex(assigneeName)) phone = normalizePhone(chefPhone);
      if (!phone) {
        state.days[date].recipients[recipientKey] = { status: "failed", at: new Date().toISOString(), reason: "phone_missing" };
        failed += 1;
        continue;
      }

      const reply = buildDigest(rows, date, assigneeName);
      try {
        await sendWhatsApp({ phoneNumberId, to: phone, reply, buttons: [] });
        state.days[date].recipients[recipientKey] = { status: "sent", at: new Date().toISOString(), count: rows.length };
        sent += 1;
        logger.log("✅ KRISTINE 08:30 Aufgabenliste gesendet", { date, assigneeId: recipientKey, assigneeName, count: rows.length });
      } catch (error) {
        const reason = String(error?.message || error || "Versand fehlgeschlagen");
        state.days[date].recipients[recipientKey] = { status: "failed", at: new Date().toISOString(), reason };
        failed += 1;
        logger.error("❌ KRISTINE 08:30 Aufgabenliste fehlgeschlagen", { date, assigneeId: recipientKey, assigneeName, reason });
      }
    }

    await writeJson(files.state, state);
    return { sent, failed, suppressed, open: tasks.length, nonWork };
  }

  async function tick() {
    try {
      const hm = localHm();
      if (!inWindow(hm, "08:30", "11:00")) return;
      await run(localDateISO(), false);
    } catch (error) {
      logger.error("KRISTINE Aufgaben-08:30 Scheduler:", error);
    }
  }

  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  setTimeout(tick, 7_000).unref?.();

  logger.log("KRISTINE Aufgaben-08:30 registriert", {
    timezone: TZ,
    rule: "Mo–Fr alle offenen Aufgaben; Wochenende/Feiertag/Abwesenheit nur Sofort-Aufgaben; Wiederholung täglich bis Erledigt",
    retryMinutes: RETRY_MINUTES,
  });

  return { run, files };
}

module.exports = { registerTaskDigest, buildDigest, normalizePhone, isAlex };
