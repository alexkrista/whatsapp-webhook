"use strict";

const fsp = require("fs/promises");
const path = require("path");

function registerPaintInventoryCounter(app, options = {}) {
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

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }

  function isInventoryArticle(article) {
    if (!article || article.active === false || article.inventory === false) return false;
    const category = String(article.category || "").trim().toLowerCase();
    if (category) return category === "base" || category === "colourant";
    return !!String(article.product || "").trim() && !!String(article.size || "").trim();
  }

  app.get("/admin/api/paint/inventory/session-count", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const sinceRaw = String(req.query.since || "").trim();
      const sinceMs = Date.parse(sinceRaw);
      const since = Number.isFinite(sinceMs) ? sinceMs : 0;
      const articles = await readJson(articlesFile, []);
      const eligible = new Set((Array.isArray(articles) ? articles : []).filter(isInventoryArticle).map(a => String(a.id || "")).filter(Boolean));

      const counted = new Set();
      let latestAt = null;
      let raw = "";
      try { raw = await fsp.readFile(movementsFile, "utf8"); } catch {}
      for (const line of String(raw || "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row = null;
        try { row = JSON.parse(line); } catch { continue; }
        if (String(row?.reason || "") !== "inventory_count" && String(row?.direction || "") !== "inventory") continue;
        const atMs = Date.parse(String(row?.at || ""));
        if (!Number.isFinite(atMs) || atMs < since) continue;
        const id = String(row?.articleId || "");
        if (!id || !eligible.has(id)) continue;
        counted.add(id);
        if (!latestAt || atMs > Date.parse(latestAt)) latestAt = new Date(atMs).toISOString();
      }

      res.json({
        ok: true,
        done: counted.size,
        total: eligible.size,
        counted: [...counted],
        since: since ? new Date(since).toISOString() : null,
        latestAt,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintInventoryCounter };
