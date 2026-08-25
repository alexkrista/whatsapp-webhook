"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { baseKey, sizeKey, readLatestStockMap, stockForArticle } = require("./paint-stock-ledger");

function registerPaintColorStockOverlay(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");

  const clean = value => String(value ?? "").trim();
  const norm = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();

  function productKey(value) {
    let key = norm(value);
    // Innovatint verwendet bei diesen beiden Produkten den Zusatz "Emulsion",
    // das Little-Greene-Lager/Bestellformular nicht.
    key = key.replace(/emulsion$/, "");
    return key;
  }

  async function readArticles() {
    try {
      const rows = JSON.parse(await fsp.readFile(articlesFile, "utf8"));
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  app.use(async (req, res, next) => {
    const requestPath = String(req.path || req.originalUrl || "").split("?")[0];
    if (!/^\/admin\/api\/paint\/color\/[^/]+$/.test(requestPath)) return next();

    let articles = [];
    let latestStock = new Map();
    try {
      [articles, latestStock] = await Promise.all([readArticles(), readLatestStockMap(root)]);
    } catch {}

    const originalJson = res.json.bind(res);
    res.json = function paintColorStockJson(body) {
      try {
        if (body?.ok === true && Array.isArray(body.products)) {
          for (const product of body.products) {
            const pKey = productKey(product?.productName);
            const bKey = baseKey(product?.baseCode || product?.baseName);
            const matching = articles.filter(article =>
              article && article.active !== false &&
              productKey(article.product) === pKey &&
              baseKey(article.baseCode || article.baseName) === bKey
            );

            for (const size of product.sizes || []) {
              const article = matching.find(row => sizeKey(row.size) === sizeKey(size.size));
              if (!article) {
                // Kein Lagerartikel = kein erfundener Bestand.
                size.stock = null;
                size.stockSource = "unmapped";
                continue;
              }

              const resolved = stockForArticle(article, latestStock);
              size.stock = resolved.stock;
              size.stockSource = resolved.source;
              size.minimumStock = Number(article.minimumStock || 0);
              size.targetStock = Number(article.targetStock ?? article.minimumStock ?? 0);
              size.purchasePrice = Number(article.purchasePrice || 0);
              size.salePrice = Number(article.salePrice || 0);
              size.ean = article.ean || "";
              size.stockCode = article.stockCode || "";
              size.articleId = article.id || "";
            }
          }
          body.stockSource = "inventory-ledger";
        }
      } catch (error) {
        console.warn("KRISTINE Farbsuche Lageroverlay:", error?.message || error);
      }
      return originalJson(body);
    };

    next();
  });
}

module.exports = { registerPaintColorStockOverlay };
