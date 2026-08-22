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

  res = await call(app, "GET", "/admin/api/paint/returns/print-queue", { query: {} });
  assert.equal(res.body.jobs.length, 2);
  const printId = res.body.jobs[0].id;

  res = await call(app, "POST", "/admin/api/paint/returns/print-queue/:id/ack", { params: { id: printId }, body: { success: true } });
  assert.equal(res.body.job.status, "printed");

  res = await call(app, "GET", "/admin/api/paint/returns/print-queue", { query: {} });
  assert.equal(res.body.jobs.length, 1);

  console.log("paint-return-stock test ok");
})().catch((error) => { console.error(error); process.exit(1); });
