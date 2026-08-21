"use strict";

// Bestell-Entwurf vor paint-commercial.js registrieren.
// null orderQuantityOverride = KRISTINE-Vorschlag, 0 = bewusst nicht bestellen, >0 = manuell.
// Tapeten werden als eigener manueller Bestellblock gefuehrt; fuer sie liegt nur die Retail-Liste vor,
// deshalb werden sie nicht in den Netto-Einkaufswert der Farben eingerechnet.

const fsp = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const LG_ORDER_EMAIL = "export.orders@thelittlegreene.com";
const LG_ACCOUNT_CODE = "FAR207";

function registerPaintOrderSummaryFix(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const purchasesFile = path.join(root, "lg-purchases.json");
  const movementsFile = path.join(root, "movements.jsonl");
  const priceListMetaFile = path.join(root, "lg-pricelist.json");
  const wallpaperOrderFile = path.join(root, "wallpaper-order.json");

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
  const nullableNonNegative = value => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.max(0, n) : null;
  };
  const pdfText = value => clean(value, 500).replace(/[\u2010-\u2015]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
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

  function suggestion(a) {
    const category = clean(a.category).toLowerCase();
    if (category === "sample-pot" || category === "marketing") return 0;
    const stock = Math.max(0, Number(a.stock || 0));
    const minimum = Math.max(0, Number(a.minimumStock || 0));
    const target = Math.max(minimum, Number(a.targetStock ?? minimum) || 0);
    return stock < minimum ? Math.max(0, Math.ceil(target - stock)) : 0;
  }

  function effectiveQuantity(a) {
    const override = nullableNonNegative(a.orderQuantityOverride);
    return override === null ? suggestion(a) : override;
  }

  function normalizeWallpaperRows(saved) {
    return (Array.isArray(saved?.items) ? saved.items : []).map(row => ({
      id: clean(row?.id, 120),
      collection: clean(row?.collection, 160),
      design: clean(row?.design, 180),
      colourway: clean(row?.colourway, 180),
      productCode: clean(row?.productCode, 120),
      rolls: Math.max(0, Math.floor(Number(row?.rolls || 0))),
      note: clean(row?.note, 300),
    })).filter(row => row.rolls > 0 && (row.design || row.productCode || row.colourway));
  }

  async function openOrderSummary() {
    const [articles, wallpaperSaved] = await Promise.all([
      readJson(articlesFile, []),
      readJson(wallpaperOrderFile, { items: [] }),
    ]);

    const items = articles
      .filter(a => a && a.active !== false && a.orderable !== false && String(a.manufacturer || "Little Greene").toLowerCase().includes("little greene"))
      .map(a => {
        const quantity = effectiveQuantity(a);
        const price = Number(a.purchasePrice || 0);
        return {
          articleId: a.id || "",
          ean: a.ean || "",
          stockCode: a.stockCode || "",
          product: a.product || "",
          baseCode: a.baseCode || "",
          baseName: a.baseName || a.baseCode || "",
          size: a.size || "",
          category: a.category || "",
          stock: Number(a.stock || 0),
          minimumStock: Number(a.minimumStock || 0),
          targetStock: Number(a.targetStock || 0),
          suggestedQuantity: suggestion(a),
          manualQuantity: nullableNonNegative(a.orderQuantityOverride),
          quantity,
          purchasePrice: price,
          lineTotal: Number((quantity * price).toFixed(2)),
          orderIndex: Number.isFinite(Number(a.orderIndex)) ? Number(a.orderIndex) : 999999,
        };
      })
      .filter(x => x.quantity > 0)
      .sort((a, b) => a.orderIndex - b.orderIndex || String(a.product).localeCompare(String(b.product), "de"));

    const wallpaperItems = normalizeWallpaperRows(wallpaperSaved);
    const paintCount = items.reduce((sum, x) => sum + Number(x.quantity || 0), 0);
    const wallpaperRolls = wallpaperItems.reduce((sum, x) => sum + Number(x.rolls || 0), 0);
    const total = Number(items.reduce((sum, x) => sum + x.lineTotal, 0).toFixed(2));

    return {
      items,
      wallpaperItems,
      paintCount,
      wallpaperRolls,
      count: paintCount + wallpaperRolls,
      total,
      totalExcludesWallpaper: wallpaperItems.length > 0,
    };
  }

  async function turnoverSummary() {
    const purchases = await readJson(purchasesFile, []);
    const byYear = new Map();
    for (const row of purchases) {
      const fy = fiscalYearInfo(row.invoiceDate || row.date || row.createdAt);
      if (!fy) continue;
      const amount = Number(row.netAmount || 0);
      if (!byYear.has(fy.key)) byYear.set(fy.key, { ...fy, netAmount: 0, invoices: 0 });
      const group = byYear.get(fy.key);
      group.netAmount += amount;
      group.invoices += 1;
    }
    if (!purchases.length) {
      const movements = await readJsonl(movementsFile);
      for (const row of movements) {
        if (String(row.direction) !== "in" || String(row.reason) !== "invoice") continue;
        const fy = fiscalYearInfo(row.at);
        if (!fy) continue;
        const amount = Number(row.quantity || 0) * Number(row.purchasePrice || 0);
        if (!byYear.has(fy.key)) byYear.set(fy.key, { ...fy, netAmount: 0, invoices: 0, estimated: true });
        byYear.get(fy.key).netAmount += amount;
      }
    }
    const years = [...byYear.values()]
      .map(x => ({ ...x, netAmount: Number(x.netAmount.toFixed(2)) }))
      .sort((a, b) => b.startYear - a.startYear);
    const current = fiscalYearInfo(new Date());
    const currentRow = years.find(x => x.key === current.key) || { ...current, netAmount: 0, invoices: 0 };
    return { current: currentRow, years };
  }

  async function buildOrderPdf(summary) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pageW = 595.28;
    const pageH = 841.89;
    const margin = 38;

    const paintChunks = [];
    for (let i = 0; i < summary.items.length; i += 31) paintChunks.push(summary.items.slice(i, i + 31));
    const wallpaperChunks = [];
    for (let i = 0; i < summary.wallpaperItems.length; i += 24) wallpaperChunks.push(summary.wallpaperItems.slice(i, i + 24));
    const totalPages = Math.max(1, paintChunks.length + wallpaperChunks.length);
    let pageNo = 0;

    const footer = page => {
      page.drawText(`Seite ${pageNo}/${totalPages}`, { x: pageW - margin - 55, y: 22, size: 8, font });
    };

    for (let chunkIndex = 0; chunkIndex < paintChunks.length; chunkIndex += 1) {
      const chunk = paintChunks[chunkIndex];
      pageNo += 1;
      const page = pdf.addPage([pageW, pageH]);
      let y = pageH - margin;
      page.drawText("LITTLE GREENE · BESTELLUNG", { x: margin, y, size: 16, font: bold, color: rgb(0.12, 0.28, 0.2) });
      y -= 24;
      page.drawText(`Kundenkonto: ${LG_ACCOUNT_CODE} · Farben Krista GmbH & Co KG · ${new Date().toLocaleDateString("de-AT")}`, { x: margin, y, size: 9, font });
      y -= 20;
      const cols = [
        { t: "Stk", x: margin },
        { t: "SKU", x: margin + 34 },
        { t: "Produkt / Artikel", x: margin + 118 },
        { t: "Gebinde", x: margin + 330 },
        { t: "Basis", x: margin + 392 },
        { t: "Preis", x: margin + 457 },
        { t: "Summe", x: margin + 505 },
      ];
      cols.forEach(c => page.drawText(c.t, { x: c.x, y, size: 8.5, font: bold }));
      y -= 12;
      page.drawLine({ start: { x: margin, y }, end: { x: pageW - margin, y }, thickness: 0.7, color: rgb(0.75, 0.75, 0.72) });
      y -= 14;
      for (const item of chunk) {
        page.drawText(String(item.quantity), { x: margin, y, size: 8.2, font });
        page.drawText(pdfText(item.stockCode).slice(0, 15), { x: margin + 34, y, size: 8, font });
        page.drawText(pdfText(item.product || item.baseName).slice(0, 34), { x: margin + 118, y, size: 8, font });
        page.drawText(pdfText(item.size).slice(0, 10), { x: margin + 330, y, size: 8, font });
        page.drawText(pdfText(item.baseName || item.baseCode).slice(0, 13), { x: margin + 392, y, size: 8, font });
        page.drawText(`€ ${Number(item.purchasePrice || 0).toFixed(2)}`, { x: margin + 452, y, size: 8, font });
        page.drawText(`€ ${Number(item.lineTotal || 0).toFixed(2)}`, { x: margin + 500, y, size: 8, font });
        y -= 20;
      }
      if (chunkIndex === paintChunks.length - 1) {
        y -= 8;
        page.drawLine({ start: { x: margin + 370, y: y + 10 }, end: { x: pageW - margin, y: y + 10 }, thickness: 1, color: rgb(0.25, 0.25, 0.25) });
        page.drawText(`Farben / Material netto: € ${summary.total.toFixed(2)}`, { x: margin + 315, y: y - 8, size: 10.5, font: bold });
        if (summary.wallpaperRolls > 0) page.drawText(`Tapeten zusaetzlich: ${summary.wallpaperRolls} Rollen`, { x: margin + 315, y: y - 23, size: 9, font });
      }
      footer(page);
    }

    for (const chunk of wallpaperChunks) {
      pageNo += 1;
      const page = pdf.addPage([pageW, pageH]);
      let y = pageH - margin;
      page.drawText("LITTLE GREENE · TAPETENBESTELLUNG", { x: margin, y, size: 16, font: bold, color: rgb(0.12, 0.28, 0.2) });
      y -= 24;
      page.drawText(`Kundenkonto: ${LG_ACCOUNT_CODE} · Farben Krista GmbH & Co KG · ${new Date().toLocaleDateString("de-AT")}`, { x: margin, y, size: 9, font });
      y -= 20;
      const cols = [
        { t: "Rollen", x: margin },
        { t: "Kollektion", x: margin + 46 },
        { t: "Design", x: margin + 145 },
        { t: "Farbweg / Product Code", x: margin + 300 },
        { t: "Notiz", x: margin + 445 },
      ];
      cols.forEach(c => page.drawText(c.t, { x: c.x, y, size: 8.3, font: bold }));
      y -= 12;
      page.drawLine({ start: { x: margin, y }, end: { x: pageW - margin, y }, thickness: 0.7, color: rgb(0.75, 0.75, 0.72) });
      y -= 14;
      for (const item of chunk) {
        const code = [item.productCode, item.colourway].filter(Boolean).join(" · ");
        page.drawText(String(item.rolls), { x: margin, y, size: 8.2, font });
        page.drawText(pdfText(item.collection).slice(0, 18), { x: margin + 46, y, size: 8, font });
        page.drawText(pdfText(item.design).slice(0, 28), { x: margin + 145, y, size: 8, font });
        page.drawText(pdfText(code).slice(0, 27), { x: margin + 300, y, size: 8, font });
        page.drawText(pdfText(item.note).slice(0, 18), { x: margin + 445, y, size: 8, font });
        y -= 22;
      }
      y -= 8;
      page.drawText(`Tapeten gesamt: ${summary.wallpaperRolls} Rollen · Preis laut Little Greene`, { x: margin, y, size: 10, font: bold });
      footer(page);
    }

    if (!paintChunks.length && !wallpaperChunks.length) {
      pageNo = 1;
      const page = pdf.addPage([pageW, pageH]);
      page.drawText("LITTLE GREENE · BESTELLUNG", { x: margin, y: pageH - margin, size: 16, font: bold, color: rgb(0.12, 0.28, 0.2) });
      page.drawText("Keine Bestellpositionen vorhanden.", { x: margin, y: pageH - margin - 35, size: 10, font });
      footer(page);
    }

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
    const [order, turnover, priceList] = await Promise.all([
      openOrderSummary(),
      turnoverSummary(),
      readJson(priceListMetaFile, null),
    ]);
    res.json({ ok: true, order, turnover, priceList, orderEmail: LG_ORDER_EMAIL, accountCode: LG_ACCOUNT_CODE, draft: true });
  });

  app.get("/admin/api/paint/lg-order/pdf", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const summary = await openOrderSummary();
    const pdf = await buildOrderPdf(summary);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=\"LittleGreene_Bestellung_${new Date().toISOString().slice(0, 10)}.pdf\"`);
    res.send(pdf);
  });

  app.post("/admin/api/paint/lg-order/email", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await openOrderSummary();
      if (!summary.items.length && !summary.wallpaperItems.length) return res.status(409).json({ ok: false, error: "Die offene Bestellung ist leer" });
      const pdf = await buildOrderPdf(summary);
      const mailer = makeMailer();
      const from = process.env.MAIL_FROM || process.env.SMTP_USER;
      const wallpaperText = summary.wallpaperRolls > 0 ? `\nWallpaper: ${summary.wallpaperRolls} rolls` : "";
      const subject = `Order ${LG_ACCOUNT_CODE} · Farben Krista · € ${summary.total.toFixed(2)}${summary.wallpaperRolls ? ` · ${summary.wallpaperRolls} wallpaper rolls` : ""}`;
      const text = `Dear Little Greene Export Team,\n\nplease find attached our current order for account ${LG_ACCOUNT_CODE}.\n\nPaint/material net order value: € ${summary.total.toFixed(2)}${wallpaperText}\n\nKind regards\nFarben Krista GmbH & Co KG`;
      const info = await mailer.sendMail({
        from,
        to: LG_ORDER_EMAIL,
        subject,
        text,
        attachments: [{
          filename: `LittleGreene_Order_${new Date().toISOString().slice(0, 10)}.pdf`,
          content: pdf,
          contentType: "application/pdf",
        }],
      });
      res.json({ ok: true, to: LG_ORDER_EMAIL, total: summary.total, wallpaperRolls: summary.wallpaperRolls, messageId: info.messageId });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
}

module.exports = { registerPaintOrderSummaryFix };
