"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const VERSION = 1;
const signature = collection => JSON.stringify([collection.id, collection.updatedAt, [...collection.memberJobIds].sort()]);

function registerCollectionViewCache(app, { dataDir, requireAdmin, collectionStore }) {
  const pending = new Map();
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  async function locate(req) {
    const id = String(req.params.collectionId || "");
    if (!/^S[A-Za-z0-9_-]+$/.test(id)) throw fail("Ungültige Sammelmappe.");
    const collection = await collectionStore.get(id);
    if (!collection) throw fail("Sammelmappe nicht gefunden.", 404);
    return { collection, file: path.join(dataDir, "_system", "collection-views", id + ".json") };
  }
  async function read(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
  app.get("/admin/api/sammelmappe/:collectionId/view-cache", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { collection, file } = await locate(req), snapshot = await read(file);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, snapshot: snapshot?.version === VERSION && snapshot.signature === signature(collection) ? snapshot : null });
    } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message }); }
  });
  app.put("/admin/api/sammelmappe/:collectionId/view-cache", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { collection, file } = await locate(req), view = req.body?.view;
      const expected = [...collection.memberJobIds].sort();
      const sameIds = rows => Array.isArray(rows) && JSON.stringify(rows.map(row => String(row.jobId)).sort()) === JSON.stringify(expected);
      if (req.body?.version !== VERSION || view?.collection?.jobId !== collection.id || view.collection.registryUpdatedAt !== collection.updatedAt || !sameIds(view.jobs) || !sameIds(view.data?.rows) || !sameIds(view.hours?.memberHours)) throw fail("Zusammensetzung der Sammelmappe hat sich geändert.", 409);
      if (!view.hours.complete || view.data.billing?.partial || !view.bookingsReady || view.bookingFailures || view.data.rows.some(row => !Array.isArray(row.errors) || row.errors.length || [...(row.regieSources || []), ...(row.billingSources || [])].some(source => source.error || source.data?.cached || source.data?.saved === false))) throw fail("Ein unvollständiger Abgleich ersetzt den gespeicherten Stand nicht.");
      if (!Number.isFinite(view.hours.total) || !Number.isFinite(view.hours.target) || !Number.isFinite(Date.parse(req.body.startedAt))) throw fail("Ungültiger Zahlenstand.");
      const total = view.hours.memberHours.reduce((sum, row) => sum + Number(row.total), 0);
      if (!Number.isFinite(total) || Math.abs(total - view.hours.total) > .02) throw fail("Stundensumme ist nicht vollständig.");
      const snapshot = { version: VERSION, signature: signature(collection), startedAt: req.body.startedAt, savedAt: new Date().toISOString(), view };
      const body = JSON.stringify(snapshot);
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw fail("Gespeicherter Stand ist zu groß.", 413);
      // Serialize competing viewers and reject an older scan that finishes late.
      const work = (pending.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
        if (signature(await collectionStore.get(collection.id) || { memberJobIds: [] }) !== snapshot.signature) throw fail("Zusammensetzung wurde inzwischen geändert.", 409);
        const previous = await read(file);
        if (previous?.signature === snapshot.signature && previous.startedAt > snapshot.startedAt) return previous;
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temp = file + "." + crypto.randomUUID() + ".tmp";
        try { await fs.writeFile(temp, body); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
        return snapshot;
      });
      pending.set(file, work);
      try { const saved = await work; res.json({ ok: true, stored: saved === snapshot, savedAt: saved.savedAt }); }
      finally { if (pending.get(file) === work) pending.delete(file); }
    } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message }); }
  });
}
module.exports = { registerCollectionViewCache };
