"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
let XLSX = null;
try { XLSX = require("xlsx"); } catch {}

const BASE_NAMES = {
  H: "Hi White",
  HI: "Hi White",
  M: "Medium",
  D: "Deep",
  XD: "Extra Deep",
  X: "Extra Deep",
  T: "Transparent",
  Y: "Yellow",
  W: "White ASP",
  P: "Pastel",
  BC: "Blue BC",
  TC: "Blue TC",
};

const DEFAULT_SETTINGS = {
  recipeUnitMl: 0.16435185185,
  recipeCalibrationNote: "Kalibriert mit Stock 37 / Absolute Matt / Hi White / 10 L = AK 40, OC 120, RG 40",
  stockGreenFrom: 2,
  stockOrangeAt: 1,
};

function registerPaintLab(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const publicDir = options.publicDir || path.join(process.cwd(), "public");
  const adminToken = process.env.ADMIN_TOKEN || "";
  const ROOT = path.join(dataDir, "_kristine", "paint");
  const ARTICLES = path.join(ROOT, "articles.json");
  const MOVEMENTS = path.join(ROOT, "movements.jsonl");
  const PRICE_HISTORY = path.join(ROOT, "price-history.jsonl");
  const FB_ALIASES = path.join(ROOT, "farrow-ball-aliases.json");
  const CATALOG = path.join(ROOT, "innovatint-catalog.json");
  const SETTINGS = path.join(ROOT, "settings.json");

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (String(token) !== String(adminToken)) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return false;
    }
    return true;
  }

  async function ensureRoot() { await fsp.mkdir(ROOT, { recursive: true }); }
  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await ensureRoot();
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }
  async function appendJsonl(file, value) {
    await ensureRoot();
    await fsp.appendFile(file, JSON.stringify(value) + "\n", "utf8");
  }
  const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
  const num = (value, fallback = 0) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
    const raw = clean(value).replace(/\s/g, "").replace(",", ".");
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const norm = (value) => clean(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const eanNorm = (value) => clean(value, 60).replace(/\D/g, "");
  const baseName = (code) => BASE_NAMES[clean(code).toUpperCase()] || clean(code);
  const sizeNorm = (value) => {
    const raw = clean(value, 50).toLowerCase().replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "");
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
  const sizeMl = (value) => {
    const s = sizeNorm(value);
    const m = s.match(/^([0-9.]+)\s*L$/i);
    if (m) return Number(m[1]) * 1000;
    const mm = s.match(/^([0-9.]+)\s*ml$/i);
    if (mm) return Number(mm[1]);
    return 0;
  };
  const articleKey = (a) => [norm(a.product), norm(a.baseCode || a.baseName), sizeNorm(a.size)].join("|");

  function parseLgWorkbook(buffer) {
    if (!XLSX) throw new Error("xlsx-Modul fehlt");
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    const stockSheet = workbook.Sheets["Lagerliste Farben"];
    if (!stockSheet) throw new Error("Blatt 'Lagerliste Farben' fehlt");
    const rows = XLSX.utils.sheet_to_json(stockSheet, { header: 1, raw: true, defval: "" });
    const articles = [];
    for (let r = 9; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const product = clean(row[1], 180);
      const size = sizeNorm(row[2]);
      const baseCode = clean(row[3], 20).toUpperCase();
      if (!product || !size || !baseCode) continue;
      const ean = eanNorm(row[8]);
      const stockCode = clean(row[9], 100);
      const stock = num(row[11], num(row[4], 0));
      const minimumStock = num(row[12], 0);
      const price = num(row[5], 0);
      const article = {
        id: `LG-${stockCode || ean || `${product}-${baseCode}-${size}`}`.replace(/[^A-Za-z0-9_-]+/g, "_"),
        manufacturer: "Little Greene",
        product,
        baseCode,
        baseName: baseName(baseCode),
        size,
        sizeMl: sizeMl(size),
        ean,
        stockCode,
        stock,
        minimumStock,
        purchasePrice: price,
        salePrice: 0,
        active: true,
        source: "Bestellformular LittleGreene.xlsx / Lagerliste Farben",
        updatedAt: new Date().toISOString(),
      };
      article.searchText = norm([product, article.baseName, baseCode, size, ean, stockCode].join(" "));
      articles.push(article);
    }

    const aliases = [];
    const fbSheet = workbook.Sheets["F&B"];
    if (fbSheet) {
      const fbRows = XLSX.utils.sheet_to_json(fbSheet, { header: 1, raw: true, defval: "" });
      const seen = new Set();
      function addAlias(alias, name, no) {
        alias = clean(alias, 120); name = clean(name, 160); no = clean(no, 50);
        if (!alias || !name) return;
        const key = `${norm(alias)}|${norm(name)}|${norm(no)}`;
        if (seen.has(key)) return;
        seen.add(key);
        aliases.push({ alias, name, number: no, searchText: norm(`${alias} ${name} ${no}`) });
      }
      for (let i = 1; i < fbRows.length; i += 1) {
        const row = fbRows[i] || [];
        addAlias(row[0], row[1], row[2]);
        addAlias(row[4], row[5], row[6]);
      }
    }
    return { articles, aliases };
  }

  function normalizeCatalog(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      meta: { exportedAt: raw.exportedAt || new Date().toISOString(), source: clean(raw.source || "Innovatint", 120) },
      colors: Array.isArray(raw.colors) ? raw.colors : [],
      products: Array.isArray(raw.products) ? raw.products : [],
      formulas: Array.isArray(raw.formulas) ? raw.formulas : [],
      colorInProduct: Array.isArray(raw.colorInProduct) ? raw.colorInProduct : [],
      basePaints: Array.isArray(raw.basePaints) ? raw.basePaints : [],
      canSizes: Array.isArray(raw.canSizes) ? raw.canSizes : [],
      cans: Array.isArray(raw.cans) ? raw.cans : [],
      colorants: Array.isArray(raw.colorants) ? raw.colorants : [],
    };
  }

  function systemOfCode(code) {
    const c = clean(code).toUpperCase();
    if (/^RAL\b/.test(c)) return "RAL";
    if (/^NCS\b/.test(c)) return "NCS";
    return "LG";
  }

  function scoreHit(text, query) {
    const t = norm(text); const q = norm(query);
    if (!q) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 80;
    if (t.includes(q)) return 60;
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.every(x => t.includes(x))) return 40;
    return 0;
  }

  function buildCatalogIndex(catalog) {
    const productById = new Map(catalog.products.map(p => [Number(p.productId ?? p.PRODUCTID), p]));
    const formulaById = new Map(catalog.formulas.map(f => [Number(f.formulaId ?? f.FORMULAID), f]));
    const colorantById = new Map(catalog.colorants.map(c => [Number(c.cntId ?? c.CNTID), c]));
    const canSizeById = new Map(catalog.canSizes.map(c => [Number(c.canSizeId ?? c.CANSIZEID), c]));
    const cipByColor = new Map();
    for (const row of catalog.colorInProduct) {
      const cid = Number(row.colourId ?? row.COLOURID);
      if (!cipByColor.has(cid)) cipByColor.set(cid, []);
      cipByColor.get(cid).push(row);
    }
    const baseByProductAbstract = new Map();
    const baseById = new Map();
    for (const b of catalog.basePaints) {
      const pid = Number(b.productId ?? b.PRODUCTID);
      const aid = Number(b.aBaseId ?? b.ABASEID);
      const bid = Number(b.baseId ?? b.BASEID);
      baseByProductAbstract.set(`${pid}|${aid}`, b);
      baseById.set(bid, b);
    }
    const cansByBaseId = new Map();
    for (const c of catalog.cans) {
      const bid = Number(c.baseId ?? c.BASEID);
      if (!cansByBaseId.has(bid)) cansByBaseId.set(bid, []);
      cansByBaseId.get(bid).push(c);
    }
    return { productById, formulaById, colorantById, canSizeById, cipByColor, baseByProductAbstract, baseById, cansByBaseId };
  }

  function resolveFormulaForProduct(colourId, productId, idx) {
    const links = idx.cipByColor.get(Number(colourId)) || [];
    let current = idx.productById.get(Number(productId));
    const visited = new Set();
    while (current) {
      const pid = Number(current.productId ?? current.PRODUCTID);
      if (visited.has(pid)) break;
      visited.add(pid);
      const candidates = links.filter(x => Number(x.productId ?? x.PRODUCTID) === pid)
        .sort((a,b) => Number(b.version ?? b.VERSION ?? 0) - Number(a.version ?? a.VERSION ?? 0));
      if (candidates.length) {
        const link = candidates[0];
        const formula = idx.formulaById.get(Number(link.formulaId ?? link.FORMULAID));
        if (formula) return { link, formula, inheritedFromProductId: pid };
      }
      const parent = Number(current.parentProductId ?? current.PARENTPRODUCTID ?? 0);
      current = parent ? idx.productById.get(parent) : null;
    }
    return null;
  }

  function parseFormulaContents(value) {
    if (Array.isArray(value)) return value;
    try { return JSON.parse(String(value || "")); } catch { return null; }
  }

  async function listJobs() {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true }).catch(() => []);
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || ["unknown"].includes(entry.name)) continue;
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(dataDir, entry.name, ".meta.json"), "utf8")); } catch {}
      jobs.push({ id: entry.name, name: clean(meta.name || entry.name, 180), status: clean(meta.status || "", 60), city: clean(meta.city || "", 100) });
    }
    return jobs.sort((a,b) => a.name.localeCompare(b.name, "de"));
  }

  app.get("/admin/paint", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.sendFile(path.join(publicDir, "paint-lab.html"));
  });

  app.get("/admin/api/paint/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const [articles, aliases, catalog, settings] = await Promise.all([
      readJson(ARTICLES, []), readJson(FB_ALIASES, []), readJson(CATALOG, null), readJson(SETTINGS, DEFAULT_SETTINGS)
    ]);
    res.json({ ok: true, articles: articles.length, fbAliases: aliases.length, catalog: catalog ? { colors: catalog.colors?.length || 0, products: catalog.products?.length || 0, formulas: catalog.formulas?.length || 0, exportedAt: catalog.meta?.exportedAt || null } : null, settings: { ...DEFAULT_SETTINGS, ...settings } });
  });

  app.post("/admin/api/paint/import-excel", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const base64 = clean(req.body?.base64, 100_000_000).replace(/^data:.*?;base64,/, "");
      if (!base64) return res.status(400).json({ ok: false, error: "Excel-Datei fehlt" });
      const parsed = parseLgWorkbook(Buffer.from(base64, "base64"));
      const previous = await readJson(ARTICLES, []);
      const prevByKey = new Map(previous.map(a => [articleKey(a), a]));
      const merged = parsed.articles.map(a => {
        const old = prevByKey.get(articleKey(a));
        if (!old) return a;
        return { ...a, stock: Number.isFinite(Number(old.stock)) ? Number(old.stock) : a.stock, salePrice: Number(old.salePrice || a.salePrice || 0), createdAt: old.createdAt || a.createdAt };
      });
      await Promise.all([writeJson(ARTICLES, merged), writeJson(FB_ALIASES, parsed.aliases)]);
      res.json({ ok: true, articles: merged.length, fbAliases: parsed.aliases.length });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.post("/admin/api/paint/import-innovatint", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const catalog = normalizeCatalog(req.body);
      if (!catalog.colors.length || !catalog.products.length) return res.status(400).json({ ok: false, error: "Innovatint-Export ist leer oder ungültig" });
      await writeJson(CATALOG, catalog);
      res.json({ ok: true, colors: catalog.colors.length, products: catalog.products.length, formulas: catalog.formulas.length });
    } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  app.get("/admin/api/paint/search", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const system = clean(req.query.system || "LG", 20).toUpperCase();
    const q = clean(req.query.q, 120);
    if (!q) return res.json({ ok: true, results: [] });
    if (system === "F&B" || system === "FB") {
      const aliases = await readJson(FB_ALIASES, []);
      const groups = new Map();
      for (const row of aliases) {
        const score = Math.max(scoreHit(row.name, q), scoreHit(row.number, q), scoreHit(row.alias, q));
        if (!score) continue;
        const key = `${norm(row.name)}|${norm(row.number)}`;
        if (!groups.has(key)) groups.set(key, { id: key, system: "F&B", name: row.name, code: row.number, aliases: [], score });
        const g = groups.get(key); g.score = Math.max(g.score, score); if (row.alias && !g.aliases.includes(row.alias)) g.aliases.push(row.alias);
      }
      return res.json({ ok: true, results: [...groups.values()].sort((a,b) => b.score-a.score || String(a.name).localeCompare(String(b.name), "de")).slice(0,50) });
    }
    const catalog = await readJson(CATALOG, null);
    if (!catalog) return res.status(503).json({ ok: false, error: "Innovatint-Katalog noch nicht importiert" });
    const results = [];
    for (const c of catalog.colors || []) {
      const id = Number(c.colourId ?? c.COLOURID);
      const code = clean(c.colourCode ?? c.COLOURCODE, 120);
      if (systemOfCode(code) !== system) continue;
      const alt = clean(c.altColourCode ?? c.ALTCOLOURCODE, 120);
      const score = Math.max(scoreHit(code, q), scoreHit(alt, q));
      if (score) results.push({ id, system, name: code, code, altCode: alt, rgb: c.rgb ?? c.RGB ?? null, score });
    }
    results.sort((a,b) => b.score-a.score || String(a.code).localeCompare(String(b.code), "de", { numeric: true }));
    res.json({ ok: true, results: results.slice(0,80) });
  });

  app.get("/admin/api/paint/color/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const system = clean(req.query.system || "LG", 20).toUpperCase();
    if (system === "F&B" || system === "FB") {
      const aliases = await readJson(FB_ALIASES, []);
      const [nameNorm, noNorm] = String(req.params.id || "").split("|");
      const rows = aliases.filter(a => norm(a.name) === nameNorm && norm(a.number) === noNorm);
      if (!rows.length) return res.status(404).json({ ok:false,error:"Farbton nicht gefunden" });
      return res.json({ ok:true, color:{ system:"F&B", name:rows[0].name, code:rows[0].number, aliases:[...new Set(rows.map(r=>r.alias).filter(Boolean))] }, products:[] });
    }
    const [catalog, articles] = await Promise.all([readJson(CATALOG, null), readJson(ARTICLES, [])]);
    if (!catalog) return res.status(503).json({ ok:false,error:"Innovatint-Katalog noch nicht importiert" });
    const colourId = Number(req.params.id);
    const color = (catalog.colors || []).find(c => Number(c.colourId ?? c.COLOURID) === colourId);
    if (!color) return res.status(404).json({ ok:false,error:"Farbton nicht gefunden" });
    const idx = buildCatalogIndex(catalog);
    const stockByKey = new Map(articles.map(a => [articleKey(a), a]));
    const products = [];
    for (const p of catalog.products || []) {
      const pid = Number(p.productId ?? p.PRODUCTID);
      const resolved = resolveFormulaForProduct(colourId, pid, idx);
      if (!resolved) continue;
      const aid = Number(resolved.formula.aBaseId ?? resolved.formula.ABASEID);
      const base = idx.baseByProductAbstract.get(`${pid}|${aid}`) || idx.baseByProductAbstract.get(`${resolved.inheritedFromProductId}|${aid}`);
      if (!base) continue;
      const baseCode = clean(base.baseCode ?? base.BASECODE, 30);
      const baseId = Number(base.baseId ?? base.BASEID);
      const canRows = idx.cansByBaseId.get(baseId) || [];
      const seenSizes = new Map();
      for (const can of canRows) {
        const cs = idx.canSizeById.get(Number(can.canSizeId ?? can.CANSIZEID));
        if (!cs) continue;
        const size = sizeNorm(cs.canSizeCode ?? cs.CANSIZECODE);
        if (!size) continue;
        if (!seenSizes.has(size)) seenSizes.set(size, { canSizeId:Number(cs.canSizeId ?? cs.CANSIZEID), size, nominalAmount:Number(cs.nominalAmount ?? cs.NOMINALAMOUNT ?? sizeMl(size)) });
      }
      const productName = clean(p.productName ?? p.PRODUCTNAME, 180);
      let sizes = [...seenSizes.values()];
      if (!sizes.length && system === "LG") {
        sizes = articles.filter(a => norm(a.product)===norm(productName) && norm(a.baseCode)===norm(baseCode)).map(a => ({canSizeId:null,size:a.size,nominalAmount:a.sizeMl}));
      }
      sizes = sizes.map(s => {
        const art = stockByKey.get([norm(productName), norm(baseCode), sizeNorm(s.size)].join("|"));
        return { ...s, stock: art ? Number(art.stock || 0) : null, minimumStock: art ? Number(art.minimumStock || 0) : null, purchasePrice: art ? Number(art.purchasePrice || 0) : null, salePrice: art ? Number(art.salePrice || 0) : null, ean: art?.ean || "", stockCode: art?.stockCode || "", articleId: art?.id || "" };
      }).sort((a,b) => Number(b.nominalAmount||0)-Number(a.nominalAmount||0));
      products.push({ productId:pid, productName, productCode:clean(p.productCode ?? p.PRODUCTCODE,80), inheritedFromProductId:resolved.inheritedFromProductId, formulaId:Number(resolved.formula.formulaId ?? resolved.formula.FORMULAID), version:Number(resolved.link.version ?? resolved.link.VERSION ?? 0), aBaseId:aid, baseCode, baseName:baseName(baseCode), baseId, sizes, recipeAvailable:!!parseFormulaContents(resolved.formula.cntInFormula ?? resolved.formula.CNTINFORMULA) });
    }
    products.sort((a,b)=>a.productName.localeCompare(b.productName,"de"));
    res.json({ ok:true, color:{ id:colourId, system, name:clean(color.colourCode ?? color.COLOURCODE,120), code:clean(color.colourCode ?? color.COLOURCODE,120), altCode:clean(color.altColourCode ?? color.ALTCOLOURCODE,120), rgb:color.rgb ?? color.RGB ?? null }, products });
  });

  app.get("/admin/api/paint/recipe", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const [catalog, settings] = await Promise.all([readJson(CATALOG, null), readJson(SETTINGS, DEFAULT_SETTINGS)]);
    if (!catalog) return res.status(503).json({ ok:false,error:"Innovatint-Katalog noch nicht importiert" });
    const colourId = Number(req.query.colourId), productId = Number(req.query.productId), canSizeId = Number(req.query.canSizeId);
    const idx = buildCatalogIndex(catalog);
    const resolved = resolveFormulaForProduct(colourId, productId, idx);
    if (!resolved) return res.status(404).json({ok:false,error:"Keine Rezeptur gefunden"});
    const formula = resolved.formula;
    const parsed = parseFormulaContents(formula.cntInFormula ?? formula.CNTINFORMULA);
    if (!parsed || !Array.isArray(parsed[0]) || !Array.isArray(parsed[1])) return res.status(404).json({ok:false,error:"Rezepturinhalt nicht lesbar"});
    const cs = idx.canSizeById.get(canSizeId);
    if (!cs) return res.status(404).json({ok:false,error:"Gebinde nicht gefunden"});
    const nominalMl = Number(cs.nominalAmount ?? cs.NOMINALAMOUNT ?? 0);
    const factorL = nominalMl / 1000;
    const unitMl = Number(settings.recipeUnitMl || DEFAULT_SETTINGS.recipeUnitMl);
    const recipe = parsed[0].map((cntId, i) => {
      const c = idx.colorantById.get(Number(cntId)) || {};
      const perL = Number(parsed[1][i] || 0);
      const ml = perL * factorL;
      const machineUnits = unitMl > 0 ? ml / unitMl : null;
      return { cntId:Number(cntId), code:clean(c.cntCode ?? c.CNTCODE,20), description:clean(c.description ?? c.DESCRIPTION,80), specificGravity:Number(c.specificGravity ?? c.SPECIFICGRAVITY ?? 0), perLiter:perL, ml:Number(ml.toFixed(4)), machineUnits:machineUnits===null?null:Number(machineUnits.toFixed(2)) };
    });
    res.json({ ok:true, formulaId:Number(formula.formulaId ?? formula.FORMULAID), inheritedFromProductId:resolved.inheritedFromProductId, canSizeId, canSize:clean(cs.canSizeCode ?? cs.CANSIZECODE,40), nominalMl, recipeUnitMl:unitMl, calibrationNote:settings.recipeCalibrationNote || "", recipe });
  });

  app.get("/admin/api/paint/scan", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const ean = eanNorm(req.query.ean);
    const articles = await readJson(ARTICLES, []);
    const article = articles.find(a => ean && eanNorm(a.ean) === ean);
    if (!article) return res.status(404).json({ok:false,error:"EAN nicht im KRISTINE-Lagerstamm"});
    res.json({ok:true,article});
  });

  app.get("/admin/api/paint/jobs", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ok:true,jobs:await listJobs()});
  });

  app.post("/admin/api/paint/movement", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const articles = await readJson(ARTICLES, []);
      const id = clean(req.body?.articleId, 160), ean = eanNorm(req.body?.ean);
      const article = articles.find(a => (id && String(a.id)===id) || (ean && eanNorm(a.ean)===ean));
      if (!article) return res.status(404).json({ok:false,error:"Artikel nicht gefunden"});
      const direction = clean(req.body?.direction || "out",20).toLowerCase();
      const quantity = Math.max(0.001, Math.abs(num(req.body?.quantity,1)));
      const delta = direction === "in" ? quantity : -quantity;
      const before = Number(article.stock || 0);
      const after = before + delta;
      if (after < 0 && req.body?.allowNegative !== true) return res.status(409).json({ok:false,error:`Nicht genug Bestand (${before})`});
      const oldPrice = Number(article.purchasePrice || 0);
      if (direction === "in" && req.body?.purchasePrice !== undefined && req.body?.purchasePrice !== "") article.purchasePrice = num(req.body.purchasePrice, oldPrice);
      article.stock = after;
      article.updatedAt = new Date().toISOString();
      await writeJson(ARTICLES, articles);
      const movement = { at:new Date().toISOString(), articleId:article.id, ean:article.ean, product:article.product, baseCode:article.baseCode, size:article.size, direction, quantity, delta, before, after, reason:clean(req.body?.reason,40), jobId:clean(req.body?.jobId,80), invoiceRef:clean(req.body?.invoiceRef,120), user:clean(req.body?.user || "KRISTINE",120), purchasePrice:direction==="in"?Number(article.purchasePrice||0):null };
      await appendJsonl(MOVEMENTS, movement);
      if (direction === "in" && Number(article.purchasePrice||0) !== oldPrice) await appendJsonl(PRICE_HISTORY,{at:movement.at,articleId:article.id,oldPurchasePrice:oldPrice,newPurchasePrice:Number(article.purchasePrice||0),invoiceRef:movement.invoiceRef});
      res.json({ok:true,article,movement});
    } catch(e) { res.status(500).json({ok:false,error:String(e?.message||e)}); }
  });

  app.post("/admin/api/paint/invoice/parse-text", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const text = String(req.body?.text || "");
    const articles = await readJson(ARTICLES, []);
    const byCode = new Map(articles.map(a=>[clean(a.stockCode).toUpperCase(),a]));
    const lines = [];
    const re = /^([A-Z0-9]{8,20})\s+LG\s+(.+?)\s+(Hi White|Medium|Deep|Extra Deep|Transparent|Yellow|Pastel|White ASP)\s+(250ml|500ml|750ml|1L|2L|2\.5L|4L|5L|10L)\s+([0-9.,]+)\s+([0-9.,]+)\s+([0-9.,]+)/i;
    for (const rawLine of text.split(/\r?\n/)) {
      const m = rawLine.trim().match(re); if (!m) continue;
      const stockCode = m[1].toUpperCase(); const article = byCode.get(stockCode) || null;
      lines.push({ stockCode, description:m[2].trim(), base:m[3], size:sizeNorm(m[4]), quantity:num(m[5]), purchasePrice:num(m[6]), net:num(m[7]), matched:!!article, articleId:article?.id||"", currentStock:article?Number(article.stock||0):null });
    }
    res.json({ok:true,lines,unmatched:lines.filter(x=>!x.matched).length});
  });

  app.post("/admin/api/paint/inbound/commit", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const results=[];
    for (const row of rows) {
      const articles=await readJson(ARTICLES,[]); const article=articles.find(a=>String(a.id)===String(row.articleId));
      if(!article){results.push({ok:false,articleId:row.articleId,error:"Artikel nicht gefunden"});continue;}
      const before=Number(article.stock||0), qty=Math.max(0.001,Math.abs(num(row.quantity,1))), oldPrice=Number(article.purchasePrice||0);
      article.stock=before+qty; if(row.purchasePrice!==undefined&&row.purchasePrice!=="") article.purchasePrice=num(row.purchasePrice,oldPrice); article.updatedAt=new Date().toISOString(); await writeJson(ARTICLES,articles);
      const movement={at:new Date().toISOString(),articleId:article.id,ean:article.ean,product:article.product,baseCode:article.baseCode,size:article.size,direction:"in",quantity:qty,delta:qty,before,after:article.stock,reason:"invoice",invoiceRef:clean(req.body?.invoiceRef,120),user:clean(req.body?.user||"Rechnung",120),purchasePrice:Number(article.purchasePrice||0)};
      await appendJsonl(MOVEMENTS,movement); if(Number(article.purchasePrice||0)!==oldPrice) await appendJsonl(PRICE_HISTORY,{at:movement.at,articleId:article.id,oldPurchasePrice:oldPrice,newPurchasePrice:Number(article.purchasePrice||0),invoiceRef:movement.invoiceRef});
      results.push({ok:true,article,movement});
    }
    res.json({ok:results.every(x=>x.ok),results});
  });

  app.get("/admin/api/paint/settings", async (req,res)=>{ if(!requireAdmin(req,res))return; res.json({ok:true,settings:{...DEFAULT_SETTINGS,...await readJson(SETTINGS,{})}}); });
  app.put("/admin/api/paint/settings", async (req,res)=>{ if(!requireAdmin(req,res))return; const current={...DEFAULT_SETTINGS,...await readJson(SETTINGS,{})}; const next={...current}; if(req.body?.recipeUnitMl!==undefined)next.recipeUnitMl=Math.max(0.000001,num(req.body.recipeUnitMl,current.recipeUnitMl)); if(req.body?.recipeCalibrationNote!==undefined)next.recipeCalibrationNote=clean(req.body.recipeCalibrationNote,500); await writeJson(SETTINGS,next); res.json({ok:true,settings:next}); });
}

module.exports = { registerPaintLab };
