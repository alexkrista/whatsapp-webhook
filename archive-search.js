// archive-search.js
// Kristine Gehirn – Projekte + Kunden + Zeiten + Dokumente + Nachkalkulation

const fsp = require("fs/promises");
const path = require("path");


const KRISTINE_API_BASE = String(
  process.env.KRISTINE_API_BASE || "https://protokoll.krista.at"
).replace(/\/$/, "");

const KRISTINE_ADMIN_TOKEN =
  process.env.KRISTINE_ADMIN_TOKEN ||
  process.env.ADMIN_TOKEN ||
  "";

async function loadKristineBrainSource() {
  const response = await fetch(`${KRISTINE_API_BASE}/kristine/api/brain-hours-source`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      ...(KRISTINE_ADMIN_TOKEN ? { "x-admin-token": KRISTINE_ADMIN_TOKEN } : {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `KRISTINE API HTTP ${response.status}`);
  }

  return {
    events: Array.isArray(data.events) ? data.events : [],
    employees: Array.isArray(data.employees) ? data.employees : []
  };
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

  app.get("/gehirn", async (req, res) => {
    const q = String(req.query.q || "").trim();
    const selectedCustomerNumber = String(req.query.customer || "").trim();

    let allProjects = [];
    let projects = [];
    let documents = [];
    let sqlError = "";
    let connectorError = "";

    if (q) {
      try {
        const data = await searchArchiveConnector(q);
        allProjects = Array.isArray(data.projects) ? data.projects : [];
        documents = Array.isArray(data.documents) ? data.documents : [];
        sqlError = String(data.sqlError || "");
      } catch (err) {
        connectorError = String(err?.message || err);
        console.error("Gehirn-Connector:", err);
      }
    }

    let kristineEvents = [];
    let kristineEmployees = [];
    try {
      const kristineSource = await loadKristineBrainSource();
      kristineEvents = kristineSource.events;
      kristineEmployees = kristineSource.employees;
    } catch (err) {
      const msg = String(err?.message || err);
      sqlError = [sqlError, `KRISTINE: ${msg}`].filter(Boolean).join(" · ");
      console.error("Gehirn-KRISTINE-API:", err);
    }
    const employeeIdentityMap = buildEmployeeIdentityMap(kristineEmployees);
    const kristineBundle = buildKristineProjectHours(kristineEvents, employeeIdentityMap);

    let wwFusionRows = [];
    if (allProjects.length) {
      try {
        wwFusionRows = await loadWwHoursFusionSource(allProjects);
      } catch (err) {
        const msg = String(err?.message || err);
        sqlError = [sqlError, `Stundenfusion: ${msg}`].filter(Boolean).join(" · ");
        console.error("Gehirn-Stundenfusion:", err);
      }
    }

    const wwFusionByProject = groupWwFusionRows(
      wwFusionRows,
      kristineBundle.dayPresence
    );
    allProjects = attachKristineHours(
      allProjects,
      kristineBundle,
      wwFusionByProject
    );

    const customers = uniqueCustomers(allProjects);

    projects = selectedCustomerNumber
      ? allProjects.filter(p => String(p.customerNumber ?? "").trim() === selectedCustomerNumber)
      : allProjects;

    const years = groupDocuments(documents);
    const typeCounts = countDocumentTypes(documents);
    const projectNumbers = uniqueProjectNumbers(projects);

    const selectedCustomer = selectedCustomerNumber
      ? customers.find(c => c.number === selectedCustomerNumber)
      : null;

    const customerTotals = selectedCustomer ? sumMetrics(projects) : null;
    const customerYearMetrics = selectedCustomer ? metricsByLastDateYear(projects) : new Map();

    const html = `
<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kristine · Gehirn</title>
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f5f6f8;
  color: #202124;
}
.header { background:#20242a; color:white; padding:22px 32px; }
.header-inner { max-width:1380px; margin:auto; display:flex; justify-content:space-between; align-items:center; }
.brand { font-size:24px; font-weight:750; }
.subtitle { color:#adb5bd; font-size:13px; margin-top:3px; }
.status { color:#b8c0c8; font-size:13px; }
.container { max-width:1380px; margin:30px auto; padding:0 20px 70px; }
.search-box {
  background:white; padding:20px; border-radius:12px;
  box-shadow:0 2px 5px rgba(0,0,0,.05),0 8px 25px rgba(0,0,0,.04);
}
.search-row { display:flex; gap:10px; }
.search-input { flex:1; border:1px solid #cfd4da; border-radius:9px; padding:16px 18px; font-size:20px; outline:none; }
.search-input:focus { border-color:#667788; box-shadow:0 0 0 3px rgba(80,100,120,.10); }
.search-button { border:0; border-radius:9px; padding:0 28px; background:#20242a; color:white; font-size:16px; font-weight:650; cursor:pointer; }
.examples { margin-top:11px; color:#777; font-size:13px; }
.alert { margin-top:16px; padding:12px 14px; border-radius:8px; font-size:13px; }
.alert.error { background:#fff4f4; border:1px solid #efc6c6; color:#8a2f2f; }
.alert.warn { background:#fff9e8; border:1px solid #eadba2; color:#705c15; }

.project-filter { margin-top:18px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.project-filter-label { font-size:13px; font-weight:750; color:#62686e; margin-right:2px; }
.project-chip {
  display:inline-flex; align-items:center; text-decoration:none; color:#28323b; background:white;
  border:1px solid #d7dde2; border-radius:999px; padding:7px 12px; font-size:13px; font-weight:750;
  box-shadow:0 1px 2px rgba(0,0,0,.025); transition:transform .08s ease,border-color .08s ease,background .08s ease;
}
.project-chip:hover { transform:translateY(-1px); border-color:#9faab4; background:#f9fafb; }

.project-section { margin-top:22px; }
.project-list {
  max-height: 58vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 8px;
  scroll-behavior: smooth;
  scrollbar-gutter: stable;
}
.project-list::-webkit-scrollbar { width: 10px; }
.project-list::-webkit-scrollbar-track { background: #eef1f3; border-radius: 999px; }
.project-list::-webkit-scrollbar-thumb { background: #b8c0c7; border-radius: 999px; border: 2px solid #eef1f3; }
.project-list::-webkit-scrollbar-thumb:hover { background: #929ca5; }
.project-card {
  background:white; border:1px solid #dde2e7; border-radius:13px; padding:20px 22px;
  box-shadow:0 3px 14px rgba(0,0,0,.045); margin-bottom:12px;
}
.project-card.primary { border-color:#aeb9c3; }
.project-card.selectable { cursor:pointer; transition:transform .08s ease, box-shadow .08s ease, border-color .08s ease; }
.project-card.selectable:hover { transform:translateY(-1px); border-color:#9faab4; box-shadow:0 7px 18px rgba(0,0,0,.07); }
.project-top { display:flex; justify-content:space-between; gap:20px; align-items:flex-start; }
.project-number { font-size:27px; font-weight:800; letter-spacing:-.4px; }
.project-title { font-size:17px; font-weight:650; margin-top:3px; }
.project-customer { margin-top:11px; font-size:15px; }
.project-address { color:#555; margin-top:4px; }
.project-dates { display:flex; gap:22px; flex-wrap:wrap; color:#555; font-size:14px; }
.date-box { background:#f6f7f8; border-radius:8px; padding:9px 12px; min-width:130px; }
.date-label { display:block; color:#8a8f95; font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin-bottom:2px; }
.more-projects { margin-top:7px; color:#777; font-size:13px; }

.customer-filter {
  margin-top:12px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;
}
.customer-filter-label { font-size:13px; font-weight:750; color:#62686e; }
.customer-select {
  min-width:min(680px,100%); max-width:100%; border:1px solid #d1d7dc; border-radius:9px;
  background:white; padding:9px 12px; font-size:13px; color:#28323b;
}
.customer-summary {
  margin-top:12px; background:#20242a; color:white; border-radius:12px; padding:14px 16px;
  display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap;
}
.customer-summary-name { font-size:14px; font-weight:800; }
.customer-summary-metrics { display:flex; gap:10px; flex-wrap:wrap; }
.customer-summary-chip {
  background:#30363d; border:1px solid #424a52; border-radius:8px; padding:7px 10px;
  font-size:12px; white-space:nowrap;
}
.project-metrics { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
.metric-box {
  background:#20242a; color:white; border-radius:8px; padding:8px 10px; min-width:126px;
}
.metric-label {
  display:block; color:#bfc6cc; font-size:10px; text-transform:uppercase;
  letter-spacing:.45px; margin-bottom:2px;
}
.metric-value { font-size:16px; font-weight:800; }
.metric-box.clickable { cursor:pointer; border:1px solid #434b53; }
.metric-box.clickable:hover { background:#30363d; }
.hours-detail {
  display:none; margin-top:12px; background:#f7f8fa; border:1px solid #e0e4e8;
  border-radius:10px; padding:12px 14px;
}
.hours-detail.open { display:block; }
.hours-detail-title { font-size:13px; font-weight:800; margin-bottom:8px; }
.hours-note { font-size:11px; color:#6d747a; margin-top:7px; line-height:1.4; }
.hours-table { width:100%; border-collapse:collapse; font-size:12px; }
.hours-table th, .hours-table td { text-align:left; padding:7px 8px; border-bottom:1px solid #e3e6e9; }
.hours-table th { color:#697077; font-size:10px; text-transform:uppercase; letter-spacing:.4px; }
.hours-table td.num, .hours-table th.num { text-align:right; white-space:nowrap; }
.year-metrics {
  margin-left:auto; display:flex; gap:7px; flex-wrap:wrap; align-items:center;
}
.year-metric {
  background:#20242a; color:white; border-radius:999px; padding:5px 9px;
  font-size:11px; white-space:nowrap;
}

.doc-summary { margin:26px 0 18px; display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.summary-title { font-weight:750; margin-right:5px; }
.type-chip { background:white; border:1px solid #dce1e5; border-radius:999px; padding:7px 11px; font-size:13px; }
.type-chip strong { margin-left:5px; }

.year-section { margin-top:28px; }
.year-heading { display:flex; align-items:baseline; gap:10px; margin:0 0 13px 2px; }
.year-number { font-size:24px; font-weight:800; }
.year-count { color:#888; font-size:13px; }
.doc-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; }
.doc-card {
  background:white; border:1px solid #e0e4e8; border-radius:12px; overflow:hidden;
  cursor:pointer; transition:transform .08s ease,box-shadow .08s ease,border-color .08s ease;
}
.doc-card:hover { transform:translateY(-2px); border-color:#b8c1c9; box-shadow:0 8px 20px rgba(0,0,0,.08); }
.doc-preview { width:100%; height:390px; background:#eef0f2; overflow:hidden; display:flex; align-items:flex-start; justify-content:center; }
.doc-preview img { width:100%; height:100%; object-fit:contain; background:white; }
.doc-info { padding:13px 14px 15px; }
.doc-line { display:flex; justify-content:space-between; gap:10px; align-items:center; }
.doc-type { display:inline-block; background:#edf0f2; color:#555; border-radius:5px; padding:4px 8px; font-size:12px; font-weight:700; }
.doc-date { color:#7c8288; font-size:12px; white-space:nowrap; }
.doc-name { margin-top:8px; font-weight:700; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.open-button { margin-top:11px; border:0; border-radius:6px; padding:8px 12px; background:#343a40; color:white; cursor:pointer; }

.pdf-hover-preview {
  position:fixed; z-index:5000; right:24px; top:50%; transform:translateY(-50%);
  width:min(48vw,820px); height:min(90vh,1080px); display:none; pointer-events:none;
  padding:10px; background:rgba(30,34,38,.94); border-radius:14px;
  box-shadow:0 24px 70px rgba(0,0,0,.34);
}
.pdf-hover-preview.visible { display:flex; align-items:center; justify-content:center; }
.pdf-hover-preview img { width:100%; height:100%; object-fit:contain; background:white; border-radius:7px; }

.empty { margin-top:25px; background:white; border:1px dashed #ccd1d6; border-radius:10px; padding:35px 20px; text-align:center; color:#777; }

@media (max-width:1000px) { .doc-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:700px) {
  .search-row { flex-direction:column; }
  .search-button { height:52px; }
  .project-top { flex-direction:column; }
  .doc-grid { grid-template-columns:1fr; }
  .doc-preview { height:420px; }
}
</style>
</head>
<body>
<div class="header"><div class="header-inner">
  <div><div class="brand">Kristine · Gehirn</div><div class="subtitle">Projekte · Kunden · Zeiten · Dokumente · Nachkalkulation</div></div>
  <div class="status">Gehirn V0.10.2 · KRISTINE live + Stundenfusion</div>
</div></div>

<div class="container">
<form method="get" action="/gehirn" class="search-box">
  <div class="search-row">
    <input class="search-input" name="q" autofocus autocomplete="off"
      placeholder="Projekt, Kunde, Rechnung, Adresse, Text ..." value="${esc(q)}">
    <button class="search-button">Suchen</button>
  </div>
  <div class="examples">Beispiele: 6844 Fusonic · 202205010 · 26085 · Innenmalerarbeiten</div>
</form>

${connectorError ? `<div class="alert error">Connector: ${esc(connectorError)}</div>` : ""}
${sqlError ? `<div class="alert warn">PDF-Suche funktioniert. SQL: ${esc(sqlError)}</div>` : ""}

${q && projectNumbers.length ? `
<div class="project-filter">
  <span class="project-filter-label">Projekte gefunden:</span>
  ${projectNumbers.slice(0, 30).map(number => {
    const refine = refinedProjectQuery(q, number);
    return `<a class="project-chip" href="/gehirn?q=${encodeURIComponent(refine)}${selectedCustomerNumber ? `&customer=${encodeURIComponent(selectedCustomerNumber)}` : ""}" title="Suche auf Projekt ${esc(number)} einschränken">${esc(number)}</a>`;
  }).join("")}
  ${projectNumbers.length > 30 ? `<span class="more-projects">+ ${projectNumbers.length - 30} weitere</span>` : ""}
</div>` : ""}

${q && customers.length ? `
<form method="get" action="/gehirn" class="customer-filter">
  <input type="hidden" name="q" value="${esc(q)}">
  <span class="customer-filter-label">Kunde:</span>
  <select class="customer-select" name="customer" onchange="this.form.submit()">
    <option value="">Alle Kunden (${customers.length})</option>
    ${customers.map(c => `
      <option value="${esc(c.number)}" ${c.number === selectedCustomerNumber ? "selected" : ""}>
        ${esc(c.label)}
      </option>
    `).join("")}
  </select>
</form>
${selectedCustomer && customerTotals ? `
<div class="customer-summary">
  <div class="customer-summary-name">${esc(selectedCustomer.label)}</div>
  <div class="customer-summary-metrics">
    <span class="customer-summary-chip">Stunden aktuell: <strong>${deHours(customerTotals.hours)}</strong></span>
    <span class="customer-summary-chip">Netto: <strong>${deMoney(customerTotals.net)}</strong></span>
    <span class="customer-summary-chip">Umsatz/Std aktuell: <strong>${deRate(customerTotals.net, customerTotals.hours)}</strong></span>
  </div>
</div>` : ""}
` : ""}

${q && projects.length ? `
<div class="project-section">
  <div class="project-list" id="projectList">
    ${projects.map((p, i) => {
      const refine = refinedProjectQuery(q, p.projectNumber);
      return `
        <div class="project-card selectable ${i === 0 ? "primary" : ""}"
             role="button"
             tabindex="0"
             data-href="/gehirn?q=${encodeURIComponent(refine)}${selectedCustomerNumber ? `&customer=${encodeURIComponent(selectedCustomerNumber)}` : ""}"
             onclick="location.href=this.dataset.href"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();location.href=this.dataset.href}">
          <div class="project-top">
            <div>
              <div class="project-number">Projekt ${esc(p.projectNumber)}</div>
              <div class="project-title">${esc(p.title || p.site || "")}</div>
              <div class="project-customer">${esc(p.company || p.customer || "")}</div>
              ${p.customerNumber !== null && p.customerNumber !== undefined
                ? `<div class="project-address"><strong>Kundennr. ${esc(p.customerNumber)}</strong></div>`
                : ""}
              <div class="project-address">${esc(p.address || "")}</div>
            </div>
            <div>
              <div class="project-dates">
                <div class="date-box"><span class="date-label">Erstes Datum</span>${deDate(p.firstDate)}</div>
                <div class="date-box"><span class="date-label">Letztes Datum</span>${deDate(p.lastDate)}</div>
              </div>
              <div class="project-metrics">
                <div class="metric-box">
                  <span class="metric-label">WW netto</span>
                  <span class="metric-value">${deHours(p.wwHoursEffective)}</span>
                </div>
                <div class="metric-box">
                  <span class="metric-label">Kristine produktiv</span>
                  <span class="metric-value">${deHours(p.kristineHoursProductive)}</span>
                </div>
                <div class="metric-box clickable"
                     onclick="event.stopPropagation(); toggleHoursDetail('hours-${esc(p.projectIndex)}')"
                     title="Mitarbeiterdetails anzeigen">
                  <span class="metric-label">Gesamt aktuell</span>
                  <span class="metric-value">${deHours(p.combinedHoursCurrent)}</span>
                </div>
                <div class="metric-box">
                  <span class="metric-label">Netto abgerechnet</span>
                  <span class="metric-value">${deMoney(p.netInvoiced)}</span>
                </div>
                <div class="metric-box">
                  <span class="metric-label">Umsatz / Std aktuell</span>
                  <span class="metric-value">${deRate(p.netInvoiced, p.combinedHoursCurrent)}</span>
                </div>
              </div>
              <div id="hours-${esc(p.projectIndex)}" class="hours-detail" onclick="event.stopPropagation()">
                <div class="hours-detail-title">Stundenfusion · Projekt ${esc(p.projectNumber)}</div>
                ${
                  Array.isArray(p.wwFusionRows) && p.wwFusionRows.length
                    ? `<div class="hours-detail-title" style="margin-top:4px">WinWorker</div>
                       <table class="hours-table">
                        <thead>
                          <tr>
                            <th>MA</th>
                            <th>Tag</th>
                            <th class="num">Roh</th>
                            <th class="num">15 Min anteilig</th>
                            <th class="num">WW netto</th>
                            <th>Wertung</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${p.wwFusionRows.map(row => `
                            <tr>
                              <td>${esc(row.employeeName || ("MAIndex " + row.maIndex))}${row.finkNumber ? ` · #${esc(row.finkNumber)}` : ""}</td>
                              <td>${deDate(row.date)}</td>
                              <td class="num">${deHours(row.rawHours)}</td>
                              <td class="num">− ${deHours(row.breakHours)}</td>
                              <td class="num">${deHours(row.netHours)}</td>
                              <td>${row.overriddenByKristine ? "<strong>KRISTINE gewinnt</strong>" : "WW zählt"}</td>
                            </tr>
                          `).join("")}
                        </tbody>
                       </table>`
                    : `<div class="hours-note">Keine WinWorker-Stunden für dieses Projekt gefunden.</div>`
                }

                <div class="hours-detail-title" style="margin-top:14px">KRISTINE</div>
                ${
                  Array.isArray(p.kristineEmployees) && p.kristineEmployees.length
                    ? `<table class="hours-table">
                        <thead>
                          <tr>
                            <th>Mitarbeiter</th>
                            <th class="num">Roh</th>
                            <th class="num">15 Min anteilig</th>
                            <th class="num">Produktiv</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${p.kristineEmployees.map(emp => `
                            <tr>
                              <td>${esc(emp.employeeName)}</td>
                              <td class="num">${deHours(emp.rawHours)}</td>
                              <td class="num">− ${deHours(emp.breakHours)}</td>
                              <td class="num"><strong>${deHours(emp.productiveHours)}</strong></td>
                            </tr>
                          `).join("")}
                        </tbody>
                      </table>`
                    : `<div class="hours-note">Noch keine Kristine-Zeitblöcke mit exakt dieser Projektnummer gefunden.</div>`
                }
                <div class="hours-note">
                  Fusion: WinWorker erhält zuerst den 15-Minuten-Abzug einmal je Mitarbeiter/Tag,
                  proportional auf dessen produktive Projekte verteilt. Existiert derselbe Mitarbeiter/Tag
                  in KRISTINE (Abgleich über Fink-Personalnummer), wird dieser WW-Tag nicht gezählt;
                  die korrigierte KRISTINE-Zeit gewinnt. Dadurch gibt es keine Doppelzählung.
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("")}
  </div>
</div>` : ""}

${q && documents.length ? `
<div class="doc-summary">
  <span class="summary-title">${documents.length} Dokumente</span>
  ${typeCounts.map(([type,count]) => `<span class="type-chip">${esc(type)} <strong>${count}</strong></span>`).join("")}
</div>

${years.map(([year, docs]) => `
<section class="year-section">
  <div class="year-heading">
    <div class="year-number">${esc(year)}</div>
    <div class="year-count">${docs.length} Dokumente · letzter Druck zuerst</div>
    ${selectedCustomer && customerYearMetrics.has(String(year)) ? (() => {
      const ym = customerYearMetrics.get(String(year));
      return `<div class="year-metrics">
        <span class="year-metric">${deHours(ym.hours)}</span>
        <span class="year-metric">${deMoney(ym.net)}</span>
        <span class="year-metric">${deRate(ym.net, ym.hours)}</span>
      </div>`;
    })() : ""}
  </div>
  <div class="doc-grid">
    ${docs.map(d => `
      <article class="doc-card" data-path="${esc(d.path)}" onclick="openArchivePdf(this.dataset.path)">
        <div class="doc-preview">
          <img loading="lazy" src="/api/archive/thumb?path=${encodeURIComponent(d.path)}"
               alt="Vorschau ${esc(d.filename)}"
               onmouseenter="showPdfHover(this.src)" onmouseleave="hidePdfHover()"
               onerror="this.style.display='none'">
        </div>
        <div class="doc-info">
          <div class="doc-line">
            <span class="doc-type">${esc(d.dokumenttyp || "Dokument")}</span>
            <span class="doc-date">${deDate(d.printDate)}</span>
          </div>
          <div class="doc-name" title="${esc(d.filename)}">${esc(d.filename)}</div>
          <button class="open-button" type="button" data-path="${esc(d.path)}"
            onclick="event.stopPropagation(); openArchivePdf(this.dataset.path)">Öffnen</button>
        </div>
      </article>
    `).join("")}
  </div>
</section>
`).join("")}
` : q ? `<div class="empty">Keine passenden Dokumente gefunden.</div>` : `<div class="empty">Suche im Kristine-Gehirn</div>`}
</div>

<div id="pdfHoverPreview" class="pdf-hover-preview" aria-hidden="true">
  <img id="pdfHoverImage" alt="Vergrößerte PDF-Vorschau">
</div>

<script>
function toggleHoursDetail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("open");
}

function showPdfHover(src) {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  const box = document.getElementById("pdfHoverPreview");
  const img = document.getElementById("pdfHoverImage");
  img.src = src;
  box.classList.add("visible");
  box.setAttribute("aria-hidden", "false");
}

function hidePdfHover() {
  const box = document.getElementById("pdfHoverPreview");
  box.classList.remove("visible");
  box.setAttribute("aria-hidden", "true");
}

async function openArchivePdf(path) {
  try {
    const response = await fetch("/api/archive/open", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({path})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) alert(data.error || "PDF konnte nicht geöffnet werden.");
  } catch (err) {
    alert("Archiv-Connector nicht erreichbar.");
  }
}
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
      version:"0.8.0",
      connector:ARCHIVE_CONNECTOR,
      timeEventsFile:KRISTINE_TIME_EVENTS_FILE
    });
  });

  app.get("/archiv", (req, res) => {
    const qs = new URLSearchParams(req.query || {}).toString();
    res.redirect(302, "/gehirn" + (qs ? "?" + qs : ""));
  });
}

module.exports = { registerArchiveSearch };
