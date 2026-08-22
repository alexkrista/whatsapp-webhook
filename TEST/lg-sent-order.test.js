"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");
const { registerPaintLgSentOrder } = require("../paint-lg-sent-order");

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
function workbookBase64() {
  const wb = XLSX.utils.book_new();
  const bases = [
    ["PRODUCT", "SIZE", "BASE", "SKU", "QUANTITY", "Price", "Total"],
    ["Intelligent Matt", "5 L", "Hi White", "021701HHHHH", 3, 74.8, 224.4],
    ["Absolute Matt", "1 L", "Yellow", "020603YYYYY", 1, 19.41, 19.41],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bases), "LG BASES");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["PRODUCT", "", "", "SKU", "QUANTITY", "Price"]]), "COLOURANTS");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["PRODUCT", "", "SKU", "QUANTITY", "Price"]]), "LG SAMPLE POTS");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["PRODUCT", "", "SKU", "QUANTITY", "Price"]]), "LG MARKETING");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64");
}

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kristine-sent-order-"));
  const paintDir = path.join(dataDir, "_kristine", "paint");
  await fs.mkdir(paintDir, { recursive: true });
  await fs.writeFile(path.join(paintDir, "articles.json"), JSON.stringify([
    { id: "LG-A", manufacturer: "Little Greene", product: "Intelligent Matt", baseName: "Hi White", size: "5 L", stockCode: "021701HHHHH", stock: 4, minimumStock: 4, targetStock: 6, purchasePrice: 74.8, active: true },
    { id: "LG-B", manufacturer: "Little Greene", product: "Absolute Matt", baseName: "Yellow", size: "1 L", stockCode: "020603YYYYY", stock: 1, minimumStock: 1, targetStock: 2, purchasePrice: 19.41, active: true },
  ]));

  const app = fakeApp();
  registerPaintLgSentOrder(app, { dataDir });

  let res = await call(app, "POST", "/admin/api/paint/sent-orders/unchanged");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.positionCount, 2);
  assert.equal(res.body.order.pieces, 3);

  res = await call(app, "POST", "/admin/api/paint/sent-orders/import", { body: { fileName: "gesendet.xlsx", base64: workbookBase64() } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.positionCount, 2);
  assert.equal(res.body.order.pieces, 4);
  assert.equal(res.body.order.quantityChanges.length, 1);
  assert.equal(res.body.order.quantityChanges[0].sku, "021701HHHHH");
  assert.equal(res.body.order.quantityChanges[0].before, 2);
  assert.equal(res.body.order.quantityChanges[0].after, 3);
  assert.equal(res.body.order.priceChanges.length, 0);

  res = await call(app, "GET", "/admin/api/paint/sent-orders/status");
  assert.equal(res.body.count, 2);
  assert.equal(res.body.latest.source, "reimported_xlsx");

  res = await call(app, "GET", "/admin/api/paint/sent-orders/open");
  assert.equal(res.body.count, 2);
  assert.equal(res.body.orders[1].positions[0].sku, "020603YYYYY");

  console.log("lg-sent-order test ok");
})().catch(error => { console.error(error); process.exit(1); });
