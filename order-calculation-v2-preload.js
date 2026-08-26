"use strict";

// KRISTINE Kalkulation V2 – Mengen/Preise, Kalkulationsauswahl und Regie-Untertypen.
// Muss VOR order-calculation-preload.js geladen werden, damit die V2-Anreicherung
// nach der bestehenden V1-Anreicherung auf /admin/api/jobs ausgeführt wird.

const fsp = require("fs/promises");
const path = require("path");
const express = require("express");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ROUTES_FLAG = Symbol.for("krista.orderCalculation.routes.v2");
const GET_PATCH_FLAG = Symbol.for("krista.orderCalculation.getPatch.v2");
const USE_PATCH_FLAG = Symbol.for("krista.orderCalculation.usePatch.v2");
const COMPONENTS = new Set(["arbeit", "material", "maschine", "leistung", "sonstiges"]);

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
function calculationPath(jobId) {
  return path.join(DATA_DIR, String(jobId), ".order-calculation.json");
}
function metaPath(jobId) {
  return path.join(DATA_DIR, String(jobId), ".order-lines-v2.json");
}
function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
function text(value, max = 80) {
  return String(value ?? "").trim().slice(0, max);
}
function euro(value) {
  const raw = String(value ?? "").trim().replace(/\./g, "").replace(",", ".");
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
function roundMoney(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}
async function readCalculation(jobId) {
  try {
    const value = JSON.parse(await fsp.readFile(calculationPath(jobId), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
async function readMeta(jobId) {
  try {
    const value = JSON.parse(await fsp.readFile(metaPath(jobId), "utf8"));
    return {
      version: 2,
      rows: Array.isArray(value?.rows) ? value.rows : [],
      updatedAt: value?.updatedAt || null,
    };
  } catch {
    return { version: 2, rows: [], updatedAt: null };
  }
}
function sanitizeMetaRow(row, index) {
  const source = row && typeof row === "object" ? row : {};
  const componentType = COMPONENTS.has(source.componentType) ? source.componentType : "";
  return {
    positionId: text(source.positionId, 100),
    quantity: number(source.quantity),
    unit: text(source.unit, 24),
    unitPrice: number(source.unitPrice),
    componentType,
    calcIncluded: source.calcIncluded !== false,
    index,
  };
}
async function writeMeta(jobId, rows) {
  const next = {
    version: 2,
    rows: (Array.isArray(rows) ? rows : []).slice(0, 600).map(sanitizeMetaRow),
    updatedAt: new Date().toISOString(),
  };
  await fsp.mkdir(path.join(DATA_DIR, String(jobId)), { recursive: true });
  await fsp.writeFile(metaPath(jobId), JSON.stringify(next, null, 2), "utf8");
  return next;
}
function parseLineNumbers(description) {
  const source = String(description || "").replace(/\s+/g, " ").trim();
  const qtyMatch = source.match(/(?:^|\s)(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)\s*(Std|VE|Stk\.?|Stück|Stueck|m²|m2|lfm|Psch\.?|Pausch\.?|pauschal|m)\b/i);
  const quantity = qtyMatch ? euro(qtyMatch[1]) : 0;
  const unit = qtyMatch ? String(qtyMatch[2]).replace(/\.$/, "") : "";
  const values = source.match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/g) || [];
  const total = values.length ? euro(values[values.length - 1]) : 0;
  let unitPrice = values.length >= 3 ? euro(values[values.length - 2]) : 0;
  if (!unitPrice && quantity > 0 && total > 0) unitPrice = total / quantity;
  return { quantity, unit, unitPrice: roundMoney(unitPrice), total: roundMoney(total) };
}
function inferComponent(row, parsed) {
  const hay = `${row?.title || ""} ${row?.shortText || ""} ${row?.description || ""}`.toLowerCase();
  if (/material|farbe|lack|grundierung|spachtel|kleber|vlies|tapete|maschinen?\s+für\s+regie|material\s+und\s+maschinen/.test(hay)) return "material";
  if (/maschine|gerät|geraet|miete/.test(hay)) return "maschine";
  if (/^std$/i.test(parsed.unit) || number(row?.plannedHours) > 0) return "arbeit";
  return "leistung";
}
function effectiveLine(row, stored, index) {
  const parsed = parseLineNumbers(row?.description || row?.shortText || row?.title || "");
  const meta = sanitizeMetaRow(stored || {}, index);
  const quantity = meta.quantity > 0 ? meta.quantity : parsed.quantity;
  const unit = meta.unit || parsed.unit;
  const unitPrice = meta.unitPrice > 0 ? meta.unitPrice : parsed.unitPrice;
  const componentType = meta.componentType || inferComponent(row, { ...parsed, unit });
  const amount = quantity > 0 && unitPrice > 0 ? roundMoney(quantity * unitPrice) : number(row?.amount || parsed.total);
  const isRegie = row?.kind === "regie" || row?.kind === "nachtrag_regie";
  const plannedHours = isRegie && componentType === "arbeit"
    ? (number(row?.plannedHours) || (/^std$/i.test(unit) ? quantity : 0))
    : 0;
  return {
    ...row,
    positionId: text(row?.id || meta.positionId, 100),
    quantity,
    unit,
    unitPrice,
    amount,
    componentType,
    calcIncluded: meta.calcIncluded !== false,
    plannedHours,
    index,
  };
}
function derive(calc, meta, fallbackRate = 0) {
  const sourceRows = Array.isArray(calc?.positions) ? calc.positions : [];
  const lines = sourceRows.map((row, index) => effectiveLine(row, meta?.rows?.[index], index));
  const included = lines.filter(row => row.calcIncluded !== false);
  const original = lines.filter(row => !row.addToContract);
  const originalIncluded = original.filter(row => row.calcIncluded !== false);
  const anyOriginalExcluded = original.some(row => row.calcIncluded === false);
  const originalSum = original.reduce((sum, row) => sum + number(row.amount), 0);
  const selectedOriginalSum = originalIncluded.reduce((sum, row) => sum + number(row.amount), 0);
  const baseNet = number(calc?.netTotal);
  const selectedBaseAmount = anyOriginalExcluded ? selectedOriginalSum : (baseNet || originalSum);
  const addedAmount = included.filter(row => row.addToContract).reduce((sum, row) => sum + number(row.amount), 0);
  const contractAmount = selectedBaseAmount + addedAmount;
  const sumKind = predicate => included.reduce((sum, row) => sum + (predicate(row) ? number(row.amount) : 0), 0);
  const regieAmount = sumKind(row => row.kind === "regie" || row.kind === "nachtrag_regie");
  const regieLaborAmount = sumKind(row => (row.kind === "regie" || row.kind === "nachtrag_regie") && row.componentType === "arbeit");
  const regieMaterialAmount = Math.max(0, regieAmount - regieLaborAmount);
  const externalServices = sumKind(row => row.kind === "fremdleistung");
  const otherExcludedAmount = sumKind(row => row.kind === "sonstiges");
  const fixedOwnAmount = Math.max(0, contractAmount - regieAmount - externalServices - otherExcludedAmount);
  const materialPercent = Math.min(100, number(calc?.materialPercent));
  const materialAmount = fixedOwnAmount * materialPercent / 100;
  const laborAmount = Math.max(0, fixedOwnAmount - materialAmount);
  const billingRate = number(calc?.billingRate) || number(fallbackRate);
  const calculatedHours = billingRate > 0 ? laborAmount / billingRate : 0;
  const plannedRegieHours = included.reduce((sum, row) => sum + ((row.kind === "regie" || row.kind === "nachtrag_regie") && row.componentType === "arbeit" ? number(row.plannedHours) : 0), 0);
  const excludedAmount = lines.filter(row => row.calcIncluded === false).reduce((sum, row) => sum + number(row.amount), 0);
  return {
    lines,
    baseNet,
    selectedBaseAmount,
    sourcePositionSum: originalSum,
    addedAmount,
    contractAmount,
    regieAmount,
    regieLaborAmount,
    regieMaterialAmount,
    externalServices,
    otherExcludedAmount,
    fixedOwnAmount,
    materialPercent,
    materialAmount,
    laborAmount,
    billingRate,
    calculatedHours,
    plannedRegieHours,
    excludedAmount,
    anyOriginalExcluded,
  };
}
async function enrichJobsPayload(payload) {
  if (!payload || !Array.isArray(payload.jobs)) return payload;
  const jobs = await Promise.all(payload.jobs.map(async job => {
    const calc = await readCalculation(job.jobId);
    if (!calc) return job;
    const meta = await readMeta(job.jobId);
    const old = job.calculation || {};
    const d = derive(calc, meta, old.billingRate || job.billingRate);
    const actualHours = number(old.actualHours);
    const actualRegieHours = number(old.actualRegieHours);
    const orderHours = number(old.orderHours ?? Math.max(0, actualHours - actualRegieHours));
    return {
      ...job,
      contractAmount: d.contractAmount,
      externalServices: d.externalServices,
      plannedRegieHours: d.plannedRegieHours,
      orderLineMetaV2: meta,
      calculation: {
        ...old,
        contractAmount: d.contractAmount,
        selectedBaseAmount: d.selectedBaseAmount,
        excludedPositionAmount: d.excludedAmount,
        externalServices: d.externalServices,
        regieBudgetAmount: d.regieAmount,
        regieLaborAmount: d.regieLaborAmount,
        regieMaterialAmount: d.regieMaterialAmount,
        otherExcludedAmount: d.otherExcludedAmount,
        kristaAmount: d.fixedOwnAmount,
        materialPercent: d.materialPercent,
        materialAmount: d.materialAmount,
        laborAmount: d.laborAmount,
        billingRate: d.billingRate,
        calculatedHours: d.calculatedHours,
        actualHours,
        actualRegieHours,
        orderHours,
        remainingOrderHours: d.calculatedHours - orderHours,
        progressPercent: d.calculatedHours > 0 ? orderHours / d.calculatedHours * 100 : 0,
        plannedRegieHours: d.plannedRegieHours,
        remainingRegieHours: d.plannedRegieHours - actualRegieHours,
      },
    };
  }));
  return { ...payload, jobs };
}
function employeeScope(calc, meta) {
  const d = derive(calc, meta, calc?.billingRate);
  const rows = d.lines
    .filter(row => row.employeeVisible !== false && row.calcIncluded !== false)
    .filter(row => ["auftrag", "regie", "nachtrag_auftrag", "nachtrag_regie"].includes(row.kind))
    .map(row => ({
      id: row.id,
      number: row.number,
      title: row.title,
      text: row.shortText || row.title || row.description,
      kind: row.kind,
      componentType: row.componentType,
      quantity: row.quantity,
      unit: row.unit,
      plannedHours: row.plannedHours,
    }));
  return {
    order: rows.filter(row => row.kind === "auftrag"),
    regie: rows.filter(row => row.kind === "regie"),
    addOrder: rows.filter(row => row.kind === "nachtrag_auftrag"),
    addRegie: rows.filter(row => row.kind === "nachtrag_regie"),
  };
}
function registerRoutes(app) {
  if (app[ROUTES_FLAG]) return;
  app[ROUTES_FLAG] = true;

  app.get("/admin/api/job/:jobId/order-lines-v2", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const jobId = safeJobId(req.params.jobId);
    if (!jobId) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    const [calc, meta] = await Promise.all([readCalculation(jobId), readMeta(jobId)]);
    res.json({ ok: true, jobId, rows: calc ? derive(calc, meta).lines.map(row => ({
      positionId: row.positionId,
      quantity: row.quantity,
      unit: row.unit,
      unitPrice: row.unitPrice,
      componentType: row.componentType,
      calcIncluded: row.calcIncluded,
    })) : meta.rows, metaUpdatedAt: meta.updatedAt });
  });

  app.put("/admin/api/job/:jobId/order-lines-v2", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const jobId = safeJobId(req.params.jobId);
      if (!jobId) return res.status(400).json({ ok: false, error: "Invalid jobId" });
      const meta = await writeMeta(jobId, req.body?.rows || []);
      const calc = await readCalculation(jobId);
      res.json({ ok: true, jobId, meta, derived: calc ? derive(calc, meta) : null });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/job/:jobId/work-scope-v2", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const jobId = safeJobId(req.params.jobId);
    if (!jobId) return res.status(400).json({ ok: false, error: "Invalid jobId" });
    const [calc, meta] = await Promise.all([readCalculation(jobId), readMeta(jobId)]);
    res.json({
      ok: true,
      jobId,
      hasCalculation: !!calc,
      subject: calc?.subject || "",
      scope: calc ? employeeScope(calc, meta) : { order: [], regie: [], addOrder: [], addRegie: [] },
      updatedAt: meta.updatedAt || calc?.updatedAt || null,
    });
  });
}

if (!express.application[GET_PATCH_FLAG]) {
  express.application[GET_PATCH_FLAG] = true;
  const originalGet = express.application.get;
  express.application.get = function patchedGet(route, ...handlers) {
    if (route === "/admin/api/jobs" && handlers.length) {
      const wrapped = handlers.map(handler => {
        if (typeof handler !== "function") return handler;
        return function orderCalculationV2JobsWrapper(req, res, next) {
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

if (!express.application[USE_PATCH_FLAG]) {
  express.application[USE_PATCH_FLAG] = true;
  const originalUse = express.application.use;
  express.application.use = function patchedUse(...args) {
    const isFinal404 = args.some(arg => typeof arg === "function" && /Not found:/.test(Function.prototype.toString.call(arg)));
    if (isFinal404) registerRoutes(this);
    return originalUse.apply(this, args);
  };
}
