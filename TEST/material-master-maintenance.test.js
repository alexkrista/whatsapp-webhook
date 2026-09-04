"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");
const { registerMaterialMaster } = require("../material-master");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "krista-material-test-"));
  try {
    const routes = {};
    const app = {};
    for (const method of ["get", "post", "put", "patch", "delete"]) app[method] = (route, handler) => { routes[`${method}:${route}`] = handler; };
    const service = registerMaterialMaster(app, { dataDir: root, requireAdmin: () => true, publicDir: path.join(__dirname, "..", "public") });
    const materialDir = path.join(root, "_kristine", "materials");
    fs.mkdirSync(materialDir, { recursive: true });
    fs.writeFileSync(path.join(materialDir, "materials.json"), JSON.stringify([
      { id: "M1", materialId: "M1", group: "Farbe", product: "Alt", unit: "kg", purchasePrice: 1, salePrice: 2, supplier: "", active: true, note: "bleibt" },
      { id: "M2", materialId: "M2", group: "Werkzeug", product: "Stilllegen", unit: "Stk", purchasePrice: 3, salePrice: 5, active: true },
    ]));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Status B/N/L", "Material-ID", "Lieferant", "Lieferanten-Artikelnummer", "Artikel", "Einheit", "EK netto (€)", "VK netto (€)", "VK brutto (€)", "Preisstand"],
      ["B", "M1", "Muster", "A-1", "Neu benannt", "kg", 4, 8, 9.6, "04.09.2026"],
      ["L", "M2", "", "", "Stilllegen", "Stk", 3, 5, 6, "04.09.2026"],
      ["N", "", "Neu-Lieferant", "N-1", "Neuer Artikel", "Rolle", 10, 18, 21.6, "04.09.2026"],
    ]), "Materialpreisliste");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Warnung"], ["nur Information"]]), "Warnliste");
    const report = await service.importWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), "pflege.xlsx");
    assert.equal(report.added, 1);
    assert.equal(report.deactivated, 1);

    const rows = await service.readMaterials();
    const changed = rows.find(row => row.materialId === "M1");
    assert.equal(changed.product, "Neu benannt");
    assert.equal(changed.group, "Farbe", "Nicht exportierte Stammdaten bleiben erhalten");
    assert.equal(changed.note, "bleibt", "Interne Notizen bleiben erhalten");
    assert.equal(changed.purchasePrice, 4);
    assert.equal(changed.priceCheckedAt, "2026-09-04");
    assert.equal(rows.find(row => row.materialId === "M2").active, false);
    assert(rows.some(row => row.product === "Neuer Artikel" && row.active !== false));

    const exported = XLSX.read(await service.exportWorkbook(), { type: "buffer" });
    assert(exported.SheetNames.includes("Materialpreisliste"));
    assert(exported.SheetNames.includes("Warnliste"));
    const exportedRows = XLSX.utils.sheet_to_json(exported.Sheets.Materialpreisliste, { defval: "" });
    assert(!exportedRows.some(row => row["Material-ID"] === "M2"), "Stillgelegte Artikel fehlen im Folgeexport");
    assert(exportedRows.some(row => row["Material-ID"] === "M1"));
    console.log("OK: Materialpflege importiert B/N/L sicher, bewahrt Stammdaten und exportiert nur aktive Artikel.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
