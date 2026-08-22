"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function registerPaintReturnStock(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const materialsFile = path.join(root, "return-materials.json");
  const returnsFile = path.join(root, "returns.json");
  const printQueueFile = path.join(root, "return-print-queue.json");
  let writeChain = Promise.resolve();

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (String(token) !== String(adminToken)) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return false;
    }
    return true;
  }

  const clean = (value, max = 300) => String(value ?? "").trim().slice(0, max);
  const eanNorm = (value) => clean(value, 80).replace(/\D/g, "");
  const num = (value, fallback = NaN) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
    const raw = clean(value, 80).replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const norm = (value) => clean(value, 1200)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  async function ensureRoot() { await fsp.mkdir(root, { recursive: true }); }
  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await ensureRoot();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }
  function serial(task) {
    const run = writeChain.then(task, task);
    writeChain = run.catch(() => {});
    return run;
  }

  function articleMaterial(article) {
    if (!article) return null;
    const product = clean(article.product, 180);
    const base = clean(article.baseName || article.baseCode, 80);
    return {
      ean: eanNorm(article.ean),
      manufacturer: clean(article.manufacturer || "Little Greene", 120),
      material: product,
      size: clean(article.size, 80),
      base,
      stockCode: clean(article.stockCode, 100),
      source: "inventory",
      learnedAt: null,
      updatedAt: clean(article.updatedAt, 40) || null,
    };
  }

  async function resolveMaterial(ean) {
    const code = eanNorm(ean);
    if (!code) return null;
    const [articles, materials] = await Promise.all([
      readJson(articlesFile, []),
      readJson(materialsFile, []),
    ]);
    const article = (Array.isArray(articles) ? articles : []).find((row) => eanNorm(row?.ean) === code);
    if (article) return articleMaterial(article);
    const learned = (Array.isArray(materials) ? materials : []).find((row) => eanNorm(row?.ean) === code && row?.active !== false);
    return learned ? { ...learned, ean: code, source: "learned" } : null;
  }

  function ageDays(value) {
    const created = new Date(value);
    if (Number.isNaN(created.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400000));
  }

  function publicReturn(row) {
    return {
      id: clean(row?.id, 80),
      returnNo: Number(row?.returnNo || 0),
      ean: eanNorm(row?.ean),
      manufacturer: clean(row?.manufacturer, 120),
      material: clean(row?.material, 180),
      size: clean(row?.size, 80),
      base: clean(row?.base, 80),
      stockCode: clean(row?.stockCode, 100),
      colour: clean(row?.colour, 160),
      weightKg: Number(row?.weightKg || 0),
      jobId: clean(row?.jobId, 100),
      jobName: clean(row?.jobName, 180),
      status: clean(row?.status || "available", 30),
      createdAt: clean(row?.createdAt, 40),
      ageDays: ageDays(row?.createdAt),
    };
  }

  function matchesReturn(row, query) {
    const q = norm(query);
    if (!q) return true;
    const hay = norm([
      row?.returnNo, row?.ean, row?.manufacturer, row?.material, row?.size,
      row?.base, row?.stockCode, row?.colour, row?.jobId, row?.jobName,
    ].join(" "));
    return q.split(/\s+/).filter(Boolean).every((part) => hay.includes(part));
  }

  app.get("/admin/api/paint/returns/lookup", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const ean = eanNorm(req.query.ean);
    if (!ean) return res.status(400).json({ ok: false, error: "EAN fehlt" });
    const material = await resolveMaterial(ean);
    res.json({ ok: true, ean, known: !!material, material });
  });

  app.get("/admin/api/paint/returns/materials", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const [articles, learned] = await Promise.all([readJson(articlesFile, []), readJson(materialsFile, [])]);
    const rows = [];
    const seen = new Set();
    for (const article of Array.isArray(articles) ? articles : []) {
      const material = articleMaterial(article);
      if (!material?.ean || seen.has(material.ean)) continue;
      seen.add(material.ean); rows.push(material);
    }
    for (const row of Array.isArray(learned) ? learned : []) {
      const ean = eanNorm(row?.ean);
      if (!ean || row?.active === false || seen.has(ean)) continue;
      seen.add(ean); rows.push({ ...row, ean, source: "learned" });
    }
    rows.sort((a, b) => `${a.manufacturer} ${a.material}`.localeCompare(`${b.manufacturer} ${b.material}`, "de"));
    res.json({ ok: true, materials: rows });
  });

  app.post("/admin/api/paint/returns/material", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const ean = eanNorm(req.body?.ean);
      const manufacturer = clean(req.body?.manufacturer, 120);
      const materialName = clean(req.body?.material, 180);
      const size = clean(req.body?.size, 80);
      const base = clean(req.body?.base, 80);
      if (!ean || ean.length < 6) return res.status(400).json({ ok: false, error: "Gültiger Barcode/EAN fehlt" });
      if (!manufacturer || !materialName) return res.status(400).json({ ok: false, error: "Hersteller und Material sind erforderlich" });

      const inventory = await readJson(articlesFile, []);
      const inventoryArticle = (Array.isArray(inventory) ? inventory : []).find((row) => eanNorm(row?.ean) === ean);
      if (inventoryArticle) {
        return res.json({ ok: true, material: articleMaterial(inventoryArticle), inventory: true });
      }

      const saved = await serial(async () => {
        const rows = await readJson(materialsFile, []);
        const list = Array.isArray(rows) ? rows : [];
        const now = new Date().toISOString();
        const entry = {
          ean, manufacturer, material: materialName, size, base,
          active: true,
          learnedAt: now,
          updatedAt: now,
        };
        const index = list.findIndex((row) => eanNorm(row?.ean) === ean);
        if (index >= 0) list[index] = { ...list[index], ...entry, learnedAt: list[index].learnedAt || now };
        else list.push(entry);
        await writeJson(materialsFile, list);
        return index >= 0 ? list[index] : list[list.length - 1];
      });
      res.json({ ok: true, material: { ...saved, source: "learned" } });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/paint/returns", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = clean(req.query.q, 200);
    const includeUsed = String(req.query.includeUsed || "") === "1";
    const rows = await readJson(returnsFile, []);
    const items = (Array.isArray(rows) ? rows : [])
      .filter((row) => includeUsed || String(row?.status || "available") === "available")
      .filter((row) => matchesReturn(row, q))
      .sort((a, b) => Number(a.returnNo || 0) - Number(b.returnNo || 0))
      .reverse()
      .slice(0, 250)
      .map(publicReturn);
    res.json({ ok: true, items, count: items.length });
  });

  app.post("/admin/api/paint/returns", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const ean = eanNorm(req.body?.ean);
      const colour = clean(req.body?.colour, 160);
      const weightKg = num(req.body?.weightKg, NaN);
      const jobId = clean(req.body?.jobId, 100);
      const jobName = clean(req.body?.jobName, 180);
      if (!ean) return res.status(400).json({ ok: false, error: "Barcode fehlt" });
      if (!colour) return res.status(400).json({ ok: false, error: "Farbnummer/Farbton fehlt" });
      if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 1000) return res.status(400).json({ ok: false, error: "Gewicht in kg ist ungültig" });
      const material = await resolveMaterial(ean);
      if (!material) return res.status(409).json({ ok: false, code: "material_required", error: "Barcode ist noch keinem Material zugeordnet" });

      const result = await serial(async () => {
        const [rowsRaw, queueRaw] = await Promise.all([readJson(returnsFile, []), readJson(printQueueFile, [])]);
        const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
        const queue = Array.isArray(queueRaw) ? queueRaw : [];
        const maxNo = rows.reduce((max, row) => Math.max(max, Number(row?.returnNo || 0)), 0);
        const returnNo = maxNo + 1;
        const createdAt = new Date().toISOString();
        const item = {
          id: `R-${returnNo}`,
          returnNo,
          ean,
          manufacturer: clean(material.manufacturer, 120),
          material: clean(material.material, 180),
          size: clean(material.size, 80),
          base: clean(material.base, 80),
          stockCode: clean(material.stockCode, 100),
          colour,
          weightKg: Math.round(weightKg * 1000) / 1000,
          jobId,
          jobName,
          status: "available",
          createdAt,
          updatedAt: createdAt,
        };
        rows.push(item);

        const date = new Date(createdAt);
        const dateLabel = new Intl.DateTimeFormat("de-AT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Vienna" }).format(date);
        const printJob = {
          id: crypto.randomUUID(),
          kind: "paint-return-label",
          returnNo,
          big: String(returnNo),
          small: dateLabel,
          createdAt,
          status: "pending",
          attempts: 0,
          printedAt: null,
          error: "",
        };
        queue.push(printJob);
        await Promise.all([writeJson(returnsFile, rows), writeJson(printQueueFile, queue)]);
        return { item, printJob };
      });
      res.json({ ok: true, item: publicReturn(result.item), printJob: result.printJob });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/paint/returns/print-queue", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
    const queue = await readJson(printQueueFile, []);
    const jobs = (Array.isArray(queue) ? queue : [])
      .filter((job) => String(job?.status || "pending") === "pending")
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
      .slice(0, limit);
    res.json({ ok: true, jobs });
  });

  app.post("/admin/api/paint/returns/print-queue/:id/ack", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = clean(req.params.id, 100);
      const success = req.body?.success !== false;
      const errorText = clean(req.body?.error, 500);
      const result = await serial(async () => {
        const queueRaw = await readJson(printQueueFile, []);
        const queue = Array.isArray(queueRaw) ? queueRaw : [];
        const index = queue.findIndex((job) => String(job?.id || "") === id);
        if (index < 0) return null;
        const now = new Date().toISOString();
        queue[index] = {
          ...queue[index],
          status: success ? "printed" : "pending",
          attempts: Number(queue[index].attempts || 0) + 1,
          printedAt: success ? now : null,
          error: success ? "" : errorText,
          updatedAt: now,
        };
        await writeJson(printQueueFile, queue);
        return queue[index];
      });
      if (!result) return res.status(404).json({ ok: false, error: "Druckauftrag nicht gefunden" });
      res.json({ ok: true, job: result });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintReturnStock };
