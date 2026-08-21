"use strict";

const fsp = require("fs/promises");
const path = require("path");
const XLSX = require("xlsx");

function registerPaintInventoryExcel(app, options = {}) {
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
  const num = value => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const raw = clean(value, 60).replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  function isInventoryArticle(article) {
    if (!article || article.active === false || article.inventory === false) return false;
    const category = clean(article.category).toLowerCase();
    if (category) return category === "base" || category === "colourant";
    return !!clean(article.product) && !!clean(article.size) && !!clean(article.stockCode);
  }

  function labelFor(article) {
    const code = clean(article.baseCode);
    const name = clean(article.baseName || article.baseCode);
    return code && name && code.toLowerCase() !== name.toLowerCase() ? `${code} · ${name}` : (name || code);
  }

  function sortedInventory(articles) {
    return (Array.isArray(articles) ? articles : [])
      .filter(isInventoryArticle)
      .sort((a, b) => {
        const ai = Number.isFinite(Number(a.orderIndex)) ? Number(a.orderIndex) : 999999;
        const bi = Number.isFinite(Number(b.orderIndex)) ? Number(b.orderIndex) : 999999;
        return ai - bi;
      });
  }

  function makeWorkbook(articles) {
    const rows = sortedInventory(articles).map(article => ({
      Material: clean(article.product),
      Gebinde: clean(article.size),
      "Basis / Colourant": labelFor(article),
      Mindest: Math.max(0, Number(article.minimumStock || 0)),
      Soll: Math.max(0, Number(article.targetStock || 0)),
      EK: Number(article.purchasePrice || 0),
      SKU: clean(article.stockCode),
    }));

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows, {
      header: ["Material", "Gebinde", "Basis / Colourant", "Mindest", "Soll", "EK", "SKU"],
    });
    worksheet["!cols"] = [
      { wch: 27 }, { wch: 13 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 18 },
    ];
    worksheet["!autofilter"] = { ref: `A1:G${Math.max(2, rows.length + 1)}` };
    XLSX.utils.book_append_sheet(workbook, worksheet, "Lager-Sollwerte");

    const info = XLSX.utils.aoa_to_sheet([
      ["KRISTINE · LG Lager-Sollwerte"],
      ["Nur Mindest und Soll ändern. Material, Gebinde, Basis, EK und SKU dienen zur sicheren Zuordnung."],
      ["Beim Wiedereinlesen wird primär über SKU zugeordnet. Leere Mindest-/Soll-Zellen verändern den bestehenden Wert nicht."],
      ["Soll muss mindestens so groß wie Mindest sein."],
    ]);
    info["!cols"] = [{ wch: 110 }];
    XLSX.utils.book_append_sheet(workbook, info, "Hinweis");
    return workbook;
  }

  function findHeaderRow(matrix) {
    for (let i = 0; i < Math.min(matrix.length, 20); i += 1) {
      const values = (matrix[i] || []).map(value => clean(value).toLowerCase());
      if (values.includes("sku") && values.includes("mindest") && values.includes("soll")) return i;
    }
    return -1;
  }

  app.get("/admin/api/paint/inventory/levels.xlsx", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const articles = await readJson(articlesFile, []);
      const workbook = makeWorkbook(articles);
      const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=\"KRISTINE_LG_Lager_Sollwerte_${date}.xlsx\"`);
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/inventory/levels.xlsx", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const base64 = clean(req.body?.base64, 120_000_000).replace(/^data:.*?;base64,/, "");
      if (!base64) return res.status(400).json({ ok: false, error: "Excel-Datei fehlt" });

      const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer", cellDates: false });
      const sheet = workbook.Sheets["Lager-Sollwerte"] || workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) return res.status(400).json({ ok: false, error: "Kein Tabellenblatt gefunden" });
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
      const headerRow = findHeaderRow(matrix);
      if (headerRow < 0) return res.status(400).json({ ok: false, error: "Spalten SKU, Mindest und Soll nicht gefunden" });

      const headers = (matrix[headerRow] || []).map(value => clean(value).toLowerCase());
      const skuCol = headers.indexOf("sku");
      const minCol = headers.indexOf("mindest");
      const targetCol = headers.indexOf("soll");

      const articles = await readJson(articlesFile, []);
      const bySku = new Map(articles.filter(a => clean(a.stockCode)).map(a => [clean(a.stockCode).toUpperCase(), a]));
      const parsed = [];
      const unknown = [];
      const invalid = [];

      for (let i = headerRow + 1; i < matrix.length; i += 1) {
        const row = matrix[i] || [];
        const sku = clean(row[skuCol]).toUpperCase();
        if (!sku) continue;
        const article = bySku.get(sku);
        if (!article) { unknown.push({ row: i + 1, sku }); continue; }

        const minimum = num(row[minCol]);
        const target = num(row[targetCol]);
        if (minimum === null && target === null) continue;
        if ((minimum !== null && minimum < 0) || (target !== null && target < 0)) {
          invalid.push({ row: i + 1, sku, reason: "negative Zahl" });
          continue;
        }
        const nextMinimum = minimum === null ? Math.max(0, Number(article.minimumStock || 0)) : minimum;
        const nextTarget = target === null ? Math.max(0, Number(article.targetStock || 0)) : target;
        if (nextTarget < nextMinimum) {
          invalid.push({ row: i + 1, sku, reason: "Soll kleiner als Mindest" });
          continue;
        }
        parsed.push({ article, sku, minimum, target });
      }

      if (unknown.length || invalid.length) {
        return res.status(409).json({
          ok: false,
          error: "Excel wurde nicht übernommen. Bitte die markierten Zeilen korrigieren.",
          unknown: unknown.slice(0, 30),
          invalid: invalid.slice(0, 30),
          unknownCount: unknown.length,
          invalidCount: invalid.length,
        });
      }

      let changed = 0;
      const changes = [];
      for (const item of parsed) {
        const article = item.article;
        let touched = false;
        if (item.minimum !== null) {
          const value = Math.round(item.minimum * 1000) / 1000;
          if (Number(article.minimumStock || 0) !== value) { article.minimumStock = value; touched = true; }
        }
        if (item.target !== null) {
          const value = Math.round(item.target * 1000) / 1000;
          if (Number(article.targetStock || 0) !== value) { article.targetStock = value; touched = true; }
        }
        if (touched) {
          article.updatedAt = new Date().toISOString();
          changed += 1;
        }
        changes.push({
          articleId: article.id || "",
          sku: item.sku,
          minimumStock: Math.max(0, Number(article.minimumStock || 0)),
          targetStock: Math.max(0, Number(article.targetStock || 0)),
          changed: touched,
        });
      }

      if (changed) await writeJson(articlesFile, articles);
      res.json({ ok: true, changed, read: parsed.length, changes });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintInventoryExcel };
