"use strict";

// Laufzeit-Hotfix fuer KRISTINE Farben & Lager.
// 1) Lagerartikel werden unabhaengig davon gematcht, ob die Basis als H/M/D/XD
//    oder als Hi White/Medium/Deep/Extra Deep gespeichert ist.
// 2) Beim Excel-Erstimport werden die alten, datierten LG-Bestellblaetter als
//    Startwert fuer die Geschaeftsjahres-Auswertung uebernommen (01.11-31.10).

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

  const clean = (v) => String(v ?? "").trim();
  const norm = (v) => clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const canonicalBase = (v) => {
    const raw = clean(v);
    return BASES[raw.toUpperCase()] || raw;
  };
  const sizeNorm = (value) => {
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
  const keyOf = (product, base, size) => `${norm(product)}|${norm(canonicalBase(base))}|${sizeNorm(size)}`;

  function readArticles() {
    try {
      const rows = JSON.parse(fs.readFileSync(articlesFile, "utf8"));
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  function enrichStocks(payload) {
    if (!payload || payload.ok !== true || !Array.isArray(payload.products)) return payload;
    const articles = readArticles();
    if (!articles.length) return payload;
    const byKey = new Map();
    for (const a of articles) {
      const base = a.baseName || canonicalBase(a.baseCode);
      byKey.set(keyOf(a.product, base, a.size), a);
    }
    for (const p of payload.products) {
      for (const s of Array.isArray(p.sizes) ? p.sizes : []) {
        const a = byKey.get(keyOf(p.productName, p.baseName || p.baseCode, s.size));
        if (!a) continue;
        s.stock = Number(a.stock || 0);
        s.minimumStock = Number(a.minimumStock || 0);
        s.purchasePrice = Number(a.purchasePrice || 0);
        s.salePrice = Number(a.salePrice || 0);
        s.ean = a.ean || "";
        s.stockCode = a.stockCode || "";
        s.articleId = a.id || "";
      }
    }
    payload.stockArticles = articles.length;
    return payload;
  }

  function parseSheetDate(name) {
    const s = clean(name);
    let m = s.match(/(\d{1,2})[.\-_ ](\d{1,2})[.\-_ ](\d{2,4})/);
    if (!m) m = s.match(/(?:^|\D)(\d{2})(\d{2})(\d{4})(?:\D|$)/);
    if (!m) {
      const m6 = s.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})(?:\D|$)/);
      if (m6) m = [m6[0], m6[1], m6[2], String(2000 + Number(m6[3]))];
    }
    if (!m) return "";
    const d = Number(m[1]), mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
    return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  function sheetTotal(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    const candidates = [];
    for (let r = 0; r < Math.min(10, rows.length); r += 1) {
      for (const v of rows[r] || []) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        if (v >= 100 && v <= 100000) candidates.push(v);
      }
    }
    return candidates.length ? Math.max(...candidates) : 0;
  }

  function seedTurnoverFromExcel(base64) {
    if (!XLSX || !base64) return { rows: 0, total: 0 };
    const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer", cellDates: true });
    const byDate = new Map();
    for (const name of workbook.SheetNames || []) {
      const invoiceDate = parseSheetDate(name);
      if (!invoiceDate) continue;
      const total = Number(sheetTotal(workbook.Sheets[name]) || 0);
      if (total <= 0) continue;
      const old = byDate.get(invoiceDate);
      // Doppelte/alte Versionen desselben Bestelltages (z.B. BEst 17042026)
      // nicht doppelt zaehlen. Die hoehere/finale Summe gewinnt.
      if (!old || total > old.netAmount) byDate.set(invoiceDate, {
        invoiceRef: `Excel-Historie ${invoiceDate}`,
        invoiceDate,
        netAmount: Number(total.toFixed(2)),
        source: "excel-history",
        estimated: true,
        createdAt: new Date().toISOString()
      });
    }
    fs.mkdirSync(root, { recursive: true });
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(purchasesFile, "utf8")); } catch {}
    if (!Array.isArray(existing)) existing = [];
    const actual = existing.filter(x => String(x?.source || "") !== "excel-history");
    const seeds = [...byDate.values()].sort((a,b) => a.invoiceDate.localeCompare(b.invoiceDate));
    fs.writeFileSync(purchasesFile, JSON.stringify([...actual, ...seeds], null, 2), "utf8");
    return { rows: seeds.length, total: Number(seeds.reduce((s,x)=>s+x.netAmount,0).toFixed(2)) };
  }

  app.use((req, res, next) => {
    const isColor = req.method === "GET" && /^\/admin\/api\/paint\/color\//.test(req.path || req.url || "");
    const isExcelImport = req.method === "POST" && (req.path || req.url || "").startsWith("/admin/api/paint/import-excel");
    if (!isColor && !isExcelImport) return next();

    const originalJson = res.json.bind(res);
    res.json = function fixedJson(body) {
      try {
        if (isColor) body = enrichStocks(body);
        if (isExcelImport && body && body.ok === true) {
          const base64 = clean(req.body?.base64).replace(/^data:.*?;base64,/, "");
          const hist = seedTurnoverFromExcel(base64);
          body.lgHistoryRows = hist.rows;
          body.lgHistoryTotal = hist.total;
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
