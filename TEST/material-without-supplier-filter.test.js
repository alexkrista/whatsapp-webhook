"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerMaterialMaster } = require("../material-master");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "material-without-supplier-"));
  try {
    const routes = {};
    const app = {};
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      app[method] = (route, handler) => { routes[`${method}:${route}`] = handler; };
    }
    registerMaterialMaster(app, {
      dataDir: root,
      requireAdmin: () => true,
      publicDir: path.join(__dirname, "..", "public"),
    });

    const materialDir = path.join(root, "_kristine", "materials");
    fs.mkdirSync(materialDir, { recursive: true });
    fs.writeFileSync(path.join(materialDir, "materials.json"), JSON.stringify([
      { id: "M1", materialId: "M1", product: "Ohne Zuordnung", supplier: "", active: true },
      { id: "M2", materialId: "M2", product: "Auch ohne Zuordnung", active: true },
      { id: "M3", materialId: "M3", product: "Mit Zuordnung", supplier: "Muster", active: true },
    ]));

    const result = await new Promise((resolve, reject) => {
      const response = { statusCode: 200, body: null };
      const res = {
        status(code) { response.statusCode = code; return this; },
        json(body) { response.body = body; resolve(response); },
      };
      Promise.resolve(routes["get:/admin/api/materials"]({
        query: { supplier: "Ohne Lieferant", limit: "5000" },
      }, res)).catch(reject);
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.summary.bySupplier["Ohne Lieferant"], 2);
    assert.deepEqual(result.body.materials.map(row => row.materialId).sort(), ["M1", "M2"]);
    console.log("OK: 'Ohne Lieferant' zeigt genau die gezählten Materialien");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
