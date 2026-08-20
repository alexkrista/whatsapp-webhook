"use strict";

// Laufzeit-Hilfe fuer KRISTINE Farben & Lager.
// Lager und Umsatz sind strikt getrennt:
// - Excel liefert nur Artikelstamm / Sollwerte / EAN / Startdaten.
// - Umsatz kommt ausschliesslich aus der Eingangsrechnungserfassung.

const fs = require("fs");
const path = require("path");
let XLSX = null;
try { XLSX = require("xlsx"); } catch {}

const BASES = {
  H: "Hi White", HI: "Hi White", "HI WHITE": "Hi White",
  M: "Medium", MEDIUM: "Medium",
  D: "Deep", DEEP: "Deep",
  XD: "Extra Deep", X: "Extra Deep", "EXTRA DEEP": "Extra Deep",
  T: "Transparent", TRANSPARENT: "Transparent",
  Y: "Yellow", YELLOW: "Yellow",
  W: "White ASP", "WHITE ASP": "White ASP",
  P: "Pastel", PASTEL: "Pastel",
  BC: "Blue BC", "BLUE BC": "Blue BC",
  TC: "Blue TC", "BLUE TC": "Blue TC"
};

function registerPaintLiveFix(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const purchasesFile = path.join(root, "lg-purchases.json");

  const clean = v => String(v ?? "").trim();
  const norm = v => clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const canonicalBase = v => BASES[clean(v).toUpperCase()] || clean(v);
  const canonicalProduct = v => norm(v).replace(/^lg\s+/, "");
  const sizeNorm = value => {
    const raw = clean(value).toLowerCase().replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "");
    if (!raw) return "";
    if (/^250ml$|^0[.,]?25l$/.test(raw)) return "0.25 L";
    if (/^500ml$|^0[.,]?5l$/.test(raw)) return "0.5 L";
    if (/^750ml$|^0[.,]?75l$/.test(raw)) return "0.75 L";
    if (/^1l$/.test(raw)) return "1 L";
    if (/^2l$/.test(raw)) return "2 L";
    if (/^2[.,]?5l$/.test(raw)) return "2.5 L";
    if (/^4l$/.test(raw)) return "4 L";
    if (/^5l$/.test(raw)) return "5 L";
    if (/^10l$/.test(raw)) return "10 L";
    return clean(value);
  };
  const keyOf = (product, base, size) => `${canonicalProduct(product)}|${norm(canonicalBase(base))}|${sizeNorm(size)}`;

  function readArticles() {
    try {
      const rows = JSON.parse(fs.readFileSync(articlesFile, "utf8"));
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  function writeArticles(rows) {
    fs.mkdirSync(root, { recursive: true });
    const tmp = `${articlesFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8");
    fs.renameSync(tmp, articlesFile);
  }

  function enrichStocks(payload) {
    if (!payload || payload.ok !== true || !Array.isArray(payload.products)) return payload;
    const articles = readArticles();
    const byKey = new Map();
    for (const a of articles) byKey.set(keyOf(a.product, a.baseName || a.baseCode, a.size), a);
    let matched = 0;
    for (const p of payload.products) {
      for (const s of Array.isArray(p.sizes) ? p.sizes : []) {
        const a = byKey.get(keyOf(p.productName, p.baseName || p.baseCode, s.size));
        if (!a) continue;
        matched += 1;
        s.stock = Number(a.stock || 0);
        s.targetStock = Number(a.targetStock ?? a.minimumStock ?? 0);
        s.minimumStock = Number(a.minimumStock ?? a.targetStock ?? 0);
        s.purchasePrice = Number(a.purchasePrice || 0);
        s.salePrice = Number(a.salePrice || 0);
        s.ean = a.ean || "";
        s.stockCode = a.stockCode || "";
        s.articleId = a.id || "";
      }
    }
    payload.stockArticles = articles.length;
    payload.stockMatched = matched;
    return payload;
  }

  function applyExcelTargets(base64) {
    if (!XLSX || !base64 || !fs.existsSync(articlesFile)) return;
    const wb = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer", cellDates: true });
    const sheet = wb.Sheets["Lagerliste Farben"];
    if (!sheet) return;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    const targets = new Map();
    for (let r = 9; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const product = clean(row[1]);
      const size = sizeNorm(row[2]);
      const base = canonicalBase(row[3]);
      const target = Number(row[12]); // Spalte M = Soll
      if (!product || !size || !base || !Number.isFinite(target)) continue;
      targets.set(keyOf(product, base, size), target);
    }
    const articles = readArticles();
    let changed = 0;
    for (const a of articles) {
      const target = targets.get(keyOf(a.product, a.baseName || a.baseCode, a.size));
      if (!Number.isFinite(target)) continue;
      if (Number(a.targetStock) !== target) { a.targetStock = target; changed += 1; }
      if (!Number.isFinite(Number(a.minimumStock))) a.minimumStock = target;
    }
    if (changed) writeArticles(articles);
  }

  function removeWrongExcelTurnoverSeeds() {
    try {
      if (!fs.existsSync(purchasesFile)) return;
      const rows = JSON.parse(fs.readFileSync(purchasesFile, "utf8"));
      if (!Array.isArray(rows)) return;
      const cleanRows = rows.filter(x => String(x?.source || "") !== "excel-history");
      if (cleanRows.length !== rows.length) {
        fs.writeFileSync(purchasesFile, JSON.stringify(cleanRows, null, 2), "utf8");
        console.log(`KRISTINE LG: ${rows.length - cleanRows.length} falsche Excel-Umsatzzeilen entfernt`);
      }
    } catch (error) {
      console.error("KRISTINE LG Umsatzbereinigung:", error?.message || error);
    }
  }
  removeWrongExcelTurnoverSeeds();

  app.use((req, res, next) => {
    const url = req.path || req.url || "";
    const isColor = req.method === "GET" && /^\/admin\/api\/paint\/color\//.test(url);
    const isExcelImport = req.method === "POST" && url.startsWith("/admin/api/paint/import-excel");
    if (!isColor && !isExcelImport) return next();
    const originalJson = res.json.bind(res);
    res.json = function fixedJson(body) {
      try {
        if (isColor) body = enrichStocks(body);
        if (isExcelImport && body && body.ok === true) {
          const base64 = clean(req.body?.base64).replace(/^data:.*?;base64,/, "");
          applyExcelTargets(base64);
        }
      } catch (error) {
        console.error("KRISTINE Farben/Lager Laufzeit-Fix:", error?.message || error);
      }
      return originalJson(body);
    };
    next();
  });
}

module.exports = { registerPaintLiveFix };
