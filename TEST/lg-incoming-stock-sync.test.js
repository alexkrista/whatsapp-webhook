"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { registerPaintInventory } = require("../paint-inventory");

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "krista-lg-stock-"));
  const paintDir = path.join(dataDir, "_kristine", "paint");
  fs.mkdirSync(paintDir, { recursive: true });
  fs.writeFileSync(path.join(paintDir, "articles.json"), JSON.stringify([{
    id: "LG-00123456789",
    manufacturer: "Little Greene",
    product: "Absolute Matt",
    baseCode: "H",
    baseName: "Hi White",
    size: "2.5 L",
    stockCode: "00123456789",
    stock: 3,
    purchasePrice: 70,
    targetStock: 4,
    minimumStock: 2,
    active: true,
  }]), "utf8");

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerPaintInventory(app, { dataDir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const payload = {
    invoiceRef: "LG-TEST-4711",
    invoiceDate: "2026-09-10",
    netAmount: 149.60,
    text: "10 00123456789 LG Absolute Matt Hi White 2,5L 2 74,80 149,60",
  };

  try {
    let response = await fetch(base + "/admin/api/paint/lg-incoming-sync", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    let body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.paintLines, 1);
    assert.equal(body.results[0].before, 3);
    assert.equal(body.results[0].after, 5);

    response = await fetch(base + "/admin/api/paint/lg-incoming-sync", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    body = await response.json();
    assert.equal(body.duplicate, true);
    const saved = JSON.parse(fs.readFileSync(path.join(paintDir, "articles.json"), "utf8"));
    assert.equal(saved[0].stock, 5);
    console.log("LG incoming stock sync checks passed");
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
