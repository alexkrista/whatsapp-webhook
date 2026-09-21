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

function intakeStorage(dataDir) {
  const root = path.join(dataDir, "_kristine", "invoice-intake");
  return { root, items:path.join(root, "items"), files:path.join(root, "files") };
}

async function readAllInvoiceItems(dataDir) {
  const storage = intakeStorage(dataDir);
  await Promise.all([fsp.mkdir(storage.items, { recursive:true }), fsp.mkdir(storage.files, { recursive:true })]);
  const rows = [];
  for (const name of (await fsp.readdir(storage.items)).filter(name => name.endsWith(".json"))) {
    try { rows.push(JSON.parse(await fsp.readFile(path.join(storage.items, name), "utf8"))); } catch {}
  }
  rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return rows;
}

async function importInvoiceBuffer({ dataDir, buffer, name, mimeType, submittedById="", submittedByName="Unbekannt", source="Eingang", capturedAt="", paymentContext="", note="" }) {
  const filename = safeFilename(name);
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error("Bitte PDF oder Foto verwenden.");
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Datei ist leer");
  if (buffer.length > MAX_FILE_BYTES) throw new Error("Datei ist größer als 12 MB");

  const storage = intakeStorage(dataDir);
  const fileSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const duplicate = (await readAllInvoiceItems(dataDir)).find(
    row => String(row.fileSha256 || "") === fileSha256 && String(row.status || "") !== "deleted"
  );
  if (duplicate) return { item:duplicate, duplicate:true };

  const id = `invoice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(storage.files, id);
  await fsp.mkdir(dir, { recursive:true });
  await fsp.writeFile(path.join(dir, filename), buffer);
  const now = new Date().toISOString();
  const item = {
    id,
    name:filename,
    storedFilename:filename,
    mimeType:cleanText(mimeType || "application/octet-stream", 160),
    size:buffer.length,
    fileSha256,
    route:"invoice",
    status:"queued",
    source:cleanText(source || "Eingang", 80),
    submittedById:cleanText(submittedById, 160),
    submittedByName:cleanText(submittedByName || "Unbekannt", 160),
    capturedAt:cleanText(capturedAt || now, 60),
    paymentContext:cleanText(paymentContext, 80),
    note:cleanText(note, 500),
    createdAt:now,
    updatedAt:now,
    processedAt:"",
    processedBy:"",
    processedDocId:"",
  };
  await fsp.mkdir(storage.items, { recursive:true });
  await fsp.writeFile(path.join(storage.items, `${safeId(id)}.json`), JSON.stringify(item, null, 2), "utf8");
  return { item, duplicate:false };
}

async function importInvoiceAttachmentsFromInbox({ dataDir, item }) {
  const inboxFiles = path.join(dataDir, "_kristine", "inbox", "files", safeId(item?.id));
  const attachments = Array.isArray(item?.mail?.attachments) ? item.mail.attachments : [];
  const imported = [];
  for (const attachment of attachments) {
    const filename = safeFilename(attachment?.name || attachment?.storedFilename);
    if (!ALLOWED_EXT.has(path.extname(filename).toLowerCase()) || attachment?.isInline) continue;
    const stored = path.join(inboxFiles, safeFilename(attachment.storedFilename || attachment.name));
    const buffer = await fsp.readFile(stored);
    const result = await importInvoiceBuffer({
      dataDir,
      buffer,
      name:filename,
      mimeType:attachment.mimeType,
      submittedById:item?.mail?.senderEmail || "",
      submittedByName:item?.mail?.senderName || item?.mail?.senderEmail || "E-Mail",
      source:"E-Mail · rechnung@krista.at",
      capturedAt:item?.mail?.receivedAt || item?.source?.receivedAt || item?.createdAt,
      note:item?.mail?.subject || item?.analysis?.subject || "",
    });
    imported.push(result);
  }
  return imported;
}

async function backfillInvoiceInbox(dataDir) {
  const inboxItems = path.join(dataDir, "_kristine", "inbox", "items");
  const names = await fsp.readdir(inboxItems).catch(() => []);
  let linked = 0;
  let files = 0;
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const filename = path.join(inboxItems, name);
    let item;
    try { item = JSON.parse(await fsp.readFile(filename, "utf8")); } catch { continue; }
    if (["dismissed", "deleted"].includes(String(item.status || ""))) continue;
    if (item.route && item.route !== "invoice") continue;
    const sentToInvoiceMailbox = (item.mail?.to || []).some(recipient =>
      String(recipient?.email || "").trim().toLowerCase() === "rechnung@krista.at"
    );
    if (!sentToInvoiceMailbox && item.analysis?.recommended !== "invoice") continue;
    const imported = await importInvoiceAttachmentsFromInbox({ dataDir, item }).catch(() => []);
    if (!imported.length) continue;
    item.links = item.links || { taskIds:[], jobIds:[] };
    item.links.invoiceIntakeIds = [...new Set(imported.map(entry => entry.item?.id).filter(Boolean))];
    item.route = "invoice";
    item.status = "linked";
    item.updatedAt = new Date().toISOString();
    await fsp.writeFile(filename, JSON.stringify(item, null, 2), "utf8");
    linked += 1;
    files += imported.filter(entry => !entry.duplicate).length;
  }
  return { linked, files };
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
      const base64 = String(req.body?.data || "").replace(/^data:[^;]+;base64,/, "");
      if (!base64) return res.status(400).json({ ok: false, error: "Datei fehlt" });
      const buffer = Buffer.from(base64, "base64");
      const result = await importInvoiceBuffer({
        dataDir,
        buffer,
        name:req.body?.name,
        mimeType:req.body?.type,
        submittedById:req.body?.submittedById,
        submittedByName:req.body?.submittedByName,
        source:req.body?.source,
        capturedAt:req.body?.capturedAt,
        paymentContext:req.body?.paymentContext,
        note:req.body?.note,
      });
      res.json({ ok:true, ...result });
    } catch (error) {
      const message = String(error?.message || error);
      res.status(/Bitte PDF|Datei ist/.test(message) ? 400 : 500).json({ ok:false, error:message });
    }
  });

  app.get("/kristine/api/invoice-intake", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const includeProcessed = ["1", "true", "yes", "ja"].includes(String(req.query?.includeProcessed || "").toLowerCase());
      let rows = await allItems();
      if (!includeProcessed) rows = rows.filter(row => !["processed", "deleted"].includes(String(row.status || "queued")));
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

  app.delete("/kristine/api/invoice-intake/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const item = await readItem(req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: "Rechnungseingang nicht gefunden" });
      const reason = cleanText(req.body?.reason, 500);
      if (reason.length < 3) return res.status(400).json({ ok: false, error: "Bitte einen kurzen Löschgrund angeben." });
      item.status = "deleted";
      item.deletedAt = new Date().toISOString();
      item.deletedBy = cleanText(req.body?.deletedBy || "Dunja", 160);
      item.deleteReason = reason;
      item.updatedAt = item.deletedAt;
      await writeItem(item);
      res.json({ ok: true, archived: true, filesPreserved: true, item });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  console.log("✅ KRISTINE Rechnungseingang registriert · PDF/Foto · Personen-/Zeitstempel");
  const backfill = setTimeout(() => backfillInvoiceInbox(dataDir).then(result => {
    if (result.linked) console.log(`✅ KRISTINE Rechnungseingang: ${result.linked} bestehende Rechnungs-Mail(s) verbunden`);
  }).catch(error => console.warn("⚠️ Rechnungsmail-Nachlauf:", String(error?.message || error))), 1000);
  backfill.unref?.();
}

module.exports = { registerKristineInvoiceIntake, importInvoiceBuffer, importInvoiceAttachmentsFromInbox, backfillInvoiceInbox };
