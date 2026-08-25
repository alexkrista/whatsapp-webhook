"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { readLatestStockMap, stockForArticle } = require("./paint-stock-ledger");

function registerPaintRuntimeSafety(app, options = {}) {
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

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }

  const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
  const sizeNorm = value => {
    const raw = clean(value, 50).toLowerCase().replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "");
    if (/^250ml$|^0[.,]?25l$/.test(raw)) return "0.25 L";
    if (/^500ml$|^0[.,]?5l$/.test(raw)) return "0.5 L";
    if (/^750ml$|^0[.,]?75l$/.test(raw)) return "0.75 L";
    if (/^1l$/.test(raw)) return "1 L";
    if (/^2l$/.test(raw)) return "2 L";
    if (/^2[.,]?5l$/.test(raw)) return "2.5 L";
    if (/^4l$/.test(raw)) return "4 L";
    if (/^5l$/.test(raw)) return "5 L";
    if (/^10l$/.test(raw)) return "10 L";
    return clean(value, 50);
  };

  // Verbindliche Lageranzeige: Artikelstamm liefert Stammdaten/Soll/EAN/Preise,
  // IST kommt aus der letzten Inventur/Lagerbewegung. Falls es fuer einen Artikel
  // noch nie eine Bewegung gab, bleibt articles.json der Fallback.
  app.get("/admin/api/paint/inventory", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const [articles, latestStock] = await Promise.all([
        readJson(articlesFile, []),
        readLatestStockMap(root),
      ]);
      const rows = Array.isArray(articles) ? articles : [];
      const items = rows
        .filter(article => article && article.active !== false)
        .map(article => {
          const resolved = stockForArticle(article, latestStock);
          const targetStock = Number(article.targetStock ?? article.minimumStock ?? 0);
          const minimumStock = Number(article.minimumStock ?? article.targetStock ?? 0);
          const stock = Number(resolved.stock || 0);
          return {
            id: article.id || "",
            product: article.product || "",
            baseName: article.baseName || article.baseCode || "",
            baseCode: article.baseCode || "",
            baseLabel: article.baseLabel || "",
            category: article.category || "",
            size: sizeNorm(article.size),
            ean: article.ean || "",
            stockCode: article.stockCode || "",
            purchasePrice: Number(article.purchasePrice || 0),
            targetStock,
            minimumStock,
            stock,
            stockSource: resolved.source,
            stockAt: resolved.movement?.at || article.lastInventoryAt || article.updatedAt || null,
            difference: targetStock - stock,
            orderQuantityOverride: article.orderQuantityOverride ?? null,
            orderManual: article.orderQuantityOverride !== null && article.orderQuantityOverride !== undefined,
          };
        });
      res.json({
        ok: true,
        items,
        count: items.length,
        scope: "LG BASES + COLOURANTS",
        stockSource: "Inventur/Lagerbuch",
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  function oldImportDisabled(req, res) {
    if (!requireAdmin(req, res)) return;
    res.status(410).json({
      ok: false,
      error: "Deaktiviert: KRISTINE/Render ist jetzt der Lager-Master. Kein Excel-Neuimport mehr.",
    });
  }

  // Schutz gegen alte/cached Oberflaechen: Sie duerfen den inventierten Bestand
  // nicht mehr ueber Excel oder den alten Recovery-Neuaufbau veraendern.
  app.post("/admin/api/paint/import-excel", oldImportDisabled);
  app.post("/admin/api/paint/inventory/import-legacy-soll", oldImportDisabled);
  app.get("/admin/api/paint/inventory/rebuild-preview", oldImportDisabled);
  app.post("/admin/api/paint/inventory/rebuild", oldImportDisabled);
}

module.exports = { registerPaintRuntimeSafety };
