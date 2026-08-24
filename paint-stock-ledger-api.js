"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { identityKey, readLatestStockMap, stockForArticle } = require("./paint-stock-ledger");

function registerPaintStockLedgerApi(app, options = {}) {
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
  const nullableNonNegative = value => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.max(0, Math.round(n * 1000) / 1000) : null;
  };

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  function suggestion(article, stock) {
    const category = clean(article?.category, 40).toLowerCase();
    if (category === "sample-pot" || category === "marketing") return 0;
    const minimum = Math.max(0, Number(article?.minimumStock || 0));
    const target = Math.max(minimum, Number(article?.targetStock ?? minimum) || 0);
    return Number(stock) <= minimum ? Math.max(0, Math.ceil(target - Number(stock))) : 0;
  }

  function rowFor(article, stockMap) {
    const resolved = stockForArticle(article, stockMap);
    const manual = nullableNonNegative(article?.orderQuantityOverride);
    const suggested = suggestion(article, resolved.stock);
    return {
      identityKey: identityKey(article),
      articleId: clean(article?.id, 220),
      product: clean(article?.product, 180),
      baseCode: clean(article?.baseCode, 80),
      baseName: clean(article?.baseName || article?.baseCode, 100),
      size: clean(article?.size, 50),
      stockCode: clean(article?.stockCode, 100),
      ean: clean(article?.ean, 100),
      stock: resolved.stock,
      stockSource: resolved.source,
      stockAt: resolved.movement?.at || article?.lastInventoryAt || article?.updatedAt || null,
      minimumStock: Math.max(0, Number(article?.minimumStock || 0)),
      targetStock: Math.max(0, Number(article?.targetStock ?? article?.minimumStock ?? 0)),
      purchasePrice: Math.max(0, Number(article?.purchasePrice || 0)),
      suggestedOrderQuantity: suggested,
      manualOrderQuantity: manual,
      effectiveOrderQuantity: manual === null ? suggested : manual,
    };
  }

  app.get("/admin/api/paint/stock-ledger", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const [articles, stockMap] = await Promise.all([
        readJson(articlesFile, []),
        readLatestStockMap(root),
      ]);
      const items = (Array.isArray(articles) ? articles : [])
        .filter(article => article && article.active !== false && article.inventory !== false)
        .map(article => rowFor(article, stockMap));
      res.json({ ok: true, items, source: "movements.jsonl", fallback: "articles.json" });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/order-direct", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const articles = await readJson(articlesFile, []);
      const wanted = {
        product: clean(req.body?.product, 180),
        baseCode: clean(req.body?.baseCode || req.body?.baseName, 80),
        baseName: clean(req.body?.baseName || req.body?.baseCode, 100),
        size: clean(req.body?.size, 50),
      };
      const wantedKey = identityKey(wanted);
      if (!wanted.product || !wanted.size || !wantedKey) {
        return res.status(400).json({ ok: false, error: "Produkt, Basis und Gebinde fehlen" });
      }

      let candidates = (Array.isArray(articles) ? articles : []).filter(article => article && identityKey(article) === wantedKey);
      const stockCode = clean(req.body?.stockCode, 100).toUpperCase();
      if (stockCode) {
        const exactSku = candidates.filter(article => clean(article?.stockCode, 100).toUpperCase() === stockCode);
        if (exactSku.length) candidates = exactSku;
      }
      if (candidates.length !== 1) {
        return res.status(409).json({
          ok: false,
          error: candidates.length ? "Lagerartikel ist nicht eindeutig" : "Lagerartikel nicht gefunden",
          matches: candidates.map(article => ({ id: article.id, stockCode: article.stockCode, product: article.product, base: article.baseName || article.baseCode, size: article.size })),
        });
      }

      const article = candidates[0];
      const mode = clean(req.body?.mode || "manual", 20).toLowerCase();
      const next = mode === "auto" ? null : nullableNonNegative(req.body?.quantity);
      if (mode !== "auto" && next === null) return res.status(400).json({ ok: false, error: "Bestellmenge ungültig" });
      article.orderQuantityOverride = next;
      article.updatedAt = new Date().toISOString();
      await writeJson(articlesFile, articles);

      const stockMap = await readLatestStockMap(root);
      res.json({ ok: true, item: rowFor(article, stockMap) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintStockLedgerApi };
