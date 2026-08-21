"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

function registerPaintOrderReview(app, options = {}) {
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
    // KRISTA-Regel: Sobald IST den Mindestbestand ERREICHT (oder darunter liegt),
    // wird bis zum Sollbestand aufgefüllt.
    return stock <= minimum ? Math.max(0, Math.ceil(target - stock)) : 0;
  }

  function effectiveQuantity(article) {
    const manual = nullableNonNegative(article?.orderQuantityOverride);
    return manual === null ? suggestion(article) : manual;
  }

  function publicRow(article) {
    const suggestedQuantity = suggestion(article);
    const manualQuantity = nullableNonNegative(article?.orderQuantityOverride);
    const quantity = manualQuantity === null ? suggestedQuantity : manualQuantity;
    const purchasePrice = Math.max(0, Number(article?.purchasePrice || 0));
    return {
      articleId: clean(article?.id, 220),
      category: clean(article?.category, 40),
      product: clean(article?.product, 180),
      size: clean(article?.size, 50),
      baseCode: clean(article?.baseCode, 40),
      baseName: clean(article?.baseName || article?.baseCode, 100),
      stockCode: clean(article?.stockCode, 100),
      ean: clean(article?.ean, 100),
      stock: Math.max(0, Number(article?.stock || 0)),
      minimumStock: Math.max(0, Number(article?.minimumStock || 0)),
      targetStock: Math.max(0, Number(article?.targetStock || 0)),
      suggestedQuantity,
      manualQuantity,
      orderManual: manualQuantity !== null,
      quantity,
      purchasePrice,
      lineTotal: Number((quantity * purchasePrice).toFixed(2)),
      orderIndex: Number.isFinite(Number(article?.orderIndex)) ? Number(article.orderIndex) : 999999,
    };
  }

  async function summary() {
    const articles = await readJson(articlesFile, []);
    const items = (Array.isArray(articles) ? articles : [])
      .filter(article => article && article.active !== false && article.orderable !== false && isLittleGreene(article))
      .map(publicRow)
      .sort((a, b) => a.orderIndex - b.orderIndex || a.product.localeCompare(b.product, "de"));
    const openItems = items.filter(item => item.quantity > 0);
    return {
      items,
      openItems,
      openPositions: openItems.length,
      pieces: openItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
      total: Number(openItems.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0).toFixed(2)),
      rule: "IST <= Mindest => bis Soll auffuellen",
    };
  }

  app.get("/admin/api/paint/order-review", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ ok: true, ...(await summary()) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/order-review", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const changes = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 500) : [];
      if (!changes.length) return res.json({ ok: true, changed: 0, ...(await summary()) });
      const articles = await readJson(articlesFile, []);
      const byId = new Map((Array.isArray(articles) ? articles : []).map(article => [String(article?.id || ""), article]));
      let changed = 0;
      for (const change of changes) {
        const article = byId.get(String(change?.articleId || ""));
        if (!article || !isLittleGreene(article)) continue;
        const next = String(change?.mode || "manual").toLowerCase() === "auto"
          ? null
          : nullableNonNegative(change?.quantity);
        if (String(change?.mode || "manual").toLowerCase() !== "auto" && next === null) continue;
        const before = nullableNonNegative(article.orderQuantityOverride);
        if (before === next) continue;
        article.orderQuantityOverride = next;
        article.updatedAt = new Date().toISOString();
        changed += 1;
      }
      if (changed) await writeJson(articlesFile, articles);
      res.json({ ok: true, changed, ...(await summary()) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/paint/order-review/pdf", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await summary();
      const rows = data.openItems;
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const pageW = 841.89;
      const pageH = 595.28;
      const margin = 28;
      const rowHeight = 17;
      const rowsPerPage = 25;
      const chunks = [];
      for (let i = 0; i < rows.length; i += rowsPerPage) chunks.push(rows.slice(i, i + rowsPerPage));
      if (!chunks.length) chunks.push([]);

      const text = value => clean(value, 300).replace(/[\u2010-\u2015]/g, "-");
      const euro = value => `EUR ${Number(value || 0).toFixed(2)}`;
      const columns = [
        ["Stk", margin, 26], ["SKU", margin + 30, 86], ["Material", margin + 120, 155],
        ["Gebinde", margin + 280, 58], ["Basis", margin + 342, 90], ["IST", margin + 436, 32],
        ["Min", margin + 472, 32], ["Soll", margin + 508, 35], ["EK", margin + 548, 68], ["Summe", margin + 620, 90],
      ];

      chunks.forEach((chunk, pageIndex) => {
        const page = pdf.addPage([pageW, pageH]);
        let y = pageH - margin;
        page.drawText("LITTLE GREENE · BESTELLUNG / PRUEFLISTE", { x: margin, y, size: 15, font: bold, color: rgb(0.12, 0.28, 0.2) });
        page.drawText(new Date().toLocaleDateString("de-AT"), { x: pageW - margin - 70, y: y + 1, size: 9, font });
        y -= 23;
        page.drawText("Regel: IST <= Mindest -> bis Soll auffuellen", { x: margin, y, size: 8.5, font });
        y -= 19;
        columns.forEach(([label, x]) => page.drawText(label, { x, y, size: 8, font: bold }));
        y -= 8;
        page.drawLine({ start: { x: margin, y }, end: { x: pageW - margin, y }, thickness: 0.7, color: rgb(0.65, 0.65, 0.62) });
        y -= 13;
        chunk.forEach(item => {
          const values = [
            String(item.quantity), text(item.stockCode).slice(0, 15), text(item.product).slice(0, 28), text(item.size).slice(0, 9),
            text(item.baseName || item.baseCode).slice(0, 15), String(item.stock), String(item.minimumStock), String(item.targetStock),
            euro(item.purchasePrice), euro(item.lineTotal),
          ];
          columns.forEach(([, x, width], index) => {
            const maxChars = Math.max(3, Math.floor(width / 5));
            page.drawText(values[index].slice(0, maxChars), { x, y, size: 7.6, font });
          });
          y -= rowHeight;
        });
        page.drawLine({ start: { x: margin, y: 42 }, end: { x: pageW - margin, y: 42 }, thickness: 0.7, color: rgb(0.7, 0.7, 0.68) });
        page.drawText(`${data.openPositions} Positionen · ${data.pieces} Stk · Gesamt netto ${euro(data.total)}`, { x: margin, y: 26, size: 9.5, font: bold });
        page.drawText(`Seite ${pageIndex + 1}/${chunks.length}`, { x: pageW - margin - 55, y: 26, size: 8, font });
      });

      const bytes = await pdf.save();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=\"LittleGreene_Bestellung_Pruefliste_${new Date().toISOString().slice(0, 10)}.pdf\"`);
      res.send(Buffer.from(bytes));
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintOrderReview };
