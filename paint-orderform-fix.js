"use strict";

// Offizielle Little-Greene-Bestellliste = Artikelwahrheit.
// Excel ist nur strukturierte Importquelle. Bestand, Soll/Mindest und Bestellentwurf leben in KRISTINE.
// Inventur: LG BASES + COLOURANTS. Sample Pots / Marketing sind Bestellzusatz, keine Inventur.

const fsp = require("fs/promises");
const path = require("path");
let XLSX = null;
try { XLSX = require("xlsx"); } catch {}

const BASES = {
  H: { code: "HI", name: "Hi White" },
  HI: { code: "HI", name: "Hi White" },
  "HI WHITE": { code: "HI", name: "Hi White" },
  M: { code: "M", name: "Medium" },
  MEDIUM: { code: "M", name: "Medium" },
  D: { code: "D", name: "Deep" },
  DEEP: { code: "D", name: "Deep" },
  XD: { code: "XD", name: "Extra Deep" },
  X: { code: "XD", name: "Extra Deep" },
  "EXTRA DEEP": { code: "XD", name: "Extra Deep" },
  T: { code: "T", name: "Transparent" },
  TRANSPARENT: { code: "T", name: "Transparent" },
  Y: { code: "Y", name: "Yellow" },
  YELLOW: { code: "Y", name: "Yellow" },
  W: { code: "W", name: "White ASP" },
  "WHITE ASP": { code: "W", name: "White ASP" },
  P: { code: "P", name: "Pastel" },
  PASTEL: { code: "P", name: "Pastel" },
  BC: { code: "BC", name: "Blue BC" },
  TC: { code: "TC", name: "Blue TC" },
};

function registerPaintOrderformFix(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const catalogFile = path.join(root, "lg-order-catalog.json");

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (String(token) !== String(adminToken)) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return false;
    }
    return true;
  }

  const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
  const num = (v, fallback = 0) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
    const raw = clean(v).replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const norm = v => clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const baseInfo = (code, fallbackName = "") => {
    const raw = clean(code || fallbackName, 80).toUpperCase();
    return BASES[raw] || {
      code: clean(code, 20).toUpperCase() || clean(fallbackName, 20).toUpperCase(),
      name: clean(fallbackName || code, 80),
    };
  };
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
  const sizeMl = value => {
    const m = sizeNorm(value).match(/^([0-9.]+)\s*L$/i);
    return m ? Number(m[1]) * 1000 : 0;
  };
  const safeId = value => clean(value, 220).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const nullableNonNegative = value => {
    if (value === null || value === undefined || value === "") return null;
    const n = num(value, NaN);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.max(0, Math.round(n * 1000) / 1000);
  };

  const canonicalArticle = a => {
    if (clean(a?.category).toLowerCase() === "colourant") return a;
    const info = baseInfo(a?.baseCode, a?.baseName);
    return { ...a, baseCode: info.code, baseName: info.name };
  };
  const articleKey = raw => {
    const a = canonicalArticle(raw || {});
    return `${norm(a.product)}|${norm(a.baseCode || a.baseName)}|${sizeNorm(a.size)}`;
  };

  async function ensureRoot() { await fsp.mkdir(root, { recursive: true }); }
  async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; } }
  async function writeJson(file, value) {
    await ensureRoot();
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  function rowsOf(workbook, name) {
    const sheet = workbook.Sheets[name];
    return sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }) : [];
  }

  function headerIndex(row, names) {
    const normalized = (row || []).map(x => norm(x));
    for (const name of names) {
      const idx = normalized.indexOf(norm(name));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function parseOfficialOrderForm(buffer) {
    if (!XLSX) throw new Error("xlsx-Modul fehlt");
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    if (!workbook.Sheets["LG BASES"] && !workbook.Sheets["COLOURANTS"]) return null;

    const articles = [];
    const counts = { bases: 0, colourants: 0, samplePots: 0, marketing: 0 };
    let orderIndex = 0;

    const baseRows = rowsOf(workbook, "LG BASES");
    if (baseRows.length) {
      const h = baseRows[0] || [];
      const cProduct = headerIndex(h, ["PRODUCT"]);
      const cSize = headerIndex(h, ["SIZE"]);
      const cBase = headerIndex(h, ["BASE"]);
      const cSku = headerIndex(h, ["SKU"]);
      const cPrice = headerIndex(h, ["Price"]);
      if ([cProduct, cSize, cBase, cSku].some(x => x < 0)) throw new Error("LG BASES: Spalten PRODUCT / SIZE / BASE / SKU nicht erkannt");
      let currentProduct = "", currentSize = "", productOrder = -1, sizeOrder = -1;
      for (let i = 1; i < baseRows.length; i += 1) {
        const row = baseRows[i] || [];
        if (clean(row[cProduct])) { currentProduct = clean(row[cProduct], 180); productOrder += 1; sizeOrder = -1; }
        if (clean(row[cSize])) { currentSize = sizeNorm(row[cSize]); sizeOrder += 1; }
        const rawBase = clean(row[cBase], 30);
        const sku = clean(row[cSku], 100);
        if (!currentProduct || !currentSize || !rawBase || !sku || /^TOTAL/i.test(sku)) continue;
        const info = baseInfo(rawBase);
        articles.push({
          id: `LG-${safeId(sku)}`, manufacturer: "Little Greene", category: "base", inventory: true, orderable: true, orderSection: "bases",
          product: currentProduct, baseCode: info.code, baseName: info.name, size: currentSize, sizeMl: sizeMl(currentSize),
          ean: "", stockCode: sku, stock: 0, targetStock: 0, minimumStock: 0, orderQuantityOverride: null,
          purchasePrice: cPrice >= 0 ? num(row[cPrice], 0) : 0, salePrice: 0, productOrder, sizeOrder, orderIndex: orderIndex++,
          active: true, source: "Official LG Order Form / LG BASES", updatedAt: new Date().toISOString(),
        });
        counts.bases += 1;
      }
    }

    const colourRows = rowsOf(workbook, "COLOURANTS");
    if (colourRows.length) {
      const h = colourRows[0] || [];
      const cCode = headerIndex(h, ["CODE", "COLOURANT", "COLORANT"]);
      const cSize = headerIndex(h, ["SIZE"]);
      const cName = headerIndex(h, ["COLOUR", "COLOR", "DESCRIPTION"]);
      const cSku = headerIndex(h, ["SKU"]);
      const cPrice = headerIndex(h, ["Price"]);
      for (let i = 1; i < colourRows.length; i += 1) {
        const row = colourRows[i] || [];
        const code = cCode >= 0 ? clean(row[cCode], 20).toUpperCase() : clean(row[0], 20).toUpperCase();
        const size = sizeNorm(cSize >= 0 ? row[cSize] : row[1]);
        const colour = cName >= 0 ? clean(row[cName], 100) : clean(row[2], 100);
        const sku = cSku >= 0 ? clean(row[cSku], 100) : clean(row[3], 100);
        if (!code || !size || !colour || !sku || /^TOTAL/i.test(sku)) continue;
        articles.push({
          id: `LG-${safeId(sku)}`, manufacturer: "Little Greene", category: "colourant", inventory: true, orderable: true, orderSection: "colourants",
          product: "Colourants", baseCode: code, baseName: colour, size, sizeMl: sizeMl(size), ean: "", stockCode: sku, stock: 0,
          targetStock: 0, minimumStock: 0, orderQuantityOverride: null, purchasePrice: cPrice >= 0 ? num(row[cPrice], 0) : num(row[5], 0),
          salePrice: 0, productOrder: 9990, sizeOrder: 0, orderIndex: orderIndex++, active: true,
          source: "Official LG Order Form / COLOURANTS", updatedAt: new Date().toISOString(),
        });
        counts.colourants += 1;
      }
    }

    const sampleRows = rowsOf(workbook, "LG SAMPLE POTS");
    for (let i = 1; i < sampleRows.length; i += 1) {
      const row = sampleRows[i] || [];
      const number = clean(row[0], 30), label = clean(row[1], 180), sku = clean(row[2], 100);
      if (!label || !sku) continue;
      articles.push({
        id: `LG-${safeId(sku)}`, manufacturer: "Little Greene", category: "sample-pot", inventory: false, orderable: true, orderSection: "sample-pots",
        product: "Sample Pots", baseCode: "", baseName: label, size: "Sample Pot", sizeMl: 0, orderNumber: number, ean: "", stockCode: sku,
        stock: 0, targetStock: 0, minimumStock: 0, orderQuantityOverride: null, purchasePrice: num(row[4], 0), salePrice: 0,
        productOrder: 9991, sizeOrder: 0, orderIndex: orderIndex++, active: true, source: "Official LG Order Form / LG SAMPLE POTS", updatedAt: new Date().toISOString(),
      });
      counts.samplePots += 1;
    }

    const marketingRows = rowsOf(workbook, "LG MARKETING");
    for (let i = 1; i < marketingRows.length; i += 1) {
      const row = marketingRows[i] || [];
      const label = clean(row[1], 180), sku = clean(row[2], 100);
      if (!label) continue;
      const stable = sku || `MARKETING-${safeId(label)}`;
      articles.push({
        id: `LG-${safeId(stable)}`, manufacturer: "Little Greene", category: "marketing", inventory: false, orderable: true, orderSection: "marketing",
        product: "Marketing", baseCode: "", baseName: label, size: "", sizeMl: 0, ean: "", stockCode: sku, stock: 0,
        targetStock: 0, minimumStock: 0, orderQuantityOverride: null, purchasePrice: num(row[4], 0), salePrice: 0,
        productOrder: 9992, sizeOrder: 0, orderIndex: orderIndex++, active: true, source: "Official LG Order Form / LG MARKETING", updatedAt: new Date().toISOString(),
      });
      counts.marketing += 1;
    }

    return { articles, counts, sourceSheets: workbook.SheetNames };
  }

  function mergeWithExisting(parsed, previous) {
    const normalizedPrevious = (Array.isArray(previous) ? previous : []).map(canonicalArticle);
    const bySku = new Map(normalizedPrevious.filter(a => clean(a.stockCode)).map(a => [clean(a.stockCode).toUpperCase(), a]));
    const byKey = new Map(normalizedPrevious.map(a => [articleKey(a), a]));
    return parsed.articles.map(a => {
      const old = bySku.get(clean(a.stockCode).toUpperCase()) || byKey.get(articleKey(a));
      if (!old) return a;
      const oldOverride = nullableNonNegative(old.orderQuantityOverride);
      return {
        ...a,
        ean: clean(old.ean) || a.ean,
        stock: Number.isFinite(Number(old.stock)) ? Math.max(0, Number(old.stock)) : a.stock,
        targetStock: Number.isFinite(Number(old.targetStock)) ? Math.max(0, Number(old.targetStock)) : Math.max(0, Number(old.minimumStock || 0)),
        minimumStock: Number.isFinite(Number(old.minimumStock)) ? Math.max(0, Number(old.minimumStock)) : Math.max(0, Number(old.targetStock || 0)),
        orderQuantityOverride: oldOverride,
        salePrice: Number(old.salePrice || a.salePrice || 0),
        createdAt: old.createdAt || a.createdAt,
      };
    });
  }

  function inferInventory(a) {
    if (a?.inventory === false) return false;
    const c = clean(a?.category).toLowerCase();
    if (c) return c === "base" || c === "colourant";
    return !!clean(a?.product) && !!clean(a?.size);
  }

  function suggestedOrder(a) {
    const stock = Math.max(0, Number(a.stock || 0));
    const minimum = Math.max(0, Number(a.minimumStock || 0));
    const target = Math.max(minimum, Number(a.targetStock ?? minimum) || 0);
    if (clean(a.category).toLowerCase() === "sample-pot" || clean(a.category).toLowerCase() === "marketing") return 0;
    return stock < minimum ? Math.max(0, Math.ceil(target - stock)) : 0;
  }

  function publicOrderFields(a) {
    const suggestion = suggestedOrder(a);
    const override = nullableNonNegative(a.orderQuantityOverride);
    return { suggestedOrder: suggestion, orderQuantityOverride: override, orderQuantity: override === null ? suggestion : override, orderManual: override !== null };
  }

  function publicInventoryRow(raw) {
    const a = canonicalArticle(raw || {});
    const category = clean(a.category).toLowerCase() || "base";
    const target = Math.max(0, Number(a.targetStock ?? a.minimumStock ?? 0));
    const minimum = Math.max(0, Number(a.minimumStock ?? 0));
    const stock = Math.max(0, Number(a.stock || 0));
    const baseLabel = `${clean(a.baseCode)} · ${clean(a.baseName || a.baseCode)}`;
    return {
      id: a.id || "", category, product: a.product || "", baseName: a.baseName || a.baseCode || "", baseCode: a.baseCode || "", baseLabel,
      size: sizeNorm(a.size), ean: a.ean || "", stockCode: a.stockCode || "", purchasePrice: Number(a.purchasePrice || 0),
      targetStock: target, minimumStock: minimum, stock,
      productOrder: Number.isFinite(Number(a.productOrder)) ? Number(a.productOrder) : 9999,
      sizeOrder: Number.isFinite(Number(a.sizeOrder)) ? Number(a.sizeOrder) : 9999,
      orderIndex: Number.isFinite(Number(a.orderIndex)) ? Number(a.orderIndex) : 999999,
      ...publicOrderFields(a),
    };
  }

  function malformedOfficialStructure(rows) {
    const inventory = (Array.isArray(rows) ? rows : []).filter(inferInventory);
    if (!inventory.length) return false;
    const bad = inventory.filter(a => {
      const product = clean(a.product).replace(/\s+/g, "");
      const size = clean(a.size).toUpperCase();
      return /^\d+(?:[.,]\d+)?L$/i.test(product) || /^(H|HI|M|D|XD|X|T|Y|P|W|BC|TC)$/.test(size);
    }).length;
    return bad >= Math.max(2, Math.ceil(inventory.length * 0.05));
  }

  app.post("/admin/api/paint/import-excel", async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    try {
      const base64 = clean(req.body?.base64, 100_000_000).replace(/^data:.*?;base64,/, "");
      if (!base64) return next();
      const parsed = parseOfficialOrderForm(Buffer.from(base64, "base64"));
      if (!parsed) return next();
      const previous = await readJson(articlesFile, []);
      const merged = mergeWithExisting(parsed, previous);
      await Promise.all([
        writeJson(articlesFile, merged),
        writeJson(catalogFile, {
          importedAt: new Date().toISOString(), structureVersion: 2, counts: parsed.counts,
          articles: merged.map(a => ({ id: a.id, category: a.category, product: a.product, baseCode: a.baseCode, baseName: a.baseName, size: a.size, stockCode: a.stockCode, purchasePrice: a.purchasePrice, orderNumber: a.orderNumber || "", productOrder: a.productOrder, sizeOrder: a.sizeOrder, orderIndex: a.orderIndex })),
        }),
      ]);
      return res.json({ ok: true, officialOrderForm: true, structureVersion: 2, articles: merged.length, fbAliases: "unchanged", counts: parsed.counts });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get("/admin/api/paint/inventory", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await readJson(articlesFile, []);
    if (malformedOfficialStructure(rows)) {
      return res.json({ ok: true, items: [], count: 0, scope: "LG BASES + COLOURANTS", needsOfficialImport: true, error: "Der aktuelle Lagerstamm stammt noch aus der alten verschobenen Struktur. Bitte die offizielle LG-Bestellliste einmal neu importieren." });
    }
    const items = rows.filter(a => a && a.active !== false && inferInventory(a)).map(publicInventoryRow).sort((a, b) => a.orderIndex - b.orderIndex);
    res.json({ ok: true, items, count: items.length, scope: "LG BASES + COLOURANTS" });
  });

  app.post("/admin/api/paint/inventory/levels", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const changes = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!changes.length) return res.json({ ok: true, changed: 0 });
      const articles = await readJson(articlesFile, []);
      const byId = new Map(articles.map(a => [String(a.id || ""), a]));
      let changed = 0;
      for (const row of changes) {
        const a = byId.get(String(row.articleId || ""));
        if (!a) continue;
        let touched = false;
        if (row.targetStock !== undefined) {
          const target = num(row.targetStock, NaN);
          if (Number.isFinite(target) && target >= 0) { const next = Math.max(0, Math.round(target * 1000) / 1000); if (Number(a.targetStock) !== next) { a.targetStock = next; touched = true; } }
        }
        if (row.minimumStock !== undefined) {
          const minimum = num(row.minimumStock, NaN);
          if (Number.isFinite(minimum) && minimum >= 0) { const next = Math.max(0, Math.round(minimum * 1000) / 1000); if (Number(a.minimumStock) !== next) { a.minimumStock = next; touched = true; } }
        }
        if (touched) { a.updatedAt = new Date().toISOString(); changed += 1; }
      }
      if (changed) await writeJson(articlesFile, articles);
      res.json({ ok: true, changed });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post("/admin/api/paint/inventory/order", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const changes = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!changes.length) return res.json({ ok: true, changed: 0 });
      const articles = await readJson(articlesFile, []);
      const byId = new Map(articles.map(a => [String(a.id || ""), a]));
      let changed = 0;
      for (const row of changes) {
        const a = byId.get(String(row.articleId || ""));
        if (!a) continue;
        const raw = row.orderQuantityOverride;
        let next = null;
        if (!(raw === null || raw === undefined || raw === "")) {
          const parsed = num(raw, NaN);
          if (!Number.isFinite(parsed) || parsed < 0) continue;
          next = Math.max(0, Math.round(parsed * 1000) / 1000);
        }
        const before = nullableNonNegative(a.orderQuantityOverride);
        if (before !== next) { a.orderQuantityOverride = next; a.updatedAt = new Date().toISOString(); changed += 1; }
      }
      if (changed) await writeJson(articlesFile, articles);
      res.json({ ok: true, changed });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.get("/admin/api/paint/order-catalog", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await readJson(articlesFile, []);
    const section = clean(req.query.section, 30).toLowerCase();
    const items = rows.filter(a => a && a.active !== false && a.orderable !== false && (!section || clean(a.orderSection, 30).toLowerCase() === section)).map(a => ({ ...a, ...publicOrderFields(a) })).sort((a, b) => Number(a.orderIndex || 999999) - Number(b.orderIndex || 999999));
    res.json({ ok: true, items });
  });
}

module.exports = { registerPaintOrderformFix };
