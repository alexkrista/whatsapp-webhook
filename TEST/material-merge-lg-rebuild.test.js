"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerMaterialMaster } = require("../material-master");

function harness() {
  const routes = {};
  const app = {};
  for (const method of ["get", "post", "put", "patch", "delete"]) app[method] = (route, handler) => { routes[`${method}:${route}`] = handler; };
  return { app, routes };
}

function invoke(handler, req = {}) {
  return new Promise((resolve, reject) => {
    const result = { statusCode: 200, body: null };
    const res = {
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; resolve(result); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "material-merge-lg-"));
  const materialDir = path.join(root, "_kristine", "materials");
  const paintDir = path.join(root, "_kristine", "paint");
  try {
    fs.mkdirSync(materialDir, { recursive: true });
    fs.mkdirSync(paintDir, { recursive: true });
    fs.writeFileSync(path.join(materialDir, "materials.json"), JSON.stringify([
      { id: "K07", materialId: "K07", product: "Alte Zuordnung", supplier: "Altlieferant", sourceSystem: "WinWorker", sourceId: "88007", active: true },
      { id: "ZIEL", materialId: "ZIEL", product: "Richtiger Artikel", supplier: "Neuer Lieferant", purchasePrice: 12, salePrice: 22, active: true },
      { id: "LG-ALT", materialId: "LG-ALT", product: "Absolute Matt allgemein", supplier: "Little Greene", active: true },
    ]));
    fs.writeFileSync(path.join(paintDir, "articles.json"), JSON.stringify([
      { id: "LG-SKU1", stockCode: "SKU1", manufacturer: "Little Greene", product: "Absolute Matt", baseName: "Hi White", baseCode: "H", size: "1 L", purchasePrice: 21, active: true, updatedAt: "2026-09-09T08:00:00Z" },
    ]));

    const { app, routes } = harness();
    const service = registerMaterialMaster(app, { dataDir: root, requireAdmin: () => true, publicDir: path.join(__dirname, "..", "public") });

    const merged = await invoke(routes["post:/admin/api/materials/:materialId/merge"], { params: { materialId: "K07" }, body: { targetMaterialId: "ZIEL" } });
    assert.equal(merged.statusCode, 200);
    let rows = await service.readMaterials();
    assert.equal(rows.find(row => row.materialId === "K07").active, false);
    assert.equal(rows.find(row => row.materialId === "K07").mergedInto, "ZIEL");
    assert.match(rows.find(row => row.materialId === "ZIEL").alias, /K07/);
    assert(rows.find(row => row.materialId === "ZIEL").sourceLinks.some(link => link.system === "WinWorker" && link.id === "88007"));

    await service.syncWinWorkerMaterials([{ sourceId: "88007", product: "Richtiger Artikel neu", supplier: "Neuer Lieferant", purchasePrice: 13, salePrice: 23 }], { deactivateMissing: false });
    rows = await service.readMaterials();
    assert.equal(rows.find(row => row.materialId === "ZIEL").purchasePrice, 13, "WW-Aktualisierung landet nach Zusammenführung am Ziel");
    assert.equal(rows.find(row => row.materialId === "K07").active, false, "Alter Dubletteneintrag bleibt stillgelegt");

    const rebuilt = await invoke(routes["post:/admin/api/materials/rebuild-little-greene"], { body: {} });
    assert.equal(rebuilt.statusCode, 200);
    assert.equal(rebuilt.body.total, 36, "Es entstehen nur die Positionen der LG-VK-Liste, nicht alle Basen");
    rows = await service.readMaterials();
    assert.equal(rows.find(row => row.materialId === "LG-ALT").active, false);
    const direct = rows.find(row => row.materialId === "SKU1");
    assert(direct && direct.active);
    assert.equal(direct.purchasePrice, 21);
    assert.equal(direct.salePrice, 49.17);
    assert.equal(direct.supplierArticleNumber, "SKU1");
    assert.match(direct.priceSource, /EK Basis Hi White/);
    assert(fs.existsSync(path.join(materialDir, rebuilt.body.backupName)), "Vor dem LG-Neuaufbau wird eine Sicherung erstellt");

    const ui = fs.readFileSync(path.join(__dirname, "..", "public", "material-admin.html"), "utf8");
    assert.match(ui, /LG-Stamm neu aufbauen/);
    assert.match(ui, /Zusammenführen/);
    console.log("OK: Material-Zusammenführung und sicherer LG-Neuaufbau funktionieren");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
