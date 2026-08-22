"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const XLSX = require("xlsx");

function registerPaintLgSentOrder(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const ordersFile = path.join(root, "lg-sent-orders.json");

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
  const skuNorm = value => clean(value, 120).toUpperCase().replace(/\s+/g, "");
  const nullableNonNegative = value => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.max(0, Math.round(n * 1000) / 1000) : null;
  };
  const numberValue = (value, fallback = 0) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
    const raw = clean(value, 80).replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const isLittleGreene = article => String(article?.manufacturer || "Little Greene").toLowerCase().includes("little greene");

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  function suggestion(article) {
    const category = clean(article?.category, 40).toLowerCase();
    if (category === "sample-pot" || category === "marketing") return 0;
    const stock = Math.max(0, Number(article?.stock || 0));
    const minimum = Math.max(0, Number(article?.minimumStock || 0));
    const target = Math.max(minimum, Number(article?.targetStock ?? minimum) || 0);
    return stock <= minimum ? Math.max(0, Math.ceil(target - stock)) : 0;
  }
  function effectiveQuantity(article) {
    const manual = nullableNonNegative(article?.orderQuantityOverride);
    return manual === null ? suggestion(article) : manual;
  }

  function articleMaps(articles) {
    const bySku = new Map();
    const byId = new Map();
    for (const article of Array.isArray(articles) ? articles : []) {
      if (!article || article.active === false || article.orderable === false || !isLittleGreene(article)) continue;
      const sku = skuNorm(article.stockCode);
      if (sku) bySku.set(sku, article);
      if (article.id) byId.set(String(article.id), article);
    }
    return { bySku, byId };
  }

  function positionFromArticle(article, quantity, unitPrice = Number(article?.purchasePrice || 0)) {
    const qty = Math.max(0, numberValue(quantity, 0));
    const price = Math.max(0, numberValue(unitPrice, 0));
    return {
      articleId: clean(article?.id, 220),
      sku: clean(article?.stockCode, 120),
      ean: clean(article?.ean, 100),
      product: clean(article?.product, 180),
      size: clean(article?.size, 50),
      baseCode: clean(article?.baseCode, 40),
      baseName: clean(article?.baseName || article?.baseCode, 100),
      quantity: qty,
      unitPrice: Number(price.toFixed(2)),
      lineTotal: Number((qty * price).toFixed(2)),
    };
  }

  function currentPositions(articles) {
    return (Array.isArray(articles) ? articles : [])
      .filter(article => article && article.active !== false && article.orderable !== false && isLittleGreene(article))
      .map(article => positionFromArticle(article, effectiveQuantity(article)))
      .filter(row => row.quantity > 0)
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }

  function parseWorkbook(buffer) {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, cellFormula: true });
    const layouts = [
      { sheet: "LG BASES", sku: 3, qty: 4, price: 5 },
      { sheet: "COLOURANTS", sku: 3, qty: 4, price: 5 },
      { sheet: "LG SAMPLE POTS", sku: 2, qty: 3, price: 4 },
      { sheet: "LG MARKETING", sku: 2, qty: 3, price: 4 },
    ];
    const foundSheets = layouts.filter(layout => workbook.Sheets[layout.sheet]);
    if (!foundSheets.length) throw new Error("Keine Little-Greene-Bestellblätter gefunden");

    const positions = new Map();
    for (const layout of foundSheets) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[layout.sheet], { header: 1, raw: true, defval: "" });
      for (let i = 1; i < rows.length; i += 1) {
        const row = rows[i] || [];
        const sku = skuNorm(row[layout.sku]);
        const quantity = Math.max(0, numberValue(row[layout.qty], 0));
        if (!sku || quantity <= 0) continue;
        const unitPrice = Math.max(0, numberValue(row[layout.price], 0));
        const old = positions.get(sku);
        if (old && Math.abs(old.unitPrice - unitPrice) > 0.005) {
          throw new Error(`SKU ${sku} hat unterschiedliche Preise im Excel`);
        }
        positions.set(sku, {
          sku,
          quantity: Number(((old?.quantity || 0) + quantity).toFixed(3)),
          unitPrice: Number(unitPrice.toFixed(2)),
        });
      }
    }
    if (!positions.size) throw new Error("Im Excel wurden keine Bestellmengen gefunden");
    return Array.from(positions.values()).sort((a, b) => a.sku.localeCompare(b.sku));
  }

  function comparePositions(reference, imported) {
    const ref = new Map(reference.map(row => [skuNorm(row.sku), row]));
    const imp = new Map(imported.map(row => [skuNorm(row.sku), row]));
    const all = new Set([...ref.keys(), ...imp.keys()]);
    const quantityChanges = [];
    const priceChanges = [];
    for (const sku of all) {
      const a = ref.get(sku);
      const b = imp.get(sku);
      const before = Number(a?.quantity || 0);
      const after = Number(b?.quantity || 0);
      if (Math.abs(before - after) > 0.0005) quantityChanges.push({ sku, before, after, delta: Number((after - before).toFixed(3)) });
      if (a && b && Math.abs(Number(a.unitPrice || 0) - Number(b.unitPrice || 0)) > 0.005) {
        priceChanges.push({ sku, before: Number(a.unitPrice || 0), after: Number(b.unitPrice || 0) });
      }
    }
    return { quantityChanges, priceChanges };
  }

  function fingerprint(positions) {
    const canonical = positions
      .map(row => [skuNorm(row.sku), Number(row.quantity || 0), Number(row.unitPrice || 0).toFixed(2)])
      .sort((a, b) => a[0].localeCompare(b[0]));
    return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  function summarizePositions(positions) {
    const rows = positions.filter(row => Number(row.quantity || 0) > 0);
    return {
      positions: rows.length,
      pieces: Number(rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0).toFixed(3)),
      total: Number(rows.reduce((sum, row) => sum + Number(row.lineTotal || 0), 0).toFixed(2)),
    };
  }

  function nextOrderId(history, now = new Date()) {
    const day = now.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `LG-${day}-`;
    const count = history.filter(order => String(order?.id || "").startsWith(prefix)).length + 1;
    return `${prefix}${String(count).padStart(3, "0")}`;
  }

  async function saveSnapshot({ positions, source, fileName = "", comparison = null }) {
    const historyRaw = await readJson(ordersFile, []);
    const history = Array.isArray(historyRaw) ? historyRaw : [];
    const fp = fingerprint(positions);
    const duplicate = [...history].reverse().find(order => order?.fingerprint === fp && order?.status !== "cancelled");
    if (duplicate) return { order: duplicate, duplicate: true };

    const now = new Date();
    const sums = summarizePositions(positions);
    const order = {
      id: nextOrderId(history, now),
      supplier: "Little Greene",
      sentAt: now.toISOString(),
      source,
      fileName: clean(fileName, 180),
      status: "sent",
      fingerprint: fp,
      positionCount: sums.positions,
      pieces: sums.pieces,
      total: sums.total,
      comparison: comparison || { quantityChanges: [], priceChanges: [] },
      positions,
    };
    history.push(order);
    await writeJson(ordersFile, history.slice(-250));
    return { order, duplicate: false };
  }

  function publicOrder(order) {
    if (!order) return null;
    return {
      id: order.id,
      sentAt: order.sentAt,
      source: order.source,
      fileName: order.fileName || "",
      status: order.status || "sent",
      positionCount: Number(order.positionCount || 0),
      pieces: Number(order.pieces || 0),
      total: Number(order.total || 0),
      quantityChanges: Array.isArray(order.comparison?.quantityChanges) ? order.comparison.quantityChanges : [],
      priceChanges: Array.isArray(order.comparison?.priceChanges) ? order.comparison.priceChanges : [],
    };
  }

  app.get("/admin/api/paint/sent-orders/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const historyRaw = await readJson(ordersFile, []);
      const history = Array.isArray(historyRaw) ? historyRaw : [];
      const latest = history.length ? history[history.length - 1] : null;
      res.json({ ok: true, latest: publicOrder(latest), count: history.length });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/paint/sent-orders/open", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const historyRaw = await readJson(ordersFile, []);
      const history = Array.isArray(historyRaw) ? historyRaw : [];
      const open = history.filter(order => !["invoiced", "cancelled", "superseded"].includes(String(order?.status || "sent")));
      res.json({ ok: true, orders: open, count: open.length });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/sent-orders/unchanged", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const articles = await readJson(articlesFile, []);
      const positions = currentPositions(articles);
      if (!positions.length) return res.status(400).json({ ok: false, error: "Keine aktuelle LG-Bestellmenge vorhanden" });
      const result = await saveSnapshot({ positions, source: "unchanged_generated" });
      res.json({ ok: true, duplicate: result.duplicate, order: publicOrder(result.order) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/sent-orders/import", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const base64 = clean(req.body?.base64, 5_000_000).replace(/^data:.*?;base64,/, "");
      const fileName = clean(req.body?.fileName || "LittleGreene_Bestellung.xlsx", 180);
      if (!base64) return res.status(400).json({ ok: false, error: "Excel-Datei fehlt" });
      if (!/\.xlsx?$/i.test(fileName)) return res.status(400).json({ ok: false, error: "Bitte die gesendete Little-Greene-Excel verwenden" });

      const parsed = parseWorkbook(Buffer.from(base64, "base64"));
      const articles = await readJson(articlesFile, []);
      const { bySku } = articleMaps(articles);
      const unknown = parsed.filter(row => !bySku.has(row.sku));
      if (unknown.length) {
        return res.status(409).json({ ok: false, error: "Gesendete Bestellung enthält unbekannte SKU", unknown: unknown.map(row => row.sku) });
      }
      const withoutPrice = parsed.filter(row => Number(row.unitPrice || 0) <= 0);
      if (withoutPrice.length) {
        return res.status(409).json({ ok: false, error: "Gesendete Bestellung enthält Positionen ohne EK-Preis", skus: withoutPrice.map(row => row.sku) });
      }

      const importedPositions = parsed.map(row => positionFromArticle(bySku.get(row.sku), row.quantity, row.unitPrice));
      const current = currentPositions(articles);
      const comparison = comparePositions(current, importedPositions);
      const result = await saveSnapshot({ positions: importedPositions, source: "reimported_xlsx", fileName, comparison });
      res.json({ ok: true, duplicate: result.duplicate, order: publicOrder(result.order) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintLgSentOrder };
