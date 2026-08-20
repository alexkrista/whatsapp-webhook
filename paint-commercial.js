"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
let XLSX = null;
try { XLSX = require("xlsx"); } catch {}

const LG_ORDER_EMAIL = "export.orders@thelittlegreene.com";
const LG_ACCOUNT_CODE = "FAR207";

function registerPaintCommercial(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const ROOT = path.join(dataDir, "_kristine", "paint");
  const ARTICLES = path.join(ROOT, "articles.json");
  const PRICE_HISTORY = path.join(ROOT, "price-history.jsonl");
  const MOVEMENTS = path.join(ROOT, "movements.jsonl");
  const PRICE_LIST_META = path.join(ROOT, "lg-pricelist.json");
  const PRICE_LIST_DIR = path.join(ROOT, "price-lists");
  const PURCHASES = path.join(ROOT, "lg-purchases.json");

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
  const normHeader = (v) => clean(v, 120).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[€()]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const stockCodeNorm = (v) => clean(v, 100).toUpperCase().replace(/\s+/g, "");

  async function ensureRoot() {
    await fsp.mkdir(ROOT, { recursive: true });
    await fsp.mkdir(PRICE_LIST_DIR, { recursive: true });
  }
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
  async function readJsonl(file) {
    try {
      return (await fsp.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  function fiscalYearInfo(value = new Date()) {
    const d = value instanceof Date ? value : new Date(String(value || ""));
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const startYear = m >= 11 ? y : y - 1;
    return {
      startYear,
      endYear: startYear + 1,
      key: `${startYear}-${startYear + 1}`,
      label: `${startYear}/${String(startYear + 1).slice(-2)}`,
      start: `${startYear}-11-01`,
      end: `${startYear + 1}-10-31`,
    };
  }

  async function openOrderSummary() {
    const articles = await readJson(ARTICLES, []);
    const items = articles
      .filter(a => a && a.active !== false && String(a.manufacturer || "Little Greene").toLowerCase().includes("little greene"))
      .map(a => {
        const stock = Number(a.stock || 0);
        const min = Number(a.minimumStock || 0);
        const quantity = Math.max(0, Math.ceil(min - stock));
        const price = Number(a.purchasePrice || 0);
        return {
          articleId: a.id || "",
          ean: a.ean || "",
          stockCode: a.stockCode || "",
          product: a.product || "",
          baseCode: a.baseCode || "",
          baseName: a.baseName || a.baseCode || "",
          size: a.size || "",
          stock,
          minimumStock: min,
          quantity,
          purchasePrice: price,
          lineTotal: Number((quantity * price).toFixed(2)),
        };
      })
      .filter(x => x.quantity > 0)
      .sort((a, b) => String(a.product).localeCompare(String(b.product), "de") || String(a.size).localeCompare(String(b.size), "de"));
    const total = Number(items.reduce((s, x) => s + x.lineTotal, 0).toFixed(2));
    return { items, total, count: items.reduce((s, x) => s + x.quantity, 0) };
  }

  async function turnoverSummary() {
    const purchases = await readJson(PURCHASES, []);
    const byYear = new Map();
    for (const row of purchases) {
      const fy = fiscalYearInfo(row.invoiceDate || row.date || row.createdAt);
      if (!fy) continue;
      const amount = Number(row.netAmount || 0);
      if (!byYear.has(fy.key)) byYear.set(fy.key, { ...fy, netAmount: 0, invoices: 0 });
      const g = byYear.get(fy.key);
      g.netAmount += amount;
      g.invoices += 1;
    }
    if (!purchases.length) {
      const movements = await readJsonl(MOVEMENTS);
      for (const row of movements) {
        if (String(row.direction) !== "in" || String(row.reason) !== "invoice") continue;
        const fy = fiscalYearInfo(row.at);
        if (!fy) continue;
        const amount = Number(row.quantity || 0) * Number(row.purchasePrice || 0);
        if (!byYear.has(fy.key)) byYear.set(fy.key, { ...fy, netAmount: 0, invoices: 0, estimated: true });
        byYear.get(fy.key).netAmount += amount;
      }
    }
    const years = [...byYear.values()].map(x => ({ ...x, netAmount: Number(x.netAmount.toFixed(2)) })).sort((a, b) => b.startYear - a.startYear);
    const current = fiscalYearInfo(new Date());
    const currentRow = years.find(x => x.key === current.key) || { ...current, netAmount: 0, invoices: 0 };
    return { current: currentRow, years };
  }

  function parsePriceListWorkbook(buffer) {
    if (!XLSX) throw new Error("xlsx-Modul fehlt");
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    const prices = new Map();
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: "" });
      let headerRow = -1, codeCol = -1, priceCol = -1;
      for (let r = 0; r < Math.min(rows.length, 30); r += 1) {
        const hs = (rows[r] || []).map(normHeader);
        const c = hs.findIndex(h => /^(product code|sku|stock code|article code|artikelnummer|produktcode)$/.test(h) || (h.includes("product") && h.includes("code")));
        const p = hs.findIndex(h => /^(price|preis|net price|netto|trade price|eur)$/.test(h) || h.includes("price") || h.includes("preis"));
        if (c >= 0 && p >= 0) { headerRow = r; codeCol = c; priceCol = p; break; }
      }
      if (headerRow < 0) continue;
      for (let r = headerRow + 1; r < rows.length; r += 1) {
        const row = rows[r] || [];
        const code = stockCodeNorm(row[codeCol]);
        const price = num(row[priceCol], NaN);
        if (!code || !Number.isFinite(price) || price <= 0) continue;
        prices.set(code, price);
      }
    }
    return prices;
  }

  async function buildOrderPdf(summary) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pageW = 595.28, pageH = 841.89;
    const margin = 42;
    const rowsPerPage = 32;
    const chunks = [];
    for (let i = 0; i < summary.items.length; i += rowsPerPage) chunks.push(summary.items.slice(i, i + rowsPerPage));
    if (!chunks.length) chunks.push([]);

    chunks.forEach((chunk, pageIndex) => {
      const page = pdf.addPage([pageW, pageH]);
      let y = pageH - margin;
      page.drawText("LITTLE GREENE · BESTELLUNG", { x: margin, y, size: 16, font: bold, color: rgb(0.12,0.28,0.2) });
      y -= 24;
      page.drawText(`Kundenkonto: ${LG_ACCOUNT_CODE} · Farben Krista GmbH & Co KG · ${new Date().toLocaleDateString("de-AT")}`, { x: margin, y, size: 9, font });
      y -= 20;
      page.drawText("Stk", { x: margin, y, size: 9, font: bold });
      page.drawText("Product Code", { x: margin + 35, y, size: 9, font: bold });
      page.drawText("Produkt", { x: margin + 120, y, size: 9, font: bold });
      page.drawText("Gebinde", { x: margin + 330, y, size: 9, font: bold });
      page.drawText("Basis", { x: margin + 390, y, size: 9, font: bold });
      page.drawText("Preis", { x: margin + 455, y, size: 9, font: bold });
      page.drawText("Summe", { x: margin + 500, y, size: 9, font: bold });
      y -= 12;
      page.drawLine({ start:{x:margin,y}, end:{x:pageW-margin,y}, thickness:0.7, color:rgb(.75,.75,.72) });
      y -= 14;
      for (const item of chunk) {
        page.drawText(String(item.quantity), { x: margin, y, size: 8.5, font });
        page.drawText(String(item.stockCode || ""), { x: margin + 35, y, size: 8.2, font });
        page.drawText(String(item.product || "").slice(0, 34), { x: margin + 120, y, size: 8.2, font });
        page.drawText(String(item.size || ""), { x: margin + 330, y, size: 8.2, font });
        page.drawText(String(item.baseName || item.baseCode || "").slice(0, 12), { x: margin + 390, y, size: 8.2, font });
        page.drawText(`€ ${Number(item.purchasePrice||0).toFixed(2)}`, { x: margin + 448, y, size: 8.2, font });
        page.drawText(`€ ${Number(item.lineTotal||0).toFixed(2)}`, { x: margin + 498, y, size: 8.2, font });
        y -= 20;
      }
      if (pageIndex === chunks.length - 1) {
        y -= 8;
        page.drawLine({ start:{x:margin+390,y:y+10}, end:{x:pageW-margin,y:y+10}, thickness:1, color:rgb(.25,.25,.25) });
        page.drawText(`Offene Bestellung netto: € ${summary.total.toFixed(2)}`, { x: margin + 330, y: y - 8, size: 11, font: bold });
      }
      page.drawText(`Seite ${pageIndex+1}/${chunks.length}`, { x: pageW-margin-55, y: 22, size: 8, font });
    });
    return Buffer.from(await pdf.save());
  }

  function makeMailer() {
    const host = process.env.SMTP_HOST || "";
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER || "";
    const pass = process.env.SMTP_PASS || "";
    if (!host || !user || !pass) throw new Error("SMTP ist nicht vollständig konfiguriert");
    return nodemailer.createTransport({ host, port, secure: false, auth: { user, pass } });
  }

  app.get("/admin/api/paint/lg-commercial", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const [order, turnover, priceList] = await Promise.all([openOrderSummary(), turnoverSummary(), readJson(PRICE_LIST_META, null)]);
    res.json({ ok: true, order, turnover, priceList, orderEmail: LG_ORDER_EMAIL, accountCode: LG_ACCOUNT_CODE });
  });

  app.post("/admin/api/paint/lg-pricelist/import", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensureRoot();
      const name = clean(req.body?.name || "LG-Preisliste", 180).replace(/[\\/:*?"<>|]+/g, "_");
      const base64 = clean(req.body?.base64, 120_000_000).replace(/^data:.*?;base64,/, "");
      if (!base64) return res.status(400).json({ ok:false, error:"Preisliste fehlt" });
      const buf = Buffer.from(base64, "base64");
      const ext = path.extname(name).toLowerCase() || ".bin";
      const stored = path.join(PRICE_LIST_DIR, `current${ext}`);
      await fsp.writeFile(stored, buf);
      let updated = 0, recognized = 0;
      if ([".xlsx", ".xls"].includes(ext)) {
        const prices = parsePriceListWorkbook(buf);
        recognized = prices.size;
        const articles = await readJson(ARTICLES, []);
        for (const article of articles) {
          const code = stockCodeNorm(article.stockCode);
          if (!code || !prices.has(code)) continue;
          const old = Number(article.purchasePrice || 0);
          const next = Number(prices.get(code));
          if (old !== next) {
            article.purchasePrice = next;
            article.updatedAt = new Date().toISOString();
            await appendJsonl(PRICE_HISTORY, { at: article.updatedAt, articleId: article.id, oldPurchasePrice: old, newPurchasePrice: next, source: "LG-Preisliste" });
            updated += 1;
          }
        }
        await writeJson(ARTICLES, articles);
      }
      const meta = { name, stored, importedAt: new Date().toISOString(), updatedArticles: updated, recognizedPrices: recognized };
      await writeJson(PRICE_LIST_META, meta);
      res.json({ ok:true, ...meta });
    } catch (e) { res.status(500).json({ok:false,error:String(e?.message||e)}); }
  });

  app.get("/admin/api/paint/lg-pricelist", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const meta = await readJson(PRICE_LIST_META, null);
    if (!meta?.stored || !fs.existsSync(meta.stored)) return res.status(404).send("Keine LG-Preisliste importiert");
    res.setHeader("Content-Disposition", `inline; filename=\"${path.basename(meta.name || meta.stored)}\"`);
    res.sendFile(path.resolve(meta.stored));
  });

  app.get("/admin/api/paint/lg-order/pdf", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const summary = await openOrderSummary();
    const pdf = await buildOrderPdf(summary);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=\"LittleGreene_Bestellung_${new Date().toISOString().slice(0,10)}.pdf\"`);
    res.send(pdf);
  });

  app.post("/admin/api/paint/lg-order/email", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await openOrderSummary();
      if (!summary.items.length) return res.status(409).json({ok:false,error:"Die offene Bestellung ist leer"});
      const pdf = await buildOrderPdf(summary);
      const mailer = makeMailer();
      const from = process.env.MAIL_FROM || process.env.SMTP_USER;
      const subject = `Order ${LG_ACCOUNT_CODE} · Farben Krista · € ${summary.total.toFixed(2)}`;
      const text = `Dear Little Greene Export Team,\n\nplease find attached our current order for account ${LG_ACCOUNT_CODE}.\n\nNet order value: € ${summary.total.toFixed(2)}\n\nKind regards\nFarben Krista GmbH & Co KG`;
      const info = await mailer.sendMail({ from, to: LG_ORDER_EMAIL, subject, text, attachments: [{ filename:`LittleGreene_Order_${new Date().toISOString().slice(0,10)}.pdf`, content:pdf, contentType:"application/pdf" }] });
      res.json({ok:true,to:LG_ORDER_EMAIL,total:summary.total,messageId:info.messageId});
    } catch (e) { res.status(500).json({ok:false,error:String(e?.message||e)}); }
  });

  app.post("/admin/api/paint/lg-purchase", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const invoiceRef = clean(req.body?.invoiceRef || req.body?.invoiceNumber, 120);
      const invoiceDate = clean(req.body?.invoiceDate, 20).slice(0,10);
      const netAmount = num(req.body?.netAmount, NaN);
      if (!invoiceRef || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) || !Number.isFinite(netAmount)) return res.status(400).json({ok:false,error:"invoiceRef, invoiceDate und netAmount erforderlich"});
      const rows = await readJson(PURCHASES, []);
      const row = { invoiceRef, invoiceDate, netAmount:Number(netAmount.toFixed(2)), createdAt:new Date().toISOString() };
      const idx = rows.findIndex(x => String(x.invoiceRef) === invoiceRef);
      if (idx >= 0) rows[idx] = { ...rows[idx], ...row }; else rows.push(row);
      await writeJson(PURCHASES, rows);
      res.json({ok:true,purchase:row,fiscalYear:fiscalYearInfo(invoiceDate)});
    } catch (e) { res.status(500).json({ok:false,error:String(e?.message||e)}); }
  });
}

module.exports = { registerPaintCommercial };
