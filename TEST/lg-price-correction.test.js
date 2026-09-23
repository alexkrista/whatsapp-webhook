"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const XLSX = require("xlsx");
const { registerPaintCommercial } = require("../paint-commercial");

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kristine-lg-prices-"));
  const paintDir = path.join(dataDir, "_kristine", "paint");
  const materialDir = path.join(dataDir, "_kristine", "materials");
  const publicDir = path.join(dataDir, "public");
  await Promise.all([fs.mkdir(paintDir, { recursive: true }), fs.mkdir(materialDir, { recursive: true }), fs.mkdir(publicDir, { recursive: true })]);
  await fs.writeFile(path.join(publicDir, "lg-retail-preisliste-2025.html"), "<table><tr><td>Absolute Matt</td><td>1 L</td><td>€ 59,00</td></tr></table>");
  await fs.writeFile(path.join(paintDir, "articles.json"), JSON.stringify([
    { id: "LG-A", manufacturer: "Little Greene", product: "Absolute Matt", baseName: "Hi White", size: "1 L", stockCode: "020603HHHHH", purchasePrice: 20, active: true },
  ]));
  await fs.writeFile(path.join(materialDir, "materials.json"), JSON.stringify([
    { materialId: "020603HHHHH", sourceId: "LG-A", supplierArticleNumber: "020603HHHHH", supplier: "Little Greene", product: "Absolute Matt · 1 L", purchasePrice: 20, salePrice: 49.17 },
  ]));

  process.env.ADMIN_TOKEN = "";
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  registerPaintCommercial(app, { dataDir, publicDir });
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const exported = await fetch(`${base}/admin/api/paint/lg-prices/export.xlsx`);
    assert.equal(exported.status, 200);
    const wb = XLSX.read(Buffer.from(await exported.arrayBuffer()), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["LG Preise"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]["EK netto"], 20);
    assert.equal(rows[0]["VK netto"], 49.17);
    rows[0]["EK netto"] = 21.5;
    rows[0]["VK netto"] = 52.25;
    wb.Sheets["LG Preise"] = XLSX.utils.json_to_sheet(rows);
    const base64 = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64");

    const preview = await fetch(`${base}/admin/api/paint/lg-prices/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base64 }) });
    const previewBody = await preview.json();
    assert.equal(preview.status, 200);
    assert.equal(previewBody.errors.length, 0);
    assert.equal(previewBody.changes.length, 1);
    assert.equal(previewBody.changes[0].oldSale, 49.17);
    assert.equal(previewBody.changes[0].nextSale, 52.25);

    const applied = await fetch(`${base}/admin/api/paint/lg-prices/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base64 }) });
    const appliedBody = await applied.json();
    assert.equal(applied.status, 200);
    assert.equal(appliedBody.updatedArticles, 1);
    assert.equal(appliedBody.updatedMaterials, 1);
    const article = JSON.parse(await fs.readFile(path.join(paintDir, "articles.json"), "utf8"))[0];
    const material = JSON.parse(await fs.readFile(path.join(materialDir, "materials.json"), "utf8"))[0];
    assert.equal(article.purchasePrice, 21.5);
    assert.equal(article.salePrice, 52.25);
    assert.equal(article.manualSalePrice, true);
    assert.equal(material.purchasePrice, 21.5);
    assert.equal(material.salePrice, 52.25);
    console.log("LG EK/VK Excel correction test OK");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
