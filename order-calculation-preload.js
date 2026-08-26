"use strict";

// KRISTINE Kalkulation V1 – additive sidecar API without touching server.js.
// Loaded with `node -r` before server.js. It patches Express only to
// (a) enrich /admin/api/jobs with the new calculation and
// (b) register dedicated order-calculation routes before the final 404 handler.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const express = require("express");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ROUTES_FLAG = Symbol.for("krista.orderCalculation.routes.v1");
const GET_PATCH_FLAG = Symbol.for("krista.orderCalculation.getPatch.v1");
const USE_PATCH_FLAG = Symbol.for("krista.orderCalculation.usePatch.v1");
const VALID_KINDS = new Set(["auftrag", "regie", "nachtrag_auftrag", "nachtrag_regie", "fremdleistung", "sonstiges"]);

function safeJobId(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) return true;
  const token = req.headers["x-admin-token"] || req.headers["x-krista-admin-token"] || req.query.token || "";
  if (token !== ADMIN_TOKEN) {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return false;
  }
  return true;
}
function calcPath(jobId) {
  return path.join(DATA_DIR, String(jobId), ".order-calculation.json");
}
function orderDir(jobId) {
  return path.join(DATA_DIR, String(jobId), "_auftrag");
}
function cleanText(value, max = 500) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}
function cleanNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
function cleanFileName(value) {
  return (String(value || "Auftrag.pdf")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_. -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Auftrag.pdf");
}
function sanitizeSourceDocument(value) {
  if (!value || typeof value !== "object") return null;
  const storedName = cleanText(value.storedName, 180).replace(/[^A-Za-z0-9_. -]/g, "_");
  if (!storedName) return null;
  return {
    name: cleanFileName(value.name || storedName),
    storedName,
    mimeType: cleanText(value.mimeType || "application/pdf", 80),
    size: cleanNumber(value.size),
    importedAt: cleanText(value.importedAt || new Date().toISOString(), 60),
  };
}
function sanitizePosition(row, index) {
  const source = row && typeof row === "object" ? row : {};
  const kind = VALID_KINDS.has(source.kind) ? source.kind : "auftrag";
  const suggestedKind = VALID_KINDS.has(source.suggestedKind) ? source.suggestedKind : "";
  return {
    id: cleanText(source.id || `pos_${index + 1}`, 80).replace(/[^A-Za-z0-9_.:-]/g, "_") || `pos_${index + 1}`,
    number: cleanText(source.number, 40),
    titleNo: cleanText(source.titleNo, 20),
    title: cleanText(source.title, 220),
    shortText: cleanText(source.shortText || source.title || source.description, 220),
    description: cleanText(source.description, 1800),
    amount: cleanNumber(source.amount),
    plannedHours: cleanNumber(source.plannedHours),
    kind,
    suggestedKind,
    needsReview: !!source.needsReview,
    employeeVisible: source.employeeVisible !== false,
    addToContract: !!source.addToContract,
    source: cleanText(source.source || "pdf", 30),
  };
}
function sanitizeCalculation(value, existing = null) {
  const raw = value && typeof value === "object" ? value : {};
  const old = existing && typeof existing === "object" ? existing : {};
  const positionsRaw = Array.isArray(raw.positions) ? raw.positions : (Array.isArray(old.positions) ? old.positions : []);
  return {
    version: 1,
    parseVersion: cleanNumber(raw.parseVersion || old.parseVersion || 1) || 1,
    sourceType: cleanText(raw.sourceType || old.sourceType || "pdf", 30),
    sourceDocument: sanitizeSourceDocument(raw.sourceDocument || old.sourceDocument),
    orderNo: cleanText(raw.orderNo ?? old.orderNo, 80),
    projectNo: cleanText(raw.projectNo ?? old.projectNo, 80),
    documentDate: cleanText(raw.documentDate ?? old.documentDate, 80),
    customer: cleanText(raw.customer ?? old.customer, 180),
    subject: cleanText(raw.subject ?? old.subject, 240),
    netTotal: cleanNumber(raw.netTotal ?? old.netTotal),
    vatAmount: cleanNumber(raw.vatAmount ?? old.vatAmount),
    grossTotal: cleanNumber(raw.grossTotal ?? old.grossTotal),
    materialPercent: Math.min(100, cleanNumber(raw.materialPercent ?? old.materialPercent)),
    billingRate: cleanNumber(raw.billingRate ?? old.billingRate),
    rawText: cleanText(raw.rawText ?? old.rawText, 60000),
    positions: positionsRaw.slice(0, 600).map(sanitizePosition),
    updatedAt: new Date().toISOString(),
  };
}
function deriveCalculation(calc, fallbackRate = 0) {
  const rows = Array.isArray(calc?.positions) ? calc.positions : [];
  const sum = predicate => rows.reduce((total, row) => total + (predicate(row) ? cleanNumber(row.amount) : 0), 0);
  const baseNet = cleanNumber(calc?.netTotal);
  const added = sum(row => row.addToContract);
  const contractAmount = baseNet + added;
  const regieAmount = sum(row => row.kind === "regie" || row.kind === "nachtrag_regie");
  const externalServices = sum(row => row.kind === "fremdleistung");
  const otherExcludedAmount = sum(row => row.kind === "sonstiges");
  const fixedOwnAmount = Math.max(0, contractAmount - regieAmount - externalServices - otherExcludedAmount);
  const materialPercent = Math.min(100, cleanNumber(calc?.materialPercent));
  const materialAmount = fixedOwnAmount * materialPercent / 100;
  const laborAmount = Math.max(0, fixedOwnAmount - materialAmount);
  const billingRate = cleanNumber(calc?.billingRate) || cleanNumber(fallbackRate);
  const calculatedHours = billingRate > 0 ? laborAmount / billingRate : 0;
  const plannedRegieHours = rows.reduce((total, row) => total + ((row.kind === "regie" || row.kind === "nachtrag_regie") ? cleanNumber(row.plannedHours) : 0), 0);
  return {
    baseNet,
    addedAmount: added,
    contractAmount,
    regieAmount,
    externalServices,
    otherExcludedAmount,
    fixedOwnAmount,
    materialPercent,
    materialAmount,
    laborAmount,
    billingRate,
    calculatedHours,
    plannedRegieHours,
  };
}
async function readCalculation(jobId) {
  try {
    const data = JSON.parse(await fsp.readFile(calcPath(jobId), "utf8"));
    return sanitizeCalculation(data, data);
  } catch {
    return null;
  }
}
async function writeCalculation(jobId, value) {
  const existing = await readCalculation(jobId);
  const next = sanitizeCalculation(value, existing);
  await fsp.mkdir(path.join(DATA_DIR, String(jobId)), { recursive: true });
  await fsp.writeFile(calcPath(jobId), JSON.stringify(next, null, 2), "utf8");
  return next;
}
function employeeScope(calc) {
  const rows = (calc?.positions || [])
    .filter(row => row.employeeVisible !== false)
    .filter(row => ["auftrag", "regie", "nachtrag_auftrag", "nachtrag_regie"].includes(row.kind))
    .map(row => ({
      id: row.id,
      number: row.number,
      titleNo: row.titleNo,
      title: row.title,
      text: row.shortText || row.title || row.description,
      kind: row.kind,
      plannedHours: row.plannedHours,
    }));
  return {
    order: rows.filter(row => row.kind === "auftrag"),
    regie: rows.filter(row => row.kind === "regie"),
    addOrder: rows.filter(row => row.kind === "nachtrag_auftrag"),
    addRegie: rows.filter(row => row.kind === "nachtrag_regie"),
  };
}

function enrichJobsPayload(data) {
  if (!data || !Array.isArray(data.jobs)) return Promise.resolve(data);
  return Promise.all(data.jobs.map(async job => {
    const calc = await readCalculation(job.jobId);
    if (!calc) return job;
    const old = job.calculation || {};
    const derived = deriveCalculation(calc, calc.billingRate || old.billingRate || job.billingRate);
    const actualHours = cleanNumber(old.actualHours);
    const actualRegieHours = cleanNumber(old.actualRegieHours);
    const orderHours = cleanNumber(old.orderHours ?? Math.max(0, actualHours - actualRegieHours));
    return {
      ...job,
      orderDocument: calc.sourceDocument || null,
      orderCalculation: calc,
      contractAmount: derived.contractAmount,
      externalServices: derived.externalServices,
      materialPercent: derived.materialPercent,
      plannedRegieHours: derived.plannedRegieHours,
      calculation: {
        ...old,
        contractAmount: derived.contractAmount,
        externalServices: derived.externalServices,
        regieBudgetAmount: derived.regieAmount,
        otherExcludedAmount: derived.otherExcludedAmount,
        kristaAmount: derived.fixedOwnAmount,
        materialPercent: derived.materialPercent,
        materialAmount: derived.materialAmount,
        laborAmount: derived.laborAmount,
        billingRate: derived.billingRate,
        calculatedHours: derived.calculatedHours,
        actualHours,
        actualRegieHours,
        orderHours,
        remainingOrderHours: derived.calculatedHours - orderHours,
        progressPercent: derived.calculatedHours > 0 ? orderHours / derived.calculatedHours * 100 : 0,
        plannedRegieHours: derived.plannedRegieHours,
        remainingRegieHours: derived.plannedRegieHours - actualRegieHours,
      },
    };
  })).then(jobs => ({ ...data, jobs }));
}

function registerRoutes(app) {
  if (app[ROUTES_FLAG]) return;
  app[ROUTES_FLAG] = true;

  app.get("/admin/api/job/:jobId/order-calculation", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const jobId = safeJobId(req.params.jobId);
    if (!jobId) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    const calculation = await readCalculation(jobId);
    res.json({ ok: true, jobId, calculation, derived: calculation ? deriveCalculation(calculation) : null });
  });

  app.put("/admin/api/job/:jobId/order-calculation", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const jobId = safeJobId(req.params.jobId);
      if (!jobId) return res.status(400).json({ ok: false, error: "Invalid jobId" });
      const calculation = await writeCalculation(jobId, req.body?.calculation || req.body || {});
      res.json({ ok: true, jobId, calculation, derived: deriveCalculation(calculation) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/job/:jobId/order-document", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const jobId = safeJobId(req.params.jobId);
      if (!jobId) return res.status(400).json({ ok: false, error: "Invalid jobId" });
      const fileName = cleanFileName(req.body?.fileName || "Auftrag.pdf");
      if (!/\.pdf$/i.test(fileName)) return res.status(400).json({ ok: false, error: "Nur PDF-Dateien sind erlaubt." });
      let base64 = String(req.body?.dataBase64 || "");
      const comma = base64.indexOf(",");
      if (comma >= 0) base64 = base64.slice(comma + 1);
      const buffer = Buffer.from(base64, "base64");
      if (!buffer.length || buffer.length > 20 * 1024 * 1024) return res.status(400).json({ ok: false, error: "PDF fehlt oder ist größer als 20 MB." });
      if (buffer.slice(0, 4).toString("ascii") !== "%PDF") return res.status(400).json({ ok: false, error: "Datei ist kein gültiges PDF." });
      await fsp.mkdir(orderDir(jobId), { recursive: true });
      const storedName = `${Date.now()}_${fileName}`;
      await fsp.writeFile(path.join(orderDir(jobId), storedName), buffer);
      const existing = await readCalculation(jobId);
      if (existing?.sourceDocument?.storedName && existing.sourceDocument.storedName !== storedName) {
        await fsp.unlink(path.join(orderDir(jobId), existing.sourceDocument.storedName)).catch(() => {});
      }
      const sourceDocument = {
        name: fileName,
        storedName,
        mimeType: "application/pdf",
        size: buffer.length,
        importedAt: new Date().toISOString(),
      };
      const calculation = await writeCalculation(jobId, { ...(existing || {}), sourceDocument });
      res.json({ ok: true, jobId, sourceDocument, calculation });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/job/:jobId/order-document", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const jobId = safeJobId(req.params.jobId);
    if (!jobId) return res.status(400).send("Invalid jobId");
    const calculation = await readCalculation(jobId);
    const storedName = calculation?.sourceDocument?.storedName;
    if (!storedName) return res.status(404).send("Kein Auftrags-PDF gespeichert.");
    const file = path.join(orderDir(jobId), storedName);
    if (!fs.existsSync(file)) return res.status(404).send("Auftrags-PDF nicht gefunden.");
    res.type("application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=\"${cleanFileName(calculation.sourceDocument.name)}\"`);
    res.sendFile(file);
  });

  app.get("/kristine/api/job/:jobId/work-scope", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const jobId = safeJobId(req.params.jobId);
    if (!jobId) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    const calculation = await readCalculation(jobId);
    res.json({
      ok: true,
      jobId,
      hasCalculation: !!calculation,
      subject: calculation?.subject || "",
      scope: calculation ? employeeScope(calculation) : { order: [], regie: [], addOrder: [], addRegie: [] },
      updatedAt: calculation?.updatedAt || null,
    });
  });
}

// Enrich the existing job list transparently. No server.js modification required.
if (!express.application[GET_PATCH_FLAG]) {
  express.application[GET_PATCH_FLAG] = true;
  const originalGet = express.application.get;
  express.application.get = function patchedGet(route, ...handlers) {
    if (route === "/admin/api/jobs" && handlers.length) {
      const wrapped = handlers.map(handler => {
        if (typeof handler !== "function") return handler;
        return function orderCalculationJobsWrapper(req, res, next) {
          const originalJson = res.json.bind(res);
          let sent = false;
          res.json = function enrichedJson(payload) {
            if (sent) return originalJson(payload);
            sent = true;
            return enrichJobsPayload(payload)
              .then(value => originalJson(value))
              .catch(() => originalJson(payload));
          };
          return handler(req, res, next);
        };
      });
      return originalGet.call(this, route, ...wrapped);
    }
    return originalGet.call(this, route, ...handlers);
  };
}

// server.js has a final 404 middleware. Register our routes immediately before it.
if (!express.application[USE_PATCH_FLAG]) {
  express.application[USE_PATCH_FLAG] = true;
  const originalUse = express.application.use;
  express.application.use = function patchedUse(...args) {
    const isFinal404 = args.some(arg => typeof arg === "function" && /Not found:/.test(Function.prototype.toString.call(arg)));
    if (isFinal404) registerRoutes(this);
    return originalUse.apply(this, args);
  };
}
