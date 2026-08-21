"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function registerPaintStockBackupRecovery(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
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
  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  async function latestRebuildBackup() {
    try {
      const names = (await fsp.readdir(backupDir))
        .filter(name => /^articles-before-rebuild-.*\.json$/i.test(name))
        .sort()
        .reverse();
      if (!names.length) return null;
      const file = path.join(backupDir, names[0]);
      return { file, name: names[0], rows: await readJson(file, []) };
    } catch { return null; }
  }

  async function buildPreview() {
    const backup = await latestRebuildBackup();
    if (!backup) return { ok: false, error: "Kein Backup vor dem LG-Neuaufbau gefunden." };
    const current = await readJson(articlesFile, []);
    const currentRows = Array.isArray(current) ? current : [];
    const backupRows = Array.isArray(backup.rows) ? backup.rows : [];
    const oldBySku = new Map(
      backupRows
        .filter(row => clean(row?.stockCode))
        .map(row => [clean(row.stockCode, 100).toUpperCase(), row])
    );

    const changes = [];
    let matched = 0;
    let backupNonZero = 0;
    for (const article of currentRows) {
      const sku = clean(article?.stockCode, 100).toUpperCase();
      if (!sku) continue;
      const old = oldBySku.get(sku);
      if (!old) continue;
      const oldStock = Number(old.stock);
      if (!Number.isFinite(oldStock) || oldStock < 0) continue;
      matched += 1;
      if (oldStock > 0) backupNonZero += 1;
      const currentStock = Math.max(0, Number(article.stock || 0));
      if (currentStock !== oldStock) {
        changes.push({
          articleId: clean(article.id, 220), sku,
          product: clean(article.product, 180), size: clean(article.size, 50),
          baseCode: clean(article.baseCode, 40), baseName: clean(article.baseName || article.baseCode, 100),
          currentStock, backupStock: oldStock,
        });
      }
    }

    return {
      ok: true,
      safe: matched >= 100,
      backupName: backup.name,
      matched,
      backupNonZero,
      changed: changes.length,
      currentNonZero: currentRows.filter(row => Number(row?.stock || 0) > 0).length,
      preview: changes.slice(0, 30),
      changes,
      currentRows,
    };
  }

  app.get("/admin/api/paint/inventory/stock-backup-preview", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const p = await buildPreview();
      if (!p.ok) return res.status(404).json(p);
      res.json({
        ok: true, safe: p.safe, backupName: p.backupName, matched: p.matched,
        backupNonZero: p.backupNonZero, changed: p.changed, currentNonZero: p.currentNonZero,
        preview: p.preview,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/paint/inventory/stock-backup-restore", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (String(req.body?.confirm || "") !== "RESTORE_STOCK_ONLY") {
      return res.status(400).json({ ok: false, error: "Bestätigung fehlt" });
    }
    try {
      const p = await buildPreview();
      if (!p.ok) return res.status(404).json(p);
      if (!p.safe) return res.status(409).json({ ok: false, error: `Restore abgebrochen: nur ${p.matched} Artikel per SKU eindeutig gefunden.` });

      await fsp.mkdir(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const beforeRestore = path.join(backupDir, `articles-before-stock-restore-${stamp}.json`);
      if (fs.existsSync(articlesFile)) await fsp.copyFile(articlesFile, beforeRestore);

      const byId = new Map(p.currentRows.map(row => [String(row?.id || ""), row]));
      let restored = 0;
      for (const change of p.changes) {
        const article = byId.get(String(change.articleId || ""));
        if (!article) continue;
        article.stock = change.backupStock;
        article.updatedAt = new Date().toISOString();
        restored += 1;
      }
      if (restored) await writeJson(articlesFile, p.currentRows);
      res.json({
        ok: true, restored, backupSource: p.backupName, safetyBackup: path.basename(beforeRestore),
        message: "Nur IST-Bestaende wurden aus dem Backup wiederhergestellt.",
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });
}

module.exports = { registerPaintStockBackupRecovery };
