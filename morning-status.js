"use strict";

// Datei: morning-status.js
// Build 0024.0
// KRISTA: 07:00 Startprüfung, 08:00 Chefstatus,
// 15:00 Planung morgen, 15:30 Nachfassung.
//
// Bestehende Datenstruktur und Exports bleiben erhalten.
// Überarbeitet wurden vor allem:
// - klarere Struktur
// - einheitliche WhatsApp-Texte
// - situationsabhängige Planungserinnerung
// - robustere Scheduler- und Versandprotokolle

const fsp = require("fs/promises");
const path = require("path");

const TZ = "Europe/Vienna";
const DAILY_TARGET_HOURS = 7.8;
const OFFICIAL_START = "07:00";

const ABSENCE_TYPES = new Set([
  "urlaub",
  "vacation",
  "krank",
  "sick",
  "za",
  "zeitausgleich",
  "feiertag",
  "holiday",
  "betriebsurlaub",
]);

const FINISHED_EVENT_TYPES = new Set([
  "ende",
  "fertig",
  "stopp",
  "stop",
]);

const START_EVENT_TYPES = new Set([
  "start",
  "weiter",
]);

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

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function localIsoDate(date = new Date()) {
  const parts = localParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localHm(date = new Date()) {
  const parts = localParts(date);
  return `${parts.hour}:${parts.minute}`;
}

function dateAtNoon(date) {
  const value = new Date(`${date}T12:00:00`);
  return Number.isNaN(value.getTime()) ? new Date() : value;
}

function addDaysIso(date, days) {
  const value = dateAtNoon(date);
  value.setDate(value.getDate() + Number(days || 0));
  return localIsoDate(value);
}

function minutesFromHm(hm) {
  const match = String(hm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function hmMinutes(hm) {
  const value = minutesFromHm(hm);
  return value == null ? -1 : value;
}

function inWindow(hm, from, to) {
  const value = hmMinutes(hm);
  return value >= hmMinutes(from) && value <= hmMinutes(to);
}

function clampStartTime(hm) {
  const value = minutesFromHm(hm);
  const official = minutesFromHm(OFFICIAL_START);

  if (value == null || official == null) return hm;
  return value < official ? OFFICIAL_START : hm;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function displayName(employee) {
  return String(
    employee?.nickname ||
    employee?.rufname ||
    employee?.name ||
    employee?.employeeName ||
    employee?.id ||
    "Mitarbeiter"
  ).trim();
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

function unwrapArray(value, keys) {
  if (Array.isArray(value)) return value;

  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }

  return [];
}

function activeEmployees(employees) {
  return (Array.isArray(employees) ? employees : []).filter(
    (employee) =>
      employee &&
      employee.active !== false &&
      normalizePhone(employee.phone)
  );
}

function rowsForDate(rows, date) {
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => String(row?.date || "") === String(date)
  );
}

function employeeRows(rows, employeeId) {
  return rows.filter(
    (row) => String(row?.employeeId || "") === String(employeeId)
  );
}

function cardType(row) {
  const explicit = String(row?.cardType || row?.type || "")
    .trim()
    .toLowerCase();

  if (explicit) return explicit;

  return String(row?.jobId || row?.jobName || "")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

function isAbsenceCard(row) {
  return ABSENCE_TYPES.has(cardType(row));
}

function currentAssignments(assignments, employeeId, date) {
  return employeeRows(rowsForDate(assignments, date), employeeId).sort(
    (left, right) =>
      String(left?.from || "").localeCompare(String(right?.from || ""))
  );
}

function currentAssignment(assignments, employeeId, date) {
  const rows = currentAssignments(assignments, employeeId, date);

  return (
    rows.find((row) => !isAbsenceCard(row)) ||
    rows[0] ||
    null
  );
}

function absenceFor(absences, assignments, employeeId, date) {
  const explicit = rowsForDate(absences, date).find(
    (row) => String(row?.employeeId || "") === String(employeeId)
  );

  if (explicit) return explicit;

  return (
    currentAssignments(assignments, employeeId, date).find(isAbsenceCard) ||
    null
  );
}

function timeState(events, employeeId, date) {
  const list = employeeRows(rowsForDate(events, date), employeeId).sort(
    (left, right) =>
      String(left?.at || left?.time || "").localeCompare(
        String(right?.at || right?.time || "")
      )
  );

  if (!list.length) {
    return {
      state: "missing",
      firstStart: null,
      events: [],
    };
  }

  const start = list.find((event) =>
    START_EVENT_TYPES.has(
      String(event?.type || event?.command || "").toLowerCase()
    )
  );

  const lastType = String(
    list.at(-1)?.type ||
    list.at(-1)?.command ||
    ""
  ).toLowerCase();

  let state = "working";

  if (["pause", "mittag"].includes(lastType)) {
    state = "pause";
  } else if (FINISHED_EVENT_TYPES.has(lastType)) {
    state = "ended";
  }

  return {
    state,
    firstStart: start?.at || start?.time || null,
    events: list,
  };
}

function lateNoticeFor(rows, employeeId, date) {
  return rowsForDate(rows, date)
    .filter(
      (row) => String(row?.employeeId || "") === String(employeeId)
    )
    .sort(
      (left, right) =>
        String(right?.updatedAt || "").localeCompare(
          String(left?.updatedAt || "")
        )
    )[0] || null;
}

function absenceLabel(absence) {
  const labels = {
    urlaub: "Urlaub",
    vacation: "Urlaub",
    krank: "Krank",
    sick: "Krank",
    za: "Zeitausgleich",
    zeitausgleich: "Zeitausgleich",
    feiertag: "Feiertag",
    holiday: "Feiertag",
    betriebsurlaub: "Betriebsurlaub",
  };

  const type = cardType(absence);

  return (
    labels[type] ||
    absence?.label ||
    absence?.type ||
    "Abwesend"
  );
}

function jobLabel(assignment) {
  return (
    assignment?.jobName ||
    assignment?.jobId ||
    assignment?.siteCode ||
    "keine Baustelle"
  );
}

function weekdayNumber(date) {
  return dateAtNoon(date).getDay();
}

function isWeekend(date) {
  return [0, 6].includes(weekdayNumber(date));
}

function dateInRange(date, row) {
  const from = String(
    row?.from ||
    row?.start ||
    row?.date ||
    ""
  );

  const to = String(
    row?.to ||
    row?.end ||
    row?.date ||
    ""
  );

  return from <= date && to >= date;
}

function isHoliday(date, holidays) {
  return holidays.some(
    (holiday) =>
      String(holiday?.date || holiday?.day || "") === String(date)
  );
}

function companyVacationFor(date, vacations) {
  return vacations.find((vacation) => dateInRange(date, vacation)) || null;
}

function worktimeScheduleFor(employee, date, models) {
  const value = dateAtNoon(date);
  const weekday = value.getDay();

  if ([0, 6].includes(weekday)) {
    return {
      isWorkDay: false,
      reason: "Wochenende",
    };
  }

  const model =
    models.find(
      (item) =>
        String(item?.id || "") ===
        String(employee?.worktimeModelId || "")
    ) ||
    models.find((item) => String(item?.id || "") === "krista-standard") ||
    models[0];

  if (!model) {
    return {
      isWorkDay: true,
      reason: "",
    };
  }

  if (Array.isArray(model.seasons)) {
    const month = value.getMonth() + 1;
    const season = model.seasons.find(
      (item) =>
        Array.isArray(item?.months) &&
        item.months.map(Number).includes(month)
    );

    const day = season?.weekdays?.[String(weekday)];

    if (day?.free === true || Number(day?.targetHours) === 0) {
      return {
        isWorkDay: false,
        reason: "Arbeitsmodell: frei",
      };
    }
  }

  if (Array.isArray(model.days)) {
    const dayNames = [
      "Sonntag",
      "Montag",
      "Dienstag",
      "Mittwoch",
      "Donnerstag",
      "Freitag",
      "Samstag",
    ];

    const day = model.days.find(
      (item) => String(item?.dayName || "") === dayNames[weekday]
    );

    if (day?.isWorkDay === false) {
      return {
        isWorkDay: false,
        reason: "Arbeitsmodell: frei",
      };
    }
  }

  return {
    isWorkDay: true,
    reason: "",
  };
}

function nonWorkContext({
  employee,
  assignments,
  absences,
  holidays,
  companyVacations,
  worktimeModels,
  date,
}) {
  const absence = absenceFor(
    absences,
    assignments,
    employee.id,
    date
  );

  if (absence) {
    return {
      nonWork: true,
      reason: absenceLabel(absence),
      absence,
    };
  }

  const vacation = companyVacationFor(date, companyVacations);

  if (vacation) {
    return {
      nonWork: true,
      reason:
        vacation.reason ||
        vacation.name ||
        "Betriebsurlaub",
    };
  }

  if (isHoliday(date, holidays)) {
    const holiday = holidays.find(
      (item) =>
        String(item?.date || item?.day || "") === String(date)
    );

    return {
      nonWork: true,
      reason: holiday?.name || "Feiertag",
    };
  }

  const schedule = worktimeScheduleFor(
    employee,
    date,
    worktimeModels
  );

  if (!schedule.isWorkDay) {
    return {
      nonWork: true,
      reason:
        schedule.reason ||
        (isWeekend(date) ? "Wochenende" : "frei"),
    };
  }

  return {
    nonWork: false,
    reason: "",
  };
}

function statusForEmployee({
  employee,
  assignments,
  absences,
  events,
  lateNotices,
  holidays,
  companyVacations,
  worktimeModels,
  date,
}) {
  const assignment = currentAssignment(
    assignments,
    employee.id,
    date
  );

  const time = timeState(events, employee.id, date);
  const late = lateNoticeFor(lateNotices, employee.id, date);
  const name = displayName(employee);

  if (["working", "pause", "ended"].includes(time.state)) {
    const suffix =
      time.state === "pause"
        ? " – Pause"
        : time.state === "ended"
          ? " – bereits beendet"
          : "";

    return {
      lamp: "green",
      icon: "🟢",
      category: "started",
      employee,
      assignment,
      text: `${name} – ${jobLabel(assignment)}${suffix}`,
    };
  }

  const nonWork = nonWorkContext({
    employee,
    assignments,
    absences,
    holidays,
    companyVacations,
    worktimeModels,
    date,
  });

  if (nonWork.nonWork) {
    return {
      lamp: "green",
      icon: "🔵",
      category: "non_work",
      employee,
      assignment,
      text: `${name} – ${nonWork.reason}`,
      reason: nonWork.reason,
    };
  }

  if (late) {
    const expected = late.expectedTime
      ? `, ca. ${late.expectedTime}`
      : "";

    return {
      lamp: "yellow",
      icon: "🟡",
      category: "late",
      employee,
      assignment,
      text: `${name} – kommt später${expected} – ${jobLabel(assignment)}`,
    };
  }

  return {
    lamp: "red",
    icon: "🔴",
    category: "missing",
    employee,
    assignment,
    text: `${name} – nicht angemeldet – ${jobLabel(assignment)}`,
  };
}

function buildChefReport(statuses, date) {
  const started = statuses.filter(
    (status) => status.category === "started"
  );

  const free = statuses.filter(
    (status) => status.category === "non_work"
  );

  const late = statuses.filter(
    (status) => status.lamp === "yellow"
  );

  const missing = statuses.filter(
    (status) => status.lamp === "red"
  );

  const lines = [
    `📋 Morgenstatus KRISTA – ${date}`,
    "",
    `🟢 ${started.length} gestartet / in Ordnung`,
    `🔵 ${free.length} frei / abwesend`,
    `🟡 ${late.length} später angekündigt`,
    `🔴 ${missing.length} ohne Anmeldung / Rückmeldung`,
  ];

  if (free.length) {
    lines.push("", "🔵 Frei / abwesend:");

    for (const status of free) {
      lines.push(`• ${status.text}`);
    }
  }

  if (late.length) {
    lines.push("", "🟡 Später:");

    for (const status of late) {
      lines.push(`• ${status.text}`);
    }
  }

  if (missing.length) {
    lines.push("", "🔴 Offen:");

    for (const status of missing) {
      lines.push(`• ${status.text}`);
    }
  }

  if (!late.length && !missing.length) {
    lines.push("", "✅ Keine offenen Punkte.");
  }

  return lines.join("\n");
}

function reminderText(employee, assignment, kristineUrl) {
  const name = displayName(employee);
  const start = String(assignment?.from || OFFICIAL_START).trim();
  const place = [assignment?.city, assignment?.address]
    .filter(Boolean)
    .join(" · ");

  const lines = [
    `Guten Morgen ${name} 👋`,
    "",
    "Heute geht’s zuerst zu:",
    `📍 ${jobLabel(assignment)}`,
  ];

  if (place) {
    lines.push(place);
  }

  lines.push(`🕒 Start: ${start} Uhr`);
  lines.push("");
  lines.push("Los geht’s mit KRISTINE →");
  lines.push(kristineUrl);
  lines.push("");
  lines.push("Falls du später kommst oder heute nicht arbeitest, gib bitte kurz Bescheid.");

  return lines.join("\n");
}

function tomorrowPlanningStatus({
  employees,
  assignments,
  absences,
  holidays,
  companyVacations,
  worktimeModels,
  date,
}) {
  const active = activeEmployees(employees);
  const planned = [];
  const missing = [];
  const free = [];

  for (const employee of active) {
    const nonWork = nonWorkContext({
      employee,
      assignments,
      absences,
      holidays,
      companyVacations,
      worktimeModels,
      date,
    });

    if (nonWork.nonWork) {
      free.push({
        employee,
        reason: nonWork.reason,
      });
      continue;
    }

    const rows = currentAssignments(
      assignments,
      employee.id,
      date
    ).filter((row) => !isAbsenceCard(row));

    if (rows.length) {
      planned.push({
        employee,
        assignments: rows,
      });
    } else {
      missing.push(employee);
    }
  }

  return {
    date,
    activeCount: active.length,
    planned,
    missing,
    free,
  };
}

function buildPlanningReminder(status, followUp = false) {
  const missingCount = status.missing.length;

  if (missingCount === 0) {
    return null;
  }

  const title = followUp
    ? "⚠️ Einteilung morgen weiterhin offen"
    : "📅 Einteilung für morgen prüfen";

  const lines = [
    title,
    "",
    `Morgen: ${status.date}`,
    "",
    `🟢 Eingeteilt: ${status.planned.length}`,
    `🔵 Frei / abwesend: ${status.free.length}`,
    `🔴 Noch ohne Einteilung: ${missingCount}`,
    "",
    "Noch offen:",
  ];

  for (const employee of status.missing) {
    lines.push(`• ${displayName(employee)}`);
  }

  lines.push("");

  if (missingCount === 1) {
    lines.push(
      `👉 Bitte ${displayName(status.missing[0])} noch einteilen.`
    );
  } else {
    lines.push("👉 Bitte morgen fertig einteilen.");
  }

  return lines.join("\n");
}

async function registerMorningStatus({
  dataDir,
  readEmployees,
  sendWhatsApp,
  chefPhone,
  phoneNumberId,
  publicBaseUrl = "https://protokoll.krista.at",
  adminToken = "",
  logger = console,
}) {
  if (!dataDir) {
    throw new Error("registerMorningStatus: dataDir fehlt");
  }

  if (typeof readEmployees !== "function") {
    throw new Error("registerMorningStatus: readEmployees fehlt");
  }

  if (typeof sendWhatsApp !== "function") {
    throw new Error("registerMorningStatus: sendWhatsApp fehlt");
  }

  function kristineGoUrl(employee) {
    const base = String(publicBaseUrl || "https://protokoll.krista.at").replace(/\/$/, "");
    const url = new URL(`${base}/public/kristine-go.html`);

    const id = String(employee?.id || employee?.employeeId || "").trim();
    if (id) url.searchParams.set("employeeId", id);
    if (adminToken) url.searchParams.set("token", String(adminToken));

    return url.toString();
  }

  const kristineDir = path.join(dataDir, "_kristine");
  const systemDir = path.join(dataDir, "_system");

  const files = {
    assignments: path.join(kristineDir, "assignments.json"),
    absences: path.join(kristineDir, "absences.json"),
    events: path.join(kristineDir, "time-events.json"),
    lateNotices: path.join(kristineDir, "late-notices.json"),
    scheduler: path.join(kristineDir, "scheduler-state.json"),
    holidays: path.join(systemDir, "holidays.json"),
    companyVacations: path.join(
      systemDir,
      "company-vacations.json"
    ),
    worktimeModels: path.join(
      systemDir,
      "worktime-models.json"
    ),
  };

  async function loadState() {
    const [
      employees,
      assignments,
      absences,
      events,
      lateNotices,
      scheduler,
      holidayRaw,
      vacationRaw,
      modelRaw,
    ] = await Promise.all([
      readEmployees(),
      readJson(files.assignments, []),
      readJson(files.absences, []),
      readJson(files.events, []),
      readJson(files.lateNotices, []),
      readJson(files.scheduler, {}),
      readJson(files.holidays, []),
      readJson(files.companyVacations, []),
      readJson(files.worktimeModels, []),
    ]);

    return {
      employees,
      assignments,
      absences,
      events,
      lateNotices,
      scheduler,
      holidays: unwrapArray(holidayRaw, ["holidays"]),
      companyVacations: unwrapArray(vacationRaw, ["vacations"]),
      worktimeModels: unwrapArray(modelRaw, ["models"]),
    };
  }

  async function saveRun(key, date, scheduler) {
    scheduler[key] = date;
    await writeJson(files.scheduler, scheduler);
  }

  async function sendToChef(reply) {
    const to = normalizePhone(chefPhone);

    if (!to) {
      logger.warn(
        "CHEF_PHONE fehlt – Nachricht nur im Log:",
        reply
      );

      return {
        sent: false,
        reason: "chef_phone_missing",
      };
    }

    await sendWhatsApp({
      phoneNumberId,
      to,
      reply,
    });

    return {
      sent: true,
    };
  }

async function runSevenOClock(
  date = localIsoDate(),
  force = false,
  onlyEmployeeId = ""
) {
    const state = await loadState();

    if (
      !force &&
      state.scheduler.startReminder === date
    ) {
      return {
        skipped: true,
      };
    }

    const employeesToCheck = onlyEmployeeId
  ? activeEmployees(state.employees).filter(
      (employee) => String(employee.id) === String(onlyEmployeeId)
    )
  : activeEmployees(state.employees);

const statuses = employeesToCheck.map(
  (employee) =>
    statusForEmployee({
      employee,
      ...state,
      date,
    })
);

const missing = statuses.filter(
  (status) => status.category === "missing"
);

    for (const status of missing) {
      try {
        await sendWhatsApp({
          phoneNumberId,
          to: normalizePhone(status.employee.phone),
          reply: reminderText(
            status.employee,
            status.assignment,
            kristineGoUrl(status.employee)
          ),
          buttons: [
            "Komme später",
            "Heute nicht",
          ],
        });
      } catch (error) {
        logger.error(
          "07:00 Erinnerung fehlgeschlagen",
          displayName(status.employee),
          error
        );
      }
    }

    await saveRun(
      "startReminder",
      date,
      state.scheduler
    );

    const suppressed = statuses.filter(
      (status) => status.category === "non_work"
    ).length;

    logger.log("KRISTA 07:00 Prüfung", {
      date,
      reminded: missing.length,
      suppressed,
    });

    return {
      sent: missing.length,
      suppressed,
      statuses,
    };
  }

  async function runEightOClock(
    date = localIsoDate(),
    force = false
  ) {
    const state = await loadState();

    if (
      !force &&
      state.scheduler.chefReport === date
    ) {
      logger.log(
        "KRISTA 08:00 Chefstatus übersprungen",
        {
          date,
          reason: "bereits gesendet",
        }
      );

      return {
        skipped: true,
      };
    }

    const statuses = activeEmployees(state.employees).map(
      (employee) =>
        statusForEmployee({
          employee,
          ...state,
          date,
        })
    );

    const report = buildChefReport(statuses, date);
    const result = await sendToChef(report);

    if (result.sent) {
      logger.log(
        "KRISTA 08:00 Chefstatus gesendet",
        {
          date,
          recipients: 1,
        }
      );
    }

    await saveRun(
      "chefReport",
      date,
      state.scheduler
    );

    return {
      sent: result.sent,
      statuses,
      report,
    };
  }

  async function runPlanningReminder({
    date,
    force,
    followUp,
  }) {
    const state = await loadState();

    const schedulerKey = followUp
      ? "tomorrowPlanningFollowUp"
      : "tomorrowPlanningReminder";

    const label = followUp
      ? "15:30 Planung-Nachfassung"
      : "15:00 Planung";

    if (
      !force &&
      state.scheduler[schedulerKey] === date
    ) {
      logger.log(`${label} übersprungen`, {
        date,
        reason: "bereits geprüft",
      });

      return {
        skipped: true,
      };
    }

    const tomorrow = addDaysIso(date, 1);

    const status = tomorrowPlanningStatus({
      ...state,
      date: tomorrow,
    });

    let sent = false;

    if (status.missing.length > 0) {
      const message = buildPlanningReminder(
        status,
        followUp
      );

      const result = await sendToChef(message);
      sent = result.sent;
    }

    logger.log(
      sent
        ? `${label} gesendet`
        : `${label} geprüft`,
      {
        date,
        tomorrow,
        reminderNeeded: status.missing.length > 0,
        missing: status.missing.length,
        planned: status.planned.length,
        free: status.free.length,
        chefPhoneConfigured: Boolean(
          normalizePhone(chefPhone)
        ),
      }
    );

    await saveRun(
      schedulerKey,
      date,
      state.scheduler
    );

    return {
      sent,
      status,
    };
  }

  async function runFifteenOClock(
    date = localIsoDate(),
    force = false
  ) {
    return runPlanningReminder({
      date,
      force,
      followUp: false,
    });
  }

  async function runFifteenThirty(
    date = localIsoDate(),
    force = false
  ) {
    return runPlanningReminder({
      date,
      force,
      followUp: true,
    });
  }

  async function schedulerTick() {
    try {
      const hm = localHm();
      const date = localIsoDate();

      // Nachholfenster:
      // Render-Neustarts oder kurze Schlafphasen verlieren
      // die Ausführung nicht.
      if (inWindow(hm, "07:00", "07:59")) {
        await runSevenOClock(date);
      }

      if (inWindow(hm, "08:00", "11:59")) {
        await runEightOClock(date);
      }

      if (inWindow(hm, "15:00", "15:29")) {
        await runFifteenOClock(date);
      }

      if (inWindow(hm, "15:30", "18:00")) {
        await runFifteenThirty(date);
      }
    } catch (error) {
      logger.error(
        "KRISTA Status-Scheduler:",
        error
      );
    }
  }

  const timer = setInterval(
    schedulerTick,
    60_000
  );

  timer.unref?.();

  // Direkt nach dem Serverstart prüfen, damit ein Start
  // innerhalb eines Nachholfensters sofort reagiert.
  setTimeout(
    schedulerTick,
    5_000
  ).unref?.();

  logger.log(
    "KRISTA Status-Scheduler registriert",
    {
      timezone: TZ,
      jobs: [
        "07:00 Startprüfung",
        "08:00 Chefstatus",
        "15:00 Planung morgen",
        "15:30 Nachfassung",
      ],
    }
  );

  return {
    runSevenOClock,
    runEightOClock,
    runFifteenOClock,
    runFifteenThirty,
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
