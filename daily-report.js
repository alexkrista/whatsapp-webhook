// Datei: daily-report.js · Build 0030.1 · Kompakter Tagesreport + aktive Mitarbeiter
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { migrateLegacyMediaForDate } = require("./media-migration");

function registerDailyReport(app, { dataDir, requireAdmin }) {
  const ROOT = path.join(dataDir, "_kristine");
  const TIME_EVENTS = path.join(ROOT, "time-events.json");
  const REVIEW_ENTRIES = path.join(ROOT, "day-review-entries.json");
  const ABSENCES = path.join(ROOT, "absences.json");
  const ASSIGNMENTS = path.join(ROOT, "assignments.json");
  const EMPLOYEES = path.join(ROOT, "employees.json");
  const SYSTEM_EMPLOYEES = path.join(dataDir, "_system", "employees.json");
  const WORKTIME_MODELS = path.join(dataDir, "_system", "worktime-models.json");
  const REPORTS_DIR = path.join(ROOT, "reports");

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  function viennaParts(d = new Date()) {
    const parts = new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function localDateISO(d = new Date()) {
    const p = viennaParts(d);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function yesterdayISO() {
    return localDateISO(new Date(Date.now() - 24 * 60 * 60 * 1000));
  }

  function minutesFromHM(value) {
    const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function formatDateDE(dateStr) {
    const [y, m, d] = String(dateStr || "").split("-");
    return y && m && d ? `${d}.${m}.${y}` : String(dateStr || "");
  }

  function formatDuration(minutes) {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return `${hours} h ${String(mins).padStart(2, "0")} min`;
  }

  function formatDurationCompact(minutes) {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function formatSignedDuration(minutes) {
    const value = Math.round(Number(minutes) || 0);
    if (value === 0) return "0:00";
    return `${value > 0 ? "+" : "-"}${formatDurationCompact(Math.abs(value))}`;
  }

  function formatPercent(actual, plan) {
    const planned = Number(plan || 0);
    if (planned <= 0) return "—";
    return `${((Number(actual || 0) / planned) * 100).toFixed(1).replace(".", ",")} %`;
  }

  function weekdayForDate(dateStr) {
    const [year, month, day] = String(dateStr || "").split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  function scheduleForDate(model, dateStr) {
    const d = new Date(String(dateStr) + "T12:00:00");
    if (Number.isNaN(d.getTime())) return null;
    const month = d.getMonth() + 1;
    const weekday = d.getDay();
    const season = (model?.seasons || []).find((item) => (item.months || []).includes(month));
    const rule = season?.weekdays?.[String(weekday)] || {};
    return {
      payrollTargetHours: weekday >= 1 && weekday <= 5
        ? Number(rule.payrollTargetHours ?? model?.payrollTargetHoursWeekday ?? 7.8)
        : 0,
    };
  }

  function employeePlanMinutes(employee, date, worktimeModels) {
    const master = employee.master || {};
    const modelId = String(master.worktimeModelId || "krista-standard");
    const model = worktimeModels.find((item) => String(item?.id) === modelId) || worktimeModels[0] || null;
    const schedule = scheduleForDate(model, date);
    const percent = Math.min(100, Math.max(0, Number(master.employmentPercent ?? 100))) / 100;
    return Math.max(0, Math.round(Number(schedule?.payrollTargetHours || 0) * percent * 60));
  }

  function assignmentPlanCategory(record) {
    const text = [record?.jobId, record?.jobName, record?.note, record?.type, record?.category]
      .filter(Boolean).join(" ").toLowerCase();
    const absence = absenceType(text);
    if (absence) return absence;
    if (/__up__|__unproduktiv__|unproduktiv|werkstatt|lager|büro|buero|intern/.test(text)) return "unproductive";
    return "productive";
  }

  function summarizePlan(employee, date, worktimeModels) {
    const result = { productive: 0, unproductive: 0, vacation: 0, sick: 0, holiday: 0, other: 0 };
    const assignments = (employee.assignments || []).filter((row) => String(row.date || "") === String(date));
    if (!assignments.length) return result;

    const target = employeePlanMinutes(employee, date, worktimeModels);
    const weighted = assignments.map((row) => {
      const from = minutesFromHM(row.from);
      const to = minutesFromHM(row.to);
      return { row, weight: from !== null && to !== null && to > from ? to - from : 1 };
    });
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0) || 1;

    let distributed = 0;
    weighted.forEach((item, index) => {
      const minutes = index === weighted.length - 1
        ? Math.max(0, target - distributed)
        : Math.max(0, Math.round(target * item.weight / totalWeight));
      distributed += minutes;
      const category = assignmentPlanCategory(item.row);
      if (Object.prototype.hasOwnProperty.call(result, category)) result[category] += minutes;
    });
    return result;
  }

  function requiredCoffeeBreaks(dateStr, hasMorningWork, hasAfternoonWork) {
    const weekday = weekdayForDate(dateStr);
    const isWeekday = weekday >= 1 && weekday <= 5;
    return {
      morning: isWeekday && hasMorningWork ? 15 : 0,
      afternoon: weekday >= 1 && weekday <= 4 && hasAfternoonWork ? 5 : 0,
    };
  }

  function absenceType(value) {
    const text = String(value || "").toLowerCase().trim();
    // Feiertag muss vor "holiday" geprüft werden: holiday wird in manchen Daten auch für Urlaub verwendet.
    if (/feiertag|public[ _-]?holiday/.test(text)) return "holiday";
    if (/urlaub|vacation|annual[ _-]?leave|ferien|holiday/.test(text)) return "vacation";
    if (/krank|krankenstand|sick|illness|arbeitsunf[aä]hig/.test(text)) return "sick";
    if (/zeitausgleich|time[ _-]?off|absence|abwesen|freistellung|sonstig/.test(text)) return "other";
    return null;
  }

  function normalizeISODate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    const text = String(value || "").trim();
    if (!text) return "";

    const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;

    const de = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
    if (de) return `${de[3]}-${String(de[2]).padStart(2, "0")}-${String(de[1]).padStart(2, "0")}`;

    return text.slice(0, 10);
  }

  function isDateWithin(date, from, to) {
    const target = normalizeISODate(date);
    const start = normalizeISODate(from || to);
    const end = normalizeISODate(to || from);
    return Boolean(target && start && end && target >= start && target <= end);
  }

  function firstValue(...values) {
    return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
  }

  function normalizeAbsence(record, date) {
    if (!record || typeof record !== "object") return null;

    const employee = record.employee && typeof record.employee === "object" ? record.employee : {};
    const worker = record.worker && typeof record.worker === "object" ? record.worker : {};
    const person = record.person && typeof record.person === "object" ? record.person : {};

    // Nicht nur das erste Feld prüfen: Ein Planungsdatensatz kann z. B.
    // type="assignment" UND jobName="Urlaub" enthalten.
    const typeText = [
      record.type,
      record.absenceType,
      record.assignmentType,
      record.kind,
      record.category,
      record.status,
      record.reason,
      record.title,
      record.label,
      record.jobName,
      record.name
    ].filter(Boolean).join(" ");
    const type = absenceType(typeText);
    if (!type) return null;

    const singleDate = firstValue(
      record.date,
      record.day,
      record.workDate,
      record.assignmentDate,
      record.plannedDate,
      record.startDay
    );
    // Uhrzeiten wie 07:00–17:00 sind kein Datumsbereich.
    const isClockTime = (value) =>
      /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());

    const dateFrom = firstValue(
      record.startDate,
      record.dateFrom,
      record.fromDate,
      record.startDay,
      !isClockTime(record.from) ? record.from : null,
      !isClockTime(record.start) ? record.start : null,
      singleDate
    );
    const dateTo = firstValue(
      record.endDate,
      record.dateTo,
      record.toDate,
      !isClockTime(record.to) ? record.to : null,
      !isClockTime(record.end) ? record.end : null,
      singleDate
    );
    if (!isDateWithin(date, dateFrom, dateTo)) return null;

    const employeeId = firstValue(
      record.employeeId,
      record.workerId,
      record.userId,
      record.personId,
      employee.id,
      employee.employeeId,
      worker.id,
      person.id
    );
    const employeeName = firstValue(
      record.employeeName,
      record.workerName,
      record.personName,
      record.displayName,
      employee.name,
      employee.employeeName,
      worker.name,
      person.name,
      // Nur als letzte Notlösung "name" verwenden, da es bei Assignments oft die Baustelle bezeichnet.
      record.name
    );

    if (!employeeId && !employeeName) return null;

    const hours = Number(firstValue(record.hours, record.durationHours));
    const minutesRaw = Number(firstValue(record.minutes, record.durationMinutes));
    const weekday = weekdayForDate(date);
    const payrollMinutes = weekday >= 1 && weekday <= 5 ? Math.round(7.8 * 60) : 0;
    const explicitFullDay = record.fullDay === true || record.allDay === true || record.isFullDay === true;
    const absenceAlwaysFullDay = ["vacation", "sick", "holiday"].includes(type);
    const looksLikeFullDay = explicitFullDay || absenceAlwaysFullDay || (Number.isFinite(hours) && hours >= 7);
    const minutes = looksLikeFullDay
      ? payrollMinutes
      : Number.isFinite(minutesRaw) && minutesRaw > 0
        ? minutesRaw
        : Number.isFinite(hours) && hours > 0
          ? hours * 60
          : payrollMinutes;

    return {
      employeeId: String(employeeId || employeeName),
      employeeName: String(employeeName || employeeId || "Unbekannt"),
      type,
      label: type === "vacation" ? "Urlaub" : type === "sick" ? "Krankenstand" : type === "holiday" ? "Feiertag" : "Sonstige Abwesenheit",
      minutes: Math.max(0, Math.round(minutes)),
      reason: String(firstValue(record.reason, record.note, record.comment, "") || "").trim(),
    };
  }

  function durationOf(block) {
    const from = minutesFromHM(block.from);
    const to = minutesFromHM(block.to);
    if (from === null || to === null || to <= from) return 0;
    return to - from;
  }

  function splitAtNoon(block, noon = 12 * 60) {
    const from = minutesFromHM(block.from);
    const to = minutesFromHM(block.to);
    if (from === null || to === null || to <= from) return { before: 0, after: 0 };
    return {
      before: Math.max(0, Math.min(to, noon) - from),
      after: Math.max(0, to - Math.max(from, noon)),
    };
  }

  function wrap(text, maxChars) {
    const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function cleanUpReason(value) {
    const raw = String(value || "").trim();
    return raw
      .replace(/^Unproduktiv\s*[·\-:]\s*/i, "")
      .replace(/^Unproduktiv$/i, "")
      .trim() || "Ohne Grund";
  }

  function classifyEvent(event) {
    const eventType = String(event.type || "").toLowerCase().trim();

    const isUnproductive =
      ["up", "unproduktiv", "werkstatt", "lager", "büro", "buero"].includes(eventType) ||
      String(event.workType || "").toLowerCase() === "unproductive" ||
      String(event.assignmentType || "").toLowerCase() === "up" ||
      String(event.jobType || "").toLowerCase() === "up";

    if (["pause", "break"].includes(eventType)) return "pause";
    if (["mittag", "lunch", "mittagspause"].includes(eventType)) return "lunch";
    if (isUnproductive) return "up";
    if (["start", "weiter", "work", "arbeit"].includes(eventType)) return "productive";
    return null;
  }

  function buildBlocks(events) {
    const sorted = events
      .map((event, index) => ({
        ...event,
        _index: index,
        _minutes: minutesFromHM(event.at),
      }))
      .filter((event) => event._minutes !== null)
      .sort(
        (a, b) =>
          a._minutes - b._minutes ||
          String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
          a._index - b._index
      );

    const blocks = [];

    for (let i = 0; i < sorted.length - 1; i++) {
      const event = sorted[i];
      const next = sorted[i + 1];
      if (next._minutes <= event._minutes) continue;

      const type = classifyEvent(event);
      if (!type) continue;

      let block;

      if (type === "productive") {
        block = {
          from: event.at,
          to: next.at,
          jobId: String(event.jobId || ""),
          jobName: String(event.jobName || event.jobId || "Ohne Baustelle"),
          type,
          productive: true,
        };
      } else if (type === "up") {
        const reason = cleanUpReason(
          event.upReason ||
          event.reason ||
          event.detail ||
          event.jobName ||
          event.upGroup ||
          event.jobId
        );

        block = {
          from: event.at,
          to: next.at,
          jobId: "",
          jobName: `Unproduktiv · ${reason}`,
          upReason: reason,
          type,
          productive: false,
        };
      } else {
        block = {
          from: event.at,
          to: next.at,
          jobId: "",
          jobName: type === "lunch" ? "Mittag" : "Pause",
          type,
          productive: false,
        };
      }

      const previous = blocks.at(-1);
      const sameIdentity =
        previous &&
        previous.to === block.from &&
        previous.type === block.type &&
        previous.jobId === block.jobId &&
        previous.jobName === block.jobName;

      if (sameIdentity) {
        previous.to = block.to;
      } else {
        blocks.push(block);
      }
    }

    return blocks;
  }

  function summarizeEmployee(employee, date) {
    const summary = {
      beforeNoon: 0,
      afterNoon: 0,
      productive: 0,
      unproductive: 0,
      pause: 0,
      stampedPause: 0,
      automaticPause: 0,
      lunch: 0,
      workingTotal: 0,
      presenceTotal: 0,
      jobs: new Map(),
      upReasons: new Map(),
      absence: employee.absence || null,
    };

    const morningEntries = [];
    const afternoonEntries = [];
    let stampedMorningPause = 0;
    let stampedAfternoonPause = 0;

    function addWorkEntry(block, minutes, segment) {
      if (minutes <= 0) return;
      const entry = {
        type: block.type,
        key: block.type === "productive"
          ? String(block.jobId || block.jobName || "Ohne Baustelle")
          : cleanUpReason(block.upReason || block.jobName),
        jobId: String(block.jobId || ""),
        jobName: String(block.jobName || block.jobId || "Ohne Baustelle"),
        minutes,
        adjusted: minutes,
      };
      (segment === "morning" ? morningEntries : afternoonEntries).push(entry);
    }

    for (const block of employee.blocks) {
      const minutes = durationOf(block);
      const split = splitAtNoon(block);

      if (block.type === "productive" || block.type === "up") {
        addWorkEntry(block, split.before, "morning");
        addWorkEntry(block, split.after, "afternoon");
      } else if (block.type === "pause") {
        stampedMorningPause += split.before;
        stampedAfternoonPause += split.after;
        summary.stampedPause += minutes;
      } else if (block.type === "lunch") {
        summary.lunch += minutes;
      }

      summary.presenceTotal += minutes;
    }

    const required = requiredCoffeeBreaks(date, morningEntries.length > 0, afternoonEntries.length > 0);
    const autoMorning = Math.max(0, required.morning - stampedMorningPause);
    const autoAfternoon = Math.max(0, required.afternoon - stampedAfternoonPause);

    function deduct(entries, minutes) {
      let remaining = Math.max(0, minutes);
      for (const entry of [...entries].sort((a, b) => b.adjusted - a.adjusted)) {
        if (remaining <= 0) break;
        const deduction = Math.min(entry.adjusted, remaining);
        entry.adjusted -= deduction;
        remaining -= deduction;
      }
      return minutes - remaining;
    }

    const deductedMorning = deduct(morningEntries, autoMorning);
    const deductedAfternoon = deduct(afternoonEntries, autoAfternoon);
    summary.automaticPause = deductedMorning + deductedAfternoon;
    summary.pause = summary.stampedPause + summary.automaticPause;

    function aggregate(entries, segment) {
      for (const entry of entries) {
        const minutes = Math.max(0, entry.adjusted);
        if (segment === "morning") summary.beforeNoon += minutes;
        else summary.afterNoon += minutes;
        summary.workingTotal += minutes;

        if (entry.type === "productive") {
          summary.productive += minutes;
          if (!summary.jobs.has(entry.key)) {
            summary.jobs.set(entry.key, {
              jobId: entry.jobId,
              jobName: entry.jobName,
              minutes: 0,
            });
          }
          summary.jobs.get(entry.key).minutes += minutes;
        } else {
          summary.unproductive += minutes;
          summary.upReasons.set(entry.key, (summary.upReasons.get(entry.key) || 0) + minutes);
        }
      }
    }

    aggregate(morningEntries, "morning");
    aggregate(afternoonEntries, "afternoon");

    return summary;
  }

  function summarizeDay(employees) {
    const day = {
      beforeNoon: 0,
      afterNoon: 0,
      productive: 0,
      unproductive: 0,
      pause: 0,
      stampedPause: 0,
      automaticPause: 0,
      lunch: 0,
      workingTotal: 0,
      presenceTotal: 0,
      jobs: new Map(),
      upReasons: new Map(),
      absences: { vacation: [], sick: [], holiday: [], other: [] },
      headcount: employees.length,
      activeCount: 0,
      plan: { productive: 0, unproductive: 0, vacation: 0, sick: 0, holiday: 0, other: 0 },
    };

    for (const employee of employees) {
      const summary = employee.summary;
      day.beforeNoon += summary.beforeNoon;
      day.afterNoon += summary.afterNoon;
      day.productive += summary.productive;
      day.unproductive += summary.unproductive;
      day.pause += summary.pause;
      day.stampedPause += summary.stampedPause;
      day.automaticPause += summary.automaticPause;
      day.lunch += summary.lunch;
      day.workingTotal += summary.workingTotal;
      day.presenceTotal += summary.presenceTotal;
      if (summary.workingTotal > 0) day.activeCount += 1;
      for (const key of Object.keys(day.plan)) day.plan[key] += Number(employee.plan?.[key] || 0);

      if (summary.absence) {
        day.absences[summary.absence.type]?.push({
          employeeName: employee.employeeName,
          minutes: summary.absence.minutes,
          reason: summary.absence.reason,
        });
      }

      for (const job of summary.jobs.values()) {
        const key = String(job.jobId || job.jobName);
        if (!day.jobs.has(key)) {
          day.jobs.set(key, { jobId: job.jobId, jobName: job.jobName, total: 0, employees: [] });
        }
        const target = day.jobs.get(key);
        target.total += job.minutes;
        target.employees.push({ employeeName: employee.employeeName, minutes: job.minutes });
      }

      for (const [reason, minutes] of summary.upReasons.entries()) {
        if (!day.upReasons.has(reason)) day.upReasons.set(reason, { total: 0, employees: [] });
        const target = day.upReasons.get(reason);
        target.total += minutes;
        target.employees.push({ employeeName: employee.employeeName, minutes });
      }
    }

    return day;
  }

  async function imageBytes(entry) {
    const rel = String(entry.file || "").replace(/^\/+/, "");
    if (!rel) return null;
    const full = path.join(dataDir, rel);
    if (!full.startsWith(path.resolve(dataDir)) || !fs.existsSync(full)) return null;

    try {
      return await sharp(full)
        .rotate()
        .resize({ width: 260, height: 180, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
    } catch {
      return null;
    }
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    for (const key of ["employees", "items", "data", "assignments", "absences", "records"]) {
      if (Array.isArray(value[key])) return value[key];
    }
    return Object.values(value).filter((item) => item && typeof item === "object");
  }

  // assignments.json und Mitarbeiterdateien existieren im Projekt in mehreren Strukturen
  // (Array, nach Datum gruppiert, nach Mitarbeiter gruppiert, verschachtelte data/items-Container).
  // Diese Funktion zieht alle echten Datensätze heraus und übernimmt Datum/Person aus dem Elternknoten.
  function flattenRecords(value, inherited = {}, depth = 0, seen = new Set()) {
    if (depth > 8 || value === null || value === undefined) return [];
    if (typeof value !== "object") return [];
    if (seen.has(value)) return [];
    seen.add(value);

    if (Array.isArray(value)) {
      return value.flatMap((item) => flattenRecords(item, inherited, depth + 1, seen));
    }

    const own = { ...inherited, ...value };
    const hasRecordFields = [
      "employeeId", "employeeName", "workerId", "workerName", "personId", "personName",
      "type", "absenceType", "assignmentType", "category", "status", "reason",
      "date", "day", "workDate", "assignmentDate", "plannedDate", "from", "to",
      "startDate", "endDate", "dateFrom", "dateTo"
    ].some((key) => value[key] !== undefined);

    const children = [];
    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== "object") continue;

      const nextInherited = { ...inherited };
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(key)) nextInherited.date = normalizeISODate(key);
      if (/^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}$/.test(key)) nextInherited.date = normalizeISODate(key);

      // Bei einem Mitarbeiter-Schlüssel Name/ID nur übernehmen, wenn der Kinddatensatz selbst keine Person enthält.
      if (!["data", "items", "records", "assignments", "absences", "employees", "days", "dates"].includes(key)) {
        if (!nextInherited.employeeId && !nextInherited.employeeName && !/^\d{4}-/.test(key)) {
          nextInherited.employeeName = key;
        }
      }
      children.push(...flattenRecords(child, nextInherited, depth + 1, seen));
    }

    return hasRecordFields ? [own, ...children] : children;
  }

  async function collect(date, jobFilter = null) {
    const [timeEventsRaw, reviewEntriesRaw, absencesRaw, assignmentsRaw, employeeMasterRaw, systemEmployeeMasterRaw, worktimeModelsRaw] = await Promise.all([
      readJson(TIME_EVENTS, []),
      readJson(REVIEW_ENTRIES, []),
      readJson(ABSENCES, []),
      readJson(ASSIGNMENTS, []),
      readJson(EMPLOYEES, []),
      readJson(SYSTEM_EMPLOYEES, []),
      readJson(WORKTIME_MODELS, []),
    ]);

    const timeEvents = asArray(timeEventsRaw);
    const reviewEntries = asArray(reviewEntriesRaw);
    const absences = flattenRecords(absencesRaw);
    const assignments = flattenRecords(assignmentsRaw);
    const worktimeModels = asArray(worktimeModelsRaw);
    const employeeMaster = [
      ...flattenRecords(employeeMasterRaw),
      ...flattenRecords(systemEmployeeMasterRaw),
      ...asArray(employeeMasterRaw),
      ...asArray(systemEmployeeMasterRaw),
    ];

    const byEmployee = new Map();

    // Inaktive/archivierte Mitarbeiter dürfen durch alte Planungs- oder
    // Abwesenheitsdatensätze nicht wieder in aktuellen Reports auftauchen.
    const excludedEmployeeKeys = new Set();
    const employeeAliases = new Map();
    const normalizePersonKey = (value) => String(value || "").trim().toLocaleLowerCase("de-AT").replace(/\s+/g, " ");

    const ensure = (id, name) => {
      const cleanId = String(id || "").trim();
      const cleanName = String(name || "").trim();
      const alias = normalizePersonKey(cleanName || cleanId);
      const existingKey = employeeAliases.get(alias) || employeeAliases.get(normalizePersonKey(cleanId));
      const key = existingKey || cleanId || cleanName || "unbekannt";

      if (!byEmployee.has(key)) {
        byEmployee.set(key, {
          employeeId: cleanId || key,
          employeeName: cleanName || cleanId || key,
          events: [],
          reviews: [],
          absence: null,
          assignments: [],
          master: null,
          inEmployeeMaster: false,
        });
      } else if (cleanName && byEmployee.get(key).employeeName === key) {
        byEmployee.get(key).employeeName = cleanName;
      }

      if (alias) employeeAliases.set(alias, key);
      if (cleanId) employeeAliases.set(normalizePersonKey(cleanId), key);
      return byEmployee.get(key);
    };

    for (const master of employeeMaster) {
      if (!master || typeof master !== "object") continue;
      const nested = master.employee && typeof master.employee === "object" ? master.employee : {};
      const masterId = firstValue(master.id, master.employeeId, master.workerId, master.userId, master.phone, nested.id);
      const masterName = firstValue(master.name, master.employeeName, master.displayName, master.fullName, nested.name);
      const active = master.active !== false && master.isActive !== false && master.enabled !== false && !master.archived && !master.deleted && master.hidden !== true;
      if (!active) {
        if (masterId) excludedEmployeeKeys.add(normalizePersonKey(masterId));
        if (masterName) excludedEmployeeKeys.add(normalizePersonKey(masterName));
        continue;
      }
      const employee = ensure(masterId, masterName);
      employee.inEmployeeMaster = true;
      employee.master = { ...master, ...nested };
    }

    for (const assignment of assignments) {
      if (String(assignment.date || "") !== String(date)) continue;
      if (jobFilter && String(assignment.jobId || "") !== String(jobFilter)) continue;
      ensure(assignment.employeeId, assignment.employeeName).assignments.push(assignment);
    }

    for (const event of timeEvents) {
      if (String(event.date) !== String(date)) continue;
      if (jobFilter && String(event.jobId || "") !== String(jobFilter)) continue;
      ensure(event.employeeId, event.employeeName).events.push(event);
    }

    for (const entry of reviewEntries) {
      if (String(entry.date) !== String(date)) continue;
      if (jobFilter && String(entry.jobId || "") !== String(jobFilter)) continue;
      ensure(entry.employeeId, entry.employeeName).reviews.push(entry);
    }

    const absenceCandidates = [
      ...absences,
      ...assignments,
      ...timeEvents,
      ...reviewEntries,
    ];

    if (!jobFilter) {
      for (const record of absenceCandidates) {
        const absence = normalizeAbsence(record, date);
        if (!absence) continue;
        const employee = ensure(absence.employeeId, absence.employeeName);
        if (!employee.absence) employee.absence = absence;
      }
    }

    return [...byEmployee.values()]
      .filter((employee) =>
        !excludedEmployeeKeys.has(normalizePersonKey(employee.employeeId)) &&
        !excludedEmployeeKeys.has(normalizePersonKey(employee.employeeName))
      )
      .map((employee) => {
        const blocks = buildBlocks(employee.events);
        const withBlocks = { ...employee, blocks };
        return {
          ...withBlocks,
          plan: summarizePlan(withBlocks, date, worktimeModels),
          summary: summarizeEmployee(withBlocks, date),
        };
      })
      .filter((employee) => employee.inEmployeeMaster || employee.blocks.length || employee.reviews.length || employee.absence)
      .sort((a, b) => String(a.employeeName).localeCompare(String(b.employeeName), "de"));
  }

  async function buildPdf({ date, employees, titleSuffix = "", includeDaySummary = true }) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const PAGE_W = 841.89;
    const PAGE_H = 595.28;
    const margin = 34;
    const contentWidth = PAGE_W - margin * 2;

    let page;
    let y;

    function newPage(sectionTitle = "") {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      page.drawText("KRISTA TAGESREPORT", {
        x: margin,
        y: PAGE_H - 38,
        size: 20,
        font: bold,
      });
      page.drawText(
        `${formatDateDE(date)}${titleSuffix ? ` - ${titleSuffix}` : ""}`,
        {
          x: margin,
          y: PAGE_H - 59,
          size: 11,
          font,
        }
      );
      page.drawLine({
        start: { x: margin, y: PAGE_H - 69 },
        end: { x: PAGE_W - margin, y: PAGE_H - 69 },
        thickness: 1,
        color: rgb(0.82, 0.82, 0.82),
      });
      y = PAGE_H - 91;

      if (sectionTitle) {
        page.drawText(sectionTitle, {
          x: margin,
          y,
          size: 13,
          font: bold,
        });
        y -= 20;
      }
    }

    function ensureSpace(height, sectionTitle = "") {
      if (!page || y - height < 34) newPage(sectionTitle);
    }

    function drawDivider() {
      page.drawLine({
        start: { x: margin, y: y - 2 },
        end: { x: PAGE_W - margin, y: y - 2 },
        thickness: 0.5,
        color: rgb(0.9, 0.9, 0.9),
      });
      y -= 15;
    }

    function drawSectionHeading(text) {
      ensureSpace(26);
      page.drawText(text, {
        x: margin,
        y,
        size: 12,
        font: bold,
      });
      y -= 17;
    }

    function drawKeyValue(label, value, x = margin, valueX = margin + 150, size = 8.8) {
      ensureSpace(13);
      page.drawText(label, { x, y, size, font });
      page.drawText(value, { x: valueX, y, size, font: bold });
      y -= 12;
    }

    function drawEmployeeSummary(summary) {
      const startY = y;
      const leftX = margin;
      const dividerX = margin + 365;
      const rightX = dividerX + 18;
      const leftValueX = margin + 112;
      const rightValueX = PAGE_W - margin - 52;

      const leftRows = [
        ["Vormittag", formatDurationCompact(summary.beforeNoon)],
        ["Nachmittag", formatDurationCompact(summary.afterNoon)],
        ["Produktiv", formatDurationCompact(summary.productive)],
        ["Unproduktiv", formatDurationCompact(summary.unproductive)],
        ["Mittag", formatDurationCompact(summary.lunch)],
        ["Pause", formatDurationCompact(summary.pause)],
        ["Arbeitszeit", formatDurationCompact(summary.workingTotal)],
      ];

      const rightRows = [
        ...[...summary.jobs.values()]
          .sort((a, b) => b.minutes - a.minutes)
          .map((job) => [
            `${job.jobId ? "#" + job.jobId + " · " : ""}${job.jobName}`,
            formatDurationCompact(job.minutes),
          ]),
        ...[...summary.upReasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([reason, minutes]) => [`UP · ${reason}`, formatDurationCompact(minutes)]),
      ];

      const rowCount = Math.max(leftRows.length, Math.max(1, rightRows.length));
      const height = 21 + rowCount * 12 + (summary.automaticPause > 0 ? 11 : 0);
      ensureSpace(height + 8);

      page.drawText("Zusammenfassung", { x: leftX, y, size: 9.2, font: bold });
      page.drawText("Baustellensummen", { x: rightX, y, size: 9.2, font: bold });
      y -= 14;
      const rowsTop = y;

      leftRows.forEach(([label, value], index) => {
        const rowY = rowsTop - index * 12;
        page.drawText(label, { x: leftX, y: rowY, size: 8.4, font });
        page.drawText(value, { x: leftValueX, y: rowY, size: 8.4, font: index === leftRows.length - 1 ? bold : font });
      });

      if (summary.automaticPause > 0) {
        const noteY = rowsTop - leftRows.length * 12;
        page.drawText(`davon automatisch: ${formatDurationCompact(summary.automaticPause)}`, {
          x: leftX,
          y: noteY,
          size: 7.4,
          font,
        });
      }

      if (!rightRows.length) {
        page.drawText("Keine Baustellenzeit", { x: rightX, y: rowsTop, size: 8.2, font });
      } else {
        rightRows.forEach(([label, value], index) => {
          const rowY = rowsTop - index * 12;
          page.drawText(label, { x: rightX, y: rowY, size: 8.2, font, maxWidth: 300 });
          page.drawText(value, { x: rightValueX, y: rowY, size: 8.2, font: bold });
        });
      }

      const bottomY = startY - height + 6;
      page.drawLine({
        start: { x: dividerX, y: startY + 2 },
        end: { x: dividerX, y: bottomY },
        thickness: 0.45,
        color: rgb(0.86, 0.86, 0.86),
      });
      y = bottomY - 4;
    }

    newPage();

    // Abwesenheiten werden nur gesammelt in der Betriebsauswertung gezeigt.
    // Eigene Mitarbeiterblöcke gibt es nur bei tatsächlichen Zeiten oder Dokumentation.
    for (const employee of employees.filter((item) => item.blocks.length || item.reviews.length)) {
      const materials = employee.reviews.filter((entry) => entry.category === "material");
      const materialPhotos = materials.filter((entry) => entry.source === "image" || entry.file);
      const photos = employee.reviews.filter((entry) => entry.category === "photo");
      const videos = employee.reviews.filter((entry) => entry.category === "video");
      const regie = employee.reviews.filter((entry) => entry.category === "regie");

      const blockLines = employee.blocks.slice(0, 10);
      const materialText = materials
        .map((entry) => entry.content || entry.transcript || (entry.source === "image" ? "Materialfoto" : "Material"))
        .filter(Boolean)
        .join("; ");
      const regieText = regie
        .map((entry) => entry.content || entry.transcript || "Regie vorgemerkt")
        .filter(Boolean)
        .join("; ");

      const summaryRows =
        52 +
        employee.summary.jobs.size * 11 +
        employee.summary.upReasons.size * 11;

      const approxHeight =
        42 +
        blockLines.length * 14 +
        summaryRows +
        (materialText ? 28 : 0) +
        (materialPhotos.length ? 62 : 0) +
        (regieText ? 24 : 0) +
        (photos.length ? 74 : 0) +
        (videos.length ? 16 : 0);

      ensureSpace(Math.min(approxHeight, 250));

      page.drawText(employee.employeeName, {
        x: margin,
        y,
        size: 13,
        font: bold,
      });
      y -= 18;

      if (blockLines.length) {
        for (const block of blockLines) {
          ensureSpace(14);
          page.drawText(`${block.from}-${block.to}`, {
            x: margin,
            y,
            size: 9.5,
            font: bold,
          });
          page.drawText(formatDurationCompact(durationOf(block)), {
            x: margin + 78,
            y,
            size: 9.2,
            font: bold,
          });
          page.drawText(
            `${block.jobId ? "#" + block.jobId + " · " : ""}${block.jobName}`,
            {
              x: margin + 120,
              y,
              size: 9.5,
              font,
              maxWidth: contentWidth - 120,
            }
          );
          y -= 14;
        }
      } else if (employee.absence) {
        page.drawText(`${employee.absence.label} · ${formatDurationCompact(employee.absence.minutes)}`, {
          x: margin,
          y,
          size: 9.5,
          font: bold,
        });
        if (employee.absence.reason) {
          page.drawText(employee.absence.reason, { x: margin + 170, y, size: 9, font, maxWidth: 500 });
        }
        y -= 14;
      } else {
        page.drawText("Keine vollständigen Zeitblöcke", {
          x: margin,
          y,
          size: 9.5,
          font,
        });
        y -= 14;
      }

      drawEmployeeSummary(employee.summary);

      if (materialText) {
        ensureSpace(30);
        page.drawText("Material:", {
          x: margin,
          y,
          size: 9,
          font: bold,
        });
        const lines = wrap(materialText, 92).slice(0, 3);
        lines.forEach((line, idx) =>
          page.drawText(line, {
            x: margin + 50,
            y: y - idx * 12,
            size: 8.5,
            font,
            maxWidth: contentWidth - 50,
          })
        );
        y -= Math.max(14, lines.length * 12);
      }

      if (materialPhotos.length) {
        ensureSpace(60);
        page.drawText(`Materialfotos: ${materialPhotos.length}`, {
          x: margin,
          y,
          size: 9,
          font: bold,
        });
        let x = margin + 82;

        for (const materialPhoto of materialPhotos.slice(0, 5)) {
          const bytes = await imageBytes(materialPhoto);
          if (!bytes) continue;

          try {
            const img = await pdf.embedJpg(bytes);
            const boxW = 72;
            const boxH = 48;
            const scale = Math.min(boxW / img.width, boxH / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            page.drawImage(img, {
              x,
              y: y - 51 + (boxH - h) / 2,
              width: w,
              height: h,
            });
            x += 82;
          } catch {}
        }

        y -= 56;
      }

      if (regieText) {
        ensureSpace(30);
        page.drawText("Regie:", {
          x: margin,
          y,
          size: 9,
          font: bold,
        });
        const lines = wrap(regieText, 95).slice(0, 3);
        lines.forEach((line, idx) =>
          page.drawText(line, {
            x: margin + 40,
            y: y - idx * 12,
            size: 8.5,
            font,
            maxWidth: contentWidth - 40,
          })
        );
        y -= Math.max(14, lines.length * 12);
      }

      if (photos.length) {
        ensureSpace(74);
        page.drawText(`Fotos: ${photos.length}`, {
          x: margin,
          y,
          size: 9,
          font: bold,
        });
        let x = margin + 54;

        for (const photo of photos.slice(0, 6)) {
          const bytes = await imageBytes(photo);
          if (!bytes) continue;

          try {
            const img = await pdf.embedJpg(bytes);
            const boxW = 72;
            const boxH = 50;
            const scale = Math.min(boxW / img.width, boxH / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            page.drawImage(img, {
              x,
              y: y - 53 + (boxH - h) / 2,
              width: w,
              height: h,
            });
            x += 82;
          } catch {}
        }

        y -= 58;
      }

      if (videos.length) {
        ensureSpace(18);
        const videoNames = videos
          .map((entry) => path.basename(String(entry.file || "Video")))
          .slice(0, 4)
          .join(", ");

        page.drawText(
          `Videos: ${videos.length}${videoNames ? " · " + videoNames : ""}`,
          {
            x: margin,
            y,
            size: 9,
            font: bold,
            maxWidth: contentWidth,
          }
        );
        y -= 16;
      }

      drawDivider();
    }

    if (!employees.length) {
      page.drawText("Für diesen Tag sind noch keine auswertbaren Daten vorhanden.", {
        x: margin,
        y,
        size: 12,
        font,
      });
    }

    if (includeDaySummary && employees.length) {
      const day = summarizeDay(employees);

      const unknownBlocks = employees.flatMap((employee) =>
        employee.blocks
          .filter((block) => block.type === "productive" && (!block.jobId || block.jobName === "Ohne Baustelle"))
          .map((block) => ({ employeeName: employee.employeeName, block }))
      );
      const activeEmployees = employees.filter((employee) => employee.summary.workingTotal > 0);
      const withoutPhotos = activeEmployees.filter((employee) => !employee.reviews.some((entry) => entry.category === "photo"));
      const withoutMaterial = activeEmployees.filter((employee) => !employee.reviews.some((entry) => entry.category === "material"));
      const withoutRegie = activeEmployees.filter((employee) => !employee.reviews.some((entry) => entry.category === "regie"));

      newPage();
      page.drawText("TAGESAUSWERTUNG", { x: margin, y, size: 13, font: bold });
      y -= 20;

      const leftX = margin;
      const leftValueX = leftX + 280;
      const dividerX = margin + 410;
      const rightX = dividerX + 20;
      const rightValueX = rightX + 180;
      const topY = y;
      const lowerLimit = 190;

      page.drawText("BAUSTELLENÜBERSICHT", { x: leftX, y, size: 12, font: bold });
      let leftY = y - 20;

      const jobRows = [...day.jobs.values()].sort((a, b) => b.total - a.total);
      const upRows = [...day.upReasons.entries()].sort((a, b) => b[1].total - a[1].total);
      let hiddenJobCount = 0;

      for (let jobIndex = 0; jobIndex < jobRows.length; jobIndex++) {
        const job = jobRows[jobIndex];
        const needed = 27 + job.employees.length * 11;
        if (leftY - needed < lowerLimit) {
          hiddenJobCount = jobRows.length - jobIndex;
          break;
        }

        page.drawText(`${job.jobId ? "#" + job.jobId + " · " : ""}${job.jobName}`, {
          x: leftX,
          y: leftY,
          size: 9.4,
          font: bold,
          maxWidth: 305,
        });
        leftY -= 12;

        for (const row of job.employees.sort((a, b) => b.minutes - a.minutes)) {
          page.drawText(row.employeeName, { x: leftX + 12, y: leftY, size: 8.1, font });
          page.drawText(formatDuration(row.minutes), { x: leftValueX, y: leftY, size: 8.1, font });
          leftY -= 10;
        }

        page.drawLine({
          start: { x: leftX + 12, y: leftY + 4 },
          end: { x: leftValueX + 72, y: leftY + 4 },
          thickness: 0.4,
          color: rgb(0.82, 0.82, 0.82),
        });
        page.drawText("Gesamt", { x: leftX + 12, y: leftY, size: 8.3, font: bold });
        page.drawText(formatDuration(job.total), { x: leftValueX, y: leftY, size: 8.3, font: bold });
        leftY -= 15;
      }

      if (hiddenJobCount > 0) {
        page.drawText(`+ ${hiddenJobCount} weitere Baustelle${hiddenJobCount === 1 ? "" : "n"}`, {
          x: leftX,
          y: leftY,
          size: 8.2,
          font: bold,
        });
        leftY -= 14;
      }

      if (upRows.length && leftY > lowerLimit + 34) {
        page.drawText("UNPRODUKTIV", { x: leftX, y: leftY, size: 10.5, font: bold });
        leftY -= 15;
        for (const [reason, info] of upRows) {
          const needed = 25 + info.employees.length * 10;
          if (leftY - needed < lowerLimit) break;
          page.drawText(reason, { x: leftX, y: leftY, size: 9, font: bold });
          leftY -= 11;
          for (const row of info.employees.sort((a, b) => b.minutes - a.minutes)) {
            page.drawText(row.employeeName, { x: leftX + 12, y: leftY, size: 8.1, font });
            page.drawText(formatDuration(row.minutes), { x: leftValueX, y: leftY, size: 8.1, font });
            leftY -= 10;
          }
          page.drawLine({
            start: { x: leftX + 12, y: leftY + 4 },
            end: { x: leftValueX + 72, y: leftY + 4 },
            thickness: 0.4,
            color: rgb(0.82, 0.82, 0.82),
          });
          page.drawText("Gesamt", { x: leftX + 12, y: leftY, size: 8.3, font: bold });
          page.drawText(formatDuration(info.total), { x: leftValueX, y: leftY, size: 8.3, font: bold });
          leftY -= 15;
        }
      }

      page.drawLine({
        start: { x: dividerX, y: topY + 4 },
        end: { x: dividerX, y: lowerLimit },
        thickness: 0.5,
        color: rgb(0.82, 0.82, 0.82),
      });

      let rightY = topY;
      page.drawText("BETRIEBSÜBERSICHT", { x: rightX, y: rightY, size: 12, font: bold });
      rightY -= 20;
      page.drawText("Tageskennzahlen", { x: rightX, y: rightY, size: 10, font: bold });
      rightY -= 16;

      const kpiCol = {
        label: rightX,
        ist: rightX + 155,
        plan: rightX + 205,
        diff: rightX + 250,
        pct: rightX + 295,
      };
      page.drawText("Ist", { x: kpiCol.ist, y: rightY, size: 7.8, font: bold });
      page.drawText("Plan", { x: kpiCol.plan, y: rightY, size: 7.8, font: bold });
      page.drawText("+/-", { x: kpiCol.diff, y: rightY, size: 7.8, font: bold });
      page.drawText("p/M %", { x: kpiCol.pct, y: rightY, size: 7.8, font: bold });
      rightY -= 13;

      const kpiRows = [
        ["Produktiv", day.productive, day.plan.productive],
        ["Interne Arbeiten", day.unproductive, day.plan.unproductive],
      ];
      for (const [label, actual, planned] of kpiRows) {
        page.drawText(label, { x: kpiCol.label, y: rightY, size: 8.5, font });
        page.drawText(formatDurationCompact(actual), { x: kpiCol.ist, y: rightY, size: 8.5, font: bold });
        page.drawText(formatDurationCompact(planned), { x: kpiCol.plan, y: rightY, size: 8.5, font });
        page.drawText(formatSignedDuration(actual - planned), { x: kpiCol.diff, y: rightY, size: 8.5, font: bold });
        page.drawText(formatPercent(actual, planned), { x: kpiCol.pct, y: rightY, size: 8.1, font: bold });
        rightY -= 14;
      }

      rightY -= 5;
      page.drawLine({ start: { x: rightX, y: rightY }, end: { x: PAGE_W - margin, y: rightY }, thickness: 0.5, color: rgb(0.82, 0.82, 0.82) });
      rightY -= 16;
      page.drawText("Personal", { x: rightX, y: rightY, size: 10, font: bold });
      rightY -= 15;

      const absenceTotal = (rows) => rows.reduce((sum, row) => sum + Number(row.minutes || 0), 0);
      const personalRows = [
        ["Mitarbeiter gesamt", String(day.headcount)],
        ["Im Einsatz", String(day.activeCount)],
        ["Urlaub", `${day.absences.vacation.length} · ${formatDurationCompact(absenceTotal(day.absences.vacation))}`],
        ["Krankenstand", `${day.absences.sick.length} · ${formatDurationCompact(absenceTotal(day.absences.sick))}`],
        ["Feiertag", `${day.absences.holiday.length} · ${formatDurationCompact(absenceTotal(day.absences.holiday))}`],
        ["Sonstige Abwesenheit", `${day.absences.other.length} · ${formatDurationCompact(absenceTotal(day.absences.other))}`],
      ];
      for (const [label, value] of personalRows) {
        page.drawText(label, { x: rightX, y: rightY, size: 8.4, font });
        page.drawText(String(value), { x: rightValueX - 25, y: rightY, size: 8.4, font: bold });
        rightY -= 11;
      }

      // Keine Namenslisten bei Urlaub/Krank: Anzahl und Stunden oben genügen.

      const checksTop = 155;
      page.drawLine({
        start: { x: margin, y: checksTop + 15 },
        end: { x: PAGE_W - margin, y: checksTop + 15 },
        thickness: 0.65,
        color: rgb(0.82, 0.82, 0.82),
      });
      page.drawText("PRÜFHINWEISE", { x: margin, y: checksTop, size: 10.5, font: bold });

      const checkColumns = [
        { title: `FOTOS FEHLEN (${withoutPhotos.length})`, rows: withoutPhotos.map((e) => e.employeeName) },
        { title: `MATERIAL FEHLT (${withoutMaterial.length})`, rows: withoutMaterial.map((e) => e.employeeName) },
        { title: `REGIE FEHLT (${withoutRegie.length})`, rows: withoutRegie.map((e) => e.employeeName) },
      ];
      const colGap = 18;
      const colWidth = (contentWidth - colGap * 2) / 3;
      checkColumns.forEach((check, index) => {
        const x = margin + index * (colWidth + colGap);
        let checkY = checksTop - 17;
        page.drawText(check.title, { x, y: checkY, size: 8.5, font: bold });
        checkY -= 12;
        if (!check.rows.length) {
          page.drawText("Keine", { x, y: checkY, size: 8, font });
          return;
        }
        for (const name of check.rows.slice(0, 7)) {
          page.drawText(name, { x, y: checkY, size: 8, font, maxWidth: colWidth });
          checkY -= 10;
        }
        if (check.rows.length > 7) {
          page.drawText(`+ ${check.rows.length - 7} weitere`, { x, y: checkY, size: 7.8, font: bold });
        }
      });

      if (unknownBlocks.length) {
        page.drawText(`${unknownBlocks.length} Zeitblock${unknownBlocks.length === 1 ? "" : "blöcke"} ohne eindeutige Baustelle`, {
          x: margin,
          y: 42,
          size: 7.8,
          font: bold,
        });
      }
    }

    const pages = pdf.getPages();
    pages.forEach((p, index) => {
      p.drawText(`Seite ${index + 1}/${pages.length}`, {
        x: PAGE_W - 88,
        y: 18,
        size: 8,
        font,
      });
    });

    return Buffer.from(await pdf.save());
  }

  async function generate(date = yesterdayISO()) {
    await fsp.mkdir(REPORTS_DIR, { recursive: true });
    await migrateLegacyMediaForDate({ dataDir, date });

    const employees = await collect(date);
    const overallBytes = await buildPdf({
      date,
      employees,
      includeDaySummary: true,
    });

    const overallPath = path.join(REPORTS_DIR, `Tagesreport_${date}.pdf`);
    await fsp.writeFile(overallPath, overallBytes);

    const jobs = new Map();

    for (const employee of employees) {
      for (const block of employee.blocks) {
        if (block.jobId) jobs.set(block.jobId, block.jobName || block.jobId);
      }
      for (const review of employee.reviews) {
        if (review.jobId) {
          jobs.set(String(review.jobId), review.jobName || review.jobId);
        }
      }
    }

    const siteReports = [];

    for (const [jobId, jobName] of jobs.entries()) {
      const siteEmployees = await collect(date, jobId);
      if (!siteEmployees.length) continue;

      const bytes = await buildPdf({
        date,
        employees: siteEmployees,
        titleSuffix: `#${jobId} · ${jobName || jobId}`,
        includeDaySummary: false,
      });

      const chronikDir = path.join(dataDir, String(jobId), "_chronik");
      await fsp.mkdir(chronikDir, { recursive: true });

      const filePath = path.join(chronikDir, `Tagesreport_${date}.pdf`);
      await fsp.writeFile(filePath, bytes);

      siteReports.push({ jobId, jobName, filePath });
    }

    return { date, overallPath, siteReports };
  }

  app.post("/admin/api/daily-report/:date?", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const date = String(req.params.date || yesterdayISO()).slice(0, 10);
      const result = await generate(date);
      res.json({
        ok: true,
        date,
        viewUrl: `/admin/daily-report/${date}`,
        sites: result.siteReports.length,
      });
    } catch (error) {
      console.error("Daily report generation failed:", error);
      res.status(500).json({
        ok: false,
        error: String(error?.message || error),
      });
    }
  });

  app.get("/admin/daily-report/:date?", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const date = String(req.params.date || yesterdayISO()).slice(0, 10);
      const filePath = path.join(REPORTS_DIR, `Tagesreport_${date}.pdf`);

      if (!fs.existsSync(filePath) || String(req.query.rebuild || "") === "1") {
        await generate(date);
      }

      res.type("application/pdf");
      res.sendFile(filePath);
    } catch (error) {
      res.status(500).send(String(error?.message || error));
    }
  });

  app.get("/admin/daily-report/:date/download", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const date = String(req.params.date || yesterdayISO()).slice(0, 10);
      const filePath = path.join(REPORTS_DIR, `Tagesreport_${date}.pdf`);

      if (!fs.existsSync(filePath)) {
        await generate(date);
      }

      res.download(filePath, `KRISTA Tagesreport ${date}.pdf`);
    } catch (error) {
      res.status(500).send(String(error?.message || error));
    }
  });

  return { generate, yesterdayISO };
}

module.exports = { registerDailyReport };
