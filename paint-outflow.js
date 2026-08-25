"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { readLatestStockMap, stockForArticle } = require("./paint-stock-ledger");

function registerPaintOutflow(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const movementsFile = path.join(root, "movements.jsonl");
  const jobMaterialsFile = path.join(root, "job-materials.jsonl");

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (String(token) !== String(adminToken)) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return false;
    }
    return true;
  }

  const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
  const num = (value, fallback = 0) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
    const raw = clean(value).replace(/\s/g, "").replace(",", ".");
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const sizeLiters = value => {
    const raw = clean(value, 50).toLowerCase().replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "").replace(",", ".");
    const ml = raw.match(/^([0-9.]+)ml$/);
    if (ml) return Math.max(0, Number(ml[1]) || 0) / 1000;
    const l = raw.match(/^([0-9.]+)l$/);
    return l ? Math.max(0, Number(l[1]) || 0) : 0;
  };

  async function ensureDir(file = articlesFile) { await fsp.mkdir(path.dirname(file), { recursive: true }); }
  async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; } }
  async function writeJson(file, value) {
    await ensureDir(file);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }
  async function appendJsonl(file, value) {
    await ensureDir(file);
    await fsp.appendFile(file, JSON.stringify(value) + "\n", "utf8");
  }

  async function appendProjectMaterial(article, movement) {
    if (movement.reason !== "project" || !movement.jobId) return;
    const booking = {
      id: `paintmat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      at: movement.at,
      jobId: movement.jobId,
      jobName: movement.jobName || "",
      articleId: article.id || "",
      product: article.product || "",
      baseCode: article.baseCode || "",
      baseName: article.baseName || article.baseCode || "",
      size: article.size || "",
      colourTone: movement.colourTone || "ungemischt",
      quantity: movement.quantity,
      liters: Number((sizeLiters(article.size) * Number(movement.quantity || 0)).toFixed(3)),
      purchasePrice: Number(article.purchasePrice || 0),
      salePrice: Number(article.salePrice || 0),
      source: movement.source || "scan",
    };
    await appendJsonl(jobMaterialsFile, booking);
    const jobDir = path.join(dataDir, String(movement.jobId));
    try {
      const stat = await fsp.stat(jobDir);
      if (stat.isDirectory()) await appendJsonl(path.join(jobDir, "_chronik", "material-bookings.jsonl"), booking);
    } catch {}
  }

  app.post("/admin/api/paint/outflow/book", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const articleId = clean(req.body?.articleId, 160);
      const reason = clean(req.body?.reason || "sale", 20).toLowerCase();
      const quantity = Math.max(1, Math.round(Math.abs(num(req.body?.quantity, 1))));
      const jobId = reason === "project" ? clean(req.body?.jobId, 80) : "";
      const jobName = reason === "project" ? clean(req.body?.jobName, 180) : "";
      const colourTone = reason === "project"
        ? (clean(req.body?.colourTone || req.body?.colorTone, 180) || "ungemischt")
        : clean(req.body?.colourTone || req.body?.colorTone, 180);
      const source = clean(req.body?.source || "scan", 40);
      const user = clean(req.body?.user || "KRISTINE", 120);

      if (!articleId) return res.status(400).json({ ok: false, error: "Material fehlt" });
      if (!["sale", "project"].includes(reason)) return res.status(400).json({ ok: false, error: "Verkauf oder Baustelle waehlen" });
      if (reason === "project" && !jobId) return res.status(400).json({ ok: false, error: "Baustelle fehlt" });

      const articles = await readJson(articlesFile, []);
      const article = articles.find(a => String(a?.id || "") === articleId);
      if (!article) return res.status(404).json({ ok: false, error: "Material nicht gefunden" });

      const latestStock = await readLatestStockMap(root);
      const resolved = stockForArticle(article, latestStock);
      const before = Number(resolved.stock || 0);
      const after = before - quantity;
      if (after < 0) return res.status(409).json({ ok: false, error: `Nicht genug Bestand (${before})` });

      const at = new Date().toISOString();
      article.stock = after;
      article.updatedAt = at;
      await writeJson(articlesFile, articles);

      const movement = {
        at, articleId: article.id, ean: article.ean || "", stockCode: article.stockCode || "",
        product: article.product || "", baseCode: article.baseCode || "", baseName: article.baseName || article.baseCode || "", size: article.size || "",
        direction: "out", quantity, delta: -quantity, before, after, reason, jobId, jobName, colourTone, source, user,
        purchasePrice: Number(article.purchasePrice || 0), salePrice: Number(article.salePrice || 0),
      };
      await appendJsonl(movementsFile, movement);
      await appendProjectMaterial(article, movement);
      res.json({ ok: true, article, movement });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintOutflow };
