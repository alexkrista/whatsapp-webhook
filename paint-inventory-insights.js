"use strict";

const fsp = require("fs/promises");
const path = require("path");

function registerPaintInventoryInsights(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const movementsFile = path.join(dataDir, "_kristine", "paint", "movements.jsonl");

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

  async function readMovements() {
    try {
      const raw = await fsp.readFile(movementsFile, "utf8");
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function quantityOf(row) {
    const quantity = Number(row?.quantity);
    if (Number.isFinite(quantity) && quantity !== 0) return Math.abs(quantity);
    const delta = Number(row?.delta);
    if (Number.isFinite(delta) && delta !== 0) return Math.abs(delta);
    return 0;
  }

  function isConsumption(row) {
    const direction = clean(row?.direction, 40).toLowerCase();
    if (direction === "out") return true;
    if (direction === "inventory") return false;
    const delta = Number(row?.delta);
    return Number.isFinite(delta) && delta < 0;
  }

  app.get("/admin/api/paint/inventory/usage", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const articleId = clean(req.query.articleId, 180);
      if (!articleId) return res.status(400).json({ ok: false, error: "articleId fehlt" });

      const months = Math.min(24, Math.max(1, Number.parseInt(req.query.months, 10) || 6));
      const to = new Date();
      const from = new Date(to);
      from.setMonth(from.getMonth() - months);

      const all = (await readMovements()).filter(row => String(row?.articleId || "") === articleId);
      const dated = all
        .map(row => ({ row, at: new Date(row?.at || 0) }))
        .filter(item => Number.isFinite(item.at.getTime()))
        .sort((a, b) => a.at - b.at);

      const trackedSince = dated.length ? dated[0].at.toISOString() : null;
      const recent = dated.filter(item => item.at >= from && item.at <= to && isConsumption(item.row));
      const consumed = recent.reduce((sum, item) => sum + quantityOf(item.row), 0);

      let jobs = 0;
      let sales = 0;
      let other = 0;
      for (const item of recent) {
        const qty = quantityOf(item.row);
        const reason = clean(item.row?.reason, 80).toLowerCase();
        if (clean(item.row?.jobId, 100) || /baustelle|job|site/.test(reason)) jobs += qty;
        else if (/verkauf|sale|retail/.test(reason)) sales += qty;
        else other += qty;
      }

      const coverageComplete = !!trackedSince && new Date(trackedSince) <= from;
      const coverageStart = trackedSince ? new Date(trackedSince) : null;
      const coverageDays = coverageStart
        ? Math.max(1, Math.round((to - coverageStart) / 86400000))
        : 0;
      const effectiveMonths = coverageComplete ? months : Math.max(1 / 30, coverageDays / 30.4375);

      res.json({
        ok: true,
        articleId,
        months,
        from: from.toISOString(),
        to: to.toISOString(),
        consumed: Math.round(consumed * 1000) / 1000,
        movements: recent.length,
        trackedSince,
        coverageComplete,
        monthlyAverage: Math.round((consumed / effectiveMonths) * 100) / 100,
        byUse: {
          jobs: Math.round(jobs * 1000) / 1000,
          sales: Math.round(sales * 1000) / 1000,
          other: Math.round(other * 1000) / 1000,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintInventoryInsights };
