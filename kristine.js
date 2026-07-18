
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const cron = require("node-cron");

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

function registerKristine(app, { dataDir, requireAdmin, publicDir, sendWhatsApp, chefPhoneNumber, phoneNumberId }) {
  const ROOT = path.join(dataDir, "_kristine");
  const ASSIGNMENTS = path.join(ROOT, "assignments.json");
  const STATES = path.join(ROOT, "states.json");
  const TASKS = path.join(ROOT, "tasks.json");
  const EVENTS = path.join(ROOT, "events.jsonl");
  const TIME_EVENTS = path.join(ROOT, "time-events.json");

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
    const tolerance = minutesFromHM("07:05");  // Toleranzfenster bis 7:05 Uhr
    return actual !== null && actual < tolerance ? "07:00" : actualTime;
  }

  async function appendTimeEvent(event) {
    const rows = await readJson(TIME_EVENTS, []);
    rows.push(event);
    // Genug Historie für Büroprüfung behalten, Datei aber begrenzen.
    await writeJson(TIME_EVENTS, rows.slice(-20000));
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
    if (/^(ja|jup|passt|ok|okay|genau|👍)$/.test(t)) return "yes";
    if (/^(nein|passt nicht|falsch|👎)$/.test(t)) return "no";
    if (/^(abbrechen|cancel|nope)$/.test(t)) return "cancel";
    if (/^(aendern|ändern|korrigieren|anders)$/.test(t)) return "change";
    if (/^(status|wo bin ich|was steht an|heute)$/.test(t)) return "status";
    if (/^(erledigt|aufgabe erledigt)$/.test(t)) return "task_done";
    if (/(falsche baustelle|falsche stelle|baustelle falsch|hier stimmt was nicht)/.test(t)) return "falsche_baustelle";
    return "message";
  }

  // ===== STATE MACHINE KONSTANTEN =====
  
  const STATE_MODES = {
    UNANMELDBAR: "unanmeldbar",     // Nicht angemeldet
    ARBEITET: "arbeitet",           // Arbeitet
    PAUSE: "pause",                 // In Pause
    MITTAG: "mittag",               // In Mittagspause
    WECHSEL: "wechsel",             // Baustellenwechsel
    FEIERABEND: "feierabend"        // Feierabend
  };

  // Erlaubte Übergänge: welche Intents von welchem State aus möglich sind
  const TRANSITIONS = {
    [STATE_MODES.UNANMELDBAR]: ["start", "status", "message"],
    [STATE_MODES.ARBEITET]: ["pause", "lunch", "finish", "status", "message", "task_done"],
    [STATE_MODES.PAUSE]: ["resume", "lunch", "status", "message"],
    [STATE_MODES.MITTAG]: ["resume", "status", "message"],
    [STATE_MODES.WECHSEL]: ["finish", "status", "message"],
    [STATE_MODES.FEIERABEND]: ["start", "status", "message"]
  };

  // Validierung: Ist ein Intent im aktuellen Zustand erlaubt?
  function isValidTransition(mode, intent) {
    const allowedIntents = TRANSITIONS[mode] || [];
    return allowedIntents.includes(intent);
  }

  // Hinweismeldung für ungültige Transitionen
  function rejectInvalidIntent(mode, intent, state, current) {
    // "start" wenn bereits arbeitet
    if (mode === STATE_MODES.ARBEITET && intent === "start") {
      return {
        reply: `Du arbeitest bereits seit ${state.lastStartActual || "heute"} auf ${current?.jobName || "einer Baustelle"}.`,
        buttons: ["Pause", "Mittag", "Fertig"],
        state
      };
    }

    if (mode === STATE_MODES.UNANMELDBAR) {
      if (intent === "pause") {
        return {
          reply: "Du hast noch nicht begonnen. Sag 'Start', um anzufangen.",
          buttons: ["Start"],
          state
        };
      }
      if (intent === "lunch") {
        return {
          reply: "Du hast noch nicht begonnen. Sag 'Start', um anzufangen.",
          buttons: ["Start"],
          state
        };
      }
      if (intent === "finish") {
        return {
          reply: "Du hast heute noch nicht gearbeitet. Schönen Feierabend! 👋",
          buttons: [],
          state
        };
      }
      if (intent === "resume") {
        return {
          reply: "Du bist nicht in Pause. Sag 'Start', um anzufangen.",
          buttons: ["Start"],
          state
        };
      }
    }

    if (mode === STATE_MODES.PAUSE && intent === "pause") {
      return {
        reply: "Du bist bereits in Pause. Sag 'Weiter', wenn es weitergeht.",
        buttons: ["Weiter", "Mittag"],
        state
      };
    }

    if (mode === STATE_MODES.MITTAG && intent === "lunch") {
      return {
        reply: "Du bist bereits in der Mittagspause. Sag 'Weiter', wenn es weitergeht.",
        buttons: ["Weiter"],
        state
      };
    }

    if (mode === STATE_MODES.FEIERABEND) {
      if (["pause", "lunch", "finish"].includes(intent)) {
        return {
          reply: "Der Tag ist bereits beendet. Morgen geht's weiter!",
          buttons: ["Start"],
          state
        };
      }
      if (intent === "resume") {
        return {
          reply: "Der Tag ist bereits beendet. Morgen geht's weiter!",
          buttons: ["Start"],
          state
        };
      }
    }

    return null; // Transition ist erlaubt
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

  // ===== STATE DETERMINATION FROM TIME-EVENTS =====
  // Bestimmt den aktuellen Zustand aus heutigen Time-Events des Mitarbeiters
  async function getCurrentStateFromTimeEvents(empId, date) {
    const timeEventsPath = path.join(dataDir, "_kristine", "time-events.jsonl");
    let events = [];
    try {
      const content = await fs.promises.readFile(timeEventsPath, "utf8");
      events = content
        .split("\n")
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(e => e && String(e.employeeId) === String(empId) && e.date === date && e.at && /^\d{2}:\d{2}$/.test(e.at))
        .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
    } catch {}

    if (events.length === 0) {
      return { state: "idle", lastEvent: null, lastTime: null };
    }

    const lastEvent = events[events.length - 1];
    const eventType = lastEvent.type;

    // Bestimme aktuellen Zustand anhand des letzten Events
    if (["start", "weiter"].includes(eventType)) {
      return { state: "working", lastEvent, lastTime: lastEvent.at };
    }
    if (eventType === "pause") {
      return { state: "break", lastEvent, lastTime: lastEvent.at };
    }
    if (eventType === "mittag") {
      return { state: "lunch", lastEvent, lastTime: lastEvent.at };
    }
    if (eventType === "ende") {
      return { state: "idle", lastEvent, lastTime: lastEvent.at };
    }

    return { state: "idle", lastEvent, lastTime: null };
  }

  // Gibt erlaubte Übergänge für einen Zustand zurück
  function getAllowedTransitions(currentState) {
    const map = {
      idle: ["start"],
      working: ["pause", "lunch", "finish", "message", "falsche_baustelle"],
      break: ["weiter", "mittag", "finish", "message"],
      lunch: ["weiter", "finish", "message"],
      closing_day: ["yes", "no", "passt", "abbrechen", "aendern", "message"]
    };
    return map[currentState] || [];
  }

  // Liest time-events nur für heutiges Datum + employeeId, baut Blöcke
  async function buildDayBlocksFromTimeEvents(empId, date, currentTime) {
    const timeEventsPath = path.join(dataDir, "_kristine", "time-events.jsonl");
    let events = [];
    try {
      const content = await fs.promises.readFile(timeEventsPath, "utf8");
      events = content
        .split("\n")
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(e => e && String(e.employeeId) === String(empId) && e.date === date)
        .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
    } catch {}

    if (events.length === 0) {
      return { text: "Keine Einträge heute.", workMinutes: 0 };
    }

    // Validiere und filtere Zeitstempel
    const validEvents = events.filter(e => e.at && /^\d{2}:\d{2}$/.test(e.at));
    if (validEvents.length === 0) {
      return { text: "Keine gültigen Zeiteinträge heute.", workMinutes: 0 };
    }

    const blocks = [];
    let i = 0;

    while (i < validEvents.length) {
      const ev = validEvents[i];

      if (["start", "weiter"].includes(ev.type)) {
        const startTime = ev.at;
        const jobName = ev.jobName || ev.jobId || "unbekannt";
        
        // Suche das Ende dieses Blocks
        let endTime = null;
        let endIdx = i + 1;
        while (endIdx < validEvents.length) {
          const nextEv = validEvents[endIdx];
          if (["pause", "mittag", "ende"].includes(nextEv.type)) {
            endTime = nextEv.at;
            break;
          }
          if (nextEv.type === "start" && (nextEv.jobId !== ev.jobId || nextEv.jobName !== ev.jobName)) {
            endTime = nextEv.at;
            break;
          }
          endIdx++;
        }

        // Falls kein Ende gefunden, verwende currentTime
        if (!endTime) {
          endTime = currentTime;
        }

        blocks.push({
          type: "work",
          start: startTime,
          end: endTime,
          job: jobName
        });

        if (endTime === currentTime) {
          i = validEvents.length; // Beende Loop, da wir ein offenes Block geschlossen haben
        } else {
          i = endIdx;
        }
      } else if (ev.type === "pause") {
        const startTime = ev.at;
        let endTime = null;
        let endIdx = i + 1;
        while (endIdx < validEvents.length) {
          const nextEv = validEvents[endIdx];
          if (nextEv.type === "weiter") {
            endTime = nextEv.at;
            break;
          }
          if (["mittag", "ende"].includes(nextEv.type)) {
            endTime = nextEv.at;
            break;
          }
          endIdx++;
        }

        if (!endTime) {
          endTime = currentTime;
        }

        blocks.push({
          type: "pause",
          start: startTime,
          end: endTime,
          job: null
        });

        i = endIdx || i + 1;
      } else if (ev.type === "mittag") {
        const startTime = ev.at;
        let endTime = null;
        let endIdx = i + 1;
        while (endIdx < validEvents.length) {
          const nextEv = validEvents[endIdx];
          if (nextEv.type === "weiter") {
            endTime = nextEv.at;
            break;
          }
          if (["pause", "ende"].includes(nextEv.type)) {
            endTime = nextEv.at;
            break;
          }
          endIdx++;
        }

        if (!endTime) {
          endTime = currentTime;
        }

        blocks.push({
          type: "lunch",
          start: startTime,
          end: endTime,
          job: null
        });

        i = endIdx || i + 1;
      } else {
        i++;
      }
    }

    // Zusammenfassung: Direkt aufeinanderfolgende "work" Blöcke mit gleicher Baustelle zusammenfassen
    const mergedBlocks = [];
    let lastBlock = null;

    for (const block of blocks) {
      if (lastBlock && block.type === "work" && lastBlock.type === "work" && block.job === lastBlock.job && block.start === lastBlock.end) {
        // Mergen
        lastBlock.end = block.end;
      } else {
        if (lastBlock) mergedBlocks.push(lastBlock);
        lastBlock = block;
      }
    }
    if (lastBlock) mergedBlocks.push(lastBlock);

    // Berechne Netto-Arbeitszeit
    let workMinutes = 0;
    for (const block of mergedBlocks) {
      if (block.type === "work") {
        const [sh, sm] = block.start.split(":").map(Number);
        const [eh, em] = block.end.split(":").map(Number);
        const mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins > 0) workMinutes += mins;
      }
    }

    // Formatiere Output
    const lines = mergedBlocks.map(b => {
      const type = b.type === "work" ? `Arbeit · ${b.job}` : (b.type === "pause" ? "Pause" : "Mittag");
      return `${b.start}–${b.end} ${type}`;
    });

    const workHours = (workMinutes / 60).toFixed(2);
    const text = lines.join("\n") + `\n\nNetto-Arbeitszeit: ${workHours} h`;

    return { text, workMinutes };
  }

  function stateLabel(state) {
    const map = {
      idle: "noch nicht gestartet",
      working: "arbeitet",
      pause: "Pause",
      lunch: "Mittagspause",
      finished_site: "Baustelle fertig",
      finished_day: "Feierabend",
    };
    return map[state?.mode] || map.idle;
  }

  function getCurrentMode(legacyMode) {
    // Mapping für alte Mode-Werte zu neuen STATE_MODES
    const modeMap = {
      "idle": STATE_MODES.UNANMELDBAR,
      "working": STATE_MODES.ARBEITET,
      "pause": STATE_MODES.PAUSE,
      "lunch": STATE_MODES.MITTAG,
      "finished_site": STATE_MODES.WECHSEL,
      "finished_day": STATE_MODES.FEIERABEND
    };
    return modeMap[legacyMode] || STATE_MODES.UNANMELDBAR;
  }

  async function findBuildingSites() {
    try {
      const entries = await fsp.readdir(dataDir, { withFileTypes: true });
      const sites = [];
      
      for (const entry of entries) {
        // Ignoriere Systemordner
        if (entry.isDirectory() && !entry.name.startsWith("_")) {
          const siteId = entry.name;
          const metaPath = path.join(dataDir, siteId, ".meta.json");
          
          let siteName = siteId;
          let siteCity = "";
          
          // Versuche .meta.json zu lesen
          try {
            const meta = await readJson(metaPath, null);
            if (meta?.name) siteName = meta.name;
            if (meta?.city) siteCity = meta.city;
          } catch {
            // .meta.json existiert nicht, nutze nur siteId
          }
          
          sites.push({
            siteId,
            name: siteName,
            city: siteCity,
          });
        }
      }
      
      return sites;
    } catch {
      return [];
    }
  }

  async function findMatchingBuildingSites(input, buildingSites) {
    const normalized = normalizeText(input);
    
    // Sammle Matches nach Priorität und dedupliziere nach siteId
    const exactMatchesBySiteId = {};    // siteId -> site
    const prefixMatchesBySiteId = {};   // siteId -> site
    const containsMatchesBySiteId = {}; // siteId -> site
    
    for (const site of buildingSites) {
      const siteIdNorm = normalizeText(site.siteId);
      const nameNorm = normalizeText(site.name);
      const cityNorm = normalizeText(site.city);
      
      // Exakte Matches (höchste Priorität): siteId, name oder city
      if (siteIdNorm === normalized || nameNorm === normalized || cityNorm === normalized) {
        if (!exactMatchesBySiteId[site.siteId]) {
          exactMatchesBySiteId[site.siteId] = site;
        }
      }
      // Präfix-Matches (mittlere Priorität): siteId oder name beginnt mit Eingabe
      else if (siteIdNorm.startsWith(normalized) || nameNorm.startsWith(normalized)) {
        if (!prefixMatchesBySiteId[site.siteId]) {
          prefixMatchesBySiteId[site.siteId] = site;
        }
      }
      // Contains-Matches (niedrigste Priorität): siteId, name oder city enthält Eingabe
      else if (siteIdNorm.includes(normalized) || nameNorm.includes(normalized) || cityNorm.includes(normalized)) {
        if (!containsMatchesBySiteId[site.siteId]) {
          containsMatchesBySiteId[site.siteId] = site;
        }
      }
    }
    
    // Rückgabe mit Priorität: Nutze nur die beste Ebene
    if (Object.keys(exactMatchesBySiteId).length > 0) {
      return Object.values(exactMatchesBySiteId);
    }
    if (Object.keys(prefixMatchesBySiteId).length > 0) {
      return Object.values(prefixMatchesBySiteId);
    }
    return Object.values(containsMatchesBySiteId);
  }

  async function getBootstrap() {
    const [assignments, states, tasks] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, []),
    ]);
    return { assignments, states, tasks };
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
      state.pending = null;
      
      // Suche in allen Baustellen im System (nicht nur in Mitarbeiter-Einteilungen)
      const buildingSites = await findBuildingSites();
      const matches = await findMatchingBuildingSites(text, buildingSites);
      
      if (matches.length === 1) {
        // Genau eine Baustelle erkannt - neue Tageseinteilung erstellen und speichern
        const matched = matches[0];
        const newAssignment = {
          id: String(`a_${Date.now()}_${Math.random().toString(36).slice(2)}`),
          date: today,
          jobId: matched.siteId,
          jobName: matched.name || "",
          city: matched.city || "",
          address: "",
          employeeId: String(employeeId),
          employeeName: state.employeeName,
          vehicle: "",
          from: "",
          to: "",
          note: `Vom Mitarbeiter erkannt: ${text}`,
        };
        
        // Speichere neue Tageseinteilung
        assignments.push(newAssignment);
        await writeJson(ASSIGNMENTS, assignments);
        
        // Setze als aktive Einteilung
        state.activeAssignmentKey = assignmentKey(newAssignment);
        addTimeline("assignment_recognized", `Baustelle erkannt: ${assignmentLabel(newAssignment)}`, newAssignment);
        await saveState();
        await appendEvent({
          type: "assignment_recognized",
          employeeId,
          employeeName: state.employeeName,
          date: today,
          jobId: matched.siteId,
          detail: assignmentLabel(newAssignment),
        });
        return {
          reply: `Perfekt. Baustelle ${assignmentLabel(newAssignment)} übernommen. Sag einfach „Start", wenn du dort beginnst.`,
          buttons: ["Start", "Navigation"],
          needsOfficeReview: true,
          state,
        };
      }
      
      if (matches.length > 1) {
        // Mehrere Baustellen passen - Auswahlliste anbieten
        state.pending = { type: "ask_actual_assignment", createdAt: now };
        await saveState();
        return {
          reply: `Mehrere Baustellen passen. Welche meinst du: ${matches.map(m => `${m.name || m.siteId}${m.city ? " (" + m.city + ")" : ""}`).join(", ")}?`,
          buttons: matches.slice(0, 3).map(m => m.name || m.siteId),
          needsOfficeReview: true,
          state,
        };
      }
      
      // Nicht erkannt - als Abweichung melden
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
        reply: `Baustelle nicht erkannt. Ich habe „${String(text).trim()}" als Abweichung vorgemerkt.`,
        buttons: ["Start"],
        needsOfficeReview: true,
        state,
      };
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

    // ===== STATE MACHINE VALIDATION =====
    // Prüfe ob der Intent im aktuellen Zustand erlaubt ist
    const currentMode = getCurrentMode(state.mode);
    const validTransition = isValidTransition(currentMode, intent);
    if (!validTransition && !["message", "task_done"].includes(intent)) {
      const rejection = rejectInvalidIntent(currentMode, intent, state, current);
      if (rejection) {
        return rejection;
      }
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
      
      // NEUE LOGIK: Prüfe aktuellen Zustand aus TimeEvents
      const stateInfo = await getCurrentStateFromTimeEvents(employeeId, today);
      
      // Wenn bereits arbeitet - zurückweisen
      if (stateInfo.state === "working") {
        const lastTime = stateInfo.lastTime || "unbekannt";
        const jobName = current?.jobName || current?.jobId || "bekannte Baustelle";
        return {
          reply: `Du arbeitest bereits seit ${lastTime} auf ${jobName}.`,
          buttons: ["Pause", "Mittag", "Falsche Baustelle", "Fertig"],
          state,
        };
      }
      
      // Wenn in Pause oder Mittag - das ist "resume", nicht "start"
      if (stateInfo.state === "break" || stateInfo.state === "lunch") {
        const pauseType = stateInfo.state === "lunch" ? "Mittagspause" : "Pause";
        return {
          reply: `Du bist noch in ${pauseType}. Sag "Weiter", um fortzufahren.`,
          buttons: ["Weiter"],
          state,
        };
      }
      
      // Normalerweise starten
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
        buttons: ["Pause", "Mittag", "Falsche Baustelle", "Fertig"],
        state,
      };
    }

    // ===== PAUSE-Intent =====
    if (intent === "pause") {
      const stateInfo = await getCurrentStateFromTimeEvents(employeeId, today);
      
      // Bereits in Pause
      if (stateInfo.state === "break") {
        const lastTime = stateInfo.lastTime || "unbekannt";
        return {
          reply: `Du bist bereits seit ${lastTime} in Pause.`,
          buttons: ["Weiter", "Mittag", "Fertig"],
          state,
        };
      }
      
      // Nicht arbeitet (idle oder andere)
      if (stateInfo.state !== "working") {
        return {
          reply: "Du hast heute noch nicht begonnen. Sag 'Start', um anzufangen.",
          buttons: ["Start"],
          state,
        };
      }
      
      // Normalerweise Pause starten
      state.mode = "pause";
      addTimeline("pause_started", "Pause", current);
      await saveState();
      await appendTimeEvent({
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: "pause",
        at: actualTime,
        jobId: current?.jobId || null,
        jobName: current?.jobName || "",
        createdAt: now,
      });
      return {
        reply: "Pause begonnen. ☕",
        buttons: ["Weiter", "Mittag", "Fertig"],
        state,
      };
    }

    // ===== LUNCH-Intent =====
    if (intent === "lunch") {
      const stateInfo = await getCurrentStateFromTimeEvents(employeeId, today);
      
      // Bereits in Mittagspause
      if (stateInfo.state === "lunch") {
        const lastTime = stateInfo.lastTime || "unbekannt";
        return {
          reply: `Du bist bereits seit ${lastTime} in der Mittagspause.`,
          buttons: ["Weiter", "Fertig"],
          state,
        };
      }
      
      // Nicht in Arbeit oder Pause (nur von working oder break aus möglich)
      if (stateInfo.state !== "working" && stateInfo.state !== "break") {
        return {
          reply: "Du hast heute noch nicht begonnen. Sag 'Start', um anzufangen.",
          buttons: ["Start"],
          state,
        };
      }
      
      // Normalerweise Mittagspause starten
      state.mode = "lunch";
      addTimeline("lunch_started", "Mittagspause", current);
      await saveState();
      await appendTimeEvent({
        employeeId,
        employeeName: state.employeeName,
        date: today,
        type: "mittag",
        at: actualTime,
        jobId: current?.jobId || null,
        jobName: current?.jobName || "",
        createdAt: now,
      });
      return {
        reply: "Mittagspause begonnen. Mahlzeit! 🍽️",
        buttons: ["Weiter", "Fertig"],
        state,
      };
    }

    if (intent === "resume") {
      const stateInfo = await getCurrentStateFromTimeEvents(employeeId, today);
      
      // Wenn aus Pause zurück
      if (stateInfo.state === "break") {
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
        buttons: ["Pause", "Mittag", "Fertig"],
        state,
      };
    }

    if (intent === "finish") {
      if (!current) {
        state.mode = "finished_day";
        addTimeline("day_finished", "Feierabend ohne Einteilung", null);
        await saveState();
        await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "ende", at: actualTime, jobId: null, createdAt: now });
        return {
          reply: "Feierabend ist gespeichert. Schönen Abend! 👋",
          buttons: [],
          state,
        };
      }
      const next = null; // VERALTET: kein next-Wechsel mehr
      if (false && next) { // VERALTET
        state.mode = "finished_site";
        state.pending = {
          type: "finish_choice",
          nextAssignmentKey: assignmentKey(next),
          createdAt: now,
        };
        await saveState();
        return {
          reply: `${assignmentLabel(current)} ist als fertig markiert. Geht’s jetzt weiter zu ${assignmentLabel(next)} oder hast du Feierabend?`,
          buttons: [`Weiter zu ${next.jobName || "#" + next.jobId}`, "Feierabend"],
          state,
        };
      }
      
      // Tagesuebersicht anzeigen
      const { text: daySummaryText } = await buildDayBlocksFromTimeEvents(employeeId, today, actualTime);
      state.pending = {
        type: "closing_day",
        createdAt: now,
      };
      state.mode = "closing_day";
      await saveState();
      return {
        reply: `Heute war:\n\n${daySummaryText}\n\nPasst das?`,
        buttons: ["Passt", "Aendern", "Abbrechen"],
        state,
      };
    }

    // ===== Tagesabschluss Dialog =====

    // Phase 1: Passt / Abbrechen / Aendern
    if (state.pending?.type === "closing_day") {
      if (intent === "yes") {
        state.pending = { type: "closing_materials", createdAt: now };
        await saveState();
        return {
          reply: "Hast du heute noch Material verwendet oder Fotos ergaenzt?",
          buttons: ["Ja", "Nein"],
          state,
        };
      }
      if (intent === "cancel") {
        state.mode = "arbeitet";
        state.pending = null;
        await saveState();
        return {
          reply: "Tagesabschluss abgebrochen. Weiter gehts!",
          buttons: [],
          state,
        };
      }
      if (intent === "change") {
        state.pending = { type: "ask_correction", createdAt: now };
        await saveState();
        return {
          reply: "Welche Zeit oder Baustelle soll geaendert werden?",
          buttons: [],
          state,
        };
      }
    }

    // Phase 2: Material / Fotos
    if (state.pending?.type === "closing_materials") {
      const hasMaterials = intent === "yes";
      state.pending = { type: "closing_regie", hasMaterials, createdAt: now };
      await saveState();
      return {
        reply: "Gab es heute Regiearbeiten?",
        buttons: ["Ja", "Nein"],
        state,
      };
    }

    // Phase 3: Regie + speichern
    if (state.pending?.type === "closing_regie") {
      const isRegie = intent === "yes";
      const hasMaterials = state.pending?.hasMaterials || false;
      state.mode = "idle";
      state.pending = null;
      addTimeline("day_finished", "Feierabend", current);
      await saveState();
      await appendEvent({
        type: "day_finished",
        employeeId,
        employeeName: state.employeeName,
        date: today,
        jobId: current?.jobId || null,
        jobName: current?.jobName || "",
        time: actualTime,
        hasMaterials,
        hasRegie: isRegie,
      });
      return {
        reply: "Tagesabschluss gespeichert. Schoenen Feierabend!",
        buttons: [],
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

  // ===== MORNING REMINDERS ===== 
  // Automatische Erinnerung um 7:00 Uhr für nicht angemeldete Mitarbeiter
  async function checkAndSendMorningReminders() {
    const today = localDateISO();
    const [assignments, states] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
    ]);

    const reminders = [];

    // Gruppen Assignments nach Mitarbeiter
    const employeesWithAssignments = {};
    for (const a of assignments) {
      if (String(a.date) === String(today)) {
        if (!employeesWithAssignments[a.employeeId]) {
          employeesWithAssignments[a.employeeId] = {
            employeeId: a.employeeId,
            employeeName: a.employeeName || a.employeeId,
            assignments: []
          };
        }
        employeesWithAssignments[a.employeeId].assignments.push(a);
      }
    }

    // Prüfe für jeden Mitarbeiter: Hat er gestartet?
    for (const [employeeId, info] of Object.entries(employeesWithAssignments)) {
      const state = states[employeeId];
      
      // "Gestartet" wenn state.mode === "working" ODER timeline hat "work_started"
      const hasStarted = state?.mode === "working" || 
        (state?.timeline && state.timeline.some(t => t.type === "work_started"));
      
      // Falls nicht gestartet, sende Erinnerung
      if (!hasStarted) {
        // Setze Pending State
        if (!state) {
          states[employeeId] = {
            employeeId,
            employeeName: info.employeeName,
            mode: "idle",
            pending: { type: "morning_reminder", createdAt: new Date().toISOString() },
            timeline: [],
          };
        } else {
          state.pending = { type: "morning_reminder", createdAt: new Date().toISOString() };
        }

        // Sammle Erinnerung mit Buttons
        reminders.push({
          employeeId,
          employeeName: info.employeeName,
          reply: `Guten Morgen ${info.employeeName}! 🌅\n\nStatus für heute:\n${info.assignments.map(a => `• ${a.jobName || ("#" + a.jobId)} ${a.from || "ganztägig"}`).join("\n")}\n\nBist du bereit? Oder gibt es ein Problem?`,
          buttons: ["Vergessen", "Krank", "Urlaub", "Arzt", "komme später"]
        });
      }
    }

    // Speichere aktualisierte States
    if (reminders.length > 0) {
      await writeJson(STATES, states);
    }

    return reminders;
  }

  // Handler für die Reminder-Antworten
  async function handleMorningReminderResponse(employeeId, intent) {
    const [states] = await Promise.all([
      readJson(STATES, {}),
    ]);
    
    const state = states[employeeId];
    if (!state || state.pending?.type !== "morning_reminder") {
      return null;
    }

    const now = new Date().toISOString();
    const today = localDateISO();

    // Map Intents zu Events
    const responseMap = {
      "vergessen": { type: "reminder_response", detail: "Vergessen", icon: "😬" },
      "krank": { type: "absence", reason: "Krank", icon: "🤒" },
      "urlaub": { type: "absence", reason: "Urlaub", icon: "🏖️" },
      "arzt": { type: "absence", reason: "Arzt", icon: "🏥" },
      "komme später": { type: "late_arrival", detail: "komme später", icon: "⏰" }
    };

    const response = responseMap[intent];
    if (!response) return null;

    state.pending = null;
    await writeJson(STATES, states);

    // Speichere als Event
    await appendEvent({
      type: response.type,
      employeeId,
      employeeName: state.employeeName,
      date: today,
      detail: response.detail || response.reason,
      createdAt: now
    });

    // Rückgabe-Nachricht basierend auf Response
    const replies = {
      vergessen: "Kein Problem! Jederzeit bereit? Start!",
      krank: "Gute Besserung! Melde dich morgen oder sobald du wieder fit bist.",
      urlaub: "Viel Spaß! Bis bald.",
      arzt: "Bis bald! Pass auf dich auf.",
      "komme später": "Verstanden. Gib Bescheid, wenn du unterwegs bist!",
    };

    return {
      reply: `${response.icon} ${replies[intent]}`,
      buttons: intent === "vergessen" ? ["Start"] : []
    };
  }

  // ===== STATUS REPORT ===== 
  // Statusbericht um 8 Uhr für den Chef
  async function generateStatusReport() {
    const today = localDateISO();
    const [assignments, states, tasks] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, [])
    ]);

    const todayAssignments = assignments.filter(a => String(a.date) === String(today));
    const reportLines = [];

    reportLines.push(`📊 STATUSBERICHT ${today}`);
    reportLines.push(`Erstellt: ${new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', hour12: false })}`);
    reportLines.push("");

    // Gruppiere Mitarbeiter mit Aufgaben
    const employeeMap = {};
    for (const a of todayAssignments) {
      if (!employeeMap[a.employeeId]) {
        employeeMap[a.employeeId] = {
          employeeId: a.employeeId,
          employeeName: a.employeeName || a.employeeId,
          assignments: [],
          state: states[a.employeeId],
          openTasks: []
        };
      }
      employeeMap[a.employeeId].assignments.push(a);
    }

    // Offene Aufgaben pro Mitarbeiter
    for (const t of tasks) {
      if (t.status !== "done" && employeeMap[t.assigneeId]) {
        employeeMap[t.assigneeId].openTasks.push(t);
      }
    }

    // Lese TimeEvents für Regiearbeiten und Material
    const timeEvents = await readJson(TIME_EVENTS, []);
    const endDayEvents = timeEvents.filter(e => 
      e.type === "ende" && 
      String(e.date) === String(today)
    );

    // Regiearbeiten und Material Infos
    const regieMap = {};
    const materialMap = {};
    for (const evt of endDayEvents) {
      if (evt.employeeId) {
        if (evt.hasRegie) regieMap[evt.employeeId] = true;
        if (evt.hasMaterials) materialMap[evt.employeeId] = true;
      }
    }

    // Events Datei lesen für Morning Reminder Responses
    const absenceMap = {};
    try {
      const eventsContent = await fsp.readFile(EVENTS, 'utf8');
      const eventLines = eventsContent.trim().split('\n').filter(l => l);
      for (const line of eventLines) {
        const evt = JSON.parse(line);
        if (String(evt.date) === String(today)) {
          if (evt.type === "absence" && evt.employeeId) {
            absenceMap[evt.employeeId] = evt.reason || evt.detail;
          } else if (evt.type === "late_arrival" && evt.employeeId) {
            absenceMap[evt.employeeId] = "komme später";
          }
        }
      }
    } catch {
      // Events Datei existiert noch nicht
    }

    // Status pro Mitarbeiter
    let startedCount = 0;
    let notStartedCount = 0;
    let absentCount = 0;
    let lateCount = 0;

    reportLines.push("═══ MITARBEITER-STATUS ═══");
    reportLines.push("");

    for (const [, emp] of Object.entries(employeeMap)) {
      const absence = absenceMap[emp.employeeId];
      const state = emp.state;
      const hasStarted = state?.mode === "working" || 
        (state?.timeline && state.timeline.some(t => t.type === "work_started"));

      let statusIcon = "⏳";
      let statusText = "Nicht gestartet";

      if (absence === "Krank" || absence === "Urlaub" || absence === "Arzt") {
        statusIcon = absence === "Krank" ? "🤒" : (absence === "Urlaub" ? "🏖️" : "🏥");
        statusText = absence;
        absentCount++;
      } else if (absence === "komme später") {
        statusIcon = "⏰";
        statusText = "komme später";
        lateCount++;
      } else if (hasStarted) {
        statusIcon = "✅";
        statusText = "Gestartet";
        startedCount++;
      } else {
        notStartedCount++;
      }

      let empLine = `${statusIcon} ${emp.employeeName}`;

      // Einteilung hinzufügen
      if (emp.assignments.length > 0) {
        const sites = emp.assignments.map(a => a.jobName || ("#" + a.jobId)).join(" / ");
        empLine += ` → ${sites}`;
      }

      // Regie oder Material?
      const extras = [];
      if (regieMap[emp.employeeId]) extras.push("Regie");
      if (materialMap[emp.employeeId]) extras.push("Material");
      if (extras.length > 0) {
        empLine += ` [${extras.join(", ")}]`;
      }

      reportLines.push(empLine);

      // Offene Aufgaben
      if (emp.openTasks.length > 0) {
        for (const task of emp.openTasks) {
          reportLines.push(`  ⊙ ${task.title}`);
        }
      }

      reportLines.push("");
    }

    // Summary
    reportLines.push("═══ ZUSAMMENFASSUNG ═══");
    reportLines.push(`✅ Gestartet: ${startedCount}`);
    reportLines.push(`⏳ Nicht gestartet: ${notStartedCount}`);
    reportLines.push(`🚫 Abwesend: ${absentCount}`);
    reportLines.push(`⏰ Komme später: ${lateCount}`);
    reportLines.push("");

    // Offene Aufgaben Summary
    const totalOpenTasks = tasks.filter(t => t.status !== "done").length;
    if (totalOpenTasks > 0) {
      reportLines.push(`📋 Insgesamt offene Aufgaben: ${totalOpenTasks}`);
    }

    return reportLines.join("\n");
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

  app.get("/kristine/api/send-morning-reminders", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const reminders = await checkAndSendMorningReminders();
      res.json({ 
        ok: true, 
        remindersCount: reminders.length,
        reminders: reminders.map(r => ({
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          message: r.reply
        }))
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get("/kristine/api/status-report", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const report = await generateStatusReport();
      res.json({ 
        ok: true,
        report
      });
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

  // ===== SCHEDULER =====
  // Prüfe ob heute ein Tag ist, wo die Scheduler laufen sollen (nicht Sa/So/Feiertag/Betriebsurlaub)
  async function shouldRunScheduler(date = localDateISO()) {
    const dayOfWeek = new Date(date + "T00:00:00Z").getUTCDay(); // 0=So, 6=Sa
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      console.log(`⏭️  [Kristine] Skip Scheduler: ${date} ist Wochenende`);
      return false;
    }

    const holidays = await readJson(path.join(dataDir, "_kristine", "holidays.json"), []);
    if (holidays.some(h => h.date === date)) {
      console.log(`⏭️  [Kristine] Skip Scheduler: ${date} ist Feiertag`);
      return false;
    }

    const vacations = await readJson(path.join(dataDir, "_kristine", "company-vacations.json"), []);
    if (vacations.some(v => date >= v.from && date <= v.to)) {
      console.log(`⏭️  [Kristine] Skip Scheduler: ${date} ist Betriebsurlaub`);
      return false;
    }

    return true;
  }

  // 7:00 AM: Morning Reminders
  if (sendWhatsApp && phoneNumberId) {
    cron.schedule("0 7 * * *", async () => {
      try {
        const today = localDateISO();
        if (!(await shouldRunScheduler(today))) return;

        console.log("🌅 [Kristine] Starte Morning Reminders (7:00 Uhr)");
        const reminders = await checkAndSendMorningReminders();
        
        for (const reminder of reminders) {
          try {
            const assignments = await readJson(ASSIGNMENTS, []);
            const empAssignment = assignments.find(a => String(a.employeeId) === String(reminder.employeeId));
            
            if (empAssignment?.whatsappNumber) {
              await sendWhatsApp({
                phoneNumberId,
                to: empAssignment.whatsappNumber,
                reply: reminder.reply,
                buttons: reminder.buttons
              });
              console.log(`✅ Morning Reminder an ${reminder.employeeName} versendet`);
            }
          } catch (e) {
            console.error(`❌ Morning Reminder an ${reminder.employeeName} fehlgeschlagen:`, e?.message || e);
          }
        }
      } catch (e) {
        console.error("❌ [Kristine] Morning Reminders Fehler:", e?.message || e);
      }
    }, { timezone: "Europe/Vienna" });
  }

  // 8:00 AM: Status Report an Chef
  if (sendWhatsApp && phoneNumberId && chefPhoneNumber) {
    cron.schedule("0 8 * * *", async () => {
      try {
        const today = localDateISO();
        if (!(await shouldRunScheduler(today))) return;

        console.log("📊 [Kristine] Starte Statusbericht (8:00 Uhr)");
        const report = await generateStatusReport();
        
        await sendWhatsApp({
          phoneNumberId,
          to: chefPhoneNumber,
          reply: report,
          buttons: []
        });
        console.log(`✅ Statusbericht an Chef (${chefPhoneNumber}) versendet`);
      } catch (e) {
        console.error("❌ [Kristine] Statusbericht Fehler:", e?.message || e);
      }
    }, { timezone: "Europe/Vienna" });
  }

  // Derselbe Dialogkern wird vom Browser-Simulator und vom echten WhatsApp-Webhook verwendet.
  return { handleMessage, localDateISO };
}

module.exports = { registerKristine };
