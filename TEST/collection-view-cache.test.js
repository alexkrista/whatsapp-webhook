"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { registerCollectionViewCache } = require("../collection-view-cache");
test("saved views require admin access, retain the newest full scan and expire after membership changes", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "collection-view-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let collection = { id: "S24177", updatedAt: "2026-09-13T12:00:00Z", memberJobIds: ["24177", "26018"] };
  const routes = {};
  registerCollectionViewCache({ get: (url, fn) => routes.GET = fn, put: (url, fn) => routes.PUT = fn }, { dataDir, collectionStore: { get: async id => id === collection?.id ? collection : null }, requireAdmin: (req, res) => { if (req.allowed) return true; res.status(403).json({ ok: false }); return false; } });
  const ids = collection.memberJobIds;
  const view = { collection: { jobId: collection.id, registryUpdatedAt: collection.updatedAt }, jobs: ids.map(jobId => ({ jobId })), data: { rows: ids.map(jobId => ({ jobId, errors: [], regieSources: [], billingSources: [] })), billing: { partial: false } }, hours: { total: 10, target: 20, complete: true, memberHours: ids.map(jobId => ({ jobId, total: 5 })) }, bookingsReady: true, bookingFailures: 0 };
  async function call(method, { allowed = true, body = {}, id = "S24177" } = {}) { const res = { code: 200, status(code) { this.code = code; return this; }, setHeader() {}, json(value) { this.body = value; } }; await routes[method]({ allowed, body, params: { collectionId: id } }, res); return res; }
  assert.equal((await call("GET", { allowed: false })).code, 403);
  assert.equal((await call("GET", { id: "../24177" })).code, 400);
  const body = { version: 1, startedAt: "2026-09-13T14:00:00Z", view };
  assert.equal((await call("PUT", { body })).body.stored, true);
  assert.equal((await call("GET")).body.snapshot.view.hours.total, 10);
  assert.equal((await call("PUT", { body: { ...body, startedAt: "2026-09-13T13:00:00Z" } })).body.stored, false);
  assert.equal((await call("PUT", { body: { ...body, view: { ...view, hours: { ...view.hours, complete: false } } } })).code, 400);
  assert.equal((await call("PUT", { body: { ...body, view: { ...view, hours: { ...view.hours, total: 11 } } } })).code, 400);
  assert.equal((await call("GET")).body.snapshot.startedAt, body.startedAt);
  collection = { ...collection, updatedAt: "2026-09-13T15:00:00Z", memberJobIds: ["24177"] };
  assert.equal((await call("GET")).body.snapshot, null);
  assert.equal((await call("PUT", { body })).code, 409);
  collection = null;
  assert.equal((await call("GET")).code, 404);
  assert.deepEqual(await fs.readdir(dataDir), ["_system"]);
});
