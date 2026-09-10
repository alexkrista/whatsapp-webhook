"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { registerPaintReturnStock } = require("../paint-return-stock");

function fakeApp() {
  const routes = { GET: new Map(), POST: new Map() };
  return {
    routes,
    get(route, fn) { routes.GET.set(route, fn); },
    post(route, fn) { routes.POST.set(route, fn); },
  };
}
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}
async function call(app, method, route, { body = {}, query = {}, params = {} } = {}) {
  const handler = app.routes[method].get(route);
  assert(handler, `${method} ${route} registered`);
  const res = response();
  await handler({ body, query, params, headers: {} }, res);
  return res;
}

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kristine-return-"));
  const paintDir = path.join(dataDir, "_kristine", "paint");
  await fs.mkdir(paintDir, { recursive: true });
  await fs.writeFile(path.join(paintDir, "articles.json"), JSON.stringify([
    { id: "LG-1", manufacturer: "Little Greene", product: "Intelligent Matt", baseName: "Hi White", size: "5 L", ean: "5050173000001", stockCode: "LG5001" },
  ]));

  const app = fakeApp();
  registerPaintReturnStock(app, { dataDir });

  let res = await call(app, "GET", "/admin/api/paint/returns/lookup", { query: { ean: "5050173000001" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.known, true);
  assert.equal(res.body.material.material, "Intelligent Matt");

  res = await call(app, "GET", "/admin/api/paint/returns/lookup", { query: { ean: "9001234567890" } });
  assert.equal(res.body.known, false);

  res = await call(app, "POST", "/admin/api/paint/returns/material", { body: { ean: "9001234567890", manufacturer: "Sto", material: "StoSil", size: "15 L" } });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.material.manufacturer, "Sto");

  res = await call(app, "POST", "/admin/api/paint/returns", { body: { ean: "9001234567890", colour: "StoColor 32145", weightKg: "3,4", jobId: "26083", jobName: "Muster Baustelle" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.item.returnNo, 1);
  assert.equal(res.body.item.weightKg, 3.4);
  assert.equal(res.body.item.jobId, "26083");
  assert.equal(res.body.printJob.big, "1");
  assert.match(res.body.printJob.small, /^\d{2}\.\d{2}\.\d{4}$/);

  res = await call(app, "POST", "/admin/api/paint/returns", { body: { ean: "5050173000001", colour: "Stock 37", weightKg: 1.2, jobId: "26083", jobName: "Muster Baustelle" } });
  assert.equal(res.body.item.returnNo, 2);
  assert.equal(res.body.item.manufacturer, "Little Greene");

  res = await call(app, "GET", "/admin/api/paint/returns", { query: { q: "StoSil" } });
  assert.equal(res.body.count, 1);
  assert.equal(res.body.items[0].returnNo, 1);

  res = await call(app, "GET", "/admin/api/paint/returns", { query: { q: "26083" } });
  assert.equal(res.body.count, 2);

  const archiveFile = path.join(paintDir, "returns.json");
  const queueFile = path.join(paintDir, "return-print-queue.json");
  const original = JSON.parse(await fs.readFile(archiveFile, "utf8"));
  const originalQueue = await fs.readFile(queueFile, "utf8");
  const update = (body, id = "R-1") => call(app, "POST", "/admin/api/paint/returns/:id/update", { params: { id }, body });
  const change = { weightKg: "2,125", jobId: "26099", jobName: "Andere Baustelle", revision: 0 };
  res = await update(change);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.item.weightKg, 2.125);
  assert.equal(res.body.item.revision, 1);
  assert.equal(res.body.item.history.length, 1);
  assert.deepEqual(res.body.item.history[0].before, { weightKg: 3.4, jobId: "26083", jobName: "Muster Baustelle" });
  assert.deepEqual(res.body.item.history[0].after, { weightKg: 2.125, jobId: "26099", jobName: "Andere Baustelle" });
  assert(Number.isFinite(Date.parse(res.body.item.history[0].changedAt)));
  const saved = JSON.parse(await fs.readFile(archiveFile, "utf8"));
  assert.equal(saved.length, 2);
  for (const key of ["id", "returnNo", "createdAt", "ean", "colour", "material", "status"])
    assert.equal(saved[0][key], original[0][key]);
  assert.deepEqual(saved[1], original[1]);
  assert.equal(await fs.readFile(queueFile, "utf8"), originalQueue);
  assert.equal((await update(change)).statusCode, 409);
  assert.equal((await update({ ...change, revision: 1 })).body.item.history.length, 1);
  for (const weightKg of [0, -1, 1001, "", "abc", 0.0001])
    assert.equal((await update({ ...change, revision: 1, weightKg })).statusCode, 400);
  assert.equal((await update({ ...change, jobId: "" })).statusCode, 400);
  assert.equal((await update({ ...change, revision: undefined })).statusCode, 400);
  assert.equal((await update(change, "R-missing")).statusCode, 404);
  const races = await Promise.all([
    update({ weightKg: 1, jobId: "__lager__", jobName: "Lager / keine Baustelle", revision: 1 }),
    update({ ...change, weightKg: 0.5, revision: 1 }),
  ]);
  assert.deepEqual(races.map((r) => r.statusCode).sort(), [200, 409]);
  const restartedApp = fakeApp();
  registerPaintReturnStock(restartedApp, { dataDir });
  res = await call(restartedApp, "GET", "/admin/api/paint/returns", { query: { q: "__lager__" } });
  assert.equal(res.body.items[0].history.length, 2);
  assert.equal(res.body.items[0].returnNo, 1);
  const previousToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "test-only";
  const securedApp = fakeApp();
  registerPaintReturnStock(securedApp, { dataDir });
  if (previousToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = previousToken;
  res = await call(securedApp, "POST", "/admin/api/paint/returns/:id/update", { params: { id: "R-1" }, body: change });
  assert.equal(res.statusCode, 403);

  res = await call(app, "GET", "/admin/api/paint/returns/print-queue", { query: {} });
  assert.equal(res.body.jobs.length, 2);
  const printId = res.body.jobs[0].id;

  res = await call(app, "POST", "/admin/api/paint/returns/print-queue/:id/ack", { params: { id: printId }, body: { success: true } });
  assert.equal(res.body.job.status, "printed");

  res = await call(app, "GET", "/admin/api/paint/returns/print-queue", { query: {} });
  assert.equal(res.body.jobs.length, 1);

  console.log("paint-return-stock test ok");
})().catch((error) => { console.error(error); process.exit(1); });
