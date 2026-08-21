"use strict";

const fsp = require("fs/promises");
const path = require("path");
const XLSX = require("xlsx");

function registerPaintLegacySollImport(app, options = {}) {
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
  const norm = value => clean(value)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const num = value => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const n = Number(clean(value, 60).replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };

  const sizeNorm = value => {
    const raw = clean(value, 50).toLowerCase()
      .replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "").replace(",", ".");
    if (/^250ml$|^0\.25l$/.test(raw)) return "0.25 L";
    if (/^500ml$|^0\.5l$/.test(raw)) return "0.5 L";
    if (/^750ml$|^0\.75l$/.test(raw)) return "0.75 L";
    if (/^1l$/.test(raw)) return "1 L";
    if (/^2l$/.test(raw)) return "2 L";
    if (/^2\.5l$/.test(raw)) return "2.5 L";
    if (/^4l$/.test(raw)) return "4 L";
    if (/^5l$/.test(raw)) return "5 L";
    if (/^10l$/.test(raw)) return "10 L";
    return clean(value, 50);
  };

  const codePart = value => clean(value, 80).split(/[·|]/)[0].trim();

  const baseNorm = value => {
    const raw = codePart(value);
    const n = norm(raw).replace(/\s+/g, "");
    if (["h", "hi", "hiwhite"].includes(n)) return "HI";
    if (["xd", "x", "extradeep"].includes(n)) return "XD";
    if (["m", "medium"].includes(n)) return "M";
    if (["d", "deep"].includes(n)) return "D";
    if (["t", "transparent"].includes(n)) return "T";
    if (["y", "yellow"].includes(n)) return "Y";
    if (["p", "pastel"].includes(n)) return "P";
    if (["w", "white", "whiteasp", "whte"].includes(n)) return "W";
    return clean(raw, 30).toUpperCase();
  };

  const articleKey = (product, size, base) =>
    `${norm(product)}|${sizeNorm(size)}|${baseNorm(base)}`;

  const colourantKey = (size, code) =>
    `colourants|${sizeNorm(size)}|${clean(codePart(code), 30).toUpperCase()}`;

  const keyForArticle = article => {
    if (clean(article?.category).toLowerCase() === "colourant") {
      return colourantKey(article.size, article.baseCode || article.baseName);
    }
    return articleKey(article.product, article.size, article.baseCode || article.baseName);
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

  function findHeader(rows, wanted) {
    for (let r = 0; r < Math.min(rows.length, 30); r += 1) {
      const headers = (rows[r] || []).map(x => norm(x));
      const positions = {};
      let ok = true;
      for (const [name, aliases] of Object.entries(wanted)) {
        const idx = headers.findIndex(h => aliases.some(a => h === norm(a)));
        positions[name] = idx;
        if (idx < 0) ok = false;
      }
      if (ok) return { row: r, ...positions };
    }
    return null;
  }

  function addSource(list, source) {
    const minimum = source.minimum === null ? null : Math.max(0, source.minimum);
    const target = source.target === null ? null : Math.max(0, source.target);
    if (minimum === null && target === null) return;
    list.push({
      ...source,
      sku: clean(source.sku, 100).toUpperCase(),
      product: clean(source.product, 180),
      size: sizeNorm(source.size),
      base: clean(source.base, 100),
      minimum,
      target,
    });
  }

  function parseCurrentSollSheet(workbook) {
    const sheet = workbook.Sheets["Lager-Sollwerte"];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    const h = findHeader(rows, {
      product: ["Material"],
      size: ["Gebinde"],
      base: ["Basis / Colourant", "Basis/Colourant"],
      minimum: ["Mindest"],
      target: ["Soll"],
      sku: ["SKU"],
    });
    if (!h) return [];

    const out = [];
    for (let r = h.row + 1; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const product = clean(row[h.product], 180);
      const size = clean(row[h.size], 50);
      const base = clean(row[h.base], 100);
      if (!product || !size || !base) continue;
      addSource(out, {
        source: "Lager-Sollwerte",
        row: r + 1,
        product,
        size,
        base,
        sku: row[h.sku],
        minimum: num(row[h.minimum]),
        target: num(row[h.target]),
      });
    }
    return out;
  }

  function parseQuickSollSheet(workbook) {
    const sheet = workbook.Sheets["Nur Mindest + Soll"];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    const h = findHeader(rows, {
      info: ["Kurzinfo"],
      minimum: ["Mindest"],
      target: ["Soll"],
    });
    if (!h) return [];

    const out = [];
    for (let r = h.row + 1; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const parts = clean(row[h.info], 300).split("·").map(x => x.trim()).filter(Boolean);
      if (parts.length < 3) continue;
      addSource(out, {
        source: "Nur Mindest + Soll",
        row: r + 1,
        product: parts[0],
        size: parts[1],
        base: parts[2],
        sku: "",
        minimum: num(row[h.minimum]),
        target: num(row[h.target]),
      });
    }
    return out;
  }

  function parseLegacySheet(workbook) {
    const sheet = workbook.Sheets["Lagerliste Farben"];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    const out = [];

    // Altes Mischen: B=Material, C=Gebinde, D=Basis/Colourant, M=Soll.
    // Dieser eine alte Sollwert gilt beim Erstimport zugleich als Mindest.
    for (let r = 9; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const product = clean(row[1], 180);
      const size = clean(row[2], 50);
      const base = clean(row[3], 100);
      const soll = num(row[12]);
      if (!product || !size || !base || soll === null || soll < 0) continue;
      addSource(out, {
        source: "Lagerliste Farben",
        row: r + 1,
        product,
        size,
        base,
        sku: "",
        minimum: soll,
        target: soll,
      });
    }
    return out;
  }

  app.post("/admin/api/paint/inventory/import-legacy-soll", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const base64 = clean(req.body?.base64, 120_000_000).replace(/^data:.*?;base64,/, "");
      if (!base64) return res.status(400).json({ ok: false, error: "Excel-Datei fehlt" });

      const workbook = XLSX.read(Buffer.from(base64, "base64"), {
        type: "buffer",
        cellDates: false,
      });

      let sourceRows = parseCurrentSollSheet(workbook);
      let format = "Lager-Sollwerte";
      if (!sourceRows.length) {
        sourceRows = parseQuickSollSheet(workbook);
        format = "Nur Mindest + Soll";
      }
      if (!sourceRows.length) {
        sourceRows = parseLegacySheet(workbook);
        format = "Lagerliste Farben";
      }
      if (!sourceRows.length) {
        return res.status(400).json({
          ok: false,
          error: "Keine ausgefüllten Mindest-/Sollwerte erkannt. Unterstützt: 'Lager-Sollwerte', 'Nur Mindest + Soll' oder 'Lagerliste Farben'.",
        });
      }

      const articles = await readJson(articlesFile, []);
      const articleList = Array.isArray(articles) ? articles : [];
      const bySku = new Map();
      const byKey = new Map();

      for (const article of articleList) {
        const sku = clean(article?.stockCode, 100).toUpperCase();
        if (sku) bySku.set(sku, article);
        byKey.set(keyForArticle(article), article);
      }

      let matched = 0;
      let changed = 0;
      let valuesApplied = 0;
      let colourantsMatched = 0;
      const missing = [];

      for (const src of sourceRows) {
        const isColourant = norm(src.product) === "colourants" || norm(src.product) === "colourant";
        const sourceKey = isColourant
          ? colourantKey(src.size, src.base)
          : articleKey(src.product, src.size, src.base);

        const article = (src.sku ? bySku.get(src.sku) : null) || byKey.get(sourceKey);
        if (!article) {
          missing.push({
            row: src.row,
            product: src.product,
            size: src.size,
            base: src.base,
            sku: src.sku,
          });
          continue;
        }

        matched += 1;
        if (clean(article.category).toLowerCase() === "colourant") colourantsMatched += 1;

        let touched = false;
        if (src.minimum !== null && Number(article.minimumStock ?? 0) !== Number(src.minimum)) {
          article.minimumStock = src.minimum;
          valuesApplied += 1;
          touched = true;
        }
        if (src.target !== null && Number(article.targetStock ?? 0) !== Number(src.target)) {
          article.targetStock = src.target;
          valuesApplied += 1;
          touched = true;
        }

        if (touched) {
          article.updatedAt = new Date().toISOString();
          changed += 1;
        }
      }

      // WICHTIG: stock / EAN / Bewegungen werden hier niemals verändert.
      if (changed) await writeJson(articlesFile, articleList);

      res.json({
        ok: true,
        format,
        sourceRows: sourceRows.length,
        matched,
        changed,
        valuesApplied,
        colourantsMatched,
        missing: missing.slice(0, 30),
        missingCount: missing.length,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintLegacySollImport };
