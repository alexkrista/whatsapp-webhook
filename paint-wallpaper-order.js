"use strict";

const fsp = require("fs/promises");
const path = require("path");

function registerPaintWallpaperOrder(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const orderFile = path.join(root, "wallpaper-order.json");

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
  const nonNegativeInt = value => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };

  async function ensureRoot() { await fsp.mkdir(root, { recursive: true }); }
  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await ensureRoot();
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  function normalizeItems(rows) {
    return (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: clean(row?.id, 120) || `wallpaper-${Date.now()}-${index}`,
      collection: clean(row?.collection, 160),
      design: clean(row?.design, 180),
      colourway: clean(row?.colourway, 180),
      productCode: clean(row?.productCode, 120),
      rolls: nonNegativeInt(row?.rolls),
      note: clean(row?.note, 300),
    })).filter(row => row.rolls > 0 && (row.design || row.productCode || row.colourway));
  }

  app.get("/admin/api/paint/wallpaper-order", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const saved = await readJson(orderFile, { items: [], updatedAt: null });
    const items = normalizeItems(saved.items || []);
    res.json({
      ok: true,
      items,
      count: items.length,
      rollsTotal: items.reduce((sum, row) => sum + row.rolls, 0),
      updatedAt: saved.updatedAt || null,
    });
  });

  app.post("/admin/api/paint/wallpaper-order", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const items = normalizeItems(req.body?.items || []);
      const payload = { items, updatedAt: new Date().toISOString() };
      await writeJson(orderFile, payload);
      res.json({
        ok: true,
        items,
        count: items.length,
        rollsTotal: items.reduce((sum, row) => sum + row.rolls, 0),
        updatedAt: payload.updatedAt,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintWallpaperOrder };
