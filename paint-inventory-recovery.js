"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function registerPaintInventoryRecovery(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const publicDir = options.publicDir || path.join(process.cwd(), "public");
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const catalogFile = path.join(root, "lg-order-catalog.json");
  const movementsFile = path.join(root, "movements.jsonl");
  const identityFile = path.join(publicDir, "lg-ean-identity.json");
  const backupDir = path.join(root, "recovery-backups");

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
  const digits = value => clean(value, 100).replace(/\D/g, "");
  const norm = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const productKey = value => norm(value).replace(/\bemulsion\b/g, "").replace(/\bpaint\b/g, "").replace(/\s+/g, " ").trim();
  const sizeKey = value => {
    let raw = clean(value, 50).toLowerCase().replace(/,/g, ".").replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "");
    if (raw === "250ml") return "0.25l";
    if (raw === "500ml") return "0.5l";
    if (raw === "750ml") return "0.75l";
    return raw;
  };
  const baseKey = value => {
    const n = norm(value).replace(/\s+/g, "");
    if (["h", "hi", "hiwhite"].includes(n)) return "HI";
    if (["xd", "x", "extradeep"].includes(n)) return "XD";
    if (["m", "medium"].includes(n)) return "M";
    if (["d", "deep"].includes(n)) return "D";
    if (["t", "transparent"].includes(n)) return "T";
    if (["y", "yellow"].includes(n)) return "Y";
    if (["p", "pastel"].includes(n)) return "P";
    if (["w", "white", "whiteasp", "whte"].includes(n)) return "WHITE";
    return clean(value, 40).toUpperCase();
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

  async function movementStocks() {
    const result = new Map();
    let parsed = 0;
    try {
      const text = await fsp.readFile(movementsFile, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const id = clean(row.articleId, 220);
          const after = Number(row.after);
          if (!id || !Number.isFinite(after) || after < 0) continue;
          result.set(id, Math.max(0, after));
          parsed += 1;
        } catch {}
      }
    } catch {}
    return { stocks: result, parsed };
  }

  async function identityMaps() {
    const identity = await readJson(identityFile, { items: {} });
    const exact = new Map();
    const colourants = new Map();
    for (const [eanRaw, entry] of Object.entries(identity?.items || {})) {
      const ean = digits(eanRaw);
      if (!ean || !entry) continue;
      const pk = productKey(entry.product);
      const bk = baseKey(entry.baseCode);
      if (pk === "colourants" || pk === "colourant") {
        // Die alte EAN-Datei führt Colourants mit 2.5 L, der aktuelle Lagerstamm mit 1 L.
        // Es gibt je Colourant-Code nur eine Lagerposition, deshalb bewusst OHNE Gebinde matchen.
        colourants.set(bk, ean);
      } else {
        exact.set(`${pk}|${sizeKey(entry.size)}|${bk}`, ean);
      }
    }
    return { exact, colourants };
  }

  function normalizeCatalogArticle(raw, index) {
    const category = clean(raw?.category, 40).toLowerCase() || "base";
    const stockCode = clean(raw?.stockCode, 100).toUpperCase();
    const id = clean(raw?.id, 220) || (stockCode ? `LG-${stockCode}` : `LG-RECOVERY-${index + 1}`);
    const inventory = category === "base" || category === "colourant";
    return {
      id,
      manufacturer: "Little Greene",
      category,
      inventory,
      orderable: raw?.orderable !== false,
      orderSection: clean(raw?.orderSection, 40) || (category === "colourant" ? "colourants" : category === "sample-pot" ? "sample-pots" : category === "marketing" ? "marketing" : "bases"),
      product: clean(raw?.product, 180),
      baseCode: clean(raw?.baseCode, 40),
      baseName: clean(raw?.baseName || raw?.baseCode, 100),
      size: clean(raw?.size, 50),
      sizeMl: Number(raw?.sizeMl || 0),
      ean: "",
      stockCode,
      stock: 0,
      targetStock: 0,
      minimumStock: 0,
      orderQuantityOverride: null,
      purchasePrice: Number(raw?.purchasePrice || 0),
      salePrice: 0,
      orderNumber: clean(raw?.orderNumber, 60),
      productOrder: Number.isFinite(Number(raw?.productOrder)) ? Number(raw.productOrder) : 9999,
      sizeOrder: Number.isFinite(Number(raw?.sizeOrder)) ? Number(raw.sizeOrder) : 9999,
      orderIndex: Number.isFinite(Number(raw?.orderIndex)) ? Number(raw.orderIndex) : index,
      active: true,
      source: "LG clean rebuild",
      updatedAt: new Date().toISOString(),
    };
  }

  async function buildPreview() {
    const catalog = await readJson(catalogFile, {});
    const catalogRows = Array.isArray(catalog?.articles) ? catalog.articles : [];
    if (!catalogRows.length) {
      return { ok: false, error: "LG-Bestellkatalog fehlt. Bitte zuerst die offizielle Little-Greene-Bestellliste einmal über 'Import & Lernen' importieren." };
    }

    const current = await readJson(articlesFile, []);
    const currentRows = Array.isArray(current) ? current : [];
    const currentBySku = new Map(currentRows.filter(a => clean(a?.stockCode)).map(a => [clean(a.stockCode, 100).toUpperCase(), a]));
    const { stocks, parsed: movementRows } = await movementStocks();
    const { exact, colourants } = await identityMaps();

    const rebuilt = catalogRows.map(normalizeCatalogArticle);
    let stockRecovered = 0;
    let eanRecovered = 0;
    let currentFallback = 0;

    for (const article of rebuilt) {
      if (stocks.has(article.id)) {
        article.stock = stocks.get(article.id);
        stockRecovered += 1;
      } else {
        const old = currentBySku.get(article.stockCode);
        const oldStock = Number(old?.stock);
        if (Number.isFinite(oldStock) && oldStock >= 0) {
          article.stock = oldStock;
          if (oldStock !== 0) currentFallback += 1;
        }
      }

      const pk = productKey(article.product);
      const bk = baseKey(article.baseCode || article.baseName);
      const ean = (pk === "colourants" || pk === "colourant")
        ? colourants.get(bk)
        : exact.get(`${pk}|${sizeKey(article.size)}|${bk}`);
      if (ean) {
        article.ean = ean;
        eanRecovered += 1;
      } else {
        const old = currentBySku.get(article.stockCode);
        const oldEan = digits(old?.ean);
        if (oldEan) {
          article.ean = oldEan;
          eanRecovered += 1;
        }
      }
    }

    const inventoryRows = rebuilt.filter(a => a.inventory);
    const colourantRows = inventoryRows.filter(a => a.category === "colourant");
    const expectedColourants = new Set(["CY","LE","SC","GN","OC","RG","UM","AK","RO","VI","WH","MA","PR","FS","UB"]);
    const seenColourants = new Set(colourantRows.map(a => clean(a.baseCode, 20).toUpperCase()));
    const missingColourants = [...expectedColourants].filter(code => !seenColourants.has(code));
    const safe = inventoryRows.length === 145 && colourantRows.length === 15 && missingColourants.length === 0;

    return {
      ok: true,
      safe,
      rebuilt,
      counts: {
        catalog: catalogRows.length,
        inventory: inventoryRows.length,
        colourants: colourantRows.length,
        currentArticles: currentRows.length,
        movementRows,
        stockRecovered,
        currentFallback,
        eanRecovered,
      },
      missingColourants,
    };
  }

  app.get("/admin/api/paint/inventory/rebuild-preview", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const preview = await buildPreview();
      if (!preview.ok) return res.status(400).json(preview);
      res.json({ ok: true, safe: preview.safe, counts: preview.counts, missingColourants: preview.missingColourants });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/inventory/rebuild", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (String(req.body?.confirm || "") !== "RESET_LG_INVENTORY") {
      return res.status(400).json({ ok: false, error: "Bestätigung fehlt" });
    }
    try {
      const preview = await buildPreview();
      if (!preview.ok) return res.status(400).json(preview);
      if (!preview.safe) {
        return res.status(409).json({ ok: false, error: "Neuaufbau abgebrochen: erwartet werden exakt 145 Lagerpositionen und 15 Colourants.", counts: preview.counts, missingColourants: preview.missingColourants });
      }

      await fsp.mkdir(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = path.join(backupDir, `articles-before-rebuild-${stamp}.json`);
      if (fs.existsSync(articlesFile)) await fsp.copyFile(articlesFile, backup);
      await writeJson(articlesFile, preview.rebuilt);

      res.json({ ok: true, counts: preview.counts, backup, message: "LG-Lagerstamm neu aufgebaut. Mindest/Soll bleiben bewusst 0 und können neu eingegeben werden." });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintInventoryRecovery };
