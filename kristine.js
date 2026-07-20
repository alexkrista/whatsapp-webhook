// Datei: kristine.js · Build 0020.3

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

// ===== HELPER: Österreichische Feiertage =====
function getAustrianHolidays(year) {
  const holidays = [];
  
  // Fixe Feiertage
  holidays.push({ date: `${year}-01-01`, name: "Neujahr" });
  holidays.push({ date: `${year}-01-06`, name: "Heilige Drei Könige" });
  holidays.push({ date: `${year}-05-01`, name: "Staatsfeiertag" });
  holidays.push({ date: `${year}-08-15`, name: "Mariä Himmelfahrt" });
  holidays.push({ date: `${year}-10-26`, name: "Nationalfeiertag" });
  holidays.push({ date: `${year}-11-01`, name: "Allerheiligen" });
  holidays.push({ date: `${year}-12-08`, name: "Mariä Empfängnis" });
  holidays.push({ date: `${year}-12-25`, name: "Christtag" });
  holidays.push({ date: `${year}-12-26`, name: "Stefanitag" });
  
  // Ostern berechnen (Computus)
  const easterDate = getEasterDate(year);
  const easterTime = easterDate.getTime();
  
  // Ostermontag: Ostern + 1 Tag
  const easterMonday = new Date(easterTime + 86400000);
  holidays.push({ 
    date: `${easterMonday.getFullYear()}-${String(easterMonday.getMonth() + 1).padStart(2, "0")}-${String(easterMonday.getDate()).padStart(2, "0")}`,
    name: "Ostermontag"
  });
  
  // Christi Himmelfahrt: Ostern + 39 Tage
  const ascensionDay = new Date(easterTime + 39 * 86400000);
  holidays.push({
    date: `${ascensionDay.getFullYear()}-${String(ascensionDay.getMonth() + 1).padStart(2, "0")}-${String(ascensionDay.getDate()).padStart(2, "0")}`,
    name: "Christi Himmelfahrt"
  });
  
  // Pfingstmontag: Ostern + 50 Tage
  const whitMondayDay = new Date(easterTime + 50 * 86400000);
  holidays.push({
    date: `${whitMondayDay.getFullYear()}-${String(whitMondayDay.getMonth() + 1).padStart(2, "0")}-${String(whitMondayDay.getDate()).padStart(2, "0")}`,
    name: "Pfingstmontag"
  });
  
  // Fronleichnam: Ostern + 60 Tage
  const corpusChristiDay = new Date(easterTime + 60 * 86400000);
  holidays.push({
    date: `${corpusChristiDay.getFullYear()}-${String(corpusChristiDay.getMonth() + 1).padStart(2, "0")}-${String(corpusChristiDay.getDate()).padStart(2, "0")}`,
    name: "Fronleichnam"
  });
  
  return holidays.sort((a, b) => a.date.localeCompare(b.date));
}

function getEasterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// ===== HELPER: Standard-Zeitmodelle =====
function getDefaultScheduleModels() {
  return [
    {
      id: "sommer",
      name: "Sommer (Krista)",
      days: [
        { dayName: "Montag", isWorkDay: true, from: "07:00", to: "17:00", pauseMinutes: 45, shouldHours: 7.8 },
        { dayName: "Dienstag", isWorkDay: true, from: "07:00", to: "17:00", pauseMinutes: 45, shouldHours: 7.8 },
        { dayName: "Mittwoch", isWorkDay: true, from: "07:00", to: "17:00", pauseMinutes: 45, shouldHours: 7.8 },
        { dayName: "Donnerstag", isWorkDay: true, from: "07:00", to: "17:00", pauseMinutes: 45, shouldHours: 7.8 },
        { dayName: "Freitag", isWorkDay: true, from: "07:00", to: "14:15", pauseMinutes: 15, shouldHours: 7.8 },
        { dayName: "Samstag", isWorkDay: false, from: "", to: "", pauseMinutes: 0, shouldHours: 0 },
        { dayName: "Sonntag", isWorkDay: false, from: "", to: "", pauseMinutes: 0, shouldHours: 0 }
      ]
    },
    {
      id: "winter",
      name: "Winter",
      days: [
        { dayName: "Montag", isWorkDay: true, from: "07:00", to: "17:00", pauseMinutes: 45, shouldHours: 7.8 },
        { dayName: "Dienstag", isWorkDay: true, from: "07:00", to: "17:00", pauseMinutes: 45, shouldHours: 7.8 },
        { dayName: "Mittwoch", isWorkDay: true, from: "07:00", to: "17:00", pauseMinutes: 45, shouldHours: 7.8 },
        { dayName: "Donnerstag", isWorkDay: true, from: "07:00", to: "17:00", pauseMinutes: 45, shouldHours: 7.8 },
        { dayName: "Freitag", isWorkDay: false, from: "", to: "", pauseMinutes: 0, shouldHours: 0 },
        { dayName: "Samstag", isWorkDay: false, from: "", to: "", pauseMinutes: 0, shouldHours: 0 },
        { dayName: "Sonntag", isWorkDay: false, from: "", to: "", pauseMinutes: 0, shouldHours: 0 }
      ]
    }
  ];
}

function registerKristine(app, { dataDir, requireAdmin, publicDir }) {
  const ROOT = path.join(dataDir, "_kristine");
  const ASSIGNMENTS = path.join(ROOT, "assignments.json");
  const STATES = path.join(ROOT, "states.json");
  const TASKS = path.join(ROOT, "tasks.json");
  const EVENTS = path.join(ROOT, "events.jsonl");
  const TIME_EVENTS = path.join(ROOT, "time-events.json");
  const REVIEW_ENTRIES = path.join(ROOT, "day-review-entries.json");

  async function ensureRoot() {
    await fsp.mkdir(ROOT, { recursive: true });
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async function writeJson(file, value) {
    await ensureRoot();
    await fsp.writeFile(file, JSON.stringify(value, null, 2), "utf8");
  }

  async function appendEvent(event) {
    await ensureRoot();
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    await fsp.appendFile(EVENTS, line, "utf8");
  }

  function viennaParts(d = new Date()) {
    const parts = new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function localDateISO(d = new Date()) {
    const p = viennaParts(d);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function localTimeHM(d = new Date()) {
    const p = viennaParts(d);
    return `${p.hour}:${p.minute}`;
  }

  function minutesFromHM(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function clampOfficialStart(actualTime) {
    const actual = minutesFromHM(actualTime);
    const official = minutesFromHM("07:00");
    return actual !== null && actual < official ? "07:00" : actualTime;
  }

  async function appendTimeEvent(event) {
    const rows = await readJson(TIME_EVENTS, []);
    rows.push(event);
    // Genug Historie für Büroprüfung behalten, Datei aber begrenzen.
    await writeJson(TIME_EVENTS, rows.slice(-20000));
  }

  async function appendReviewEntry(entry) {
    const rows = await readJson(REVIEW_ENTRIES, []);
    rows.push({ id: `review_entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString(), ...entry });
    await writeJson(REVIEW_ENTRIES, rows.slice(-20000));
  }

  async function completeDayReview({ employeeId, employeeName, date, state, states, current, actualTime, now, hasMaterials = false, hasPhotos = false, hasRegie = false }) {
    state.mode = "finished_day";
    state.pending = null;
    state.timeline = Array.isArray(state.timeline) ? state.timeline : [];
    state.timeline.push({
      at: now,
      time: actualTime,
      type: "day_finished",
      detail: "Tagesabschluss bestätigt",
      assignmentKey: current ? assignmentKey(current) : null,
      jobId: current?.jobId || null,
      jobName: current?.jobName || "",
    });
    state.timeline = state.timeline.slice(-200);
    states[employeeId] = state;
    await writeJson(STATES, states);
    await appendTimeEvent({
      id: `review_${Date.now()}_${String(employeeId).replace(/[^A-Za-z0-9_-]/g, "")}`,
      employeeId,
      employeeName,
      date,
      type: "day_review",
      at: actualTime,
      jobId: current?.jobId || null,
      jobName: current?.jobName || "",
      hasMaterials,
      hasPhotos,
      hasRegie,
      createdAt: now,
    });
    await appendEvent({
      type: "day_finished",
      employeeId,
      employeeName,
      date,
      jobId: current?.jobId || null,
      time: actualTime,
      hasMaterials,
      hasPhotos,
      hasRegie,
    });
    return {
      reply: "Tagesabschluss gespeichert. Schönen Feierabend! 👋",
      buttons: [],
      state,
    };
  }

  function normalizeText(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/[.!?,;:]+/g, "")
      .replace(/\s+/g, " ");
  }

  function detectIntent(text) {
    const t = normalizeText(text);
    if (/^(start|beginn|los|arbeitsbeginn|geht los|auf gehts)$/.test(t)) return "start";
    if (/^(pause|kaffee|kaffeepause|kurze pause)$/.test(t)) return "pause";
    if (/^(mittag|essen|mittagspause|mahlzeit)$/.test(t)) return "lunch";
    if (/^(weiter|wieder da|geht weiter|pause fertig|los gehts)$/.test(t)) return "resume";
    if (/^(fertig|feierabend|schluss|wir sind fertig|bin fertig)$/.test(t)) return "finish";
    if (/^(baustelle wechseln|wechseln|baustellenwechsel|andere baustelle)$/.test(t)) return "switch_site";
    if (/^(ja|jup|passt|ok|okay|genau|👍)$/.test(t)) return "yes";
    if (/^(ändern|aendern|korrigieren|korrektur)$/.test(t)) return "change";
    if (/^(abbrechen|stopp|stop)$/.test(t)) return "cancel";
    if (/^(nein|passt nicht|falsch|👎)$/.test(t)) return "no";
    if (/^(status|wo bin ich|was steht an|heute)$/.test(t)) return "status";
    if (/^(erledigt|aufgabe erledigt)$/.test(t)) return "task_done";
    return "message";
  }

  function assignmentKey(a) {
    return `${a.date}|${a.employeeId}|${a.from || ""}|${a.jobId || ""}`;
  }

  function sortedAssignments(items) {
    return [...items].sort((a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      String(a.from || "").localeCompare(String(b.from || ""))
    );
  }

  function assignmentsFor(items, employeeId, date) {
    return sortedAssignments(items.filter(a =>
      String(a.employeeId) === String(employeeId) &&
      String(a.date) === String(date)
    ));
  }

  function activeAssignment(dayAssignments, state) {
    if (state?.activeAssignmentKey) {
      const found = dayAssignments.find(a => assignmentKey(a) === state.activeAssignmentKey);
      if (found) return found;
    }
    return dayAssignments[0] || null;
  }

  function nextAssignment(dayAssignments, current) {
    if (!current) return dayAssignments[0] || null;
    const idx = dayAssignments.findIndex(a => assignmentKey(a) === assignmentKey(current));
    return idx >= 0 ? dayAssignments[idx + 1] || null : null;
  }

  function assignmentLabel(a) {
    if (!a) return "keine Baustelle";
    return `${a.jobName || ("#" + a.jobId)}${a.city ? ", " + a.city : ""}`;
  }

  function stateLabel(state) {
    const map = {
      idle: "noch nicht gestartet",
      working: "arbeitet",
      pause: "Pause",
      lunch: "Mittagspause",
      finished_site: "Baustelle fertig",
      finished_day: "Feierabend",
      closing_day: "Tagesabschluss",
    };
    return map[state?.mode] || map.idle;
  }

  async function getBootstrap() {
    const [assignments, states, tasks, timeEvents] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, []),
      readJson(TIME_EVENTS, []),
    ]);
    return { assignments, states, tasks, timeEvents };
  }

  function normalizeSiteSearch(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function listBuildingSites() {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true }).catch(() => []);
    const sites = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;

      const siteId = entry.name;
      const meta = await readJson(path.join(dataDir, siteId, ".meta.json"), {});
      sites.push({
        siteId,
        name: String(meta?.name || siteId.replace(/_/g, " ")),
        city: String(meta?.city || meta?.ort || ""),
        address: String(meta?.address || meta?.adresse || ""),
      });
    }

    return sites;
  }

  async function findBuildingSiteMatches(query) {
    const wanted = normalizeSiteSearch(query);
    if (!wanted) return [];

    const sites = await listBuildingSites();
    const valuesFor = (site) => [site.siteId, site.name, site.city]
      .map(normalizeSiteSearch)
      .filter(Boolean);

    const exact = sites.filter(site => valuesFor(site).some(value => value === wanted));
    if (exact.length) return exact;

    const prefix = sites.filter(site => valuesFor(site).some(value => value.startsWith(wanted)));
    if (prefix.length) return prefix;

    return sites.filter(site => valuesFor(site).some(value => value.includes(wanted)));
  }


  function formatDuration(totalMinutes) {
    const value = Math.max(0, Number(totalMinutes || 0));
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return `${hours}:${String(minutes).padStart(2, "0")} h`;
  }

  function blockLabel(type) {
    if (type === "work") return "Arbeit";
    if (type === "pause") return "Pause";
    if (type === "lunch") return "Mittag";
    return "";
  }

  async function buildDaySummary(employeeId, date) {
    const rows = await readJson(TIME_EVENTS, []);
    const events = rows
      .filter(row => String(row.employeeId) === String(employeeId) && String(row.date) === String(date))
      .map((row, index) => ({ ...row, _index: index, _minutes: minutesFromHM(row.at) }))
      .filter(row => row._minutes !== null)
      .sort((a, b) => a._minutes - b._minutes || String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a._index - b._index);

    const blocks = [];
    for (let i = 0; i < events.length - 1; i++) {
      const event = events[i];
      const next = events[i + 1];
      if (next._minutes < event._minutes) continue;

      let type = null;
      if (event.type === "start" || event.type === "weiter") type = "work";
      else if (event.type === "pause") type = "pause";
      else if (event.type === "mittag") type = "lunch";
      if (!type) continue;

      const block = {
        type,
        from: event.at,
        to: next.at,
        fromMinutes: event._minutes,
        toMinutes: next._minutes,
        jobId: event.jobId || null,
        jobName: event.jobName || "",
      };
      if (block.toMinutes < block.fromMinutes) continue;

      const previous = blocks.at(-1);
      if (previous && previous.type === block.type && previous.toMinutes === block.fromMinutes &&
          (block.type !== "work" || String(previous.jobId || previous.jobName) === String(block.jobId || block.jobName))) {
        previous.to = block.to;
        previous.toMinutes = block.toMinutes;
      } else {
        blocks.push(block);
      }
    }

    const workMinutes = blocks.filter(block => block.type === "work")
      .reduce((sum, block) => sum + block.toMinutes - block.fromMinutes, 0);
    const breakMinutes = blocks.filter(block => block.type === "pause" || block.type === "lunch")
      .reduce((sum, block) => sum + block.toMinutes - block.fromMinutes, 0);

    const lines = blocks.map(block => {
      const site = block.type === "work" ? ` · ${block.jobName || (block.jobId ? "#" + block.jobId : "Baustelle")}` : "";
      return `${block.from}–${block.to} ${blockLabel(block.type)}${site}`;
    });

    return {
      blocks,
      workMinutes,
      breakMinutes,
      text: [
        "Heute war:",
        "",
        ...(lines.length ? lines : ["Keine vollständigen Zeitblöcke gefunden."]),
        "",
        `Netto-Arbeitszeit: ${formatDuration(workMinutes)}`,
        `Pause und Mittag: ${formatDuration(breakMinutes)}`,
        "",
        "Passt das?",
      ].join("\n"),
    };
  }

  async function removeTimeEventById(eventId) {
    if (!eventId) return;
    const rows = await readJson(TIME_EVENTS, []);
    await writeJson(TIME_EVENTS, rows.filter(row => String(row.id || "") !== String(eventId)));
  }

  async function handleMessage({ employeeId, employeeName, text, date }) {
    const today = date || localDateISO();
    const [assignments, states, tasks] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, []),
    ]);

    const dayAssignments = assignmentsFor(assignments, employeeId, today);
    const previous = states[employeeId] || {
      employeeId,
      employeeName: employeeName || employeeId,
      mode: "idle",
      activeAssignmentKey: dayAssignments[0] ? assignmentKey(dayAssignments[0]) : null,
      pending: null,
      timeline: [],
    };
    const state = { ...previous, employeeName: employeeName || previous.employeeName || employeeId };
    const current = activeAssignment(dayAssignments, state);
    const intent = detectIntent(text);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const actualTime = localTimeHM(nowDate);

    const saveState = async () => {
      states[employeeId] = state;
      await writeJson(STATES, states);
    };
    const addTimeline = (type, detail, assignment = current) => {
      state.timeline = Array.isArray(state.timeline) ? state.timeline : [];
      state.timeline.push({
        at: now,
        time: actualTime,
        type,
        detail,
        assignmentKey: assignment ? assignmentKey(assignment) : null,
        jobId: assignment?.jobId || null,
        jobName: assignment?.jobName || "",
      });
      state.timeline = state.timeline.slice(-200);
    };

    // Pending questions have priority.
    if (state.pending?.type === "confirm_assignment") {
      if (intent === "yes") {
        state.pending = null;
        await saveState();
        return {
          reply: `Perfekt. Sag einfach „Start“, wenn ihr bei ${assignmentLabel(current)} beginnt.`,
          buttons: ["Start", "Navigation"],
          state,
        };
      }
      if (intent === "no") {
        state.pending = { type: "ask_actual_assignment", createdAt: now };
        await saveState();
        return {
          reply: "Okay. Wo wurdest du stattdessen eingeteilt?",
          buttons: [],
          state,
        };
      }
    }

    if (state.pending?.type === "ask_actual_assignment" && intent === "message") {
      const matches = await findBuildingSiteMatches(text);

      if (matches.length === 1) {
        const site = matches[0];
        const actualAssignment = {
          id: `actual_${Date.now()}_${String(employeeId).replace(/[^A-Za-z0-9_-]/g, "")}`,
          date: today,
          jobId: site.siteId,
          jobName: site.name,
          city: site.city,
          address: site.address,
          employeeId: String(employeeId),
          employeeName: state.employeeName,
          vehicle: "",
          from: actualTime,
          to: "",
          note: "Tatsächliche Einteilung über Kristine",
        };

        assignments.push(actualAssignment);
        await writeJson(ASSIGNMENTS, assignments);

        state.activeAssignmentKey = assignmentKey(actualAssignment);
        state.pending = null;
        addTimeline("assignment_deviation", `Baustelle ${assignmentLabel(actualAssignment)} übernommen`, actualAssignment);
        await saveState();
        await appendEvent({
          type: "assignment_deviation",
          employeeId,
          employeeName: state.employeeName,
          date: today,
          jobId: actualAssignment.jobId,
          detail: assignmentLabel(actualAssignment),
        });

        return {
          reply: `Perfekt. Baustelle ${assignmentLabel(actualAssignment)} übernommen. Sag einfach Start.`,
          buttons: ["Start", "Navigation"],
          needsOfficeReview: true,
          state,
        };
      }

      if (matches.length > 1) {
        const choices = matches.slice(0, 5).map(site => site.name || site.siteId);
        return {
          reply: `Ich habe mehrere passende Baustellen gefunden:\n- ${choices.join("\n- ")}\n\nBitte schreib den Namen etwas genauer.`,
          buttons: [],
          state,
        };
      }

      state.pending = null;
      addTimeline("assignment_deviation", String(text), null);
      await saveState();
      await appendEvent({
        type: "assignment_deviation",
        employeeId,
        employeeName: state.employeeName,
        date: today,
        detail: String(text),
      });
      return {
        reply: `Ich finde keine Baustelle zu „${String(text).trim()}“. Die abweichende Einteilung wurde zur Kontrolle vorgemerkt.`,
        buttons: [],
        needsOfficeReview: true,
        state,
      };
    }

    if (state.pending?.type === "review_day") {
      if (intent === "yes") {
        state.pending = { type: "review_material_question", createdAt: now };
        await saveState();
        return {
          reply: "Hast du heute Material verwendet?",
          buttons: ["Ja", "Nein"],
          state,
        };
      }
      if (intent === "change") {
        state.pending = {
          type: "review_change_note",
          createdAt: now,
          previousMode: state.pending.previousMode,
          finishEventId: state.pending.finishEventId,
        };
        await saveState();
        return {
          reply: "Welche Zeit oder Baustelle soll geändert werden? Schreib mir die Korrektur bitte kurz.",
          buttons: ["Abbrechen"],
          state,
        };
      }
      if (intent === "cancel") {
        await removeTimeEventById(state.pending.finishEventId);
        state.mode = state.pending.previousMode || "working";
        state.pending = null;
        addTimeline("day_review_cancelled", "Tagesabschluss abgebrochen", current);
        await saveState();
        return {
          reply: "Tagesabschluss abgebrochen. Deine Arbeitszeit läuft weiter.",
          buttons: ["Pause", "Mittag", "Baustelle wechseln", "Fertig"],
          state,
        };
      }
      return {
        reply: "Bitte wähle Passt, Ändern oder Abbrechen.",
        buttons: ["Passt", "Ändern", "Abbrechen"],
        state,
      };
    }

    if (state.pending?.type === "review_change_note") {
      if (intent === "cancel") {
        state.pending = { ...state.pending, type: "review_day" };
        await saveState();
        const summary = await buildDaySummary(employeeId, today);
        return { reply: summary.text, buttons: ["Passt", "Ändern", "Abbrechen"], state };
      }
      await appendEvent({
        type: "day_review_change",
        employeeId,
        employeeName: state.employeeName,
        date: today,
        detail: String(text),
        needsOfficeReview: true,
      });
      state.pending = { type: "review_material_question", createdAt: now, changeRequested: true };
      await saveState();
      return {
        reply: "Danke, die Korrektur ist für Chef/Büro vorgemerkt. Hast du heute Material verwendet?",
        buttons: ["Ja", "Nein"],
        needsOfficeReview: true,
        state,
      };
    }

    if (state.pending?.type === "review_material_question") {
      if (!['yes', 'no'].includes(intent)) {
        return { reply: "Hast du heute Material verwendet?", buttons: ["Ja", "Nein"], state };
      }
      if (intent === "yes") {
        state.pending = { type: "collect_material", createdAt: now, itemCount: 0, hasMaterials: true };
        await saveState();
        return {
          reply: "Bitte Material jetzt eingeben. Du kannst schreiben, eine Sprachnachricht oder ein Foto senden. Schreib „fertig“, wenn alles erfasst ist.",
          buttons: [],
          state,
        };
      }
      state.pending = { type: "review_photos_question", createdAt: now, hasMaterials: false };
      await saveState();
      return { reply: "Hast du heute Baustellenfotos gemacht?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "collect_material") {
      if (intent === "finish") {
        state.pending = {
          type: "review_photos_question",
          createdAt: now,
          hasMaterials: true,
          materialCount: Number(state.pending.itemCount || 0),
        };
        await saveState();
        return { reply: "Material gespeichert. Hast du heute Baustellenfotos gemacht?", buttons: ["Ja", "Nein"], state };
      }
      await appendReviewEntry({
        employeeId, employeeName: state.employeeName, date: today,
        jobId: current?.jobId || null, jobName: current?.jobName || "",
        category: "material", source: "text", content: String(text).trim(),
      });
      state.pending.itemCount = Number(state.pending.itemCount || 0) + 1;
      await saveState();
      return {
        reply: "Material aufgenommen. Sende bei Bedarf noch etwas oder schreibe „fertig“.",
        buttons: ["Fertig"],
        state,
      };
    }

    if (state.pending?.type === "review_photos_question") {
      if (!['yes', 'no'].includes(intent)) {
        return { reply: "Hast du heute Baustellenfotos gemacht?", buttons: ["Ja", "Nein"], state };
      }
      if (intent === "yes") {
        state.pending = {
          type: "collect_photos", createdAt: now, photoCount: 0,
          hasMaterials: Boolean(state.pending.hasMaterials),
        };
        await saveState();
        return {
          reply: "Bitte die Baustellenfotos jetzt hochladen. Schreib „fertig“, wenn alle Fotos gesendet sind.",
          buttons: [],
          state,
        };
      }
      state.pending = {
        type: "review_regie_question", createdAt: now,
        hasMaterials: Boolean(state.pending.hasMaterials), hasPhotos: false,
      };
      await saveState();
      return { reply: "Gab es heute Regiearbeiten?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "collect_photos") {
      if (intent === "finish") {
        state.pending = {
          type: "review_regie_question", createdAt: now,
          hasMaterials: Boolean(state.pending.hasMaterials),
          hasPhotos: Number(state.pending.photoCount || 0) > 0,
          photoCount: Number(state.pending.photoCount || 0),
        };
        await saveState();
        return { reply: "Fotos gespeichert. Gab es heute Regiearbeiten?", buttons: ["Ja", "Nein"], state };
      }
      return {
        reply: "Bitte ein Foto senden oder „fertig“ schreiben, wenn alle Fotos hochgeladen sind.",
        buttons: ["Fertig"],
        state,
      };
    }

    if (state.pending?.type === "review_regie_question") {
      if (!['yes', 'no'].includes(intent)) {
        return { reply: "Gab es heute Regiearbeiten?", buttons: ["Ja", "Nein"], state };
      }
      if (intent === "yes") {
        state.pending = {
          type: "collect_regie", createdAt: now,
          hasMaterials: Boolean(state.pending.hasMaterials),
          hasPhotos: Boolean(state.pending.hasPhotos),
        };
        await saveState();
        return { reply: "Bitte die Regiearbeit kurz beschreiben. Du kannst schreiben oder eine Sprachnachricht senden.", buttons: [], state };
      }
      return completeDayReview({
        employeeId, employeeName: state.employeeName, date: today, state, states, current, actualTime, now,
        hasMaterials: Boolean(state.pending.hasMaterials), hasPhotos: Boolean(state.pending.hasPhotos), hasRegie: false,
      });
    }

    if (state.pending?.type === "collect_regie") {
      await appendReviewEntry({
        employeeId, employeeName: state.employeeName, date: today,
        jobId: current?.jobId || null, jobName: current?.jobName || "",
        category: "regie", source: "text", content: String(text).trim(), needsOfficeReview: true,
      });
      return completeDayReview({
        employeeId, employeeName: state.employeeName, date: today, state, states, current, actualTime, now,
        hasMaterials: Boolean(state.pending.hasMaterials), hasPhotos: Boolean(state.pending.hasPhotos), hasRegie: true,
      });
    }

    if (state.pending?.type === "finish_choice") {
      if (intent === "yes" && state.pending.nextAssignmentKey) {
        const next = dayAssignments.find(a => assignmentKey(a) === state.pending.nextAssignmentKey);
        if (next) {
          state.activeAssignmentKey = assignmentKey(next);
          state.mode = "idle";
          state.pending = null;
          addTimeline("site_switch", `Wechsel zu ${assignmentLabel(next)}`, next);
          await saveState();
          await appendEvent({
            type: "site_switch",
            employeeId,
            employeeName: state.employeeName,
            date: today,
            jobId: next.jobId,
            detail: assignmentLabel(next),
          });
          return {
            reply: `Passt. Nächste Baustelle: ${assignmentLabel(next)}${next.from ? ` ab ${next.from}` : ""}. Sag „Start“, wenn du dort beginnst.`,
            buttons: ["Navigation", "Start"],
            state,
          };
        }
      }
      if (intent === "finish" || /feierabend/.test(normalizeText(text)) || intent === "no") {
        state.mode = "finished_day";
        state.pending = null;
        addTimeline("day_finished", "Feierabend", current);
        await saveState();
        await appendTimeEvent({
          employeeId,
          employeeName: state.employeeName,
          date: today,
          type: "ende",
          at: actualTime,
          jobId: current?.jobId || null,
          jobName: current?.jobName || "",
          createdAt: now,
        });
        await appendEvent({
          type: "day_finished",
          employeeId,
          employeeName: state.employeeName,
          date: today,
          jobId: current?.jobId || null,
          time: actualTime,
        });
        return {
          reply: "Feierabend ist gespeichert. Danke und schönen Abend! 👋",
          buttons: [],
          state,
        };
      }
    }

    if (intent === "status") {
      if (!dayAssignments.length) {
        state.pending = { type: "ask_actual_assignment", createdAt: now };
        await saveState();
        return {
          reply: "Für heute finde ich noch keine Einteilung. Wo wurdest du eingeteilt?",
          buttons: [],
          state,
        };
      }
      return {
        reply: `Heute: ${dayAssignments.map(a => `${a.from || "ganztägig"}${a.to ? "–" + a.to : ""} ${assignmentLabel(a)}`).join(" · ")}. Aktueller Status: ${stateLabel(state)}.`,
        buttons: state.mode === "working" ? ["Pause", "Fertig"] : ["Start"],
        state,
      };
    }

    if (intent === "switch_site") {
      if (state.mode !== "working") {
        return {
          reply: "Ein Baustellenwechsel ist nur während laufender Arbeitszeit möglich.",
          buttons: ["Start"],
          state,
        };
      }

      await appendTimeEvent({
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: "wechsel",
        at: actualTime,
        jobId: current?.jobId || null,
        jobName: current?.jobName || "",
        createdAt: now,
      });
      addTimeline("site_switch_requested", `Baustellenwechsel von ${assignmentLabel(current)}`, current);
      state.mode = "idle";
      state.pending = { type: "ask_actual_assignment", createdAt: now };
      await saveState();
      return {
        reply: "Auf welche Baustelle wechselst du?",
        buttons: [],
        state,
      };
    }

    if (intent === "start") {
      if (!current) {
        state.pending = { type: "ask_actual_assignment", createdAt: now };
        await saveState();
        return {
          reply: "Ich finde für heute noch keine Baustelle. Wo wurdest du eingeteilt?",
          buttons: [],
          state,
        };
      }
      const bookedTime = clampOfficialStart(actualTime);
      state.mode = "working";
      state.pending = null;
      state.activeAssignmentKey = assignmentKey(current);
      state.lastStartActual = actualTime;
      state.lastStartBooked = bookedTime;
      addTimeline("work_started", `Arbeitsbeginn ${bookedTime}${bookedTime !== actualTime ? ` (gestempelt ${actualTime})` : ""}`, current);
      await saveState();
      await appendTimeEvent({
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: "start",
        at: bookedTime,
        actualAt: actualTime,
        adjusted: bookedTime !== actualTime,
        jobId: current.jobId,
        jobName: current.jobName || "",
        createdAt: now,
      });
      await appendEvent({
        type: "work_started",
        employeeId,
        employeeName: state.employeeName,
        date: today,
        jobId: current.jobId,
        actualTime,
        bookedTime,
        adjusted: bookedTime !== actualTime,
      });
      return {
        reply: bookedTime !== actualTime
          ? `Arbeitsbeginn bei ${assignmentLabel(current)} ist gespeichert. Gemäß Betriebsregel wurde ${actualTime} auf 07:00 Uhr gesetzt. Gute Arbeit!`
          : `Arbeitsbeginn bei ${assignmentLabel(current)} ist um ${bookedTime} gespeichert. Gute Arbeit!`,
        buttons: ["Pause", "Mittag", "Baustelle wechseln", "Fertig"],
        state,
      };
    }

    if (intent === "pause" || intent === "lunch") {
      if (state.mode !== "working") {
        return {
          reply: "Deine Arbeitszeit läuft gerade nicht. Soll ich zuerst den Arbeitsbeginn speichern?",
          buttons: ["Start"],
          state,
        };
      }
      state.mode = intent === "lunch" ? "lunch" : "pause";
      addTimeline(intent === "lunch" ? "lunch_started" : "pause_started", intent === "lunch" ? "Mittagspause" : "Pause", current);
      await saveState();
      await appendTimeEvent({
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: intent === "lunch" ? "mittag" : "pause",
        at: actualTime,
        jobId: current?.jobId || null,
        jobName: current?.jobName || "",
        createdAt: now,
      });
      return {
        reply: intent === "lunch" ? "Mittagspause begonnen. Mahlzeit! 🍽️" : "Pause begonnen. ☕",
        buttons: ["Weiter"],
        state,
      };
    }

    if (intent === "resume") {
      if (!["pause", "lunch"].includes(state.mode)) {
        return {
          reply: "Bei mir ist gerade keine Pause offen. Deine Arbeitszeit läuft weiter.",
          buttons: ["Pause", "Fertig"],
          state,
        };
      }
      state.mode = "working";
      addTimeline("work_resumed", "Arbeit fortgesetzt", current);
      await saveState();
      await appendTimeEvent({
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: "weiter",
        at: actualTime,
        jobId: current?.jobId || null,
        jobName: current?.jobName || "",
        createdAt: now,
      });
      return {
        reply: "Weiter geht’s. Arbeitszeit läuft wieder.",
        buttons: ["Pause", "Mittag", "Baustelle wechseln", "Fertig"],
        state,
      };
    }

    if (intent === "finish") {
      if (!current || !["working", "pause", "lunch"].includes(state.mode)) {
        return {
          reply: "Ich finde gerade keine laufende Arbeitszeit für den Tagesabschluss.",
          buttons: current ? ["Start"] : [],
          state,
        };
      }

      const previousMode = state.mode;
      const finishEventId = `finish_${Date.now()}_${String(employeeId).replace(/[^A-Za-z0-9_-]/g, "")}`;
      await appendTimeEvent({
        id: finishEventId,
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: "ende",
        at: actualTime,
        jobId: current.jobId,
        jobName: current.jobName || "",
        createdAt: now,
      });

      state.mode = "closing_day";
      state.pending = {
        type: "review_day",
        previousMode,
        finishEventId,
        createdAt: now,
      };
      addTimeline("day_review_started", "Tagesabschluss gestartet", current);
      await saveState();

      const summary = await buildDaySummary(employeeId, today);
      return {
        reply: summary.text,
        buttons: ["Passt", "Ändern", "Abbrechen"],
        state,
      };
    }

    if (intent === "task_done") {
      const open = tasks.find(t => String(t.assigneeId) === String(employeeId) && t.status !== "done");
      if (!open) {
        return { reply: "Ich finde gerade keine offene Aufgabe für dich.", buttons: [], state };
      }
      open.status = "done";
      open.completedAt = now;
      await writeJson(TASKS, tasks);
      await appendEvent({
        type: "task_completed",
        employeeId,
        employeeName: state.employeeName,
        taskId: open.id,
        detail: open.title,
      });
      return {
        reply: `Danke. „${open.title}“ ist als erledigt markiert.`,
        buttons: [],
        state,
      };
    }

    // If this is the first contact of the day, confirm plan.
    if (state.mode === "idle" && current && !state.pending) {
      state.pending = { type: "confirm_assignment", createdAt: now };
      await saveState();
      return {
        reply: `Hallo ${state.employeeName}. Du bist heute bei ${assignmentLabel(current)}${current.from ? ` von ${current.from}${current.to ? " bis " + current.to : ""}` : ""} eingeteilt. Passt das?`,
        buttons: ["Ja", "Nein", "Navigation"],
        state,
      };
    }

    addTimeline("message", String(text), current);
    await saveState();
    await appendEvent({
      type: "employee_message",
      employeeId,
      employeeName: state.employeeName,
      date: today,
      jobId: current?.jobId || null,
      detail: String(text),
    });
    return {
      reply: "Danke, ich habe deine Nachricht gespeichert. Für den Test verstehe ich bereits: Start, Pause, Mittag, Weiter, Fertig, Status und Erledigt.",
      buttons: state.mode === "working" ? ["Pause", "Fertig"] : ["Status", "Start"],
      state,
    };
  }

  async function getPendingState(employeeId) {
    const states = await readJson(STATES, {});
    return states[String(employeeId)]?.pending || null;
  }

  async function handleMedia({ employeeId, employeeName, date, mediaType, file, transcript = "" }) {
    const today = date || localDateISO();
    const [assignments, states] = await Promise.all([readJson(ASSIGNMENTS, []), readJson(STATES, {})]);
    const state = states[String(employeeId)];
    if (!state?.pending) return { handled: false };
    const dayAssignments = assignmentsFor(assignments, employeeId, today);
    const current = activeAssignment(dayAssignments, state);
    const pending = state.pending;
    const now = new Date().toISOString();
    const actualTime = localTimeHM(new Date());

    if (pending.type === "collect_material" && ["image", "audio"].includes(mediaType)) {
      await appendReviewEntry({
        employeeId, employeeName: employeeName || state.employeeName, date: today,
        jobId: current?.jobId || null, jobName: current?.jobName || "",
        category: "material", source: mediaType, file: file || "", transcript: transcript || "",
      });
      pending.itemCount = Number(pending.itemCount || 0) + 1;
      states[String(employeeId)] = state;
      await writeJson(STATES, states);
      return { handled: true, reply: "Material aufgenommen. Sende bei Bedarf noch etwas oder schreibe „fertig“.", buttons: ["Fertig"] };
    }

    if (pending.type === "collect_photos" && mediaType === "image") {
      await appendReviewEntry({
        employeeId, employeeName: employeeName || state.employeeName, date: today,
        jobId: current?.jobId || null, jobName: current?.jobName || "",
        category: "photo", source: "image", file: file || "",
      });
      pending.photoCount = Number(pending.photoCount || 0) + 1;
      states[String(employeeId)] = state;
      await writeJson(STATES, states);
      return { handled: true, reply: `Foto ${pending.photoCount} gespeichert. Sende weitere Fotos oder schreibe „fertig“.`, buttons: ["Fertig"] };
    }

    if (pending.type === "collect_regie" && mediaType === "audio") {
      await appendReviewEntry({
        employeeId, employeeName: employeeName || state.employeeName, date: today,
        jobId: current?.jobId || null, jobName: current?.jobName || "",
        category: "regie", source: "audio", file: file || "", transcript: transcript || "", needsOfficeReview: true,
      });
      const result = await completeDayReview({
        employeeId, employeeName: employeeName || state.employeeName, date: today, state, states, current, actualTime, now,
        hasMaterials: Boolean(pending.hasMaterials), hasPhotos: Boolean(pending.hasPhotos), hasRegie: true,
      });
      return { handled: true, reply: result.reply, buttons: result.buttons };
    }

    return { handled: false };
  }

  app.get("/kristine", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.sendFile(path.join(publicDir, "kristine.html"));
  });

  app.get("/kristine/api/bootstrap", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ ok: true, ...(await getBootstrap()), today: localDateISO() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.put("/kristine/api/assignments", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
      const clean = rows.map((a, index) => ({
        id: String(a.id || `a_${Date.now()}_${index}`),
        date: String(a.date || "").slice(0, 10),
        jobId: String(a.jobId || "").slice(0, 80),
        jobName: String(a.jobName || "").trim().slice(0, 140),
        city: String(a.city || "").trim().slice(0, 100),
        address: String(a.address || "").trim().slice(0, 300),
        employeeId: String(a.employeeId || "").slice(0, 100),
        employeeName: String(a.employeeName || "").trim().slice(0, 140),
        vehicle: String(a.vehicle || "").trim().slice(0, 100),
        from: String(a.from || "").slice(0, 5),
        to: String(a.to || "").slice(0, 5),
        note: String(a.note || "").trim().slice(0, 500),
        cardType: ["site", "urlaub", "arzt", "krank", "aufraeumen", "werkstatt"].includes(String(a.cardType || "site")) ? String(a.cardType || "site") : "site",
        hours: Math.max(0, Math.min(24, Number(a.hours || 0))),
      })).filter(a => a.date && a.employeeId && (a.jobId || a.jobName));
      await writeJson(ASSIGNMENTS, clean);
      await appendEvent({ type: "planning_saved", detail: `${clean.length} Einteilungen gespeichert`, source: "office" });
      res.json({ ok: true, assignments: clean });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/kristine/api/message", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.body?.employeeId || "").trim();
      const employeeName = String(req.body?.employeeName || employeeId).trim();
      const text = String(req.body?.text || "").trim();
      const date = String(req.body?.date || localDateISO()).slice(0, 10);
      if (!employeeId || !text) return res.status(400).json({ ok: false, error: "employeeId und text erforderlich" });
      res.json({ ok: true, ...(await handleMessage({ employeeId, employeeName, text, date })) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/kristine/api/reset-state/:employeeId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const states = await readJson(STATES, {});
      delete states[String(req.params.employeeId)];
      await writeJson(STATES, states);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.put("/kristine/api/tasks", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
      const clean = tasks.map((t, index) => ({
        id: String(t.id || `t_${Date.now()}_${index}`),
        title: String(t.title || "").trim().slice(0, 180),
        assigneeId: String(t.assigneeId || "").slice(0, 100),
        assigneeName: String(t.assigneeName || "").trim().slice(0, 140),
        jobId: String(t.jobId || "").slice(0, 80),
        jobName: String(t.jobName || "").trim().slice(0, 140),
        dueDate: String(t.dueDate || "").slice(0, 10),
        reminder: String(t.reminder || "").trim().slice(0, 300),
        status: t.status === "done" ? "done" : "open",
        createdAt: t.createdAt || new Date().toISOString(),
        completedAt: t.completedAt || null,
      })).filter(t => t.title);
      await writeJson(TASKS, clean);
      res.json({ ok: true, tasks: clean });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ===== HOLIDAYS =====
  app.get("/kristine/api/holidays", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const holidaysFile = path.join(dataDir, "_kristine", "holidays.json");
      let holidays = await readJson(holidaysFile, []);
      
      // Auto-Load: Wenn leer, lade österreichische Feiertage für 2026
      if (holidays.length === 0) {
        holidays = getAustrianHolidays(2026);
        await writeJson(holidaysFile, holidays);
      }
      
      res.json({ ok: true, holidays });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post("/kristine/api/holidays/reload-austrian", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const holidaysFile = path.join(dataDir, "_kristine", "holidays.json");
      const existing = await readJson(holidaysFile, []);
      const year = req.body?.year || 2026;
      const austrian = getAustrianHolidays(year);
      
      // Merge: Behalte nicht-österreichische Feiertage
      const manual = existing.filter(h => !austrian.some(a => a.date === h.date));
      const merged = [...austrian, ...manual].sort((a, b) => a.date.localeCompare(b.date));
      
      await writeJson(holidaysFile, merged);
      res.json({ ok: true, holidays: merged });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.put("/kristine/api/holidays", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const holidays = Array.isArray(req.body?.holidays) ? req.body.holidays : [];
      const clean = holidays.map(h => ({
        date: String(h.date || "").slice(0, 10),
        name: String(h.name || "").trim().slice(0, 140)
      })).filter(h => h.date && h.name).sort((a, b) => a.date.localeCompare(b.date));
      await writeJson(path.join(dataDir, "_kristine", "holidays.json"), clean);
      res.json({ ok: true, holidays: clean });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ===== COMPANY VACATIONS =====
  app.get("/kristine/api/company-vacations", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const vacations = await readJson(path.join(dataDir, "_kristine", "company-vacations.json"), []);
      res.json({ ok: true, vacations });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.put("/kristine/api/company-vacations", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const vacations = Array.isArray(req.body?.vacations) ? req.body.vacations : [];
      const clean = vacations.map(v => ({
        from: String(v.from || "").slice(0, 10),
        to: String(v.to || "").slice(0, 10),
        reason: String(v.reason || "").trim().slice(0, 300)
      })).filter(v => v.from && v.to).sort((a, b) => a.from.localeCompare(b.from));
      await writeJson(path.join(dataDir, "_kristine", "company-vacations.json"), clean);
      res.json({ ok: true, vacations: clean });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ===== SCHEDULE MODELS =====
  app.get("/kristine/api/schedule-models", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const modelsFile = path.join(dataDir, "_kristine", "schedule-models.json");
      let models = await readJson(modelsFile, []);
      
      // Auto-Load: Wenn leer, lade Standard-Modelle (Sommer/Winter)
      if (models.length === 0) {
        models = getDefaultScheduleModels();
        await writeJson(modelsFile, models);
      }
      
      res.json({ ok: true, models });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.put("/kristine/api/schedule-models", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const models = Array.isArray(req.body?.models) ? req.body.models : [];
      const clean = models.map(m => ({
        id: String(m.id || Math.random().toString(36).slice(2)),
        name: String(m.name || "").trim().slice(0, 140),
        days: Array.isArray(m.days) ? m.days.map(d => ({
          dayName: String(d.dayName || "").slice(0, 50),
          isWorkDay: Boolean(d.isWorkDay),
          from: String(d.from || "").slice(0, 5),
          to: String(d.to || "").slice(0, 5),
          pauseMinutes: Number(d.pauseMinutes) || 0,
          shouldHours: Number(d.shouldHours) || 0
        })) : []
      })).filter(m => m.name && m.days.length > 0);
      await writeJson(path.join(dataDir, "_kristine", "schedule-models.json"), clean);
      res.json({ ok: true, models: clean });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });


  // Derselbe Dialogkern wird vom Browser-Simulator und vom echten WhatsApp-Webhook verwendet.
  return { handleMessage, handleMedia, getPendingState, localDateISO };
}

module.exports = { registerKristine };
