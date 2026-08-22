"use strict";

const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const CFB = XLSX.CFB;
try { CFB?.utils?.use_zlib?.(require("zlib")); } catch {}

const TEMPLATE_NAME = "Order form MAY 2026 LG_PRICE KRISTA.xlsx";
const SHEET_CONFIG = Object.freeze({
  "LG BASES": { xml: "xl/worksheets/sheet2.xml", skuCol: "D", qtyCol: "E", priceCol: "F", totalCol: "G", startRow: 2, endRow: 142, totalCell: "G143" },
  "COLOURANTS": { xml: "xl/worksheets/sheet3.xml", skuCol: "D", qtyCol: "E", priceCol: "F", totalCol: "G", startRow: 2, endRow: 16, totalCell: "G18" },
  "LG SAMPLE POTS": { xml: "xl/worksheets/sheet4.xml", skuCol: "C", qtyCol: "D", priceCol: "E", totalCol: "F", startRow: 2, endRow: 206, totalCell: "F207" },
  "LG MARKETING": { xml: "xl/worksheets/sheet5.xml", skuCol: "C", qtyCol: "D", priceCol: "E", totalCol: "F", startRow: 2, endRow: 36, totalCell: "F37" },
});
const SUMMARY_XML = "xl/worksheets/sheet1.xml";

function registerPaintLgOrderExcel(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const templateFile = path.join(root, "lg-order-template.xlsx");
  const templateMetaFile = path.join(root, "lg-order-template.json");

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
  const isLittleGreene = article => String(article?.manufacturer || "Little Greene").toLowerCase().includes("little greene");
  const money2 = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

  async function ensureRoot() { await fsp.mkdir(root, { recursive: true }); }
  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await ensureRoot();
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

  async function currentOrder() {
    const articles = await readJson(articlesFile, []);
    const items = (Array.isArray(articles) ? articles : [])
      .filter(article => article && article.active !== false && article.orderable !== false && isLittleGreene(article))
      .map(article => ({
        articleId: clean(article?.id, 220),
        product: clean(article?.product, 180),
        stockCode: clean(article?.stockCode, 100).toUpperCase(),
        quantity: effectiveQuantity(article),
        purchasePrice: Math.max(0, Number(article?.purchasePrice || 0)),
      }));
    const openItems = items.filter(item => Number(item.quantity || 0) > 0);
    return {
      openItems,
      openPositions: openItems.length,
      pieces: openItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
      kristineTotal: money2(openItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.purchasePrice || 0), 0)),
    };
  }

  function cellNumber(ws, address) {
    const n = Number(ws?.[address]?.v);
    return Number.isFinite(n) ? n : NaN;
  }

  function buildTemplateIndex(workbook) {
    const bySku = new Map();
    for (const [sheetName, cfg] of Object.entries(SHEET_CONFIG)) {
      const ws = workbook.Sheets[sheetName];
      if (!ws) throw new Error(`LG-Vorlage: Tabellenblatt '${sheetName}' fehlt`);
      for (let row = cfg.startRow; row <= cfg.endRow; row += 1) {
        const sku = clean(ws[`${cfg.skuCol}${row}`]?.v, 100).toUpperCase();
        if (!sku) continue;
        if (bySku.has(sku)) throw new Error(`LG-Vorlage: SKU ${sku} ist doppelt vorhanden`);
        const price = cellNumber(ws, `${cfg.priceCol}${row}`);
        if (!Number.isFinite(price)) throw new Error(`LG-Vorlage: Preis für SKU ${sku} fehlt`);
        bySku.set(sku, { sheetName, row, price: money2(price), cfg });
      }
    }
    return bySku;
  }

  function validateTemplate(workbook) {
    const required = ["Zusammenfassung", ...Object.keys(SHEET_CONFIG)];
    for (const name of required) if (!workbook.Sheets[name]) throw new Error(`Tabellenblatt '${name}' fehlt`);
    const index = buildTemplateIndex(workbook);
    if (index.size < 100) throw new Error(`Zu wenige SKU-Zeilen gefunden (${index.size})`);
    return index.size;
  }

  function normalizedZipPath(value) {
    return String(value || "").replace(/^Root Entry\/?/i, "").replace(/^\/+/, "").replace(/\\/g, "/");
  }

  function zipEntry(cfb, filePath) {
    const target = normalizedZipPath(filePath).toLowerCase();
    const paths = Array.isArray(cfb?.FullPaths) ? cfb.FullPaths : [];
    for (let i = 0; i < paths.length; i += 1) {
      if (normalizedZipPath(paths[i]).toLowerCase() === target) return cfb.FileIndex[i];
    }
    const found = CFB?.find?.(cfb, filePath) || CFB?.find?.(cfb, `/${filePath}`);
    if (found) return found;
    throw new Error(`LG-Vorlage: ZIP-Datei '${filePath}' fehlt`);
  }

  function readXml(cfb, filePath) {
    const entry = zipEntry(cfb, filePath);
    return Buffer.from(entry.content || []).toString("utf8");
  }

  function writeXml(cfb, filePath, xml) {
    const entry = zipEntry(cfb, filePath);
    const bytes = Buffer.from(xml, "utf8");
    entry.content = bytes;
    entry.size = bytes.length;
  }

  function regexEscape(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function stripCellType(attrs) {
    return String(attrs || "").replace(/\s+t="[^"]*"/g, "");
  }

  function replaceCell(xml, ref, innerXml) {
    const r = regexEscape(ref);
    const selfClosing = new RegExp(`<c\\b([^>]*\\br="${r}"[^>]*)\\s*/>`);
    if (selfClosing.test(xml)) {
      return xml.replace(selfClosing, (_all, attrs) => `<c${stripCellType(attrs)}>${innerXml}</c>`);
    }
    const paired = new RegExp(`<c\\b([^>]*\\br="${r}"[^>]*)>[\\s\\S]*?<\\/c>`);
    if (paired.test(xml)) {
      return xml.replace(paired, (_all, attrs) => `<c${stripCellType(attrs)}>${innerXml}</c>`);
    }
    throw new Error(`LG-Vorlage: Zelle ${ref} fehlt`);
  }

  function clearNumericCell(xml, ref) {
    const r = regexEscape(ref);
    const selfClosing = new RegExp(`<c\\b([^>]*\\br="${r}"[^>]*)\\s*/>`);
    if (selfClosing.test(xml)) return xml.replace(selfClosing, (_all, attrs) => `<c${stripCellType(attrs)}/>`);
    const paired = new RegExp(`<c\\b([^>]*\\br="${r}"[^>]*)>[\\s\\S]*?<\\/c>`);
    if (paired.test(xml)) return xml.replace(paired, (_all, attrs) => `<c${stripCellType(attrs)}/>`);
    throw new Error(`LG-Vorlage: Zelle ${ref} fehlt`);
  }

  function numericCell(xml, ref, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Ungültiger Zahlenwert für ${ref}`);
    return replaceCell(xml, ref, `<v>${n}</v>`);
  }

  function formulaCell(xml, ref, formula, cachedValue) {
    const f = String(formula).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return replaceCell(xml, ref, `<f>${f}</f><v>${money2(cachedValue)}</v>`);
  }

  function patchOriginalXlsx(templateBuffer, index, openItems, sheetTotals, grandTotal) {
    if (!CFB?.read || !CFB?.write) throw new Error("ZIP-Engine für originales LG-Excel ist nicht verfügbar");
    const cfb = CFB.read(templateBuffer, { type: "buffer" });
    const xmlBySheet = new Map();
    for (const [sheetName, cfg] of Object.entries(SHEET_CONFIG)) xmlBySheet.set(sheetName, readXml(cfb, cfg.xml));

    // Zuerst sämtliche Mengen leeren und die vorhandenen Zeilensummen auf 0
    // setzen. So kann auch eine später manuell gespeicherte Preislisten-Vorlage
    // niemals alte Bestellmengen in eine neue Bestellung übernehmen.
    for (const slot of index.values()) {
      let xml = xmlBySheet.get(slot.sheetName);
      const qtyRef = `${slot.cfg.qtyCol}${slot.row}`;
      const totalRef = `${slot.cfg.totalCol}${slot.row}`;
      xml = clearNumericCell(xml, qtyRef);
      xml = formulaCell(xml, totalRef, `${qtyRef}*${slot.cfg.priceCol}${slot.row}`, 0);
      xmlBySheet.set(slot.sheetName, xml);
    }

    for (const item of openItems) {
      const slot = index.get(item.stockCode);
      const qtyRef = `${slot.cfg.qtyCol}${slot.row}`;
      const totalRef = `${slot.cfg.totalCol}${slot.row}`;
      const lineTotal = money2(Number(item.quantity || 0) * Number(slot.price || 0));
      let xml = xmlBySheet.get(slot.sheetName);
      xml = numericCell(xml, qtyRef, item.quantity);
      xml = formulaCell(xml, totalRef, `${qtyRef}*${slot.cfg.priceCol}${slot.row}`, lineTotal);
      xmlBySheet.set(slot.sheetName, xml);
    }

    let bases = xmlBySheet.get("LG BASES");
    let colourants = xmlBySheet.get("COLOURANTS");
    let samples = xmlBySheet.get("LG SAMPLE POTS");
    let marketing = xmlBySheet.get("LG MARKETING");
    bases = formulaCell(bases, "G143", "SUM(G2:G142)", sheetTotals["LG BASES"] || 0);
    bases = formulaCell(bases, "G145", "G143+COLOURANTS!G18+'LG SAMPLE POTS'!F207+'LG MARKETING'!F37", grandTotal);
    colourants = formulaCell(colourants, "G18", "SUM(G2:G16)", sheetTotals.COLOURANTS || 0);
    samples = formulaCell(samples, "F207", "SUM(F2:F206)", sheetTotals["LG SAMPLE POTS"] || 0);
    marketing = formulaCell(marketing, "F37", "SUM(F2:F36)", sheetTotals["LG MARKETING"] || 0);
    xmlBySheet.set("LG BASES", bases);
    xmlBySheet.set("COLOURANTS", colourants);
    xmlBySheet.set("LG SAMPLE POTS", samples);
    xmlBySheet.set("LG MARKETING", marketing);

    let summary = readXml(cfb, SUMMARY_XML);
    summary = formulaCell(summary, "B9", "'LG BASES'!G143", sheetTotals["LG BASES"] || 0);
    summary = formulaCell(summary, "B10", "COLOURANTS!G18", sheetTotals.COLOURANTS || 0);
    summary = formulaCell(summary, "B11", "'LG SAMPLE POTS'!F207", sheetTotals["LG SAMPLE POTS"] || 0);
    summary = formulaCell(summary, "B12", "'LG MARKETING'!F37", sheetTotals["LG MARKETING"] || 0);
    summary = formulaCell(summary, "B13", "SUM(B9:B12)", grandTotal);

    for (const [sheetName, cfg] of Object.entries(SHEET_CONFIG)) writeXml(cfb, cfg.xml, xmlBySheet.get(sheetName));
    writeXml(cfb, SUMMARY_XML, summary);
    return Buffer.from(CFB.write(cfb, { type: "buffer", fileType: "zip", compression: true }));
  }

  app.get("/admin/api/paint/order-review/xlsx-template/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const meta = await readJson(templateMetaFile, null);
    res.json({ ok: true, installed: fs.existsSync(templateFile), template: meta });
  });

  app.post("/admin/api/paint/order-review/xlsx-template", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const name = clean(req.body?.name || TEMPLATE_NAME, 180);
      const base64 = String(req.body?.base64 || "").replace(/^data:.*?;base64,/, "").replace(/\s+/g, "");
      if (!base64) return res.status(400).json({ ok: false, error: "Excel-Datei fehlt" });
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length < 10000 || bytes.length > 5_000_000) return res.status(400).json({ ok: false, error: "Ungültige Excel-Dateigröße" });
      const workbook = XLSX.read(bytes, { type: "buffer", cellFormula: true, cellDates: true });
      const skuCount = validateTemplate(workbook);
      await ensureRoot();
      const tmp = `${templateFile}.tmp`;
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, templateFile);
      const meta = { name, installedAt: new Date().toISOString(), source: "manual-upload", skuCount, sheets: workbook.SheetNames };
      await writeJson(templateMetaFile, meta);
      res.json({ ok: true, installed: true, template: meta });
    } catch (error) {
      res.status(400).json({ ok: false, error: `LG-Vorlage nicht übernommen: ${String(error?.message || error)}` });
    }
  });

  app.get("/admin/api/paint/order-review/xlsx", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (!fs.existsSync(templateFile)) return res.status(428).json({ ok: false, error: "LG-Excel-Vorlage ist noch nicht hinterlegt.", needsTemplate: true });
      const order = await currentOrder();
      if (!order.openItems.length) return res.status(409).json({ ok: false, error: "Keine offenen Little-Greene-Bestellpositionen." });

      const templateBuffer = await fsp.readFile(templateFile);
      const workbook = XLSX.read(templateBuffer, { type: "buffer", cellFormula: true, cellDates: true });
      validateTemplate(workbook);
      const index = buildTemplateIndex(workbook);
      const missing = [];
      const priceMismatches = [];
      const sheetTotals = { "LG BASES": 0, COLOURANTS: 0, "LG SAMPLE POTS": 0, "LG MARKETING": 0 };
      let lgTotal = 0;

      for (const item of order.openItems) {
        const sku = clean(item.stockCode, 100).toUpperCase();
        const slot = index.get(sku);
        if (!sku || !slot) {
          missing.push({ sku: sku || "(keine SKU)", product: item.product, quantity: item.quantity });
          continue;
        }
        const kristinePrice = money2(item.purchasePrice);
        const lgPrice = money2(slot.price);
        if (Math.abs(kristinePrice - lgPrice) > 0.005) priceMismatches.push({ sku, product: item.product, kristinePrice, lgPrice });
        const lineTotal = money2(Number(item.quantity || 0) * lgPrice);
        sheetTotals[slot.sheetName] = money2(sheetTotals[slot.sheetName] + lineTotal);
        lgTotal = money2(lgTotal + lineTotal);
      }

      if (missing.length || priceMismatches.length) {
        return res.status(409).json({
          ok: false,
          error: missing.length ? "LG-Excel kann nicht erstellt werden: SKU-Zuordnung unvollständig." : "LG-Excel kann nicht erstellt werden: Bestellpreise stimmen nicht überein.",
          missing,
          priceMismatches,
          kristineTotal: order.kristineTotal,
          lgTotal,
        });
      }
      if (Math.abs(order.kristineTotal - lgTotal) > 0.005) {
        return res.status(409).json({ ok: false, error: "Preisprüfung fehlgeschlagen: KRISTINE-Gesamt und Little-Greene-Excel unterscheiden sich.", kristineTotal: order.kristineTotal, lgTotal });
      }

      const bytes = patchOriginalXlsx(templateBuffer, index, order.openItems, sheetTotals, lgTotal);
      // Nach dem Patch noch einmal parsbar prüfen. Dadurch liefern wir niemals
      // eine beschädigte Excel-Datei aus.
      const check = XLSX.read(bytes, { type: "buffer", cellFormula: true });
      if (!check?.Sheets?.Zusammenfassung || !check?.Sheets?.["LG BASES"]) throw new Error("Ausgabe-Excel konnte nicht verifiziert werden");

      const day = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=\"LittleGreene_Bestellung_${day}.xlsx\"`);
      res.setHeader("X-Kristine-Total", order.kristineTotal.toFixed(2));
      res.setHeader("X-LG-Total", lgTotal.toFixed(2));
      res.setHeader("X-Order-Positions", String(order.openPositions));
      res.setHeader("X-Order-Pieces", String(order.pieces));
      res.setHeader("X-Price-Check", "ok");
      res.send(bytes);
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintLgOrderExcel };
