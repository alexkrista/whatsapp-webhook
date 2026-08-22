"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const express = require("express");
const XLSX = require("xlsx");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cfbEntry(buffer, target) {
  const cfb = XLSX.CFB.read(buffer, { type: "buffer" });
  const normalizedTarget = String(target).replace(/^\/+/, "").toLowerCase();
  for (let i = 0; i < cfb.FullPaths.length; i += 1) {
    const p = String(cfb.FullPaths[i]).replace(/^Root Entry\/?/i, "").replace(/^\/+/, "").replace(/\\/g, "/").toLowerCase();
    if (p === normalizedTarget) return Buffer.from(cfb.FileIndex[i].content || []);
  }
  throw new Error(`ZIP entry not found: ${target}`);
}

async function jsonFetch(url) {
  const response = await fetch(url);
  return { response, body: await response.json() };
}

(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "kristine-lg-order-"));
  process.env.DATA_DIR = tmp;
  process.env.ADMIN_TOKEN = "";

  const { registerPaintLgOrderExcel } = require("../paint-lg-order-excel");
  const root = path.join(tmp, "_kristine", "paint");
  const articlesFile = path.join(root, "articles.json");
  const templateFile = path.join(root, "lg-order-template.xlsx");

  assert.ok(fs.existsSync(templateFile), "bundled KRISTA LG template was not installed");
  const templateBytes = await fsp.readFile(templateFile);
  assert.strictEqual(templateBytes.length, 62484, "template byte length changed");
  assert.strictEqual(sha256(templateBytes), "dfb79a7103ba911563f29202d8ad73454bfeabc12191912a3bedcbad74dee49c", "template SHA-256 changed");
  const originalImageHash = sha256(cfbEntry(templateBytes, "xl/media/image1.jpeg"));

  const goodArticles = [
    { id: "base", manufacturer: "Little Greene", category: "paint", product: "Absolute Matt", stockCode: "020605HHHHH", purchasePrice: 5.21, stock: 4, minimumStock: 4, targetStock: 8, active: true, orderable: true },
    { id: "colourant", manufacturer: "Little Greene", category: "colourant", product: "CY", stockCode: "029803CYANZ", purchasePrice: 36.61, stock: 1, minimumStock: 1, targetStock: 2, active: true, orderable: true },
    { id: "sample", manufacturer: "Little Greene", category: "sample-pot", product: "China Clay", stockCode: "020606CHINA", purchasePrice: 3.61, stock: 0, minimumStock: 0, targetStock: 0, orderQuantityOverride: 2, active: true, orderable: true },
    { id: "marketing", manufacturer: "Little Greene", category: "marketing", product: "Little Greene Fandeck", stockCode: "0299FANDE09", purchasePrice: 21, stock: 0, minimumStock: 0, targetStock: 0, orderQuantityOverride: 1, active: true, orderable: true },
  ];
  await fsp.writeFile(articlesFile, JSON.stringify(goodArticles, null, 2), "utf8");

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  registerPaintLgOrderExcel(app, { dataDir: tmp });
  const server = await new Promise(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const status = await jsonFetch(`${base}/admin/api/paint/order-review/xlsx-template/status`);
    assert.strictEqual(status.response.status, 200);
    assert.strictEqual(status.body.installed, true);

    const good = await fetch(`${base}/admin/api/paint/order-review/xlsx`);
    if (good.status !== 200) throw new Error(`Good export returned ${good.status}: ${await good.text()}`);
    const out = Buffer.from(await good.arrayBuffer());
    assert.strictEqual(good.headers.get("x-price-check"), "ok");
    assert.strictEqual(good.headers.get("x-kristine-total"), "85.67");
    assert.strictEqual(good.headers.get("x-lg-total"), "85.67");
    assert.strictEqual(good.headers.get("x-order-positions"), "4");
    assert.strictEqual(good.headers.get("x-order-pieces"), "8");

    const wb = XLSX.read(out, { type: "buffer", cellFormula: true });
    assert.deepStrictEqual(wb.SheetNames, ["Zusammenfassung", "LG BASES", "COLOURANTS", "LG SAMPLE POTS", "LG MARKETING"]);
    assert.strictEqual(wb.Sheets["LG BASES"].E2.v, 4);
    assert.strictEqual(wb.Sheets.COLOURANTS.E2.v, 1);
    assert.strictEqual(wb.Sheets["LG SAMPLE POTS"].D2.v, 2);
    assert.strictEqual(wb.Sheets["LG MARKETING"].D7.v, 1);
    assert.strictEqual(Number(wb.Sheets.Zusammenfassung.B13.v.toFixed(2)), 85.67);
    assert.strictEqual(sha256(cfbEntry(out, "xl/media/image1.jpeg")), originalImageHash, "summary logo/image changed");

    const wrongPrice = [{ ...goodArticles[0], purchasePrice: 5.22 }];
    await fsp.writeFile(articlesFile, JSON.stringify(wrongPrice, null, 2), "utf8");
    const priceFail = await jsonFetch(`${base}/admin/api/paint/order-review/xlsx`);
    assert.strictEqual(priceFail.response.status, 409);
    assert.ok(Array.isArray(priceFail.body.priceMismatches) && priceFail.body.priceMismatches.length === 1);
    assert.strictEqual(priceFail.body.priceMismatches[0].sku, "020605HHHHH");

    const missingSku = [{ ...goodArticles[0], stockCode: "DOES-NOT-EXIST", purchasePrice: 5.21 }];
    await fsp.writeFile(articlesFile, JSON.stringify(missingSku, null, 2), "utf8");
    const skuFail = await jsonFetch(`${base}/admin/api/paint/order-review/xlsx`);
    assert.strictEqual(skuFail.response.status, 409);
    assert.ok(Array.isArray(skuFail.body.missing) && skuFail.body.missing.length === 1);

    console.log("LG Excel integration test OK: exact template, 4 sheets, price check, image preserved, mismatch guards OK");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(tmp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
