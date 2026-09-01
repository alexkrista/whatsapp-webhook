// archive-search.js
// Kristine Gehirn – Projekte + Kunden + Zeiten + Dokumente + Nachkalkulation

const fsp = require("fs/promises");
const path = require("path");


const DATA_DIR = process.env.DATA_DIR || "/var/data";
const KRISTINE_TIME_EVENTS_FILE =
  process.env.KRISTINE_TIME_EVENTS_FILE ||
  path.join(DATA_DIR, "_kristine", "time-events.json");

const KRISTINE_EMPLOYEES_FILE =
  process.env.KRISTINE_EMPLOYEES_FILE ||
  path.join(DATA_DIR, "_system", "employees.json");


const KRISTINE_API_BASE = String(
  process.env.KRISTINE_API_BASE || "https://protokoll.krista.at"
).replace(/\/$/, "");

const KRISTINE_ADMIN_TOKEN =
  process.env.KRISTINE_ADMIN_TOKEN ||
  process.env.ADMIN_TOKEN ||
  "";

async function loadKristineBrainSource(runtimeToken = "") {
  const token = String(
    KRISTINE_ADMIN_TOKEN ||
    runtimeToken ||
    ""
  ).trim();

  const url = new URL(
    "/kristine/api/brain-hours-source",
    KRISTINE_API_BASE
  );

  // Browser-Test hat bestätigt: Render akzeptiert den bestehenden ADMIN_TOKEN
  // zuverlässig als Query-Parameter. Deshalb hier bewusst dieselbe Variante.
  if (token) url.searchParams.set("token", token);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  const text = await response.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Keine komplette Render-HTML-Seite ins Gehirn kippen.
    const compact = String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    throw new Error(
      `KRISTINE API HTTP ${response.status}: ${compact || response.statusText || "keine JSON-Antwort"}`
    );
  }

  if (!response.ok || !data?.ok) {
    const detail =
      response.status === 403
        ? "ADMIN_TOKEN fehlt oder ist falsch"
        : String(data?.error || `HTTP ${response.status}`);
    throw new Error(`KRISTINE API HTTP ${response.status}: ${detail}`);
  }

  return {
    events: Array.isArray(data.events) ? data.events : [],
    employees: Array.isArray(data.employees) ? data.employees : [],
    eventCount: Number(data.eventCount || 0),
    employeeCount: Number(data.employeeCount || 0),
    source: String(data.source || "KRISTINE"),
  };
}


function brainMinutesFromHM(value) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function normalizeJobId(value) {
  return String(value || "").trim().replace(/^#/, "");
}

async function readKristineTimeEvents() {
  try {
    const raw = await fsp.readFile(KRISTINE_TIME_EVENTS_FILE, "utf8");
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}


async function readKristineEmployees() {
  try {
    const raw = await fsp.readFile(KRISTINE_EMPLOYEES_FILE, "utf8");
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function finkNumberOf(employee) {
  return String(
    employee?.finkzeitPersonnelNumber ||
    employee?.finkzeitPersonalNumber ||
    employee?.personalnummerFinkzeit ||
    employee?.personalNumberFinkzeit ||
    employee?.personnelNumber ||
    employee?.personalNumber ||
    ""
  ).trim();
}

function normalizeFinkKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return raw.replace(/^0+(?=\d)/, "");
  return raw.toLowerCase();
}

function buildEmployeeIdentityMap(employees) {
  const byId = new Map();
  for (const employee of Array.isArray(employees) ? employees : []) {
    const id = String(employee?.id || employee?.employeeId || "").trim();
    if (!id) continue;
    byId.set(id, {
      employeeId: id,
      employeeName: String(employee?.nickname || employee?.name || employee?.employeeName || id).trim(),
      finkNumber: finkNumberOf(employee),
      finkKey: normalizeFinkKey(finkNumberOf(employee)),
    });
  }
  return byId;
}


function buildKristineProjectHours(events, employeeIdentityMap) {
  const groups = new Map();

  for (const row of Array.isArray(events) ? events : []) {
    const employeeId = String(row?.employeeId || "").trim();
    const identity = employeeIdentityMap?.get(employeeId) || null;
    const employeeName = String(
      row?.employeeName ||
      identity?.employeeName ||
      employeeId ||
      "Unbekannt"
    ).trim();
    const finkNumber = String(identity?.finkNumber || "").trim();
    const finkKey = String(identity?.finkKey || "").trim();
    const date = String(row?.date || "").slice(0, 10);
    const atMinutes = brainMinutesFromHM(row?.at);
    if (!employeeId || !date || atMinutes === null) continue;

    const key = `${employeeId}|${date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      ...row,
      _employeeId: employeeId,
      _employeeName: employeeName,
      _finkNumber: finkNumber,
      _finkKey: finkKey,
      _date: date,
      _minutes: atMinutes,
    });
  }

  const projectMap = new Map();

  function ensureProject(jobId) {
    const id = normalizeJobId(jobId);
    if (!id) return null;
    if (!projectMap.has(id)) {
      projectMap.set(id, {
        jobId: id,
        rawMinutes: 0,
        productiveMinutes: 0,
        breakMinutesAllocated: 0,
        employees: new Map(),
        days: new Set(),
      });
    }
    return projectMap.get(id);
  }

  for (const rows of groups.values()) {
    rows.sort((a, b) =>
      a._minutes - b._minutes ||
      String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
    );

    const dayWork = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const type = String(row.type || "").toLowerCase();
      if (!["start", "weiter"].includes(type)) continue;

      const next = rows[i + 1];
      if (!next) continue;

      const duration = Math.max(0, next._minutes - row._minutes);
      const jobId = normalizeJobId(row.jobId);
      if (!jobId || duration <= 0) continue;

      dayWork.push({
        employeeId: row._employeeId,
        employeeName: row._employeeName,
        finkNumber: row._finkNumber,
        finkKey: row._finkKey,
        date: row._date,
        jobId,
        minutes: duration,
      });
    }

    const totalDayMinutes = dayWork.reduce((sum, row) => sum + row.minutes, 0);
    if (totalDayMinutes <= 0) continue;

    const fixedBreak = Math.min(15, totalDayMinutes);

    for (const work of dayWork) {
      const allocatedBreak = fixedBreak * (work.minutes / totalDayMinutes);
      const productive = Math.max(0, work.minutes - allocatedBreak);

      const project = ensureProject(work.jobId);
      if (!project) continue;

      project.rawMinutes += work.minutes;
      project.productiveMinutes += productive;
      project.breakMinutesAllocated += allocatedBreak;
      project.days.add(`${work.employeeId}|${work.date}`);

      if (!project.employees.has(work.employeeId)) {
        project.employees.set(work.employeeId, {
          employeeId: work.employeeId,
          employeeName: work.employeeName,
          finkNumber: work.finkNumber,
          finkKey: work.finkKey,
          rawMinutes: 0,
          productiveMinutes: 0,
          breakMinutesAllocated: 0,
          days: new Set(),
        });
      }

      const employee = project.employees.get(work.employeeId);
      employee.rawMinutes += work.minutes;
      employee.productiveMinutes += productive;
      employee.breakMinutesAllocated += allocatedBreak;
      employee.days.add(work.date);
    }
  }

  const result = new Map();
  for (const [jobId, row] of projectMap.entries()) {
    result.set(jobId, {
      jobId,
      rawHours: row.rawMinutes / 60,
      productiveHours: row.productiveMinutes / 60,
      breakHours: row.breakMinutesAllocated / 60,
      employeeDays: row.days.size,
      employees: [...row.employees.values()]
        .map(emp => ({
          employeeId: emp.employeeId,
          employeeName: emp.employeeName,
          finkNumber: emp.finkNumber,
          finkKey: emp.finkKey,
          rawHours: emp.rawMinutes / 60,
          productiveHours: emp.productiveMinutes / 60,
          breakHours: emp.breakMinutesAllocated / 60,
          days: emp.days.size,
        }))
        .sort((a, b) =>
          b.productiveHours - a.productiveHours ||
          a.employeeName.localeCompare(b.employeeName, "de")
        ),
    });
  }

  const dayPresence = new Set();
  for (const rows of groups.values()) {
    const first = rows[0];
    if (!first) continue;
    const finkKey = String(first._finkKey || "").trim();
    if (finkKey) dayPresence.add(`${finkKey}|${first._date}`);
  }

  return { projectHours: result, dayPresence };
}

async function loadWwHoursFusionSource(projects) {
  const projectIndices = [...new Set(
    (projects || [])
      .map(p => Number(p.projectIndex))
      .filter(Number.isInteger)
  )];

  if (!projectIndices.length) return [];

  const response = await fetch(`${ARCHIVE_CONNECTOR}/hours-fusion-source`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ projectIndices })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Stundenfusion HTTP ${response.status}`);
  }
  return Array.isArray(data.rows) ? data.rows : [];
}

function groupWwFusionRows(rows, kristineDayPresence) {
  const byProjectIndex = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const projectIndex = Number(row?.projectIndex);
    if (!Number.isInteger(projectIndex)) continue;

    const finkKey = normalizeFinkKey(row?.finkNumber);
    const date = String(row?.date || "").slice(0, 10);
    const overriddenByKristine = Boolean(
      finkKey && date && kristineDayPresence?.has(`${finkKey}|${date}`)
    );

    if (!byProjectIndex.has(projectIndex)) {
      byProjectIndex.set(projectIndex, {
        rawHours: 0,
        netHoursBeforeOverride: 0,
        breakHours: 0,
        effectiveHours: 0,
        overriddenHours: 0,
        rows: [],
      });
    }

    const group = byProjectIndex.get(projectIndex);
    const rawHours = Number(row?.rawHours || 0);
    const netHours = Number(row?.netHours || 0);
    const breakHours = Number(row?.breakHours || 0);

    group.rawHours += rawHours;
    group.netHoursBeforeOverride += netHours;
    group.breakHours += breakHours;

    if (overriddenByKristine) group.overriddenHours += netHours;
    else group.effectiveHours += netHours;

    group.rows.push({
      ...row,
      finkKey,
      overriddenByKristine,
    });
  }

  return byProjectIndex;
}

function attachKristineHours(projects, kristineBundle, wwFusionByProject) {
  const kristineHours = kristineBundle?.projectHours || new Map();
  return (projects || []).map(project => {
    const number = normalizeJobId(project.projectNumber);
    const kristine = kristineHours.get(number) || {
      rawHours: 0,
      productiveHours: 0,
      breakHours: 0,
      employeeDays: 0,
      employees: [],
    };

    const ww = wwFusionByProject?.get(Number(project.projectIndex)) || {
      rawHours: Number(project.hoursTotal || 0),
      netHoursBeforeOverride: Number(project.hoursTotal || 0),
      breakHours: 0,
      effectiveHours: Number(project.hoursTotal || 0),
      overriddenHours: 0,
      rows: [],
    };

    const combinedCurrent =
      Number(ww.effectiveHours || 0) +
      Number(kristine.productiveHours || 0);

    return {
      ...project,
      wwHoursRaw: ww.rawHours,
      wwHoursAfterBreak: ww.netHoursBeforeOverride,
      wwBreakHours: ww.breakHours,
      wwHoursEffective: ww.effectiveHours,
      wwHoursOverriddenByKristine: ww.overriddenHours,
      wwFusionRows: ww.rows,
      kristineHoursRaw: kristine.rawHours,
      kristineHoursProductive: kristine.productiveHours,
      kristineBreakHours: kristine.breakHours,
      kristineEmployeeDays: kristine.employeeDays,
      kristineEmployees: kristine.employees,
      combinedHoursCurrent: combinedCurrent,
    };
  });
}

const ARCHIVE_CONNECTOR =
  process.env.ARCHIVE_CONNECTOR ||
  "http://127.0.0.1:5051";

const BRAIN_PUBLIC_URL =
  process.env.BRAIN_PUBLIC_URL ||
  "https://pc-alex02.tail610122.ts.net";

async function searchArchiveConnector(q) {
  const url = `${ARCHIVE_CONNECTOR}/search?q=${encodeURIComponent(q)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Archiv-Connector HTTP ${response.status}`);
  }
  return data;
}

async function openArchiveConnector(path) {
  const response = await fetch(`${ARCHIVE_CONNECTOR}/open`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Archiv-Connector HTTP ${response.status}`);
  }
  return data;
}

async function loadArchiveThumbnail(path) {
  const url = `${ARCHIVE_CONNECTOR}/thumb?path=${encodeURIComponent(path)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "Accept": "image/png" }
  });

  if (!response.ok) throw new Error(`Thumbnail HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") || "image/png"
  };
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function deDate(value) {
  if (!value) return "–";
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : esc(value);
}

function deHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2
  }) + " h";
}

function deMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR"
  });
}

function deRate(net, hours) {
  const n = Number(net);
  const h = Number(hours);
  if (!Number.isFinite(n) || !Number.isFinite(h) || h <= 0) return "–";
  return (n / h).toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + "/h";
}

function customerLabel(p) {
  const number = String(p.customerNumber ?? "").trim();
  const name = String(p.company || p.customer || "").trim();
  const address = [p.street, p.postalCode, p.city]
    .map(x => String(x || "").trim())
    .filter(Boolean)
    .join(" ");
  return [number, name, address].filter(Boolean).join(" · ");
}

function uniqueCustomers(projects) {
  const map = new Map();
  for (const p of projects) {
    const number = String(p.customerNumber ?? "").trim();
    if (!number) continue;
    if (!map.has(number)) map.set(number, p);
  }
  return [...map.entries()]
    .map(([number, p]) => ({ number, label: customerLabel(p) }))
    .sort((a, b) => {
      const an = Number(a.number), bn = Number(b.number);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return a.number.localeCompare(b.number, "de");
    });
}

function sumMetrics(projects) {
  let hours = 0;
  let net = 0;
  let hasHours = false;
  let hasNet = false;

  for (const p of projects) {
    const combined = Number(p.combinedHoursCurrent);
    const ww = Number(p.hoursTotal);
    const h = Number.isFinite(combined) ? combined : ww;
    const n = Number(p.netInvoiced);
    if (Number.isFinite(h)) { hours += h; hasHours = true; }
    if (Number.isFinite(n)) { net += n; hasNet = true; }
  }

  return {
    hours: hasHours ? hours : null,
    net: hasNet ? net : null,
    rate: hasHours && hasNet && hours > 0 ? net / hours : null
  };
}

function metricsByLastDateYear(projects) {
  const map = new Map();
  for (const p of projects) {
    const m = String(p.lastDate || "").match(/^(\\d{4})/);
    if (!m) continue;
    const year = m[1];
    if (!map.has(year)) map.set(year, []);
    map.get(year).push(p);
  }

  const result = new Map();
  for (const [year, rows] of map.entries()) {
    result.set(year, sumMetrics(rows));
  }
  return result;
}

function groupDocuments(documents) {
  const byYear = new Map();
  for (const d of documents) {
    const year = String(d.year || "Ohne Jahr");
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(d);
  }

  return [...byYear.entries()].sort((a, b) => {
    if (a[0] === "Ohne Jahr") return 1;
    if (b[0] === "Ohne Jahr") return -1;
    return Number(b[0]) - Number(a[0]);
  });
}

function countDocumentTypes(documents) {
  const counts = new Map();
  for (const d of documents) {
    const type = String(d.dokumenttyp || "Dokument").trim() || "Dokument";
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function uniqueProjectNumbers(projects) {
  const seen = new Set();
  const result = [];
  for (const p of projects) {
    const number = String(p.projectNumber || "").trim();
    if (!number || seen.has(number)) continue;
    seen.add(number);
    result.push(number);
  }
  return result;
}

function refinedProjectQuery(currentQuery, projectNumber) {
  const terms = String(currentQuery || "")
    .split(/\s+/)
    .map(x => x.trim())
    .filter(Boolean);

  // Vorhandene reine Nummern/Projektcodes ersetzen, Name/Freitext bleibt erhalten.
  const descriptive = terms.filter(t => !/^\d+(?:[-./]\d+)*$/.test(t));
  return [projectNumber, ...descriptive].join(" ").trim();
}

function registerArchiveSearch(app) {

  app.get("/api/tower/planning", async (req, res) => {
    try {
      const year = Number(req.query.year || 2026);
      const response = await fetch(`${ARCHIVE_CONNECTOR}/tower/planning?year=${encodeURIComponent(year)}`, { headers:{Accept:"application/json"} });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) throw new Error(data?.error || `WW-Connector HTTP ${response.status}`);
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.json(data);
    } catch (err) {
      return res.status(502).json({ok:false,error:String(err?.message || err)});
    }
  });

  app.get("/gehirn", async (req, res) => {
    const runtimeToken = String(req.query.token || "").trim();
    const backUrl = `/kristine${runtimeToken ? `?token=${encodeURIComponent(runtimeToken)}` : ""}`;

    const html = `
<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KRISTINE · The Brain</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f6f8;color:#202124}
.header{background:#20242a;color:white;padding:22px 32px}
.header-inner{max-width:1120px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:18px}
.brand{font-size:24px;font-weight:800}
.subtitle{color:#adb5bd;font-size:13px;margin-top:3px}
.back{display:inline-flex;align-items:center;min-height:40px;padding:9px 14px;border-radius:9px;border:1px solid #555e67;color:white;background:#30363d;text-decoration:none;font-size:13px;font-weight:750}
.container{max-width:1120px;margin:34px auto;padding:0 20px 70px}
.hero{background:white;border:1px solid #dde2e7;border-radius:16px;padding:26px;box-shadow:0 5px 24px rgba(0,0,0,.055)}
.hero-top{display:flex;justify-content:space-between;gap:22px;align-items:flex-start;flex-wrap:wrap}
.hero h1{font-size:30px;margin:0 0 5px}
.hero p{margin:0;color:#697077}
.overall{display:inline-flex;align-items:center;gap:9px;border-radius:999px;padding:9px 13px;background:#eef1f3;font-size:13px;font-weight:800}
.dot,.source-dot{width:11px;height:11px;border-radius:50%;background:#9aa1a8;box-shadow:0 0 0 4px rgba(154,161,168,.13)}
.overall.ok .dot,.source.ok .source-dot{background:#2f9e62}
.overall.warn .dot,.source.warn .source-dot{background:#e0a21a}
.overall.bad .dot,.source.bad .source-dot{background:#d64545}
.sources{margin-top:22px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.source{border:1px solid #e0e4e8;border-radius:12px;padding:14px;background:#fafbfc;display:flex;align-items:center;gap:11px;min-height:72px}
.source-dot{flex:0 0 auto}
.source-name{font-weight:800;font-size:14px}
.source-detail{color:#7b8288;font-size:11px;margin-top:3px;line-height:1.3}
.actions{margin-top:24px;display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.brain-wrap{display:flex;flex-direction:column;gap:6px}
.brain-button{display:inline-flex;align-items:center;justify-content:center;min-height:54px;padding:0 24px;border-radius:11px;background:#20242a;color:white;text-decoration:none;font-size:16px;font-weight:850}
.brain-button.disabled{opacity:.42;pointer-events:none}
.tail-note{font-size:11px;color:#777}
.tail-link{color:#4d5964;text-decoration:underline;text-underline-offset:2px}
.refresh{min-height:42px;padding:0 14px;border:1px solid #d5dbe0;border-radius:9px;background:white;color:#30363d;font-weight:750;cursor:pointer}
.tech{margin-top:18px;color:#90969b;font-size:11px}
@media(max-width:800px){.sources{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.header{padding:18px 16px}.header-inner{align-items:flex-start;flex-direction:column}.container{margin-top:20px}.hero{padding:19px}.sources{grid-template-columns:1fr}.brain-button{width:100%}.brain-wrap{width:100%}}
</style>
</head>
<body>
<div class="header">
  <div class="header-inner">
    <div>
      <div class="brand">KRISTINE · The Brain</div>
      <div class="subtitle">Zentrale Wissensquellen</div>
    </div>
    <a class="back" href="${backUrl}">← Zurück zu KRISTINE</a>
  </div>
</div>

<div class="container">
  <section class="hero">
    <div class="hero-top">
      <div>
        <h1>🧠 The Brain</h1>
        <p>WinWorker · Archiv · MOSER · Finkzeit · KRISTINE</p>
      </div>
      <div id="overall" class="overall"><span class="dot"></span><span>Status wird geprüft …</span></div>
    </div>

    <div class="sources">
      <div id="src-brain" class="source"><span class="source-dot"></span><div><div class="source-name">Brain-Dienst</div><div class="source-detail">Verbindung wird geprüft …</div></div></div>
      <div id="src-ww" class="source"><span class="source-dot"></span><div><div class="source-name">WinWorker</div><div class="source-detail">Status vom Brain</div></div></div>
      <div id="src-archive" class="source"><span class="source-dot"></span><div><div class="source-name">PDF-Archiv</div><div class="source-detail">Status vom Brain</div></div></div>
      <div id="src-moser" class="source"><span class="source-dot"></span><div><div class="source-name">MOSER</div><div class="source-detail">Status vom Brain</div></div></div>
      <div id="src-fink" class="source"><span class="source-dot"></span><div><div class="source-name">Finkzeit</div><div class="source-detail">Status vom Brain</div></div></div>
      <div id="src-kristine" class="source ok"><span class="source-dot"></span><div><div class="source-name">KRISTINE</div><div class="source-detail">Weboberfläche erreichbar</div></div></div>
    </div>

    <div class="actions">
      <div class="brain-wrap">
        <a id="openBrain" class="brain-button" href="${esc(BRAIN_PUBLIC_URL)}/" target="_blank" rel="noopener">🧠 THE BRAIN ÖFFNEN</a>
        <div id="tailNote" class="tail-note">⚠ Private Verbindung wird geprüft.</div>
      </div>
      <button class="refresh" type="button" onclick="checkBrain()">↻ Status neu prüfen</button>
    </div>

    <div class="tech">Die Ampeln zeigen nur bestätigte Zustände. Kann der Browser den privaten Status nicht prüfen, bleibt The Brain trotzdem direkt öffnbar.</div>
  </section>
</div>

<script>
const BRAIN_URL = ${JSON.stringify(BRAIN_PUBLIC_URL)};

function setSource(id, state, detail) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("ok","warn","bad");
  el.classList.add(state);
  const detailEl = el.querySelector(".source-detail");
  if (detailEl) detailEl.textContent = detail || "";
}

function sourceState(value) {
  if (value === true || value === "ok" || value === "online" || value === "connected" || value === "ready") return "ok";
  if (value === false || value === "error" || value === "offline" || value === "failed") return "bad";
  return "warn";
}

function sourceDetail(value, fallback) {
  if (value && typeof value === "object") {
    return String(value.detail || value.message || value.status || fallback || "");
  }
  return fallback || String(value ?? "");
}

async function checkBrain() {
  const overall = document.getElementById("overall");
  const openBrain = document.getElementById("openBrain");
  const tailNote = document.getElementById("tailNote");

  overall.className = "overall";
  overall.querySelector("span:last-child").textContent = "Status wird geprüft …";

  try {
    const response = await fetch(BRAIN_URL + "/status", {method:"GET",cache:"no-store"});
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();

    setSource("src-brain","ok","Brain erreichbar" + (data.version ? " · V" + data.version : ""));

    const sources = data.sources || {};
    const defs = [
      ["src-ww", sources.winworker ?? sources.ww, "Vom Connector noch nicht separat geprüft"],
      ["src-archive", sources.archive ?? (data.pdfIndexExists === true ? true : undefined), data.pdfIndexExists === true ? "PDF-Index bereit" : "Vom Connector noch nicht separat geprüft"],
      ["src-moser", sources.moser, "Noch nicht angebunden"],
      ["src-fink", sources.fink ?? sources.finkzeit, "Noch nicht angebunden"]
    ];

    let hasBad = false;
    let hasWarn = false;

    for (const [id,value,fallback] of defs) {
      const raw = value && typeof value === "object" ? (value.ok ?? value.status) : value;
      const state = sourceState(raw);
      if (state === "bad") hasBad = true;
      if (state === "warn") hasWarn = true;
      setSource(id,state,sourceDetail(value,fallback));
    }

    overall.classList.add(hasBad || hasWarn ? "warn" : "ok");
    overall.querySelector("span:last-child").textContent =
      hasBad || hasWarn ? "Brain bereit · Quellen teilweise eingeschränkt" : "Brain bereit · alle Quellen online";

    tailNote.innerHTML = 'Private Verbindung aktiv · <a class="tail-link" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener">Tailscale öffnen ↗</a>';
  } catch (err) {
    // Ein Browser-Fetch von protokoll.krista.at auf eine private Tailscale-Adresse
    // kann durch Browser/CORS/Private-Network-Regeln blockiert werden, obwohl Brain
    // beim direkten Öffnen funktioniert. Deshalb NICHT fälschlich "offline" anzeigen.
    setSource("src-brain","warn","Status hier nicht automatisch prüfbar");
    setSource("src-ww","warn","Status im Brain prüfen");
    setSource("src-archive","warn","Status im Brain prüfen");
    setSource("src-moser","warn","Status im Brain prüfen");
    setSource("src-fink","warn","Status im Brain prüfen");

    overall.classList.add("warn");
    overall.querySelector("span:last-child").textContent = "Brain direkt öffnen und prüfen";
    tailNote.innerHTML =
      '⚠ Automatischer Statuscheck im Browser nicht möglich · ' +
      '<a class="tail-link" href="https://login.tailscale.com/admin/machines" ' +
      'target="_blank" rel="noopener">Tailscale öffnen ↗</a>';
  }
}
checkBrain();
</script>
</body>
</html>`;

    res.status(200).type("html").send(html);
  });

  app.post("/api/archive/open", async (req, res) => {
    try {
      const pdfPath = String(req.body?.path || "").trim();
      if (!pdfPath) return res.status(400).json({ ok:false, error:"PDF-Pfad fehlt" });
      const result = await openArchiveConnector(pdfPath);
      return res.json(result);
    } catch (err) {
      console.error("Archiv PDF öffnen:", err);
      return res.status(502).json({ ok:false, error:String(err?.message || err) });
    }
  });

  app.get("/api/archive/thumb", async (req, res) => {
    try {
      const pdfPath = String(req.query.path || "").trim();
      if (!pdfPath) return res.status(400).send("PDF-Pfad fehlt");
      const thumb = await loadArchiveThumbnail(pdfPath);
      res.setHeader("Content-Type", thumb.contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.send(thumb.buffer);
    } catch (err) {
      console.error("Archiv Thumbnail:", err);
      return res.status(404).end();
    }
  });

  app.get("/api/archive/status", (req, res) => {
    res.json({
      ok:true,
      module:"kristine-brain",
      version:"0.10.3",
      connector:ARCHIVE_CONNECTOR,
      kristineApiBase:KRISTINE_API_BASE,
      kristineTokenConfigured:Boolean(KRISTINE_ADMIN_TOKEN),
      localFallbackTimeEventsFile:KRISTINE_TIME_EVENTS_FILE
    });
  });

  app.get("/archiv", (req, res) => {
    const qs = new URLSearchParams(req.query || {}).toString();
    res.redirect(302, "/gehirn" + (qs ? "?" + qs : ""));
  });
}

module.exports = { registerArchiveSearch };
