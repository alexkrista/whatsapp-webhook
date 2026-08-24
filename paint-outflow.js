"use strict";

const fsp = require("fs/promises");
const path = require("path");

function registerPaintOutflow(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const movementsFile = path.join(root, "movements.jsonl");

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

  async function ensureRoot() {
    await fsp.mkdir(root, { recursive: true });
  }

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }

  async function writeJson(file, value) {
    await ensureRoot();
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  async function appendJsonl(file, value) {
    await ensureRoot();
    await fsp.appendFile(file, JSON.stringify(value) + "\n", "utf8");
  }

  app.post("/admin/api/paint/outflow/book", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const articleId = clean(req.body?.articleId, 160);
      const reason = clean(req.body?.reason || "sale", 20).toLowerCase();
      const quantity = Math.max(1, Math.round(Math.abs(num(req.body?.quantity, 1))));
      const jobId = reason === "project" ? clean(req.body?.jobId, 80) : "";
      const colourTone = reason === "project" ? clean(req.body?.colourTone || req.body?.colorTone, 180) : "";
      const source = clean(req.body?.source || "scan", 40);
      const user = clean(req.body?.user || "KRISTINE", 120);

      if (!articleId) return res.status(400).json({ ok: false, error: "Material fehlt" });
      if (!["sale", "project"].includes(reason)) return res.status(400).json({ ok: false, error: "Verkauf oder Baustelle waehlen" });
      if (reason === "project" && !jobId) return res.status(400).json({ ok: false, error: "Baustelle fehlt" });
      if (reason === "project" && !colourTone) return res.status(400).json({ ok: false, error: "Farbton fehlt" });

      const articles = await readJson(articlesFile, []);
      const article = articles.find(a => String(a?.id || "") === articleId);
      if (!article) return res.status(404).json({ ok: false, error: "Material nicht gefunden" });

      const before = Number(article.stock || 0);
      const after = before - quantity;
      if (after < 0) return res.status(409).json({ ok: false, error: `Nicht genug Bestand (${before})` });

      const at = new Date().toISOString();
      article.stock = after;
      article.updatedAt = at;
      await writeJson(articlesFile, articles);

      const movement = {
        at,
        articleId: article.id,
        ean: article.ean || "",
        product: article.product || "",
        baseCode: article.baseCode || "",
        baseName: article.baseName || article.baseCode || "",
        size: article.size || "",
        direction: "out",
        quantity,
        delta: -quantity,
        before,
        after,
        reason,
        jobId,
        colourTone,
        source,
        user,
      };
      await appendJsonl(movementsFile, movement);
      res.json({ ok: true, article, movement });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintOutflow };
