"use strict";

const fsp = require("fs/promises");
const path = require("path");
const XLSX = require("xlsx");

function registerPaintLegacySollImport(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");

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
  const norm = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const num = value => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const n = Number(clean(value, 60).replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const sizeNorm = value => {
    const raw = clean(value, 50).toLowerCase().replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "").replace(",", ".");
    if (/^250ml$|^0\.25l$/.test(raw)) return "0.25 L";
    if (/^500ml$|^0\.5l$/.test(raw)) return "0.5 L";
    if (/^750ml$|^0\.75l$/.test(raw)) return "0.75 L";
    if (/^1l$/.test(raw)) return "1 L";
    if (/^2l$/.test(raw)) return "2 L";
    if (/^2\.5l$/.test(raw)) return "2.5 L";
    if (/^4l$/.test(raw)) return "4 L";
    if (/^5l$/.test(raw)) return "5 L";
    if (/^10l$/.test(raw)) return "10 L";
    return clean(value, 50);
  };
  const baseNorm = value => {
    const n = norm(value).replace(/\s+/g, "");
    if (["h","hi","hiwhite"].includes(n)) return "H";
    if (["xd","x","extradeep"].includes(n)) return "XD";
    if (["m","medium"].includes(n)) return "M";
    if (["d","deep"].includes(n)) return "D";
    if (["t","transparent"].includes(n)) return "T";
    if (["y","yellow"].includes(n)) return "Y";
    if (["p","pastel"].includes(n)) return "P";
    if (["w","whte","white","whiteasp"].includes(n)) return "W";
    return clean(value, 30).toUpperCase();
  };
  const key = (product, size, base) => `${norm(product)}|${sizeNorm(size)}|${baseNorm(base)}`;

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  app.post("/admin/api/paint/inventory/import-legacy-soll", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const base64 = clean(req.body?.base64, 120_000_000).replace(/^data:.*?;base64,/, "");
      if (!base64) return res.status(400).json({ ok: false, error: "Excel-Datei fehlt" });

      const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer", cellDates: false });
      const sheet = workbook.Sheets["Lagerliste Farben"];
      if (!sheet) return res.status(400).json({ ok: false, error: "Blatt 'Lagerliste Farben' fehlt" });
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });

      const legacy = new Map();
      for (let r = 9; r < rows.length; r += 1) {
        const row = rows[r] || [];
        const product = clean(row[1], 180);
        const size = clean(row[2], 50);
        const base = clean(row[3], 40);
        const soll = num(row[12]);
        if (!product || !size || !base || soll === null || soll < 0) continue;
        legacy.set(key(product, size, base), { product, size, base, soll: Math.round(soll * 1000) / 1000, row: r + 1 });
      }

      const articles = await readJson(articlesFile, []);
      let matched = 0;
      let changed = 0;
      const missing = [];

      for (const article of Array.isArray(articles) ? articles : []) {
        const hit = legacy.get(key(article.product, article.size, article.baseCode || article.baseName));
        if (!hit) continue;
        matched += 1;
        let touched = false;
        if (Number(article.minimumStock || 0) !== hit.soll) { article.minimumStock = hit.soll; touched = true; }
        if (Number(article.targetStock || 0) !== hit.soll) { article.targetStock = hit.soll; touched = true; }
        if (touched) {
          article.updatedAt = new Date().toISOString();
          changed += 1;
        }
      }

      for (const [legacyKey, hit] of legacy) {
        const exists = (Array.isArray(articles) ? articles : []).some(article => key(article.product, article.size, article.baseCode || article.baseName) === legacyKey);
        if (!exists && hit.soll > 0) missing.push({ row: hit.row, product: hit.product, size: hit.size, base: hit.base, soll: hit.soll });
      }

      if (changed) await writeJson(articlesFile, articles);
      res.json({ ok: true, matched, changed, legacyRows: legacy.size, missing: missing.slice(0, 30), missingCount: missing.length });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintLegacySollImport };
