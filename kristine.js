
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function registerKristine(app, { dataDir, requireAdmin, publicDir, markJobRunning, sendWhatsApp, phoneNumberId, readEmployees, readJobMeta }) {
  const ROOT = path.join(dataDir, "_kristine");
  const ASSIGNMENTS = path.join(ROOT, "assignments.json");
  const STATES = path.join(ROOT, "states.json");
  const TASKS = path.join(ROOT, "tasks.json");
  const EVENTS = path.join(ROOT, "events.jsonl");
  const TIME_EVENTS = path.join(ROOT, "time-events.json");
  const REVIEW_ENTRIES = path.join(ROOT, "day-review-entries.json");
  const GPS_IMPORTS_DIR = path.join(ROOT, "gps-imports");
  const GPS_LATEST = path.join(GPS_IMPORTS_DIR, "latest.json");
  const DAY_CORRECTIONS = path.join(ROOT, "day-corrections.json");
  const DAY_RELEASES = path.join(ROOT, "day-releases.json");
  const MATERIAL_REQUESTS = path.join(ROOT, "material-requests.json");
  const MATERIAL_NOTIFY_STATE = path.join(ROOT, "material-notify-state.json");
  const EMPLOYEE_WORK_RULES = path.join(ROOT, "employee-work-rules.json");

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



  function parseCsvRows(text, delimiter = ";") {
    const source = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (char === '"') {
        if (quoted && next === '"') { cell += '"'; index += 1; }
        else quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        row.push(cell); cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") index += 1;
        row.push(cell); cell = "";
        if (row.some(value => String(value).trim() !== "")) rows.push(row);
        row = [];
      } else {
        cell += char;
      }
    }
    row.push(cell);
    if (row.some(value => String(value).trim() !== "")) rows.push(row);
    if (!rows.length) return [];
    const headers = rows[0].map(value => String(value || "").trim());
    return rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, String(values[index] || "").trim()])));
  }

  function gpsDateISO(value) {
    const match = String(value || "").trim().match(/^(\d{2})[-./](\d{2})[-./](\d{4})$/);
    if (match) return `${match[3]}-${match[2]}-${match[1]}`;
    return String(value || "").slice(0, 10);
  }

  function gpsNumber(value) {
    const normalized = String(value || "").trim().replace(/\./g, "").replace(",", ".");
    const result = Number(normalized);
    return Number.isFinite(result) ? result : 0;
  }

  function normalizePersonName(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function personNameParts(value) {
    return normalizePersonName(value).split(/\s+/).filter(Boolean);
  }

  function employeeEverydayName(employee) {
    const official = String(employee?.name || employee?.employeeName || "").trim();
    const nickname = String(employee?.nickname || employee?.rufname || "").trim();
    if (!nickname) return official;
    const officialParts = official.split(/\s+/).filter(Boolean);
    const lastName = officialParts.length > 1 ? officialParts.slice(1).join(" ") : "";
    return lastName ? `${nickname} ${lastName}` : nickname;
  }

  function matchGpsEmployee(driverName, employees) {
    const wanted = personNameParts(driverName);
    if (!wanted.length) return null;
    let best = null;
    for (const employee of employees || []) {
      const official = String(employee.name || employee.employeeName || "");
      const officialParts = official.split(/\s+/).filter(Boolean);
      const lastName = officialParts.length > 1 ? officialParts.slice(1).join(" ") : "";
      const candidates = [
        official,
        employee.nickname ? `${employee.nickname}${lastName ? " " + lastName : ""}` : "",
        employee.nickname || ""
      ].filter(Boolean);
      let employeeBest = 0;
      for (const candidate of candidates) {
        const parts = personNameParts(candidate);
        if (!parts.length) continue;
        let score = 0;
        if (parts.join(" ") === wanted.join(" ")) score = 100;
        else {
          const wantedLast = wanted[wanted.length - 1];
          const actualLast = parts[parts.length - 1];
          const wantedFirst = wanted[0];
          const actualFirst = parts[0];
          if (wantedLast === actualLast) score += 60;
          if (wantedFirst === actualFirst) score += 35;
          else if (wantedFirst.startsWith(actualFirst) || actualFirst.startsWith(wantedFirst)) score += 24;
          score += wanted.filter(part => parts.includes(part)).length * 5;
        }
        employeeBest = Math.max(employeeBest, score);
      }
      if (!best || employeeBest > best.score) best = { score: employeeBest, employee };
    }
    return best && best.score >= 70 ? best.employee : null;
  }


  function reconcileGpsMappings(data, employees) {
    if (!data) return false;
    data.mappings = data.mappings || {};

    const firstRowByDriver = new Map();
    for (const row of data.rows || []) {
      const driverKey = String(row.driverKey || "").trim();
      if (driverKey && !firstRowByDriver.has(driverKey)) firstRowByDriver.set(driverKey, row);
    }

    let changed = false;
    for (const [driverKey, row] of firstRowByDriver) {
      const existing = data.mappings[driverKey] || {};

      // Explicit office corrections always win.
      if (existing.employeeId && existing.autoMatched !== true) continue;

      const match = matchGpsEmployee(row.driverName, employees);
      if (!match) continue;

      const employeeId = String(match.id || match.employeeId || "");
      const employeeName = employeeEverydayName(match) || row.driverName;
      if (!employeeId) continue;

      if (
        String(existing.employeeId || "") !== employeeId ||
        String(existing.employeeName || "") !== employeeName ||
        existing.autoMatched !== true
      ) {
        data.mappings[driverKey] = {
          employeeId,
          employeeName,
          autoMatched: true,
          matchedAt: new Date().toISOString(),
          matchedBy: "official-name-or-rufname",
        };
        changed = true;
      }
    }
    return changed;
  }

  function cleanGpsRow(row, index) {
    const driverName = String(row["Fahrername"] || "").replace(/\s+/g, " ").trim() || "Ohne Fahrer";
    const date = gpsDateISO(row["Datum"]);
    const driverKey = normalizePersonName(driverName).replace(/\s+/g, "_") || `ohne_fahrer_${index}`;
    return {
      id: `gps_${date}_${driverKey}_${index}`,
      date,
      driverName,
      driverKey,
      gpsEmployeeId: String(row["Mitarbeiter-ID"] || row["Fahrernummer"] || ""),
      vehicleName: String(row["Fahrzeugname"] || ""),
      vehicleNumber: String(row["Fahrzeugnummer"] || ""),
      licensePlate: String(row["Kennzeichen"] || ""),
      startLocation: String(row["Startstandort"] || ""),
      stopLocation: String(row["Stoppstandort"] || ""),
      startTime: String(row["Startzeit"] || "").slice(0, 5),
      arrivalTime: String(row["Ankunftszeit"] || "").slice(0, 5),
      departureTime: String(row["Abfahrtszeit"] || "").slice(0, 5),
      travelSeconds: Math.max(0, Number(row["Fahrzeit (in Sekunden)"] || 0) || 0),
      staySeconds: Math.max(0, Number(row["Zeit vor Ort (in Sekunden)"] || 0) || 0),
      idleSeconds: Math.max(0, Number(row["Leerlaufzeit (in Sekunden)"] || 0) || 0),
      distanceKm: gpsNumber(row["Strecke"]),
      odometerStart: gpsNumber(row["Kilometerzählerstart"]),
      odometerEnd: gpsNumber(row["Kilometerzählerende"]),
      startLat: gpsNumber(row["Breitengrad am Start"]),
      startLng: gpsNumber(row["Längengrad am Start"]),
      stopLat: gpsNumber(row["Breitengrad am Stopp"]),
      stopLng: gpsNumber(row["Längengrad am Stopp"]),
      fuelType: String(row["Kraftstoffart"] || ""),
      isPrivate: false,
      privateMarkedAt: null,
      assignedEmployeeId: "",
      assignedEmployeeName: "",
      assignmentUpdatedAt: null,
      passengers: [],
      changeHistory: [],
    };
  }

  async function readGpsImport(importId = "latest") {
    try {
      const file = importId === "latest" ? GPS_LATEST : path.join(GPS_IMPORTS_DIR, `${String(importId).replace(/[^A-Za-z0-9_-]/g, "")}.json`);
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch { return null; }
  }

  async function writeGpsImport(data) {
    await fsp.mkdir(GPS_IMPORTS_DIR, { recursive: true });
    const file = path.join(GPS_IMPORTS_DIR, `${data.id}.json`);
    await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
    await fsp.writeFile(GPS_LATEST, JSON.stringify(data, null, 2), "utf8");
  }

  function gpsImportSummary(data) {
    if (!data) return null;
    const groups = new Map();
    for (const row of data.rows || []) {
      const key = `${row.driverKey}|${row.date}`;
      if (!groups.has(key)) groups.set(key, {
        key, driverKey: row.driverKey, driverName: row.driverName, date: row.date,
        employeeId: data.mappings?.[row.driverKey]?.employeeId || "",
        employeeName: data.mappings?.[row.driverKey]?.employeeName || "",
        vehicleName: row.vehicleName, licensePlate: row.licensePlate,
        vehicles: [], trips: 0, distanceKm: 0, privateKm: 0,
      });
      const group = groups.get(key);
      const vehicleKey = `${row.licensePlate || ""}|${row.vehicleName || ""}`;
      if (!group.vehicles.some(vehicle => vehicle.key === vehicleKey)) {
        group.vehicles.push({ key: vehicleKey, licensePlate: row.licensePlate || "", vehicleName: row.vehicleName || "" });
      }
      group.trips += 1;
      group.distanceKm += Number(row.distanceKm || 0);
      if (row.isPrivate) group.privateKm += Number(row.distanceKm || 0);
    }
    return {
      id: data.id, filename: data.filename, importedAt: data.importedAt,
      rowCount: (data.rows || []).length,
      groups: [...groups.values()].sort((a,b) => a.date.localeCompare(b.date) || a.driverName.localeCompare(b.driverName, "de")),
    };
  }


  function effectiveGpsDriver(data, row) {
    const mapping = data?.mappings?.[row.driverKey] || {};
    return {
      employeeId: String(row.assignedEmployeeId || mapping.employeeId || ""),
      employeeName: String(row.assignedEmployeeName || mapping.employeeName || row.driverName || ""),
      source: row.assignedEmployeeId ? "manual" : (mapping.employeeId ? "mapping" : "gps"),
    };
  }

  function gpsEmployeeDay(data, employeeId, date) {
    const id = String(employeeId || "");
    const wantedDate = String(date || "").slice(0, 10);
    const ownRows = [];
    const passengerRows = [];
    for (const row of data?.rows || []) {
      if (wantedDate && row.date !== wantedDate) continue;
      const driver = effectiveGpsDriver(data, row);
      if (driver.employeeId && driver.employeeId === id) {
        ownRows.push({ ...row, effectiveDriver: driver });
      }
      const passenger = (row.passengers || []).find(item => String(item.employeeId || "") === id);
      if (passenger) {
        passengerRows.push({
          rideId: row.id,
          date: row.date,
          startTime: row.startTime,
          arrivalTime: row.arrivalTime,
          departureTime: row.departureTime,
          startLocation: row.startLocation,
          stopLocation: row.stopLocation,
          distanceKm: row.distanceKm,
          travelSeconds: row.travelSeconds,
          staySeconds: row.staySeconds,
          vehicleName: row.vehicleName,
          licensePlate: row.licensePlate,
          startLat: row.startLat,
          startLng: row.startLng,
          stopLat: row.stopLat,
          stopLng: row.stopLng,
          driver,
          passenger,
        });
      }
    }
    ownRows.sort((a,b) => String(a.startTime).localeCompare(String(b.startTime)));
    passengerRows.sort((a,b) => String(a.startTime).localeCompare(String(b.startTime)));
    return { ownRows, passengerRows };
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
  if (actual === null) return actualTime;

  const official = 7 * 60;
  const tolerance = 15;

  if (actual < official) return "07:00";
  if (actual <= official + tolerance) return "07:00";

  return actualTime;
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
    if (/^(fertig|ende|stopp|stop|feierabend|schluss|wir sind fertig|bin fertig)$/.test(t)) return "finish";
    if (/^(ja|jup|passt|ok|okay|genau|👍)$/.test(t)) return "yes";
    if (/^(nein|passt nicht|falsch|👎)$/.test(t)) return "no";
    if (/^(status|wo bin ich|was steht an|heute)$/.test(t)) return "status";
    if (/^(andere baustelle|baustelle wechseln|wechseln)$/.test(t)) return "switch_site";
    if (/^(erledigt|aufgabe erledigt)$/.test(t)) return "task_done";
    if (/^(anrufen|anruf|rufen)$/.test(t)) return "task_call";
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

  function uniqueSites(assignments) {
    const map = new Map();
    for (const assignment of assignments) {
      const jobId = String(assignment?.jobId || "").trim();
      const jobName = String(assignment?.jobName || "").trim();
      if (!jobId && !jobName) continue;
      const key = jobId || normalizeText(jobName);
      if (!map.has(key)) map.set(key, {
        jobId, jobName, city: assignment?.city || "", address: assignment?.address || "",
      });
    }
    return [...map.values()];
  }

  function findSiteCandidates(assignments, query, preferredAssignments = []) {
    const q = normalizeText(query);
    const preferredKeys = new Set(preferredAssignments.map((assignment) => String(assignment.jobId || normalizeText(assignment.jobName))));
    return uniqueSites(assignments)
      .map((site) => {
        const id = normalizeText(site.jobId);
        const name = normalizeText(site.jobName);
        let score = preferredKeys.has(String(site.jobId || name)) ? 100 : 0;
        if (!q) score += 1;
        if (id === q || name === q) score += 1000;
        else if (id.startsWith(q) || name.startsWith(q)) score += 500;
        else if (id.includes(q) || name.includes(q)) score += 200;
        return { ...site, score };
      })
      .filter((site) => !q || site.score > 0)
      .sort((a, b) => b.score - a.score || String(a.jobName).localeCompare(String(b.jobName), "de"));
  }

  function formatDaySummary(timeEvents, employeeId, date, state) {
    const segments = buildEditableSegments(timeEvents, employeeId, date, state);
    if (!segments.length) return "Keine Zeitabschnitte vorhanden.";
    return segments.map((segment) => {
      const label = segment.type === "lunch" ? "Mittag" : segment.type === "pause" ? "Pause" : (segment.jobName || segment.jobId || "Arbeit");
      return `${segment.from}–${segment.to || "offen"} ${label}`;
    }).join("\n");
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

  async function getBootstrap() {
    const [assignments, states, tasks, timeEvents, employees, latestGps] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, []),
      readJson(TIME_EVENTS, []),
      typeof readEmployees === "function" ? readEmployees() : [],
      readGpsImport("latest"),
    ]);
    // Status für die Oberfläche immer aus den HEUTIGEN Zeitereignissen ableiten.
    // states.json ist mitarbeiterbezogen und kann noch den Status vom Vortag enthalten.
    // Ein nachgeholter Tagesabschluss darf deshalb niemals "Feierabend" für heute vortäuschen.
    const today = localDateISO();
    const visibleStates = { ...states };
    const byEmployee = new Map();
    for (const event of Array.isArray(timeEvents) ? timeEvents : []) {
      if (String(event?.date || "") !== today) continue;
      const type = String(event?.type || "").toLowerCase();
      if (!["start","weiter","pause","mittag","ende","fertig","stop","stopp"].includes(type)) continue;
      const id = String(event?.employeeId || "");
      if (!id) continue;
      const rows = byEmployee.get(id) || [];
      rows.push(event);
      byEmployee.set(id, rows);
    }
    const modeForType = (type) => {
      type = String(type || "").toLowerCase();
      if (["start","weiter"].includes(type)) return "working";
      if (type === "pause") return "pause";
      if (type === "mittag") return "lunch";
      if (["ende","fertig","stop","stopp"].includes(type)) return "finished_day";
      return "idle";
    };
    for (const employee of employees || []) {
      const id = String(employee?.id || employee?.employeeId || "");
      if (!id) continue;
      const rows = (byEmployee.get(id) || []).sort((a,b) =>
        String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
        String(a.at || "").localeCompare(String(b.at || ""))
      );
      const base = visibleStates[id] || { employeeId:id, employeeName:employee?.nickname || employee?.name || id, timeline:[] };
      visibleStates[id] = { ...base, mode: rows.length ? modeForType(rows[rows.length-1].type) : "idle" };
    }
    // KRISTOOL braucht für Diäten/Entsendung die echte Baustellenadresse.
    // Die Planung enthält sie nicht immer. Deshalb nur für die Ausgabe des Bootstrap
    // mit dem Baustellenstamm anreichern – assignments.json selbst bleibt unverändert.
    const enrichedAssignments = [];
    for (const assignment of assignments || []) {
      const row = { ...assignment };
      const jobId = String(row.jobId || "").trim();
      if (jobId && typeof readJobMeta === "function") {
        try {
          const jobMeta = await readJobMeta(jobId) || {};
          const masterAddress = String(
            jobMeta.address ||
            [
              [jobMeta.street, jobMeta.houseNumber].filter(Boolean).join(" "),
              [jobMeta.postalCode, jobMeta.city].filter(Boolean).join(" ")
            ].filter(Boolean).join(", ")
          ).trim();
          if (masterAddress) row.address = masterAddress;
          if (jobMeta.city) row.city = String(jobMeta.city);
          if (jobMeta.country) row.country = String(jobMeta.country);
          if (jobMeta.countryCode) row.countryCode = String(jobMeta.countryCode);
        } catch {}
      }
      enrichedAssignments.push(row);
    }

    return { assignments: enrichedAssignments, states: visibleStates, tasks, timeEvents, employees, gpsImport: gpsImportSummary(latestGps) };
  }

  async function handleMessage({ employeeId, employeeName, text, date }) {
    const today = date || localDateISO();
    const [assignments, states, tasks, timeEvents] = await Promise.all([
      readJson(ASSIGNMENTS, []),
      readJson(STATES, {}),
      readJson(TASKS, []),
      readJson(TIME_EVENTS, []),
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
    let current = activeAssignment(dayAssignments, state);
    if (
  state.activeJobOverride?.date === today &&
  (state.activeJobOverride?.jobId || state.activeJobOverride?.jobName)
) {
  current = state.activeJobOverride;
} else if (state.activeJobOverride) {
  delete state.activeJobOverride;
}
    const rawText = String(text || "").trim();

if (rawText.startsWith("task_call:")) {
  state.taskId = rawText.slice("task_call:".length);
}

if (rawText.startsWith("task_done:")) {
  state.taskId = rawText.slice("task_done:".length);
}

const intent = rawText.startsWith("task_call:")
  ? "task_call"
  : rawText.startsWith("task_done:")
    ? "task_done"
    : detectIntent(rawText);
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
      const query = String(text).trim();
      const candidates = findSiteCandidates(assignments, query, dayAssignments);
      if (!candidates.length) {
        return {
          reply: `Ich finde keine Baustelle zu „${query}“. Bitte Name oder Nummer anders schreiben.`,
          buttons: [],
          state,
        };
      }
      if (candidates.length === 1 || candidates[0].score >= 1000) {
        const selected = candidates[0];
        const wasWorking = ["working", "pause", "lunch"].includes(state.mode) || state.pending?.forSwitch;
        state.activeAssignmentKey = null;
        state.activeJobOverride = {
  date: today,
  jobId: selected.jobId,
  jobName: selected.jobName,
  city: selected.city || ""
};
        state.mode = wasWorking ? "working" : state.mode;
        state.pending = null;
        addTimeline(wasWorking ? "site_switch" : "assignment_deviation", `${wasWorking ? "Baustellenwechsel" : "Abweichende Einteilung"} zu ${assignmentLabel(selected)}`, selected);
        await saveState();
        if (wasWorking) {
          await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "weiter", at: actualTime, jobId: selected.jobId, jobName: selected.jobName || "", createdAt: now });
          await appendEvent({ type: "site_switch", employeeId, employeeName: state.employeeName, date: today, jobId: selected.jobId, detail: assignmentLabel(selected), time: actualTime });
          return { reply: `✅ Baustelle gewechselt.\nArbeitszeit läuft weiter auf ${assignmentLabel(selected)}.`, buttons: [], state };
        }
        return { reply: `✅ Baustelle ausgewählt: ${assignmentLabel(selected)}.\nSag „Start“, wenn die Arbeit beginnt.`, buttons: ["Start"], state };
      }
      state.pending = { type: "choose_site_search", choices: candidates.slice(0, 6), forSwitch: Boolean(state.pending?.forSwitch), createdAt: now };
      await saveState();
      return {
        reply: `Welche Baustelle meinst du?\n${candidates.slice(0, 6).map((site, index) => `${index + 1}. ${assignmentLabel(site)}`).join("\n")}`,
        buttons: candidates.slice(0, 3).map((_, index) => String(index + 1)),
        state,
      };
    }

    if (state.pending?.type === "choose_site_search") {
      const number = Number(normalizeText(text));
      const choices = Array.isArray(state.pending.choices) ? state.pending.choices : [];
      const selected = Number.isInteger(number) && number > 0 ? choices[number - 1] : choices.find((site) => normalizeText(site.jobName).includes(normalizeText(text)) || normalizeText(site.jobId) === normalizeText(text));
      if (!selected) return { reply: "Bitte Nummer oder Baustellenname auswählen.", buttons: choices.slice(0, 3).map((_, index) => String(index + 1)), state };
      const wasWorking = Boolean(state.pending.forSwitch) || ["working", "pause", "lunch"].includes(state.mode);
      state.activeAssignmentKey = null;
      state.activeJobOverride = {
  date: today,
  jobId: selected.jobId,
  jobName: selected.jobName,
  city: selected.city || ""
};
      state.mode = wasWorking ? "working" : state.mode;
      state.pending = null;
      addTimeline(wasWorking ? "site_switch" : "assignment_deviation", `${wasWorking ? "Baustellenwechsel" : "Abweichende Einteilung"} zu ${assignmentLabel(selected)}`, selected);
      await saveState();
      if (wasWorking) {
        await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "weiter", at: actualTime, jobId: selected.jobId, jobName: selected.jobName || "", createdAt: now });
        return { reply: `✅ Baustelle gewechselt.\nArbeitszeit läuft weiter auf ${assignmentLabel(selected)}.`, buttons: [], state };
      }
      return { reply: `✅ Baustelle ausgewählt: ${assignmentLabel(selected)}.`, buttons: ["Start"], state };
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

    if (intent === "switch_site") {
      const alternatives = dayAssignments.filter((assignment) => !current || assignmentKey(assignment) !== assignmentKey(current));
      if (!alternatives.length) {
        state.pending = { type: "ask_actual_assignment", forSwitch: true, createdAt: now };
        await saveState();
        return { reply: "Welche Baustelle ist richtig? Schreib bitte Name oder Nummer.", buttons: [], state };
      }
      state.pending = { type: "choose_switch_assignment", choices: alternatives.map((assignment) => assignmentKey(assignment)), createdAt: now };
      await saveState();
      return {
        reply: `Welche Baustelle?\n${alternatives.map((assignment, index) => `${index + 1}. ${assignmentLabel(assignment)}`).join("\n")}\nOder schreibe Name bzw. Nummer.`,
       buttons: [
       ...alternatives.slice(0, 2).map((assignment, index) => ({
       id: String(index + 1),
       title: assignmentLabel(assignment).slice(0, 20)
       })),
       {
       id: "other_site",
       title: "Andere Baustelle"
       }
    ],
    state,
    };
    }

    if (state.pending?.type === "choose_switch_assignment") {
      const normalized = normalizeText(text);
      if (text === "other_site") {
  state.pending = {
    type: "ask_actual_assignment",
    forSwitch: true,
    createdAt: now
  };

  await saveState();

  return {
    reply: "Schreib bitte Name oder Nummer der anderen Baustelle.",
    buttons: [],
    state
  };
}
      const alternatives = dayAssignments.filter((assignment) => state.pending.choices?.includes(assignmentKey(assignment)));
      const number = Number(normalized);
      const selected = Number.isInteger(number) && number > 0 && number <= alternatives.length
        ? alternatives[number - 1]
        : alternatives.find((assignment) => normalizeText(assignment.jobName).includes(normalized) || normalizeText(assignment.jobId) === normalized);
      if (selected) {
        state.activeAssignmentKey = assignmentKey(selected);
        delete state.activeJobOverride;
        state.mode = "working";
        state.pending = null;
        addTimeline("site_switch", `Baustellenwechsel zu ${assignmentLabel(selected)}`, selected);
        await saveState();
        await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "weiter", at: actualTime, jobId: selected.jobId, jobName: selected.jobName || "", createdAt: now });
        return { reply: `✅ Baustelle gewechselt.\nArbeitszeit läuft weiter auf ${assignmentLabel(selected)}.`, buttons: [], state };
      }
      state.pending = { type: "ask_actual_assignment", forSwitch: true, createdAt: now };
      await saveState();
      return { reply: "Schreib bitte Name oder Nummer der Baustelle.", buttons: [], state };
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
        buttons: state.mode === "working" ? ["Andere Baustelle"] : ["Start"],
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
      if (typeof markJobRunning === "function") await markJobRunning(current.jobId, "time_booking").catch(() => false);
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
        buttons: ["Andere Baustelle"],
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
          buttons: ["Andere Baustelle"],
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
        buttons: ["Andere Baustelle"],
        state,
      };
    }

    if (state.pending?.type === "day_review_summary") {
      if (intent === "no") {
        state.pending = null;
        await saveState();
        return { reply: "Bitte die Zeiten im Leitstand korrigieren und danach nochmals „Fertig“ schreiben.", buttons: [], state };
      }
      if (intent === "yes") {
        state.dayReview = { ...(state.dayReview || {}), summaryConfirmed: true };
        state.pending = { type: "day_review_photo", createdAt: now };
        await saveState();
        return { reply: "Sind alle Fotos für heute erfasst?", buttons: ["Ja", "Nein"], state };
      }
      return { reply: "Passt die Zusammenfassung?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "day_review_photo") {
      if (!["yes", "no"].includes(intent)) return { reply: "Sind alle Fotos erfasst?", buttons: ["Ja", "Nein"], state };
      state.dayReview = { ...(state.dayReview || {}), photosComplete: intent === "yes" };
      state.pending = { type: "day_review_material", createdAt: now };
      await saveState();
      return { reply: "Ist das verwendete Material erfasst?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "day_review_material") {
      if (!["yes", "no"].includes(intent)) return { reply: "Ist das Material erfasst?", buttons: ["Ja", "Nein"], state };
      state.dayReview = { ...(state.dayReview || {}), materialComplete: intent === "yes" };
      state.pending = { type: "day_review_regie", createdAt: now };
      await saveState();
      return { reply: "Ist noch ein Regiebericht nötig?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "day_review_regie") {
      if (!["yes", "no"].includes(intent)) return { reply: "Ist ein Regiebericht nötig?", buttons: ["Ja", "Nein"], state };
      state.dayReview = { ...(state.dayReview || {}), regieNeeded: intent === "yes" };
      state.pending = { type: "day_review_task", createdAt: now };
      await saveState();
      return { reply: "Ist noch etwas offen, das als Aufgabe gespeichert werden soll?", buttons: ["Ja", "Nein"], state };
    }

    if (state.pending?.type === "day_review_task") {
      if (intent === "yes") {
        state.pending = { type: "day_review_task_text", createdAt: now };
        await saveState();
        return { reply: "Was ist noch offen? Schreib mir kurz die Aufgabe.", buttons: [], state };
      }
      if (intent !== "no") return { reply: "Soll ich noch eine Aufgabe speichern?", buttons: ["Ja", "Nein"], state };
      state.pending = null;
      state.mode = "finished_day";
      addTimeline("day_finished", "Tagesabschluss bestätigt", current);
      await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "ende", at: actualTime, jobId: current?.jobId || state.activeJobOverride?.jobId || null, jobName: current?.jobName || state.activeJobOverride?.jobName || "", createdAt: now });
      await appendEvent({ type: "day_finished", employeeId, employeeName: state.employeeName, date: today, jobId: current?.jobId || state.activeJobOverride?.jobId || null, time: actualTime, review: state.dayReview || {} });
      await saveState();
      return { reply: "✅ Tagesabschluss gespeichert. Danke und schönen Feierabend! 👋", buttons: [], state };
    }

    if (state.pending?.type === "day_review_task_text" && intent === "message") {
      const title = String(text).trim();
      tasks.push({
        id: `t_${Date.now()}`, title, assigneeId: String(employeeId), assigneeName: state.employeeName,
        jobId: current?.jobId || state.activeJobOverride?.jobId || "", jobName: current?.jobName || state.activeJobOverride?.jobName || "",
        dueDate: today, reminder: "Beim Tagesabschluss erstellt", status: "open", createdAt: now, completedAt: null, createdBy: employeeId,
      });
      await writeJson(TASKS, tasks);
      state.dayReview = { ...(state.dayReview || {}), taskCreated: title };
      state.pending = null;
      state.mode = "finished_day";
      addTimeline("day_finished", "Tagesabschluss bestätigt", current);
      await appendTimeEvent({ employeeId, employeeName: state.employeeName, date: today, type: "ende", at: actualTime, jobId: current?.jobId || state.activeJobOverride?.jobId || null, jobName: current?.jobName || state.activeJobOverride?.jobName || "", createdAt: now });
      await appendEvent({ type: "day_finished", employeeId, employeeName: state.employeeName, date: today, jobId: current?.jobId || state.activeJobOverride?.jobId || null, time: actualTime, review: state.dayReview || {} });
      await saveState();
      return { reply: `✅ Aufgabe „${title}“ gespeichert. Tagesabschluss erledigt. Schönen Feierabend! 👋`, buttons: [], state };
    }

    if (intent === "finish") {
      const summary = formatDaySummary(timeEvents, employeeId, today, state);
      state.pending = { type: "day_review_summary", createdAt: now };
      state.dayReview = { startedAt: now, summary };
      await saveState();
      return {
        reply: `📋 Tageszusammenfassung\n${summary}\n\nPasst das so?`,
        buttons: ["Ja", "Nein"],
        state,
      };
    }

    if (intent === "task_call") {
  const taskId = String(state?.taskId || "").trim();

  const open = taskId
    ? tasks.find(t =>
        String(t.id) === taskId &&
        String(t.assigneeId) === String(employeeId) &&
        t.status !== "done"
      )
    : tasks.find(t =>
        String(t.assigneeId) === String(employeeId) &&
        t.status !== "done"
      );

  if (!open) {
    return {
      reply: "Ich finde diese offene Aufgabe nicht mehr.",
      buttons: [],
      state
    };
  }

  const phone = String(open.contactPhone || "").trim();

  if (!phone) {
    return {
      reply: `Bei „${open.title}“ ist keine Rückrufnummer hinterlegt.`,
      buttons: [
  { id: `task_done:${open.id}`, title: "Erledigt" }
],
      state
    };
  }

  return {
    reply: `📞 ${open.contactName ? open.contactName + ": " : ""}${phone}`,
    buttons: [
  { id: `task_done:${open.id}`, title: "Erledigt" }
],
    state
  };
}

    if (intent === "task_done") {
      const taskId = String(state?.taskId || "").trim();

const open = taskId
  ? tasks.find(t =>
      String(t.id) === taskId &&
      String(t.assigneeId) === String(employeeId) &&
      t.status !== "done"
    )
  : tasks.find(t =>
      String(t.assigneeId) === String(employeeId) &&
      t.status !== "done"
    );
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
      reply: "Danke, ich habe deine Nachricht gespeichert.",
      buttons: state.mode === "working" ? ["Andere Baustelle"] : ["Status", "Start"],
      state,
    };
  }

  app.get("/kristine", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.sendFile(path.join(publicDir, "kristine.html"));
  });

  app.get("/kontrollzentrum", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.sendFile(path.join(publicDir, "kontrollzentrum.html"));
  });


  function materialAlertPhones() {
    return String(process.env.WHATSAPP_ALERT_PHONES || process.env.MATERIAL_ALERT_PHONES || process.env.MATERIAL_ALERT_PHONE || "")
      .split(/[;,]/)
      .map(value => value.replace(/\D/g, ""))
      .filter(Boolean);
  }

  function materialNeedLabel(value) {
    return value === "urgent_today" ? "Heute dringend" : value === "tomorrow" ? "Für morgen" : "Nur dokumentieren";
  }

  async function materialEmployeePhone(employeeId) {
    if (typeof readEmployees !== "function") return "";
    const employees = await readEmployees().catch(() => []);
    const employee = (employees || []).find(item =>
      String(item.id || item.employeeId || "") === String(employeeId || "")
    );
    return String(
      employee?.phone ||
      employee?.phoneNumber ||
      employee?.whatsapp ||
      employee?.mobile ||
      ""
    ).replace(/\D/g, "");
  }

  async function sendMaterialResponseToEmployee(request) {
    if (typeof sendWhatsApp !== "function") return { sent: false, reason: "whatsapp_not_configured" };
    const phone = await materialEmployeePhone(request.employeeId);
    if (!phone) return { sent: false, reason: "employee_phone_missing" };

    const statusLabel = request.status === "stocked" ? "📦 Lagernd" : "✅ Bestellt";
    const lines = [
      "📦 Materialmeldung beantwortet",
      "",
      statusLabel,
      request.materialText ? `Material: ${request.materialText}` : "",
      request.jobName ? `Baustelle: ${request.jobName}${request.jobId ? ` (#${request.jobId})` : ""}` : "",
      request.availableAt ? `Verfügbar: ${request.availableAt}` : "",
      request.responseNote ? `Info: ${request.responseNote}` : "",
      "",
      "KRISTINE kümmert sich."
    ].filter(Boolean);

    try {
      await sendWhatsApp({ to: phone, reply: lines.join("\n"), buttons: [] });
      return { sent: true, phoneTail: phone.slice(-5) };
    } catch (error) {
      return { sent: false, reason: String(error?.message || error) };
    }
  }

  async function sendMaterialAlert(request, mode = "urgent") {
    const phones = materialAlertPhones();
    if (!phones.length || typeof sendWhatsApp !== "function") {
      return { sent: false, reason: !phones.length ? "material_alert_phone_missing" : "whatsapp_not_configured" };
    }
    const headline = mode === "late"
      ? "⚠️ Material-Nachmeldung nach 15 Uhr"
      : "🚨 Material heute dringend";
    const lines = [
      headline,
      request.jobName ? `🏗️ ${request.jobName}${request.jobId ? ` (#${request.jobId})` : ""}` : "",
      request.employeeName ? `👷 Von: ${request.employeeName}` : "",
      `📦 ${request.materialText}`,
      request.note ? `ℹ️ ${request.note}` : "",
    ].filter(Boolean);
    const results = [];
    for (const phone of phones) {
      try {
        await sendWhatsApp({ to: phone, reply: lines.join("\n"), buttons: [] });
        results.push({ phoneTail: phone.slice(-5), sent: true });
      } catch (error) {
        results.push({ phoneTail: phone.slice(-5), sent: false, reason: String(error?.message || error) });
      }
    }
    return { sent: results.some(row => row.sent), results };
  }

  async function sendMaterialSummary(date = localDateISO()) {
    const requests = await readJson(MATERIAL_REQUESTS, []);
    const rows = requests.filter(row =>
      row.status === "open" &&
      row.need === "tomorrow" &&
      String(row.createdDate || "") === String(date) &&
      !row.summaryNotifiedAt
    );
    if (!rows.length) return { sent: false, reason: "nothing_open" };

    const phones = materialAlertPhones();
    if (!phones.length || typeof sendWhatsApp !== "function") {
      return { sent: false, reason: "notification_not_configured" };
    }

    const grouped = new Map();
    for (const row of rows) {
      const key = row.jobId || row.jobName || "Ohne Baustelle";
      if (!grouped.has(key)) grouped.set(key, { title: row.jobName || row.jobId || "Ohne Baustelle", items: [] });
      grouped.get(key).items.push(row);
    }
    const lines = ["📦 Material für morgen"];
    for (const group of grouped.values()) {
      lines.push("", `🏗️ ${group.title}`);
      group.items.forEach(row => lines.push(`• ${row.materialText}${row.employeeName ? ` · ${row.employeeName}` : ""}`));
    }

    let sent = false;
    for (const phone of phones) {
      try {
        await sendWhatsApp({ to: phone, reply: lines.join("\n"), buttons: [] });
        sent = true;
      } catch (error) {
        console.error("Material-Sammelmeldung fehlgeschlagen:", error);
      }
    }
    if (sent) {
      const now = new Date().toISOString();
      const ids = new Set(rows.map(row => row.id));
      requests.forEach(row => { if (ids.has(row.id)) row.summaryNotifiedAt = now; });
      await writeJson(MATERIAL_REQUESTS, requests);
    }
    return { sent, count: rows.length };
  }

  app.get("/kristine/api/material-requests", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await readJson(MATERIAL_REQUESTS, []);
      res.json({ ok: true, requests: rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/material-requests", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const materialText = String(req.body?.materialText || "").trim().slice(0, 600);
      if (!materialText) return res.status(400).json({ ok: false, error: "Material fehlt." });

      const need = ["urgent_today", "tomorrow", "document"].includes(String(req.body?.need))
        ? String(req.body.need)
        : "document";
      const requestType = ["consumption", "missing", "new_material"].includes(String(req.body?.requestType))
        ? String(req.body.requestType)
        : "missing";
      const now = new Date();
      const createdDate = localDateISO(now);
      const createdMinutes = Number(viennaParts(now).hour) * 60 + Number(viennaParts(now).minute);

      const row = {
        id: `mat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        employeeId: String(req.body?.employeeId || "").slice(0, 100),
        employeeName: String(req.body?.employeeName || "").trim().slice(0, 140),
        jobId: String(req.body?.jobId || "").slice(0, 80),
        jobName: String(req.body?.jobName || "").trim().slice(0, 180),
        materialText,
        note: String(req.body?.note || "").trim().slice(0, 500),
        requestType,
        need,
        needLabel: materialNeedLabel(need),
        status: "open",
        newMaterial: requestType === "new_material",
        createdAt: now.toISOString(),
        createdDate,
        summaryNotifiedAt: null,
        directNotifiedAt: null,
      };

      const rows = await readJson(MATERIAL_REQUESTS, []);
      rows.push(row);
      await writeJson(MATERIAL_REQUESTS, rows.slice(-5000));
      await appendEvent({
        type: "material_request_created",
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        jobId: row.jobId,
        detail: `${row.needLabel}: ${row.materialText}`,
      });

      let notification = { sent: false, reason: "not_required" };
      if (need === "urgent_today") {
        notification = await sendMaterialAlert(row, "urgent");
      } else if (need === "tomorrow" && createdMinutes >= 15 * 60) {
        notification = await sendMaterialAlert(row, "late");
      }
      if (notification.sent) {
        row.directNotifiedAt = new Date().toISOString();
        const latest = await readJson(MATERIAL_REQUESTS, []);
        const found = latest.find(item => item.id === row.id);
        if (found) found.directNotifiedAt = row.directNotifiedAt;
        await writeJson(MATERIAL_REQUESTS, latest);
      }

      res.json({ ok: true, request: row, notification });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.patch("/kristine/api/material-requests/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await readJson(MATERIAL_REQUESTS, []);
      const row = rows.find(item => String(item.id) === String(req.params.id));
      if (!row) return res.status(404).json({ ok: false, error: "Materialaufgabe nicht gefunden." });

      const status = String(req.body?.status || "");
      if (!["open", "stocked", "ordered"].includes(status)) {
        return res.status(400).json({ ok: false, error: "Ungültiger Status." });
      }

      const previousStatus = row.status;
      row.status = status;
      row.availableAt = String(req.body?.availableAt || "").trim().slice(0, 120);
      row.responseNote = String(req.body?.responseNote || "").trim().slice(0, 500);
      row.respondedBy = String(req.body?.respondedBy || "").trim().slice(0, 140);
      row.updatedAt = new Date().toISOString();

      let notification = { sent: false, reason: "not_required" };
      if (["stocked", "ordered"].includes(status)) {
        row.respondedAt = new Date().toISOString();
        row.employeeReadAt = null;
        notification = await sendMaterialResponseToEmployee(row);
        row.employeeNotifiedAt = notification.sent ? new Date().toISOString() : null;
        row.employeeNotification = notification;
      }

      await writeJson(MATERIAL_REQUESTS, rows);
      await appendEvent({
        type: "material_request_updated",
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        jobId: row.jobId,
        detail: `${previousStatus || "open"} → ${status}: ${row.materialText}`,
      });

      res.json({ ok: true, request: row, notification });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/material-responses/:employeeId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await readJson(MATERIAL_REQUESTS, []);
      const employeeId = String(req.params.employeeId || "");
      const responses = rows
        .filter(row =>
          String(row.employeeId || "") === employeeId &&
          ["stocked", "ordered"].includes(String(row.status || "")) &&
          row.respondedAt &&
          !row.employeeReadAt
        )
        .sort((a, b) => String(b.respondedAt).localeCompare(String(a.respondedAt)));
      res.json({ ok: true, responses });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/material-responses/:id/read", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await readJson(MATERIAL_REQUESTS, []);
      const row = rows.find(item => String(item.id) === String(req.params.id));
      if (!row) return res.status(404).json({ ok: false, error: "Materialmeldung nicht gefunden." });
      row.employeeReadAt = new Date().toISOString();
      await writeJson(MATERIAL_REQUESTS, rows);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  const materialSummaryTimer = setInterval(async () => {
    try {
      const p = viennaParts();
      if (Number(p.hour) !== 15 || Number(p.minute) > 4) return;
      const state = await readJson(MATERIAL_NOTIFY_STATE, {});
      const today = localDateISO();
      if (state.lastSummaryDate === today) return;
      const result = await sendMaterialSummary(today);
      if (result.sent || result.reason === "nothing_open") {
        await writeJson(MATERIAL_NOTIFY_STATE, { ...state, lastSummaryDate: today, updatedAt: new Date().toISOString() });
      }
    } catch (error) {
      console.error("Material-15-Uhr-Prüfung fehlgeschlagen:", error);
    }
  }, 60 * 1000);
  materialSummaryTimer.unref?.();


  app.get("/kristine/api/bootstrap", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const [bootstrap, employeeWorkRules] = await Promise.all([
        getBootstrap(),
        readJson(EMPLOYEE_WORK_RULES, {}),
      ]);
      res.json({ ok: true, ...bootstrap, employeeWorkRules, today: localDateISO() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });



  // ===================== KRISTOOL GPS / Tagesfolie =====================
  app.post("/kristine/api/gps/import", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const filename = String(req.body?.filename || "gps.csv").slice(0, 180);
      const content = String(req.body?.content || "");
      if (!content.trim()) return res.status(400).json({ ok: false, error: "CSV-Datei ist leer." });
      const sourceRows = parseCsvRows(content, ";");
      if (!sourceRows.length) return res.status(400).json({ ok: false, error: "Keine GPS-Zeilen erkannt." });
      const rows = sourceRows.map(cleanGpsRow).filter(row => row.date && row.startTime);
      const employees = typeof readEmployees === "function" ? await readEmployees() : [];
      const id = `gps_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
      const data = { id, filename, importedAt: new Date().toISOString(), mappings: {}, rows };
      reconcileGpsMappings(data, employees);
      await writeGpsImport(data);
      await appendEvent({ type: "gps_csv_imported", detail: `${rows.length} GPS-Fahrten aus ${filename}`, source: "office" });
      res.json({ ok: true, import: gpsImportSummary(data) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/gps/imports/latest", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await readGpsImport("latest");
      const employees = typeof readEmployees === "function" ? await readEmployees() : [];
      if (data && reconcileGpsMappings(data, employees)) await writeGpsImport(data);
      res.json({ ok: true, import: gpsImportSummary(data) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/gps/day", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await readGpsImport(String(req.query.importId || "latest"));
      if (!data) return res.json({ ok: true, rows: [], mapping: null });
      const driverKey = String(req.query.driverKey || "");
      const date = String(req.query.date || "").slice(0, 10);
      const rows = (data.rows || []).filter(row => (!driverKey || row.driverKey === driverKey) && (!date || row.date === date));
      res.json({ ok: true, importId: data.id, rows, mapping: data.mappings?.[driverKey] || null });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });



  // 0023.43 · Finkzeit-Personalnummer = führende Mitarbeiter-Identität.
  function finkzeitPersonnelNumber(employee) {
    return String(
      employee?.finkzeitPersonnelNumber ||
      employee?.finkzeitPersonalNumber ||
      employee?.personalnummerFinkzeit ||
      employee?.personnelNumber ||
      ""
    ).trim();
  }

  function normalizeEmployeeIdentityName(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function findEmployeeMaster(employees, ref = {}) {
    const wantedFink=String(
      ref.finkzeitPersonnelNumber ||
      ref.finkzeitPersonalNumber ||
      ref.personalnummerFinkzeit ||
      ref.personnelNumber ||
      ""
    ).trim();
    if(wantedFink){
      const byFink=(employees||[]).find(e=>finkzeitPersonnelNumber(e)===wantedFink);
      if(byFink)return byFink;
    }

    const wantedId=String(ref.employeeId||ref.id||"").trim();
    if(wantedId){
      const byId=(employees||[]).find(e=>String(e.id||e.employeeId||"").trim()===wantedId);
      if(byId)return byId;
    }

    const wantedName=normalizeEmployeeIdentityName(ref.employeeName||ref.name||"");
    if(wantedName){
      const byName=(employees||[]).find(e=>
        normalizeEmployeeIdentityName(e.name||e.employeeName||e.nickname||"")===wantedName
      );
      if(byName)return byName;
    }
    return null;
  }

  function assignmentAbsenceType(assignment) {
    const raw=[
      assignment?.cardType, assignment?.assignmentType, assignment?.type,
      assignment?.category, assignment?.status, assignment?.reason,
      assignment?.jobId, assignment?.jobName, assignment?.name, assignment?.note
    ].map(v=>String(v||"").trim().toLowerCase()).join(" ");

    if (/(^|[^a-z])urlaub([^a-z]|$)|vacation/.test(raw)) return "urlaub";
    if (/(^|[^a-z])krank([^a-z]|$)|krankenstand|(^|[^a-z])sick([^a-z]|$)/.test(raw)) return "krank";
    if (/(^|[^a-z])arzt([^a-z]|$)|arzttermin/.test(raw)) return "arzt";
    if (/feiertag|holiday/.test(raw)) return "feiertag";
    if (/zeitausgleich|(^|[^a-z])za([^a-z]|$)/.test(raw)) return "za";
    return "";
  }

  function employeeAbsenceForDay(assignments, employee, date) {
    const employeeId=String(employee?.id||employee?.employeeId||"").trim();
    const employeeName=normalizeEmployeeIdentityName(employee?.name||employee?.employeeName||employee?.nickname||"");
    const fink=finkzeitPersonnelNumber(employee);

    const rows=(assignments||[]).filter(a=>{
      if(String(a.date||a.day||"").slice(0,10)!==String(date))return false;

      const rowFink=String(
        a.finkzeitPersonnelNumber ||
        a.finkzeitPersonalNumber ||
        a.personalnummerFinkzeit ||
        a.personnelNumber ||
        ""
      ).trim();

      if(fink && rowFink && fink===rowFink)return true;
      if(employeeId && String(a.employeeId||a.id||"").trim()===employeeId)return true;

      const rowName=normalizeEmployeeIdentityName(a.employeeName||a.name||"");
      return Boolean(employeeName && rowName && employeeName===rowName);
    });

    for(const row of rows){
      const type=assignmentAbsenceType(row);
      if(type)return {type,row};
    }
    return null;
  }


  // KRISTOOL · Mitarbeiter-Arbeitslogik.
  // Fehlende Einträge sind bewusst: Produktiv + BUAK Nein.
  app.get("/kristine/api/employee-work-rules", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rules=await readJson(EMPLOYEE_WORK_RULES,{});
    res.json({ok:true,rules});
  });

  app.put("/kristine/api/employee-work-rules", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try{
      const incoming=req.body?.rules&&typeof req.body.rules==="object"?req.body.rules:{};
      const clean={};
      for(const [employeeId,row] of Object.entries(incoming)){
        const id=String(employeeId||"").trim().slice(0,120);
        if(!id)continue;
        const activityMode=["productive","partial","unproductive"].includes(row?.activityMode)?row.activityMode:"productive";
        clean[id]={activityMode,buak:row?.buak===true};
      }
      await writeJson(EMPLOYEE_WORK_RULES,clean);
      res.json({ok:true,rules:clean});
    }catch(error){res.status(500).json({ok:false,error:String(error?.message||error)})}
  });

  // KRISTOOL Tagesarbeitsliste:
  // 1) tatsächliche Fahrer aus GPS
  // 2) danach Teammitglieder ohne eigene Fahrt
  app.get("/kristine/api/day-queue/:date", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const date = String(req.params.date || localDateISO()).slice(0, 10);
      const [gpsData, employees, events, states, corrections, releases, assignments, employeeWorkRules] = await Promise.all([
        readGpsImport("latest"),
        typeof readEmployees === "function" ? readEmployees() : [],
        readJson(TIME_EVENTS, []),
        readJson(STATES, {}),
        readJson(DAY_CORRECTIONS, []),
        readJson(DAY_RELEASES, []),
        readJson(ASSIGNMENTS, []),
        readJson(EMPLOYEE_WORK_RULES, {}),
      ]);

      if (gpsData && reconcileGpsMappings(gpsData, employees)) {
        await writeGpsImport(gpsData);
      }

      const items = [];
      const activeEmployees = (employees || []).filter(employee =>
        employee && employee.active !== false && employee.archived !== true
      );

      for (const employee of activeEmployees) {
        const employeeId = String(employee.id || employee.employeeId || "").trim();
        if (!employeeId) continue;
        const employeeName = employeeEverydayName(employee) || employeeId;

        const gpsDay = gpsEmployeeDay(gpsData, employeeId, date);
        const ownRows = gpsDay.ownRows || [];
        const passengerRows = gpsDay.passengerRows || [];
        const segments = buildEditableSegments(
          events,
          employeeId,
          date,
          states[employeeId] || {}
        );
        const correction = (corrections || []).find(row =>
          String(row.employeeId) === employeeId && String(row.date) === date
        );

        const vehicleMap = new Map();
        for (const row of ownRows) {
          const key = `${row.licensePlate || ""}|${row.vehicleName || ""}`;
          if (!vehicleMap.has(key)) {
            vehicleMap.set(key, {
              licensePlate: String(row.licensePlate || ""),
              vehicleName: String(row.vehicleName || ""),
            });
          }
        }

        const passengerDrivers = [...new Set(
          passengerRows
            .map(row => String(row.driver?.employeeName || row.effectiveDriver?.employeeName || "").trim())
            .filter(Boolean)
        )];

        const driverKeys = [...new Set(ownRows.map(row => String(row.driverKey || "")).filter(Boolean))];
        const employeeFinkzeit=finkzeitPersonnelNumber(employee);
        const absence=employeeAbsenceForDay(assignments,employee,date);
        const employeeRule=(employeeWorkRules||{})[employeeId]||{activityMode:"productive",buak:false};

        items.push({
          employeeId,
          employeeName,
          finkzeitPersonnelNumber: employeeFinkzeit,
          employeeIdentityKey: employeeFinkzeit ? `fink:${employeeFinkzeit}` : `legacy:${employeeId}`,
          activityMode:employeeRule.activityMode||"productive",
          buak:employeeRule.buak===true,
          role: ownRows.length ? "driver" : "team",
          driverKey: driverKeys[0] || "",
          ownTripCount: ownRows.length,
          distanceKm: ownRows.reduce((sum, row) => sum + Number(row.distanceKm || 0), 0),
          vehicles: [...vehicleMap.values()],
          passengerDrivers,
          passengerRideCount: passengerRows.length,
          segmentCount: segments.length,
          copiedCorrection: Boolean(
            correction &&
            (
              String(correction.reason || "").toLowerCase().includes("team") ||
              String(correction.note || "").toLowerCase().includes("team") ||
              (correction.history || []).some(entry =>
                String(entry.note || "").toLowerCase().includes("team")
              )
            )
          ),
          corrected: Boolean(correction?.updatedAt),
          released: Boolean((releases || []).find(row =>
            String(row.date)===date &&
            row.released===true &&
            (
              (employeeFinkzeit && String(row.finkzeitPersonnelNumber||"")===employeeFinkzeit) ||
              String(row.employeeId)===employeeId
            )
          )),
          absenceType: absence?.type || "",
          absenceLabel: String(absence?.row?.jobName || absence?.row?.reason || absence?.row?.note || ""),
          gpsTripCount: ownRows.length,
        });
      }

      items.sort((a, b) =>
        (a.role === b.role ? 0 : a.role === "driver" ? -1 : 1) ||
        a.employeeName.localeCompare(b.employeeName, "de")
      );

      res.json({
        ok: true,
        date,
        items,
        drivers: items.filter(item => item.role === "driver").length,
        team: items.filter(item => item.role !== "driver").length,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/gps/employee-day", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await readGpsImport(String(req.query.importId || "latest"));
      if (!data) return res.json({ ok: true, ownRows: [], passengerRows: [] });
      const employees = typeof readEmployees === "function" ? await readEmployees() : [];
      if (reconcileGpsMappings(data, employees)) await writeGpsImport(data);
      const employeeId = String(req.query.employeeId || "");
      const date = String(req.query.date || "").slice(0, 10);
      if (!employeeId || !date) return res.status(400).json({ ok: false, error: "Mitarbeiter und Datum fehlen." });
      res.json({ ok: true, importId: data.id, ...gpsEmployeeDay(data, employeeId, date) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/kristine/api/gps/imports/:importId/mapping", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await readGpsImport(String(req.params.importId || "latest"));
      if (!data) return res.status(404).json({ ok: false, error: "GPS-Import nicht gefunden." });
      const driverKey = String(req.body?.driverKey || "");
      const employeeId = String(req.body?.employeeId || "");
      const employeeName = String(req.body?.employeeName || "");
      if (!driverKey) return res.status(400).json({ ok: false, error: "Fahrer fehlt." });
      data.mappings = data.mappings || {};
      data.mappings[driverKey] = { employeeId, employeeName, autoMatched: false, updatedAt: new Date().toISOString() };
      await writeGpsImport(data);
      res.json({ ok: true, import: gpsImportSummary(data) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/kristine/api/gps/imports/:importId/rows/:rowId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await readGpsImport(String(req.params.importId || "latest"));
      if (!data) return res.status(404).json({ ok: false, error: "GPS-Import nicht gefunden." });
      const row = (data.rows || []).find(item => String(item.id) === String(req.params.rowId));
      if (!row) return res.status(404).json({ ok: false, error: "GPS-Fahrt nicht gefunden." });
      const changedAt = new Date().toISOString();
      row.changeHistory = Array.isArray(row.changeHistory) ? row.changeHistory : [];
      if (typeof req.body?.isPrivate === "boolean") {
        row.changeHistory.push({ at: changedAt, type: "private", from: !!row.isPrivate, to: req.body.isPrivate, by: "Bettina / Büro" });
        row.isPrivate = req.body.isPrivate;
        row.privateMarkedAt = changedAt;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "assignedEmployeeId")) {
        const oldDriver = effectiveGpsDriver(data, row);
        const assignedEmployeeId = String(req.body?.assignedEmployeeId || "");
        const assignedEmployeeName = String(req.body?.assignedEmployeeName || "");
        row.assignedEmployeeId = assignedEmployeeId;
        row.assignedEmployeeName = assignedEmployeeName;
        row.assignmentUpdatedAt = changedAt;
        row.changeHistory.push({
          at: changedAt,
          type: "driver_changed",
          from: { employeeId: oldDriver.employeeId, employeeName: oldDriver.employeeName },
          to: { employeeId: assignedEmployeeId, employeeName: assignedEmployeeName },
          by: "Bettina / Büro",
        });
      }
      if (Array.isArray(req.body?.passengers)) {
        const cleanPassengers = req.body.passengers
          .map(item => ({ employeeId: String(item.employeeId || ""), employeeName: String(item.employeeName || "").trim() }))
          .filter(item => item.employeeId)
          .filter((item, index, list) => list.findIndex(other => other.employeeId === item.employeeId) === index);
        row.changeHistory.push({ at: changedAt, type: "passengers_changed", from: row.passengers || [], to: cleanPassengers, by: "Bettina / Büro" });
        row.passengers = cleanPassengers;
      }
      await writeGpsImport(data);
      res.json({ ok: true, row: { ...row, effectiveDriver: effectiveGpsDriver(data, row) }, import: gpsImportSummary(data) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/kristine/api/assignments", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
      const employeeMaster = typeof readEmployees === "function" ? await readEmployees().catch(()=>[]) : [];
      const clean = rows.map((a, index) => {
        const master=findEmployeeMaster(employeeMaster,a)||{};
        const fink=String(
          a.finkzeitPersonnelNumber ||
          a.finkzeitPersonalNumber ||
          a.personalnummerFinkzeit ||
          a.personnelNumber ||
          finkzeitPersonnelNumber(master) ||
          ""
        ).trim();
        return ({
        id: String(a.id || `a_${Date.now()}_${index}`),
        date: String(a.date || "").slice(0, 10),
        cardType: String(a.cardType || a.assignmentType || a.type || "").trim().toLowerCase().slice(0,40),
        jobId: String(a.jobId || "").slice(0, 80),
        jobName: String(a.jobName || "").trim().slice(0, 140),
        city: String(a.city || "").trim().slice(0, 100),
        address: String(a.address || "").trim().slice(0, 300),
        contactName: String(a.contactName || "").trim().slice(0, 140),
        contactPhone: String(a.contactPhone || "").trim().slice(0, 80),
        employeeId: String(master.id || master.employeeId || a.employeeId || "").slice(0, 100),
        employeeName: String(master.name || master.employeeName || a.employeeName || "").trim().slice(0, 140),
        finkzeitPersonnelNumber: fink.slice(0,40),
        employeeIdentityKey: fink ? `fink:${fink}` : `legacy:${String(master.id || master.employeeId || a.employeeId || "").slice(0,100)}`,
        vehicle: String(a.vehicle || "").trim().slice(0, 100),
        from: String(a.from || "").slice(0, 5),
        to: String(a.to || "").slice(0, 5),
        note: String(a.note || "").trim().slice(0, 500),
        });
      }).filter(a => a.date && a.employeeId && (a.jobId || a.jobName));
      await writeJson(ASSIGNMENTS, clean);
      if (typeof markJobRunning === "function") {
        for (const jobId of [...new Set(clean.map(a => a.jobId).filter(Boolean))]) {
          await markJobRunning(jobId, "planning").catch(() => false);
        }
      }
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


  function hmFromMinutes(value) {
    const minutes = Math.max(0, Math.min(24 * 60, Math.round(Number(value) || 0)));
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  function buildEditableSegments(events, employeeId, date, state) {
    const rows = events
      .filter((row) => String(row.employeeId) === String(employeeId) && String(row.date) === String(date))
      .map((row, index) => ({ ...row, _index: index, _minutes: minutesFromHM(row.at) }))
      .filter((row) => row._minutes !== null)
      .sort((a, b) => a._minutes - b._minutes || String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a._index - b._index);

    const result = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const type =
        row.type === "start" || row.type === "weiter" ? "work" :
        row.type === "pause" ? "pause" :
        row.type === "mittag" ? "lunch" :
        row.type === "up" ? "up" : null;
      if (!type) continue;
      const next = rows[index + 1];
      let toMinutes = next?._minutes ?? null;
      if (toMinutes === null && ["working", "pause", "lunch"].includes(state?.mode)) {
        toMinutes = minutesFromHM(localTimeHM());
      }
      result.push({
        id: String(row.segmentId || `seg_${employeeId}_${date}_${index}`),
        type,
        from: row.at,
        to: toMinutes === null ? "" : hmFromMinutes(toMinutes),
        jobId: String(row.jobId || ""),
        jobName: String(row.jobName || ""),
        reason: String(row.reason || ""),
        source: String(row.source || "employee"),
      });
    }
    return result;
  }

  function eventTypeForSegment(segment) {
    if (segment.type === "pause") return "pause";
    if (segment.type === "lunch") return "mittag";
    if (segment.type === "up") return "up";
    return "start";
  }

  function entryMinutes(entry) {
    const direct = minutesFromHM(entry.at || entry.time || entry.capturedAt);
    if (direct !== null) return direct;
    const raw = entry.createdAt || entry.timestamp || entry.capturedAt;
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : minutesFromHM(localTimeHM(parsed));
  }


  // Tagesfolien derselben Baustelle für den Teamabgleich.
  // Es werden ausschließlich Mitarbeiter vorgeschlagen, die am selben Tag
  // zumindest einen Arbeitsblock auf einer identischen Baustelle besitzen.
  app.get("/kristine/api/team-candidates/:employeeId/:date", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const sourceEmployeeId = String(req.params.employeeId || "").trim();
      const date = String(req.params.date || localDateISO()).slice(0, 10);
      const [events, states, employees] = await Promise.all([
        readJson(TIME_EVENTS, []),
        readJson(STATES, {}),
        typeof readEmployees === "function" ? readEmployees() : [],
      ]);

      const sourceSegments = buildEditableSegments(
        events,
        sourceEmployeeId,
        date,
        states[sourceEmployeeId] || {}
      );
      const sourceJobMap = new Map();
      sourceSegments
        .filter(segment => segment.type === "work" && segment.jobId)
        .forEach(segment => sourceJobMap.set(
          String(segment.jobId),
          String(segment.jobName || segment.jobId)
        ));

      if (!sourceJobMap.size) {
        return res.json({ ok: true, sourceJobs: [], candidates: [] });
      }

      const candidates = [];
      for (const employee of employees || []) {
        const employeeId = String(employee.id || employee.employeeId || "").trim();
        if (!employeeId || employeeId === sourceEmployeeId) continue;
        const employeeName = employeeEverydayName(employee) || employeeId;
        const segments = buildEditableSegments(
          events,
          employeeId,
          date,
          states[employeeId] || {}
        );
        const sharedJobs = [];
        const seen = new Set();
        for (const segment of segments) {
          const jobId = String(segment.jobId || "");
          if (segment.type !== "work" || !jobId || !sourceJobMap.has(jobId) || seen.has(jobId)) continue;
          seen.add(jobId);
          sharedJobs.push({ jobId, jobName: sourceJobMap.get(jobId) || segment.jobName || jobId });
        }
        if (!sharedJobs.length) continue;
        candidates.push({
          employeeId,
          employeeName,
          sharedJobs,
          segmentCount: segments.length,
        });
      }

      candidates.sort((a, b) => a.employeeName.localeCompare(b.employeeName, "de"));
      res.json({
        ok: true,
        sourceJobs: [...sourceJobMap].map(([jobId, jobName]) => ({ jobId, jobName })),
        candidates,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });


  // KRISTOOL 0023.43 · endgültige Tagesfreigabe
  app.get("/kristine/api/day-release/:employeeId/:date", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId=String(req.params.employeeId||"").trim();
      const date=String(req.params.date||localDateISO()).slice(0,10);
      const employees=typeof readEmployees==="function"?await readEmployees().catch(()=>[]):[];
      const master=findEmployeeMaster(employees,{employeeId})||{};
      const fink=finkzeitPersonnelNumber(master);
      const releases=await readJson(DAY_RELEASES,[]);
      const release=releases.find(row=>
        String(row.date)===date &&
        (
          (fink && String(row.finkzeitPersonnelNumber||"")===fink) ||
          String(row.employeeId)===employeeId
        )
      )||null;
      res.json({ok:true,release});
    } catch(error) {
      res.status(500).json({ok:false,error:String(error?.message||error)});
    }
  });

  app.put("/kristine/api/day-release/:employeeId/:date", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId=String(req.params.employeeId||"").trim();
      const date=String(req.params.date||localDateISO()).slice(0,10);
      if(!employeeId||!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ok:false,error:"Mitarbeiter oder Datum fehlt."});
      const checks=req.body?.checks&&typeof req.body.checks==="object"?req.body.checks:{};
      const required=["times","regie","close","diet","fl","ch"];
      if(required.some(key=>checks[key]!==true)) return res.status(400).json({ok:false,error:"Bitte alle Kontrollpunkte bestätigen."});
      const reviewer=String(req.body?.reviewer||"").trim().slice(0,120);
      if(!reviewer) return res.status(400).json({ok:false,error:"Name der Kontrolle fehlt."});
      const employeeName=String(req.body?.employeeName||employeeId).trim().slice(0,160);
      const note=String(req.body?.note||"").trim().slice(0,300);
      const employees=typeof readEmployees==="function"?await readEmployees().catch(()=>[]):[];
      const master=findEmployeeMaster(employees,{employeeId,employeeName})||{};
      const fink=finkzeitPersonnelNumber(master);
      const releases=await readJson(DAY_RELEASES,[]);
      let release=releases.find(row=>
        String(row.date)===date &&
        (
          (fink && String(row.finkzeitPersonnelNumber||"")===fink) ||
          String(row.employeeId)===employeeId
        )
      );
      const now=new Date().toISOString();
      if(!release){
        release={id:`release_${employeeId}_${date}`,employeeId,date,createdAt:now};
        releases.push(release);
      }
      Object.assign(release,{
        employeeId:String(master.id||master.employeeId||employeeId),
        employeeName:String(master.name||master.employeeName||employeeName),
        finkzeitPersonnelNumber:fink,
        employeeIdentityKey:fink?`fink:${fink}`:`legacy:${String(master.id||master.employeeId||employeeId)}`,
        checks:{...checks},reviewer,note,released:true,releasedAt:now,updatedAt:now
      });
      await writeJson(DAY_RELEASES,releases);
      res.json({ok:true,release});
    } catch(error) {
      res.status(500).json({ok:false,error:String(error?.message||error)});
    }
  });

  app.get("/kristine/api/segments/:employeeId/:date", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.params.employeeId || "");
      const date = String(req.params.date || localDateISO()).slice(0, 10);
      const [events, states, corrections] = await Promise.all([
        readJson(TIME_EVENTS, []), readJson(STATES, {}), readJson(DAY_CORRECTIONS, []),
      ]);
      const segments = buildEditableSegments(events, employeeId, date, states[employeeId] || {});
      const correction = corrections.find(row => String(row.employeeId) === employeeId && String(row.date) === date) || null;
      res.json({
        ok: true,
        segments,
        originalSegments: correction?.originalSegments || segments,
        correction: correction ? {
          reason: correction.reason || "",
          note: correction.note || "",
          updatedAt: correction.updatedAt || null,
          updatedBy: correction.updatedBy || "Büro",
          history: Array.isArray(correction.history) ? correction.history.slice(-20) : [],
        } : null,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });


  // KRISTOOL 0023.43 · Diätenbericht 16.–15.
  app.get("/kristine/api/diet-report", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const from = String(req.query?.from || "").slice(0, 10);
      const to = String(req.query?.to || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return res.status(400).json({ ok:false, error:"Zeitraum prüfen." });
      }

      const [allEvents, states, corrections, employees] = await Promise.all([
        readJson(TIME_EVENTS, []),
        readJson(STATES, {}),
        readJson(DAY_CORRECTIONS, []),
        typeof readEmployees === "function" ? readEmployees() : [],
      ]);

      const dates = [];
      for (let d = new Date(`${from}T12:00:00`), e = new Date(`${to}T12:00:00`); d <= e; d.setDate(d.getDate()+1)) {
        dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
      }

      const cleanText = value => String(value || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      const dietMarker = /\s*\[\[DIET:taggeld=(auto|0|1);fl=(auto|0|1);ch=(auto|0|1)\]\]\s*$/i;
      const parseOverride = note => {
        const m = String(note || "").match(dietMarker);
        return m ? { taggeld:m[1].toLowerCase(), fl:m[2].toLowerCase(), ch:m[3].toLowerCase() }
                 : { taggeld:"auto", fl:"auto", ch:"auto" };
      };
      const finalFlag = (override, automatic) =>
        override === "1" ? 1 : override === "0" ? 0 : (automatic ? 1 : 0);

      const minutesOf = segment => {
        const a = minutesFromHM(segment.from);
        const b = minutesFromHM(segment.to);
        return a === null || b === null || b <= a ? 0 : b - a;
      };

      const jobCache = new Map();
      const jobMetaFor = async jobId => {
        const key = String(jobId || "").trim();
        if (!key || typeof readJobMeta !== "function") return {};
        if (jobCache.has(key)) return jobCache.get(key);
        let meta = {};
        try { meta = await readJobMeta(key) || {}; } catch {}
        jobCache.set(key, meta);
        return meta;
      };

      const countryFor = meta => {
        const text = cleanText([
          meta.address, meta.street, meta.houseNumber, meta.postalCode,
          meta.city, meta.country, meta.countryCode
        ].filter(Boolean).join(" "));
        if (/liechtenstein|lichtenstein|\bfl[-\s]?\d{4}\b|\b94(?:8[5-9]|9[0-8])\b/.test(text)) return "FL";
        if (/schweiz|switzerland|suisse|svizzera|\bch[-\s]?\d{4}\b/.test(text)) return "CH";
        return "";
      };

      const isInternal = (segment, meta) => {
        const text = cleanText([
          segment.jobName, segment.reason, meta.name, meta.jobName,
          meta.address, meta.city
        ].filter(Boolean).join(" "));
        return /\b(buro|buero|firma|werkstatt|lager|intern)\b/.test(text);
      };

      const personalNo = employee => String(
        employee.finkzeitPersonnelNumber ||
        employee.finkzeitPersonalNumber ||
        employee.personalnummerFinkzeit ||
        employee.personnelNumber ||
        employee.personalNumber ||
        employee.employeeNumber ||
        employee.number ||
        ""
      ).trim();

      const people = [...(employees || [])]
        .filter(employee => employee && (employee.id || employee.employeeId))
        .sort((a,b) => {
          const an = personalNo(a), bn = personalNo(b);
          const ax = /^\d+$/.test(an) ? Number(an) : Number.MAX_SAFE_INTEGER;
          const bx = /^\d+$/.test(bn) ? Number(bn) : Number.MAX_SAFE_INTEGER;
          return ax - bx || an.localeCompare(bn, "de", {numeric:true}) ||
            String(a.name || "").localeCompare(String(b.name || ""), "de");
        });

      const reportEmployees = [];
      for (const employee of people) {
        const employeeId = String(employee.id || employee.employeeId);
        const employeeName = String(employee.name || employee.employeeName || employee.nickname || employeeId);
        const rows = [];

        for (const date of dates) {
          const segments = buildEditableSegments(allEvents, employeeId, date, states[employeeId] || {});
          let siteMinutes = 0, flMinutes = 0, chMinutes = 0;

          for (const segment of segments) {
            if (segment.type !== "work") continue;
            const duration = minutesOf(segment);
            if (!duration) continue;

            const meta = await jobMetaFor(segment.jobId);
            if (!isInternal(segment, meta)) siteMinutes += duration;

            const country = countryFor(meta);
            if (country === "FL") flMinutes += duration;
            if (country === "CH") chMinutes += duration;
          }

          const correction = corrections.find(row =>
            String(row.employeeId) === employeeId && String(row.date) === date
          );
          const override = parseOverride(correction?.note || "");

          rows.push({
            date,
            taggeld: finalFlag(override.taggeld, siteMinutes > 180),
            flMinutes,
            flDay: finalFlag(override.fl, flMinutes > 0),
            chMinutes,
            chDay: finalFlag(override.ch, chMinutes > 0),
          });
        }

        reportEmployees.push({
          employeeId,
          employeeName,
          personalNumber: personalNo(employee),
          rows,
        });
      }

      res.json({ ok:true, from, to, employees:reportEmployees });
    } catch (error) {
      res.status(500).json({ ok:false, error:String(error?.message || error) });
    }
  });

  app.put("/kristine/api/segments/:employeeId/:date", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.params.employeeId || "").trim();
      const date = String(req.params.date || localDateISO()).slice(0, 10);
      const employeeName = String(req.body?.employeeName || employeeId).trim();
      const correctionReason = String(req.body?.reason || "").trim().slice(0, 160);
      const correctionNote = String(req.body?.note || "").trim().slice(0, 500);
      const correctedBy = String(req.body?.correctedBy || "Bettina / Büro").trim().slice(0, 120);
      const copiedFromRaw = req.body?.copiedFrom && typeof req.body.copiedFrom === "object" ? req.body.copiedFrom : null;
      const copiedFrom = copiedFromRaw ? { employeeId: String(copiedFromRaw.employeeId || "").slice(0, 100), employeeName: String(copiedFromRaw.employeeName || "").trim().slice(0, 160) } : null;
      const moveLinked = true; // Zeitblock ist die Wahrheit: verknüpfte Einträge werden immer mitgeführt.
      const incoming = Array.isArray(req.body?.segments) ? req.body.segments : [];
      const segments = incoming.map((segment, index) => ({
        id: String(segment.id || `seg_${Date.now()}_${index}`),
        type: ["work", "pause", "lunch", "up"].includes(segment.type) ? segment.type : "work",
        from: String(segment.from || "").slice(0, 5),
        to: String(segment.to || "").slice(0, 5),
        jobId: String(segment.jobId || "").slice(0, 80),
        jobName: String(segment.jobName || "").trim().slice(0, 140),
        reason: String(segment.reason || "").trim().slice(0, 140),
      })).filter((segment) => minutesFromHM(segment.from) !== null && (!segment.to || minutesFromHM(segment.to) !== null));

      segments.sort((a, b) => minutesFromHM(a.from) - minutesFromHM(b.from));
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const from = minutesFromHM(segment.from);
        const to = segment.to ? minutesFromHM(segment.to) : null;
        if (to !== null && to <= from) throw new Error(`Ungültiger Zeitraum ${segment.from}–${segment.to}`);
        if (index > 0) {
          const previous = segments[index - 1];
          const previousTo = previous.to ? minutesFromHM(previous.to) : null;
          if (previousTo === null || previousTo > from) throw new Error("Zeitsegmente überschneiden sich oder ein offenes Segment steht nicht am Ende.");
        }
      }

      const [allEvents, states, reviewEntries, corrections] = await Promise.all([
        readJson(TIME_EVENTS, []), readJson(STATES, {}), readJson(REVIEW_ENTRIES, []), readJson(DAY_CORRECTIONS, []),
      ]);
      const oldSegments = buildEditableSegments(allEvents, employeeId, date, states[employeeId] || {});
      let correction = corrections.find(row => String(row.employeeId) === employeeId && String(row.date) === date);
      if (!correction) {
        correction = {
          id: `corr_${employeeId}_${date}`,
          employeeId, employeeName, date,
          originalSegments: oldSegments,
          history: [],
          createdAt: new Date().toISOString(),
        };
        corrections.push(correction);
      }
      correction.employeeName = employeeName;
      correction.reason = correctionReason;
      correction.note = correctionNote;
      correction.updatedBy = correctedBy;
      correction.updatedAt = new Date().toISOString();
      correction.history = Array.isArray(correction.history) ? correction.history : [];
      correction.history.push({
        at: correction.updatedAt,
        by: correctedBy,
        reason: correctionReason,
        note: correctionNote,
        before: oldSegments,
        after: segments,
      });
      correction.history = correction.history.slice(-100);
      await writeJson(DAY_CORRECTIONS, corrections);

      const retained = allEvents.filter((row) => !(String(row.employeeId) === employeeId && String(row.date) === date));
      const createdAt = new Date().toISOString();
      const replacement = [];
      for (const segment of segments) {
        replacement.push({
          employeeId, employeeName, date,
          type: eventTypeForSegment(segment), at: segment.from,
          jobId: segment.type === "work" ? segment.jobId : null,
          jobName: segment.type === "work" ? segment.jobName : "",
          reason: segment.type === "up" ? segment.reason : "",
          segmentId: segment.id, source: "office", manual: true, createdAt,
        });
      }
      const last = segments.at(-1);
      // WICHTIG: "Bis" leer = laufender Abschnitt. Speichern darf keinen Ende-Event erzeugen.
      if (last?.to) replacement.push({
        employeeId, employeeName, date, type: "ende", at: last.to,
        jobId: last.type === "work" ? last.jobId : null,
        jobName: last.type === "work" ? last.jobName : "",
        source: "office", manual: true, createdAt,
      });
      await writeJson(TIME_EVENTS, [...retained, ...replacement].slice(-20000));

      let moved = 0;
      if (moveLinked) {
        for (const entry of reviewEntries) {
          if (String(entry.employeeId) !== employeeId || String(entry.date) !== date) continue;
          const minute = entryMinutes(entry);
          if (minute === null) continue;
          const target = segments.find((segment) => segment.type === "work" && minute >= minutesFromHM(segment.from) && (!segment.to || minute < minutesFromHM(segment.to)));
          if (!target) continue;
          if (String(entry.jobId || "") !== String(target.jobId || "")) {
            entry.history = Array.isArray(entry.history) ? entry.history : [];
            entry.history.push({ at: createdAt, action: "job_reassigned_from_time_segment", oldJobId: entry.jobId || null, oldJobName: entry.jobName || "", newJobId: target.jobId || null, newJobName: target.jobName || "", source: "office" });
            entry.jobId = target.jobId || null;
            entry.jobName = target.jobName || "";
            entry.bookingSegmentId = target.id;
            moved += 1;
          } else if (!entry.bookingSegmentId) entry.bookingSegmentId = target.id;
        }
        await writeJson(REVIEW_ENTRIES, reviewEntries);
      }

      // Tagesreport ist nur eine Ansicht: nach Zeitblockänderungen immer neu erzeugen.
      const reportFile = path.join(ROOT, "reports", `Tagesreport_${date}.pdf`);
      await fsp.rm(reportFile, { force: true }).catch(() => {});
      const affectedJobs = new Set([
        ...oldSegments.filter((segment) => segment.type === "work" && segment.jobId).map((segment) => String(segment.jobId)),
        ...segments.filter((segment) => segment.type === "work" && segment.jobId).map((segment) => String(segment.jobId)),
      ]);
      for (const jobId of affectedJobs) {
        await fsp.rm(path.join(dataDir, jobId, "_chronik", `Tagesreport_${date}.pdf`), { force: true }).catch(() => {});
      }

      const state = { ...(states[employeeId] || {}), employeeId, employeeName, timeline: Array.isArray(states[employeeId]?.timeline) ? states[employeeId].timeline : [] };
      if (!segments.length) state.mode = "idle";
      else if (last?.to) state.mode = "finished_day";
      else state.mode = last.type === "pause" ? "pause" : last.type === "lunch" ? "lunch" : "working";
      const active = [...segments].reverse().find((segment) => segment.type === "work");
      if (active) state.activeAssignmentKey = `${date}|${employeeId}|${active.from}|${active.jobId}`;
      state.timeline.push({ at: createdAt, time: localTimeHM(), type: copiedFrom?.employeeId ? "day_segments_copied" : "day_segments_edited", detail: copiedFrom?.employeeId ? `${segments.length} Tagesabschnitt(e) wie ${copiedFrom.employeeName || copiedFrom.employeeId} übernommen` : `${segments.length} Tagesabschnitt(e) durch Büro gespeichert`, source: "office", manual: true, movedLinkedEntries: moved, copiedFrom });
      state.timeline = state.timeline.slice(-200);
      states[employeeId] = state;
      await writeJson(STATES, states);
      await appendEvent({ type: copiedFrom?.employeeId ? "day_segments_copied" : "day_segments_edited", employeeId, employeeName, date, segmentCount: segments.length, movedLinkedEntries: moved, source: "office", copiedFrom });
      res.json({
        ok: true,
        segments,
        originalSegments: correction.originalSegments || oldSegments,
        correction: {
          reason: correction.reason || "",
          note: correction.note || "",
          updatedAt: correction.updatedAt,
          updatedBy: correction.updatedBy,
          history: correction.history.slice(-20),
        },
        movedLinkedEntries: moved,
        state,
        previousSegments: oldSegments.length,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/manual-action", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.body?.employeeId || "").trim();
      const employeeName = String(req.body?.employeeName || employeeId).trim();
      const date = String(req.body?.date || localDateISO()).slice(0, 10);
      const action = String(req.body?.action || "").trim().toLowerCase();
      const at = String(req.body?.at || localTimeHM()).slice(0, 5);
      const jobId = String(req.body?.jobId || "").trim().slice(0, 80);
      const jobName = String(req.body?.jobName || "").trim().slice(0, 140);
      if (!employeeId) return res.status(400).json({ ok: false, error: "employeeId erforderlich" });
      if (!/^(start|pause|lunch|resume|end)$/.test(action)) return res.status(400).json({ ok: false, error: "Ungültige Aktion" });
      if (minutesFromHM(at) === null) return res.status(400).json({ ok: false, error: "Ungültige Uhrzeit" });

      const [states, assignments] = await Promise.all([readJson(STATES, {}), readJson(ASSIGNMENTS, [])]);
      const state = { ...(states[employeeId] || {}), employeeId, employeeName, timeline: Array.isArray(states[employeeId]?.timeline) ? states[employeeId].timeline : [] };
      const dayAssignments = assignments.filter(a => String(a.date) === date && String(a.employeeId) === employeeId);
      const selected = dayAssignments.find(a => String(a.jobId) === jobId) || activeAssignment(dayAssignments, state) || dayAssignments[0] || null;
      const effectiveJobId = jobId || selected?.jobId || null;
      const effectiveJobName = jobName || selected?.jobName || "";
      const now = new Date().toISOString();
      const map = {
        start: { mode: "working", eventType: "start", timelineType: "work_started", detail: `Arbeitsbeginn manuell ${at}` },
        pause: { mode: "pause", eventType: "pause", timelineType: "pause_started", detail: `Pause manuell ${at}` },
        lunch: { mode: "lunch", eventType: "mittag", timelineType: "lunch_started", detail: `Mittag manuell ${at}` },
        resume: { mode: "working", eventType: "weiter", timelineType: "work_resumed", detail: `Arbeit fortgesetzt / Baustelle gewechselt ${at}` },
        end: { mode: "finished_day", eventType: "ende", timelineType: "day_finished", detail: `Feierabend manuell ${at}` },
      };
      const cfg = map[action];
      state.mode = cfg.mode;
      state.pending = null;
      if (selected && ["start", "resume"].includes(action)) state.activeAssignmentKey = assignmentKey(selected);
      state.timeline.push({ at: now, time: at, type: cfg.timelineType, detail: cfg.detail, assignmentKey: selected ? assignmentKey(selected) : null, jobId: effectiveJobId, jobName: effectiveJobName, source: "office", manual: true });
      state.timeline = state.timeline.slice(-200);
      states[employeeId] = state;
      await writeJson(STATES, states);
      await appendTimeEvent({ employeeId, employeeName, date, type: cfg.eventType, at, jobId: effectiveJobId, jobName: effectiveJobName, createdAt: now, source: "office", manual: true });
      await appendEvent({ type: "manual_time_action", action, employeeId, employeeName, date, at, jobId: effectiveJobId, jobName: effectiveJobName, source: "office" });
      res.json({ ok: true, state, action, at });
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
      const previousTasks = await readJson(TASKS, []);
      const previousIds = new Set(previousTasks.map(t => String(t.id || "")));
      const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
      const employees = typeof readEmployees === "function" ? await readEmployees() : [];
      const employeeById = new Map(employees.map(e => [String(e.id || ""), e]));
      const clean = [];
      for (let index = 0; index < tasks.length; index++) {
        const t = tasks[index] || {};
        const jobId = String(t.jobId || "").slice(0, 80);
        let jobMeta = {};
        if (jobId && typeof readJobMeta === "function") {
          try { jobMeta = await readJobMeta(jobId) || {}; } catch {}
        }
        const row = {
          id: String(t.id || `t_${Date.now()}_${index}`),
          title: String(t.title || "").trim().slice(0, 180),
          assigneeId: String(t.assigneeId || "").slice(0, 100),
          assigneeName: String(t.assigneeName || "").trim().slice(0, 140),
          jobId,
          jobName: String(t.jobName || jobMeta.name || "").trim().slice(0, 140),
          taskType: ["Rückruf","Angebot","Problem","Termin","Reklamation","Sonstiges"].includes(String(t.taskType || "")) ? String(t.taskType) : "Sonstiges",
          priority: ["normal","heute","sofort"].includes(String(t.priority || "")) ? String(t.priority) : "normal",
          creatorId: String(t.creatorId || "admin").slice(0, 100),
          creatorName: String(t.creatorName || "Chef / Büro").trim().slice(0, 140),
          address: String(t.address || [jobMeta.street, jobMeta.houseNumber, [jobMeta.postalCode, jobMeta.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "").trim().slice(0, 300),
          contactName: String(t.contactName || jobMeta.contactName || "").trim().slice(0, 140),
          contactPhone: String(t.contactPhone || jobMeta.contactPhone || "").trim().slice(0, 60),
          contactEmail: String(t.contactEmail || jobMeta.contactEmail || jobMeta.email || "").trim().slice(0, 180),
          dueDate: String(t.dueDate || "").slice(0, 10),
          reminder: String(t.reminder || "").trim().slice(0, 500),
          status: t.status === "done" ? "done" : "open",
          createdAt: t.createdAt || new Date().toISOString(),
          completedAt: t.completedAt || null,
        };
        if (row.title) clean.push(row);
      }
      await writeJson(TASKS, clean);

      const notifications = [];
      const newOpenTasks = clean.filter(t => !previousIds.has(String(t.id)) && t.status !== "done");
      console.log("🧾 Aufgaben gespeichert", { total: clean.length, newOpenTasks: newOpenTasks.length });
      for (const task of newOpenTasks) {
        console.log("🧪 TASK-WA 1/5 Aufgabe erkannt", { taskId: task.id, assigneeId: task.assigneeId, assigneeName: task.assigneeName });
        const employee = employeeById.get(String(task.assigneeId || ""));
        console.log("🧪 TASK-WA 2/5 Mitarbeiter gesucht", { taskId: task.id, found: Boolean(employee), employeeId: employee?.id || null, employeeName: employee?.name || null });
        const employeePhone = String(employee?.phone || "").replace(/\D/g, "");
        console.log("🧪 TASK-WA 3/5 Telefonnummer geprüft", { taskId: task.id, phonePresent: Boolean(employeePhone), phoneTail: employeePhone.slice(-6) || null });
        if (!employeePhone) {
          notifications.push({ taskId: task.id, sent: false, reason: "no_employee_phone" });
          console.error("❌ Aufgaben-WhatsApp: Mitarbeiter-Telefonnummer fehlt", {
            taskId: task.id, assigneeId: task.assigneeId, assigneeName: task.assigneeName,
          });
          continue;
        }
        if (typeof sendWhatsApp !== "function") {
          notifications.push({ taskId: task.id, sent: false, reason: "whatsapp_not_configured" });
          console.error("❌ Aufgaben-WhatsApp: Versandfunktion fehlt", { taskId: task.id });
          continue;
        }
        const priorityLabel = task.priority === "sofort" ? "🔴 Sofort" : task.priority === "heute" ? "🟡 Heute" : "🟢 Normal";
        const lines = [
          `📌 Neue Aufgabe · ${task.taskType || "Aufgabe"}`,
          `*${task.title}*`,
          task.creatorName ? `👤 Von: ${task.creatorName}` : "",
          task.jobName ? `🏗️ ${task.jobName}${task.jobId ? ` (#${task.jobId})` : ""}` : "",
          task.address ? `📍 ${task.address}` : "",
          task.dueDate ? `📅 Fällig: ${task.dueDate.split("-").reverse().join(".")}` : "",
          `Priorität: ${priorityLabel}`,
          task.reminder ? `ℹ️ ${task.reminder}` : "",
          task.contactPhone ? `📞 ${task.contactName ? task.contactName + ": " : ""}${task.contactPhone}` : "",
          task.contactEmail ? `✉️ ${task.contactEmail}` : "",
        ].filter(Boolean);
        try {
          console.log("📤 Aufgaben-WhatsApp wird gesendet", {
            taskId: task.id,
            assigneeId: task.assigneeId,
            assigneeName: task.assigneeName,
            employeePhone,
          });
          console.log("🧪 TASK-WA 4/5 sendWhatsApp wird aufgerufen", { taskId: task.id });
          // Absichtlich ohne eigenen Sonderweg: exakt dieselbe Versandfunktion wie Kristine.
          await sendWhatsApp({
  to: employeePhone,
  reply: lines.join("\n"),
  buttons: [
    { id: `task_call:${task.id}`, title: "Anrufen" },
    { id: `task_done:${task.id}`, title: "Erledigt" }
  ]
});
          console.log("🧪 TASK-WA 5/5 sendWhatsApp erfolgreich beendet", { taskId: task.id });
          notifications.push({ taskId: task.id, sent: true });
          console.log("✅ Aufgaben-WhatsApp versendet", { taskId: task.id, assigneeName: task.assigneeName });
        } catch (error) {
          const reason = String(error?.message || error);
          const reasonCode = error?.metaCode === 131047 || /24.?hour|re-engagement|outside.*window/i.test(reason)
            ? "outside_24h_window"
            : error?.metaCode
              ? `meta_${error.metaCode}`
              : reason;
          notifications.push({ taskId: task.id, sent: false, reason: reasonCode, detail: reason });
          console.error("❌ Aufgaben-WhatsApp fehlgeschlagen", {
            taskId: task.id,
            assigneeId: task.assigneeId,
            assigneeName: task.assigneeName,
            employeePhone,
            reason,
          });
        }
      }
      res.json({ ok: true, tasks: clean, notifications });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  require("./task-escalation-server").installTaskEscalation(app, { dataDir, requireAdmin, sendWhatsApp, readEmployees });

  // Derselbe Dialogkern wird vom Browser-Simulator und vom echten WhatsApp-Webhook verwendet.
  return { handleMessage, localDateISO };
}

module.exports = { registerKristine };
