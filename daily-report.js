// Datei: daily-report.js · Build 0029.2 · Reporting-Basis
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
  const EMPLOYEES = path.join(ROOT, "employees.json");
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

  function weekdayForDate(dateStr) {
    const [year, month, day] = String(dateStr || "").split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
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
    const text = String(value || "").toLowerCase();
    if (/urlaub|vacation|holiday/.test(text)) return "vacation";
    if (/krank|krankenstand|sick|illness/.test(text)) return "sick";
    if (/feiertag|public holiday/.test(text)) return "holiday";
    if (/zeitausgleich|time off|absence|abwesen/.test(text)) return "other";
    return null;
  }

  function isDateWithin(date, from, to) {
    const target = String(date || "").slice(0, 10);
    const start = String(from || to || "").slice(0, 10);
    const end = String(to || from || "").slice(0, 10);
    return Boolean(target && start && end && target >= start && target <= end);
  }

  function normalizeAbsence(record, date) {
    if (!record || typeof record !== "object") return null;
    const type = absenceType(
      record.type || record.absenceType || record.category || record.status || record.reason
    );
    if (!type) return null;

    const matchesDate =
      String(record.date || "").slice(0, 10) === String(date) ||
      isDateWithin(date, record.from || record.startDate || record.dateFrom, record.to || record.endDate || record.dateTo);
    if (!matchesDate) return null;

    const minutes = Number(record.minutes) || Number(record.hours) * 60 || 7.8 * 60;
    return {
      employeeId: String(record.employeeId || record.workerId || record.userId || record.employeeName || record.name || ""),
      employeeName: String(record.employeeName || record.workerName || record.name || record.employeeId || "Unbekannt"),
      type,
      label: type === "vacation" ? "Urlaub" : type === "sick" ? "Krankenstand" : type === "holiday" ? "Feiertag" : "Sonstige Abwesenheit",
      minutes: Math.max(0, Math.round(minutes)),
      reason: String(record.reason || record.note || "").trim(),
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

  async function collect(date, jobFilter = null) {
    const [timeEvents, reviewEntries, absences, employeeMaster] = await Promise.all([
      readJson(TIME_EVENTS, []),
      readJson(REVIEW_ENTRIES, []),
      readJson(ABSENCES, []),
      readJson(EMPLOYEES, []),
    ]);

    const byEmployee = new Map();

    const ensure = (id, name) => {
      const key = String(id || name || "unbekannt");
      if (!byEmployee.has(key)) {
        byEmployee.set(key, {
          employeeId: key,
          employeeName: name || key,
          events: [],
          reviews: [],
          absence: null,
        });
      }
      return byEmployee.get(key);
    };

    for (const master of Array.isArray(employeeMaster) ? employeeMaster : []) {
      const active = master.active !== false && master.isActive !== false && !master.archived;
      if (!active) continue;
      ensure(master.id || master.employeeId || master.phone, master.name || master.employeeName);
    }

    for (const event of Array.isArray(timeEvents) ? timeEvents : []) {
      if (String(event.date) !== String(date)) continue;
      if (jobFilter && String(event.jobId || "") !== String(jobFilter)) continue;
      ensure(event.employeeId, event.employeeName).events.push(event);
    }

    for (const entry of Array.isArray(reviewEntries) ? reviewEntries : []) {
      if (String(entry.date) !== String(date)) continue;
      if (jobFilter && String(entry.jobId || "") !== String(jobFilter)) continue;
      ensure(entry.employeeId, entry.employeeName).reviews.push(entry);
    }

    const absenceCandidates = [
      ...(Array.isArray(absences) ? absences : []),
      ...(Array.isArray(timeEvents) ? timeEvents : []),
      ...(Array.isArray(reviewEntries) ? reviewEntries : []),
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
      .map((employee) => {
        const blocks = buildBlocks(employee.events);
        const withBlocks = { ...employee, blocks };
        return { ...withBlocks, summary: summarizeEmployee(withBlocks, date) };
      })
      .filter((employee) => employee.blocks.length || employee.reviews.length || employee.absence)
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

    for (const employee of employees) {
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
          page.drawText(
            `${block.jobId ? "#" + block.jobId + " · " : ""}${block.jobName}`,
            {
              x: margin + 76,
              y,
              size: 9.5,
              font,
              maxWidth: 570,
            }
          );
          page.drawText(formatDurationCompact(durationOf(block)), {
            x: PAGE_W - margin - 38,
            y,
            size: 9.2,
            font: bold,
          });
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

      ensureSpace(40, "TAGESAUSWERTUNG");
      drawSectionHeading("BAUSTELLENÜBERSICHT");

      for (const job of [...day.jobs.values()].sort((a, b) => b.total - a.total)) {
        ensureSpace(34 + job.employees.length * 11, "BAUSTELLENÜBERSICHT");

        page.drawText(
          `${job.jobId ? "#" + job.jobId + " · " : ""}${job.jobName}`,
          {
            x: margin,
            y,
            size: 10,
            font: bold,
            maxWidth: 450,
          }
        );
        y -= 13;

        for (const row of job.employees.sort((a, b) => b.minutes - a.minutes)) {
          page.drawText(row.employeeName, {
            x: margin + 12,
            y,
            size: 8.5,
            font,
          });
          page.drawText(formatDuration(row.minutes), {
            x: margin + 260,
            y,
            size: 8.5,
            font: bold,
          });
          y -= 11;
        }

        page.drawLine({
          start: { x: margin + 12, y: y + 4 },
          end: { x: margin + 320, y: y + 4 },
          thickness: 0.45,
          color: rgb(0.82, 0.82, 0.82),
        });
        page.drawText("Gesamt", {
          x: margin + 12,
          y,
          size: 8.7,
          font: bold,
        });
        page.drawText(formatDuration(job.total), {
          x: margin + 260,
          y,
          size: 8.7,
          font: bold,
        });
        y -= 16;
      }

      if (day.upReasons.size) {
        drawSectionHeading("UNPRODUKTIV");

        for (const [reason, info] of [...day.upReasons.entries()].sort(
          (a, b) => b[1].total - a[1].total
        )) {
          ensureSpace(34 + info.employees.length * 11, "UNPRODUKTIV");

          page.drawText(reason, {
            x: margin,
            y,
            size: 10,
            font: bold,
          });
          y -= 13;

          for (const row of info.employees.sort((a, b) => b.minutes - a.minutes)) {
            page.drawText(row.employeeName, {
              x: margin + 12,
              y,
              size: 8.5,
              font,
            });
            page.drawText(formatDuration(row.minutes), {
              x: margin + 260,
              y,
              size: 8.5,
              font: bold,
            });
            y -= 11;
          }

          page.drawText("Gesamt", {
            x: margin + 12,
            y,
            size: 8.7,
            font: bold,
          });
          page.drawText(formatDuration(info.total), {
            x: margin + 260,
            y,
            size: 8.7,
            font: bold,
          });
          y -= 16;
        }
      }

      newPage("BETRIEBSÜBERSICHT");
      const leftX = margin;
      const dividerX = margin + 430;
      const rightX = dividerX + 20;
      const rowYStart = y;

      page.drawText("Tageskennzahlen", { x: leftX, y, size: 12, font: bold });
      y -= 20;

      const col = {
        label: leftX,
        ist: leftX + 170,
        plan: leftX + 235,
        diff: leftX + 300,
        pct: leftX + 365,
      };
      page.drawText("Ist", { x: col.ist, y, size: 8.4, font: bold });
      page.drawText("Plan", { x: col.plan, y, size: 8.4, font: bold });
      page.drawText("+/-", { x: col.diff, y, size: 8.4, font: bold });
      page.drawText("p/M %", { x: col.pct, y, size: 8.4, font: bold });
      y -= 14;

      const kpiRows = [
        ["Produktiv", day.productive],
        ["Unproduktiv", day.unproductive],
      ];
      for (const [label, minutes] of kpiRows) {
        page.drawText(label, { x: col.label, y, size: 9, font });
        page.drawText(formatDurationCompact(minutes), { x: col.ist, y, size: 9, font: bold });
        page.drawText("—", { x: col.plan, y, size: 9, font });
        page.drawText("—", { x: col.diff, y, size: 9, font });
        page.drawText("—", { x: col.pct, y, size: 9, font });
        y -= 15;
      }

      y -= 5;
      page.drawLine({ start: { x: leftX, y }, end: { x: dividerX - 18, y }, thickness: 0.6, color: rgb(0.82, 0.82, 0.82) });
      y -= 17;
      page.drawText("Personal", { x: leftX, y, size: 10, font: bold });
      y -= 15;
      const personalRows = [
        ["Mitarbeiter gesamt", String(day.headcount)],
        ["Im Einsatz", String(day.activeCount)],
        ["Urlaub", String(day.absences.vacation.length)],
        ["Krankenstand", String(day.absences.sick.length)],
        ["Feiertag", String(day.absences.holiday.length)],
        ["Sonstige Abwesenheit", String(day.absences.other.length)],
      ];
      for (const [label, value] of personalRows) {
        page.drawText(label, { x: leftX, y, size: 8.6, font });
        page.drawText(value, { x: leftX + 180, y, size: 8.6, font: bold });
        y -= 12;
      }

      function drawAbsenceList(title, rows) {
        if (!rows.length) return;
        y -= 5;
        page.drawText(title, { x: leftX, y, size: 9, font: bold });
        y -= 12;
        for (const row of rows) {
          page.drawText(row.employeeName, { x: leftX + 10, y, size: 8.2, font });
          page.drawText(formatDurationCompact(row.minutes), { x: leftX + 180, y, size: 8.2, font: bold });
          y -= 11;
        }
      }
      drawAbsenceList("Urlaub", day.absences.vacation);
      drawAbsenceList("Krankenstand", day.absences.sick);
      drawAbsenceList("Feiertag", day.absences.holiday);
      drawAbsenceList("Sonstige Abwesenheit", day.absences.other);

      const unknownBlocks = employees.flatMap((employee) =>
        employee.blocks
          .filter((block) => block.type === "productive" && (!block.jobId || block.jobName === "Ohne Baustelle"))
          .map((block) => ({ employeeName: employee.employeeName, block }))
      );
      const withoutPhotos = employees.filter((employee) => employee.summary.productive > 0 && !employee.reviews.some((entry) => entry.category === "photo"));
      const withoutMaterial = employees.filter((employee) => employee.summary.productive > 0 && !employee.reviews.some((entry) => entry.category === "material"));
      const withoutRegie = employees.filter((employee) => employee.summary.productive > 0 && !employee.reviews.some((entry) => entry.category === "regie"));
      const checks = [];
      if (unknownBlocks.length) checks.push(`${unknownBlocks.length} produktive Zeitblöcke ohne eindeutige Baustellennummer`);
      if (withoutPhotos.length) checks.push(`Keine Fotos erfasst: ${withoutPhotos.map((e) => e.employeeName).join(", ")}`);
      if (withoutMaterial.length) checks.push(`Kein Material erfasst: ${withoutMaterial.map((e) => e.employeeName).join(", ")}`);
      if (withoutRegie.length) checks.push(`Keine Regie erfasst: ${withoutRegie.map((e) => e.employeeName).join(", ")}`);

      page.drawLine({
        start: { x: dividerX, y: rowYStart + 6 },
        end: { x: dividerX, y: 56 },
        thickness: 0.55,
        color: rgb(0.82, 0.82, 0.82),
      });
      let checkY = rowYStart;
      page.drawText("Prüfhinweise", { x: rightX, y: checkY, size: 12, font: bold });
      checkY -= 20;
      if (!checks.length) {
        page.drawText("Keine automatischen Prüfhinweise.", { x: rightX, y: checkY, size: 8.8, font });
      } else {
        for (const check of checks) {
          const lines = wrap(check, 46);
          lines.forEach((line, index) => {
            page.drawText(`${index === 0 ? "• " : "  "}${line}`, {
              x: rightX,
              y: checkY,
              size: 8.5,
              font,
              maxWidth: PAGE_W - margin - rightX,
            });
            checkY -= 11;
          });
          checkY -= 4;
        }
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
