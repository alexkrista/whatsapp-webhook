// morning-status.js
// KRISTA: 07:00 Startprüfung + 08:00 Chefstatus
// Zeitzone: Europe/Vienna
// Ohne zusätzliche npm-Abhängigkeit.

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

function localIsoDate(date = new Date()) {
  const p = localParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function localHm(date = new Date()) {
  const p = localParts(date);
  return `${p.hour}:${p.minute}`;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function minutesFromHm(hm) {
  const m = String(hm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Betriebsregel: Alles vor 07:00 wird als 07:00 gespeichert.
function clampStartTime(hm) {
  const value = minutesFromHm(hm);
  const official = minutesFromHm(OFFICIAL_START);
  if (value == null) return hm;
  return value < official ? OFFICIAL_START : hm;
}

function activeEmployees(employees) {
  return (Array.isArray(employees) ? employees : []).filter(
    (e) => e && e.active !== false && normalizePhone(e.phone)
  );
}

function rowsForDate(rows, date) {
  return (Array.isArray(rows) ? rows : []).filter((r) => String(r.date) === String(date));
}

function employeeRows(rows, employeeId) {
  return rows.filter((r) => String(r.employeeId) === String(employeeId));
}

function currentAssignment(assignments, employeeId, date) {
  const list = employeeRows(rowsForDate(assignments, date), employeeId)
    .sort((a, b) => String(a.from || "").localeCompare(String(b.from || "")));
  return list[0] || null;
}

function absenceFor(absences, employeeId, date) {
  return rowsForDate(absences, date).find(
    (r) => String(r.employeeId) === String(employeeId)
  ) || null;
}

function timeState(events, employeeId, date) {
  const list = employeeRows(rowsForDate(events, date), employeeId)
    .sort((a, b) => String(a.at || a.time || "").localeCompare(String(b.at || b.time || "")));

  if (!list.length) return { state: "missing", firstStart: null, events: [] };

  const start = list.find((e) => String(e.type || e.command || "").toLowerCase() === "start");
  const last = list[list.length - 1];
  const type = String(last.type || last.command || "").toLowerCase();

  let state = "working";
  if (type === "pause" || type === "mittag") state = "pause";
  if (type === "ende" || type === "fertig") state = "ended";

  return {
    state,
    firstStart: start?.at || start?.time || null,
    events: list,
  };
}

function lateNoticeFor(lateNotices, employeeId, date) {
  return rowsForDate(lateNotices, date)
    .filter((r) => String(r.employeeId) === String(employeeId))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

function absenceLabel(absence) {
  const type = String(absence?.type || "").toLowerCase();
  if (type === "urlaub") return "Urlaub";
  if (type === "krank") return "Krank";
  if (type === "zeitausgleich") return "Zeitausgleich";
  if (type === "berufsschule") return "Berufsschule";
  return absence?.label || absence?.type || "Abwesend";
}

function jobLabel(assignment) {
  return assignment?.jobName || assignment?.jobId || assignment?.siteCode || "keine Baustelle";
}

function statusForEmployee({ employee, assignments, absences, events, lateNotices, date }) {
  const assignment = currentAssignment(assignments, employee.id, date);
  const absence = absenceFor(absences, employee.id, date);
  const time = timeState(events, employee.id, date);
  const late = lateNoticeFor(lateNotices, employee.id, date);

  if (absence) {
    return {
      lamp: "green",
      icon: "🟢",
      category: "absence",
      employee,
      assignment,
      text: `${employee.name} – ${absenceLabel(absence)} (${DAILY_TARGET_HOURS.toLocaleString("de-AT")} Sollstunden)`,
    };
  }

  if (time.state === "working" || time.state === "pause" || time.state === "ended") {
    const suffix =
      time.state === "pause" ? " – Pause" :
      time.state === "ended" ? " – bereits beendet" : "";
    return {
      lamp: "green",
      icon: "🟢",
      category: "started",
      employee,
      assignment,
      text: `${employee.name} – ${jobLabel(assignment)}${suffix}`,
    };
  }

  if (late) {
    const expected = late.expectedTime ? `, ca. ${late.expectedTime}` : "";
    return {
      lamp: "yellow",
      icon: "🟡",
      category: "late",
      employee,
      assignment,
      text: `${employee.name} – kommt später${expected} – ${jobLabel(assignment)}`,
    };
  }

  return {
    lamp: "red",
    icon: "🔴",
    category: "missing",
    employee,
    assignment,
    text: `${employee.name} – nicht angemeldet – ${jobLabel(assignment)}`,
  };
}

function buildChefReport(statuses, date) {
  const green = statuses.filter((s) => s.lamp === "green");
  const yellow = statuses.filter((s) => s.lamp === "yellow");
  const red = statuses.filter((s) => s.lamp === "red");

  const lines = [
    `📋 Morgenstatus KRISTA – ${date}`,
    "",
    `🟢 ${green.length} in Ordnung`,
    `🟡 ${yellow.length} später angekündigt`,
    `🔴 ${red.length} ohne Anmeldung/Rückmeldung`,
  ];

  if (!yellow.length && !red.length) {
    lines.push("", "✅ Alle Mitarbeiter sind erfasst. Keine offenen Punkte.");
    return lines.join("\n");
  }

  if (yellow.length) {
    lines.push("", "🟡 Später:");
    for (const s of yellow) lines.push(`• ${s.text}`);
  }

  if (red.length) {
    lines.push("", "🔴 Offen:");
    for (const s of red) lines.push(`• ${s.text}`);
  }

  return lines.join("\n");
}

function reminderText(employee, assignment) {
  return [
    `Guten Morgen ${employee.name}.`,
    `Du bist heute auf ${jobLabel(assignment)} eingeteilt.`,
    "",
    "Ich habe noch keinen Arbeitsbeginn erhalten.",
    "Kommst du heute später?",
  ].join("\n");
}

function weekdayIndex(dateStr) {
  const day = new Date(`${dateStr}T12:00:00`).getDay();
  return day === 0 ? 6 : day - 1;
}

function addMinutes(hm, amount) {
  const base = minutesFromHm(hm);
  if (base == null) return "";
  const total = ((base + Number(amount || 0)) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function reminderDone(scheduler, group, date, employeeId) {
  return Boolean(scheduler?.[group]?.[date]?.[String(employeeId)]);
}

function markReminder(scheduler, group, date, employeeId) {
  scheduler[group] = scheduler[group] || {};
  scheduler[group][date] = scheduler[group][date] || {};
  scheduler[group][date][String(employeeId)] = true;
}

async function registerMorningStatus({
  dataDir,
  readEmployees,
  sendWhatsApp,
  chefPhone,
  phoneNumberId,
  logger = console,
}) {
  if (!dataDir) throw new Error("registerMorningStatus: dataDir fehlt");
  if (typeof readEmployees !== "function") throw new Error("registerMorningStatus: readEmployees fehlt");
  if (typeof sendWhatsApp !== "function") throw new Error("registerMorningStatus: sendWhatsApp fehlt");

  const kristineDir = path.join(dataDir, "_kristine");
  const files = {
    assignments: path.join(kristineDir, "assignments.json"),
    absences: path.join(kristineDir, "absences.json"),
    events: path.join(kristineDir, "time-events.json"),
    lateNotices: path.join(kristineDir, "late-notices.json"),
    scheduler: path.join(kristineDir, "scheduler-state.json"),
    states: path.join(kristineDir, "states.json"),
    scheduleModels: path.join(kristineDir, "schedule-models.json"),
  };

  async function loadState() {
    const [employees, assignments, absences, events, lateNotices, scheduler, states, scheduleModels] = await Promise.all([
      readEmployees(),
      readJson(files.assignments, []),
      readJson(files.absences, []),
      readJson(files.events, []),
      readJson(files.lateNotices, []),
      readJson(files.scheduler, {}),
      readJson(files.states, {}),
      readJson(files.scheduleModels, []),
    ]);
    return { employees, assignments, absences, events, lateNotices, scheduler, states, scheduleModels };
  }

  async function saveRun(key, date, scheduler) {
    scheduler[key] = date;
    await writeJson(files.scheduler, scheduler);
  }

  async function runSevenOClock(date = localIsoDate(), force = false) {
    const state = await loadState();
    if (!force && state.scheduler.startReminder === date) return { skipped: true };

    const statuses = activeEmployees(state.employees).map((employee) =>
      statusForEmployee({ employee, ...state, date })
    );

    for (const status of statuses.filter((s) => s.category === "missing")) {
      await sendWhatsApp({
        phoneNumberId,
        to: normalizePhone(status.employee.phone),
        reply: reminderText(status.employee, status.assignment),
        buttons: ["Start", "Komme später", "Heute nicht"],
      }).catch((error) => logger.error("07:00 Erinnerung fehlgeschlagen", status.employee.name, error));
    }

    await saveRun("startReminder", date, state.scheduler);
    return { sent: statuses.filter((s) => s.category === "missing").length };
  }

  async function runEightOClock(date = localIsoDate(), force = false) {
    const state = await loadState();
    if (!force && state.scheduler.chefReport === date) return { skipped: true };

    const statuses = activeEmployees(state.employees).map((employee) =>
      statusForEmployee({ employee, ...state, date })
    );

    const report = buildChefReport(statuses, date);
    if (normalizePhone(chefPhone)) {
      await sendWhatsApp({
        phoneNumberId,
        to: normalizePhone(chefPhone),
        reply: report,
      });
    } else {
      logger.warn("CHEF_PHONE fehlt – Chefbericht nur im Log:", report);
    }

    await saveRun("chefReport", date, state.scheduler);
    return { sent: true, statuses, report };
  }

  function scheduleDayFor(employee, date, scheduleModels) {
    const modelId = String(employee?.worktimeModelId || "");
    const model = (Array.isArray(scheduleModels) ? scheduleModels : []).find((item) => String(item?.id) === modelId) || (Array.isArray(scheduleModels) ? scheduleModels[0] : null);
    return model?.days?.[weekdayIndex(date)] || null;
  }

  async function runLunchAutomation(date = localIsoDate(), hm = localHm()) {
    const state = await loadState();
    let changed = false;
    for (const employee of activeEmployees(state.employees)) {
      const employeeState = state.states[String(employee.id)];
      if (!employeeState || employeeState.pending) continue;
      const day = scheduleDayFor(employee, date, state.scheduleModels);
      if (!day?.isWorkDay || !day.lunchStart || !day.lunchEnd) continue;

      const startReminderAt = addMinutes(day.lunchStart, 5);
      const endReminderAt = addMinutes(day.lunchEnd, 5);
      if (hm === startReminderAt && employeeState.mode === "working" && !reminderDone(state.scheduler, "lunchStart", date, employee.id)) {
        employeeState.pending = { type: "lunch_start_question", createdAt: new Date().toISOString() };
        await sendWhatsApp({ phoneNumberId, to: normalizePhone(employee.phone), reply: "🍽️ Laut deinem Arbeitsmodell wäre jetzt Mittagspause. Machst du jetzt Mittag?", buttons: ["Ja", "Nein"] }).catch((error) => logger.error("Mittagserinnerung fehlgeschlagen", employee.name, error));
        markReminder(state.scheduler, "lunchStart", date, employee.id); changed = true;
      }
      if (hm === endReminderAt && employeeState.mode === "lunch" && !reminderDone(state.scheduler, "lunchEnd", date, employee.id)) {
        employeeState.pending = { type: "resume_check", createdAt: new Date().toISOString(), breakMode: "lunch" };
        await sendWhatsApp({ phoneNumberId, to: normalizePhone(employee.phone), reply: "🍽️ Arbeitest du bereits wieder?", buttons: ["Ja", "Nein"] }).catch((error) => logger.error("Mittagsende-Erinnerung fehlgeschlagen", employee.name, error));
        markReminder(state.scheduler, "lunchEnd", date, employee.id); changed = true;
      }
    }
    if (changed) { await writeJson(files.states, state.states); await writeJson(files.scheduler, state.scheduler); }
  }

  async function runEmployeeDayEndCheck(employeeId, date = localIsoDate()) {
    const state = await loadState();
    const employee = activeEmployees(state.employees).find((item) => String(item.id) === String(employeeId));
    if (!employee) throw new Error("Mitarbeiter nicht gefunden oder inaktiv");
    const employeeState = state.states[String(employee.id)];
    if (!employeeState || !["working", "pause", "lunch"].includes(employeeState.mode)) {
      return { sent: false, employee: employee.name, reason: "Mitarbeiter ist nicht mehr aktiv eingestempelt" };
    }
    employeeState.pending = { type: "day_end_check", createdAt: new Date().toISOString(), previousMode: employeeState.mode };
    await sendWhatsApp({
      phoneNumberId,
      to: normalizePhone(employee.phone),
      reply: "👋 Du bist bei mir noch eingestempelt. Arbeitest du noch?",
      buttons: ["Ja", "Nein"],
    });
    await writeJson(files.states, state.states);
    return { sent: true, employee: employee.name, mode: employeeState.mode };
  }

  async function runDayEndCheck(date = localIsoDate(), force = false) {
    const state = await loadState();
    if (!force && state.scheduler.dayEndCheck === date) return { skipped: true };
    const active = [];
    for (const employee of activeEmployees(state.employees)) {
      const employeeState = state.states[String(employee.id)];
      if (!employeeState || !["working", "pause", "lunch"].includes(employeeState.mode)) continue;
      active.push(employee);
      if (!employeeState.pending) {
        employeeState.pending = { type: "day_end_check", createdAt: new Date().toISOString(), previousMode: employeeState.mode };
        await sendWhatsApp({ phoneNumberId, to: normalizePhone(employee.phone), reply: "👋 Du bist bei mir noch eingestempelt. Arbeitest du noch?", buttons: ["Ja", "Nein"] }).catch((error) => logger.error("Feierabend-Erinnerung fehlgeschlagen", employee.name, error));
      }
    }
    if (active.length && normalizePhone(chefPhone)) {
      await sendWhatsApp({ phoneNumberId, to: normalizePhone(chefPhone), reply: [`⚠️ 17:30 Uhr – noch aktiv:`, ...active.map((employee) => `• ${employee.name}`), "", "Kristine fragt die Mitarbeiter direkt, ob sie noch arbeiten und gegebenenfalls seit wann sie aufgehört haben."].join("\n") }).catch((error) => logger.error("Chef-Feierabendinfo fehlgeschlagen", error));
    }
    await writeJson(files.states, state.states);
    await saveRun("dayEndCheck", date, state.scheduler);
    return { sent: active.length, employees: active.map((employee) => employee.name) };
  }

  // Prüft jede Minute, führt aber jeden Job pro Datum nur einmal aus.
  const timer = setInterval(async () => {
    try {
      const hm = localHm();
      const date = localIsoDate();
      if (hm === "07:00") await runSevenOClock(date);
      if (hm === "08:00") await runEightOClock(date);
      await runLunchAutomation(date, hm);
      if (hm === "17:30") await runDayEndCheck(date);
    } catch (error) {
      logger.error("KRISTA Morgenstatus Scheduler:", error);
    }
  }, 60_000);
  timer.unref?.();

  return {
    runSevenOClock,
    runEightOClock,
    runLunchAutomation,
    runDayEndCheck,
    runEmployeeDayEndCheck,
    clampStartTime,
    dailyTargetHours: DAILY_TARGET_HOURS,
    files,
  };
}

module.exports = {
  registerMorningStatus,
  clampStartTime,
  DAILY_TARGET_HOURS,
  OFFICIAL_START,
};
