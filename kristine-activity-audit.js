"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { isAlexander } = require("./kristine-user-access");
const { currentActor } = require("./employee-sessions");

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function text(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function employeeId(employee) {
  return text(employee?.id || employee?.employeeId, 120);
}

function employeeName(employee) {
  return text(employee?.nickname || employee?.rufname || employee?.name || employee?.employeeName || employeeId(employee) || "Benutzer", 160);
}

function cleanPage(value) {
  const raw = text(value, 500).split("?")[0];
  return raw.startsWith("/") ? raw : "/";
}

function jobFromPath(pathname) {
  const match = String(pathname || "").match(/\/admin\/api\/job\/([^/]+)/);
  if (!match) return "";
  try { return decodeURIComponent(match[1]).slice(0, 100); }
  catch { return match[1].slice(0, 100); }
}

function describeAction(method, pathname) {
  const route = String(pathname || "");
  const jobId = jobFromPath(route);
  const atJob = jobId ? ` · Baustelle ${jobId}` : "";
  if (/\/offer-draft\/accept$/.test(route)) return `Angebot als Auftrag übernommen${atJob}`;
  if (/\/order-schedule\/request$/.test(route)) return `Terminwunsch erfasst${atJob}`;
  if (/\/order-schedule\/confirm$/.test(route)) return `Auftragstermin bestätigt${atJob}`;
  if (/\/order-schedule\/propose$/.test(route)) return `Alternativtermin vorgeschlagen${atJob}`;
  if (/\/order-schedule\/retry-outlook$/.test(route)) return `Outlook-Termin erneut synchronisiert${atJob}`;
  if (/\/offer-draft\/finalize$/.test(route)) return `Angebot finalisiert${atJob}`;
  if (/\/offer-draft$/.test(route)) return `Angebot gespeichert${atJob}`;
  if (/\/customer-portal\/invitations\/send$/.test(route)) return `Persönliche Kundenlinks versendet${atJob}`;
  if (/\/customer-portal\/invitation$/.test(route)) return `Kundenlink erstellt${atJob}`;
  if (/\/customer-portal$/.test(route)) return `Kundenportal und Empfänger gespeichert${atJob}`;
  if (/\/customer-points\/.+\/send$/.test(route)) return `Kundenpunkt versendet${atJob}`;
  if (/\/customer-points$/.test(route)) return `Kundenpunkt erfasst${atJob}`;
  if (/\/workflows\/.+\/create-job$/.test(route)) return "Baustelle aus Aufgabe angelegt";
  if (/\/kristool\/api\/workflows$/.test(route)) return "Terminprotokoll aus Aufgabe angelegt";
  if (/\/kristool\/api\/workflows\/.+\/status$/.test(route)) return "Terminprotokoll-Status geändert";
  if (/\/kristine\/api\/tasks$/.test(route)) return "Aufgaben aktualisiert";
  if (/\/admin\/api\/job\/.+\/meta$/.test(route)) return `Baustellen-Stammdaten aktualisiert${atJob}`;
  if (/\/admin\/api\/jobs$/.test(route)) return "Baustelle angelegt";
  if (/\/admin\/api\/employees(?:\/|$)/.test(route)) return method === "DELETE" ? "Mitarbeiter gelöscht" : "Mitarbeiter-Stammdaten gespeichert";
  if (/\/kristine\/api\/assignments$/.test(route)) return "Planung aktualisiert";
  if (/\/kristine\/api\/segments\//.test(route)) return "Arbeitszeit aktualisiert";
  if (/\/documentation\/mail$/.test(route)) return `E-Mail abgelegt${atJob}`;
  if (/\/documentation\/regie-report$/.test(route)) return `Regiebericht importiert${atJob}`;
  if (/\/day\/.+\/regie$/.test(route)) return `Tagesrapport gespeichert${atJob}`;
  const verb = { POST: "Angelegt/ausgeführt", PUT: "Gespeichert", PATCH: "Geändert", DELETE: "Gelöscht" }[method] || method;
  return `${verb}: ${route}`.slice(0, 300);
}

function registerKristineActivityAudit(app, { dataDir, requireAdmin, readEmployees, now = () => new Date() }) {
  const logFile = path.join(dataDir, "_kristine", "activity-log.jsonl");
  let writeQueue = Promise.resolve();
  let employeeCache = { at: 0, rows: [] };

  async function employees() {
    if (Date.now() - employeeCache.at < 15000) return employeeCache.rows;
    const rows = typeof readEmployees === "function" ? await readEmployees().catch(() => []) : [];
    employeeCache = { at: Date.now(), rows: Array.isArray(rows) ? rows : [] };
    return employeeCache.rows;
  }

  async function actor(req) {
    const sessionActor = currentActor(req);
    if (sessionActor) return (await employees()).find(employee => employeeId(employee) === sessionActor.id) || null;
    const wanted = text(req.headers["x-krista-user-id"], 120);
    if (!wanted) return null;
    return (await employees()).find((employee) => employeeId(employee) === wanted) || null;
  }

  function append(entry) {
    const row = { id: `activity-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`, ...entry };
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(path.dirname(logFile), { recursive: true });
        await fsp.appendFile(logFile, `${JSON.stringify(row)}\n`, "utf8");
      });
    return writeQueue.then(() => row);
  }

  async function readEntries(limit = 100) {
    await writeQueue.catch(() => {});
    let raw = "";
    try { raw = await fsp.readFile(logFile, "utf8"); }
    catch { return []; }
    const rows = raw.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(500, Number(limit) || 100)));
    return rows.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse();
  }

  app.post("/kristine/api/activity/session", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const person = await actor(req);
      if (!person) return res.status(400).json({ ok: false, error: "Bitte zuerst einen KRISTINE-Benutzer auswählen." });
      const page = cleanPage(req.body?.page);
      const entry = await append({
        at: now().toISOString(),
        type: "session",
        actorId: employeeId(person),
        actorName: employeeName(person),
        action: `Einstieg: ${text(req.body?.title, 120) || page}`,
        page,
        status: "success",
        sessionId: text(req.body?.sessionId, 120),
      });
      res.status(201).json({ ok: true, entry });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/activity", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const person = await actor(req);
      if (!person || !isAlexander(person)) return res.status(403).json({ ok: false, error: "Das Aktivitätsprotokoll ist nur für Alexander sichtbar." });
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, entries: await readEntries(req.query?.limit) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.use((req, res, next) => {
    const method = String(req.method || "").toUpperCase();
    const pathname = String(req.path || "");
    const internalApi = pathname.startsWith("/kristine/api/") || pathname.startsWith("/admin/api/") || pathname.startsWith("/kristool/api/") || pathname.startsWith("/api/");
    if (!MUTATING_METHODS.has(method) || !internalApi || pathname.startsWith("/kristine/api/activity")) return next();
    const startedAt = Date.now();
    const personPromise = actor(req).catch(() => null);
    res.once("finish", () => {
      void personPromise.then((person) => {
        if (!person) return null;
        return append({
          at: now().toISOString(),
          type: "action",
          actorId: employeeId(person),
          actorName: employeeName(person),
          action: describeAction(method, pathname),
          method,
          path: pathname.slice(0, 500),
          status: res.statusCode >= 200 && res.statusCode < 400 ? "success" : "failed",
          statusCode: res.statusCode,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      }).catch(() => {});
    });
    next();
  });

  return { append, readEntries, flush: () => writeQueue, logFile, describeAction };
}

module.exports = { registerKristineActivityAudit, describeAction };
