"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const ALLOWED_EXT = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);

function safeFilename(value) {
  const name = path.basename(String(value || "Rechnung")).replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_").trim();
  return (name || "Rechnung").slice(0, 180);
}

function safeId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 180);
}

function cleanText(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function registerKristineInvoiceIntake(app, { dataDir, requireAdmin }) {
  const ROOT = path.join(dataDir, "_kristine", "invoice-intake");
  const ITEMS = path.join(ROOT, "items");
  const FILES = path.join(ROOT, "files");

  async function ensure() {
    await Promise.all([
      fsp.mkdir(ITEMS, { recursive: true }),
      fsp.mkdir(FILES, { recursive: true }),
    ]);
  }

  function itemPath(id) {
    return path.join(ITEMS, `${safeId(id)}.json`);
  }

  async function readItem(id) {
    try { return JSON.parse(await fsp.readFile(itemPath(id), "utf8")); }
    catch { return null; }
  }

  async function writeItem(item) {
    await ensure();
    await fsp.writeFile(itemPath(item.id), JSON.stringify(item, null, 2), "utf8");
  }

  function storedFile(item) {
    return path.join(FILES, safeId(item.id), safeFilename(item.storedFilename || item.name));
  }

  async function allItems() {
    await ensure();
    const names = (await fsp.readdir(ITEMS)).filter(name => name.endsWith(".json"));
    const rows = [];
    for (const name of names) {
      try { rows.push(JSON.parse(await fsp.readFile(path.join(ITEMS, name), "utf8"))); }
      catch {}
    }
    rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return rows;
  }

  async function existingByHash(hash) {
    if (!hash) return null;
    const rows = await allItems();
    return rows.find(row => String(row.fileSha256 || "") === hash && String(row.status || "") !== "deleted") || null;
  }

  app.post("/kristine/api/invoice-intake/import", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const name = safeFilename(req.body?.name);
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        return res.status(400).json({ ok: false, error: "Bitte PDF oder Foto verwenden." });
      }

      const mimeType = cleanText(req.body?.type || "application/octet-stream", 160);
      const base64 = String(req.body?.data || "").replace(/^data:[^;]+;base64,/, "");
      if (!base64) return res.status(400).json({ ok: false, error: "Datei fehlt" });
      const buffer = Buffer.from(base64, "base64");
      if (!buffer.length) return res.status(400).json({ ok: false, error: "Datei ist leer" });
      if (buffer.length > MAX_FILE_BYTES) return res.status(413).json({ ok: false, error: "Datei ist größer als 12 MB" });

      const fileSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      const duplicate = await existingByHash(fileSha256);
      if (duplicate) return res.json({ ok: true, duplicate: true, item: duplicate });

      await ensure();
      const id = `invoice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const dir = path.join(FILES, id);
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      await fsp.writeFile(file, buffer);

      const now = new Date().toISOString();
      const submittedById = cleanText(req.body?.submittedById, 160);
      const submittedByName = cleanText(req.body?.submittedByName || "Unbekannt", 160);
      const source = cleanText(req.body?.source || "Eingang", 80);
      const capturedAt = cleanText(req.body?.capturedAt || now, 60);
      const paymentContext = cleanText(req.body?.paymentContext, 80);
      const note = cleanText(req.body?.note, 500);

      const item = {
        id,
        name,
        storedFilename: name,
        mimeType,
        size: buffer.length,
        fileSha256,
        route: "invoice",
        status: "queued",
        source,
        submittedById,
        submittedByName,
        capturedAt,
        paymentContext,
        note,
        createdAt: now,
        updatedAt: now,
        processedAt: "",
        processedBy: "",
        processedDocId: "",
      };
      await writeItem(item);
      res.json({ ok: true, duplicate: false, item });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/invoice-intake", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const includeProcessed = ["1", "true", "yes", "ja"].includes(String(req.query?.includeProcessed || "").toLowerCase());
      let rows = await allItems();
      if (!includeProcessed) rows = rows.filter(row => String(row.status || "queued") !== "processed");
      res.json({ ok: true, count: rows.length, items: rows.slice(0, 250) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/invoice-intake/:id/file", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const item = await readItem(req.params.id);
    if (!item) return res.status(404).send("Rechnungseingang nicht gefunden");
    const file = storedFile(item);
    if (!fs.existsSync(file)) return res.status(404).send("Originaldatei fehlt");
    res.setHeader("Content-Type", item.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(item.name || "Rechnung")}`);
    res.sendFile(file);
  });

  app.post("/kristine/api/invoice-intake/:id/complete", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const item = await readItem(req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: "Rechnungseingang nicht gefunden" });
      item.status = "processed";
      item.processedAt = new Date().toISOString();
      item.processedBy = cleanText(req.body?.processedBy || "Dunja", 160);
      item.processedDocId = cleanText(req.body?.processedDocId, 160);
      item.updatedAt = item.processedAt;
      await writeItem(item);
      res.json({ ok: true, item });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/invoice-intake/:id/reopen", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const item = await readItem(req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: "Rechnungseingang nicht gefunden" });
      item.status = "queued";
      item.processedAt = "";
      item.processedBy = "";
      item.processedDocId = "";
      item.updatedAt = new Date().toISOString();
      await writeItem(item);
      res.json({ ok: true, item });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  console.log("✅ KRISTINE Rechnungseingang registriert · PDF/Foto · Personen-/Zeitstempel");
}

module.exports = { registerKristineInvoiceIntake };
