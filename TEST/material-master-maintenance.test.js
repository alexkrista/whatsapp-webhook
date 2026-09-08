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
    const routes = {}, routeOrder = [];
    const app = {};
    for (const method of ["get", "post", "put", "patch", "delete"]) app[method] = (route, handler) => { routes[`${method}:${route}`] = handler; routeOrder.push(`${method}:${route}`); };
    const service = registerMaterialMaster(app, { dataDir: root, requireAdmin: () => true, publicDir: path.join(__dirname, "..", "public") });
    assert(routeOrder.indexOf("get:/admin/api/materials/export-excel") < routeOrder.indexOf("get:/admin/api/materials/:materialId"), "Excel-Export steht vor der dynamischen Material-ID-Route");
    const materialDir = path.join(root, "_kristine", "materials");
    fs.mkdirSync(materialDir, { recursive: true });
    fs.writeFileSync(path.join(materialDir, "materials.json"), JSON.stringify([
      { id: "M1", materialId: "M1", group: "Farbe", product: "Alt", unit: "kg", purchasePrice: 1, salePrice: 2, supplier: "", active: true, note: "bleibt" },
      { id: "M2", materialId: "M2", group: "Werkzeug", product: "Stilllegen", unit: "Stk", purchasePrice: 3, salePrice: 5, active: true },
      { id: "M3", materialId: "M3", group: "Farbe", product: "Absolute Matt", unit: "1 L", purchasePrice: 0, salePrice: 0, supplier: "LG", supplierArticleNumber: "SKU1", active: true },
      { id: "M4", materialId: "M4", group: "Farbe", product: "LG Zubehör", unit: "Stk", purchasePrice: 4, salePrice: 8, supplier: "Little Greene", active: true },
    ]));
    const paintDir = path.join(root, "_kristine", "paint");
    fs.mkdirSync(paintDir, { recursive: true });
    fs.writeFileSync(path.join(paintDir, "articles.json"), JSON.stringify([
      { id: "LG-SKU1", stockCode: "SKU1", manufacturer: "Little Greene", product: "Absolute Matt", size: "1 L", purchasePrice: 21, salePrice: 0, active: true, updatedAt: "2026-09-08T08:00:00Z" },
    ]));

    const invoke = (handler, req = {}) => new Promise((resolve, reject) => {
      const result = { statusCode: 200, body: null };
      const res = {
        status(code) { result.statusCode = code; return this; },
        json(body) { result.body = body; resolve(result); },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
    const createdByMask = await invoke(routes["post:/admin/api/materials/auto"], { body: {
      materialId: "A05", product: "Maskenartikel", unit: "Stk", purchasePrice: "10,00", salePrice: "18,00",
    } });
    assert.equal(createdByMask.statusCode, 200);
    assert.equal(createdByMask.body.material.materialId, "A05", "Manuell eingegebenes Kürzel wird als Material-ID gespeichert");
    const renamedByMask = await invoke(routes["put:/admin/api/materials/:materialId"], { params: { materialId: "A05" }, body: { materialId: "A06" } });
    assert.equal(renamedByMask.statusCode, 200);
    assert.equal(renamedByMask.body.material.materialId, "A06", "Kürzel kann in der Materialmaske korrigiert werden");

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
    const supplierExport = XLSX.read(await service.exportWorkbook({ supplier: "Muster" }), { type: "buffer" });
    const supplierRows = XLSX.utils.sheet_to_json(supplierExport.Sheets.Materialpreisliste, { defval: "" });
    assert(supplierRows.some(row => row["Material-ID"] === "M1"), "Gewählter Lieferant wird exportiert");
    assert(!supplierRows.some(row => row["Material-ID"] === "M2"), "Andere Lieferanten fehlen im Lieferantenexport");
    assert(supplierRows.filter(row => row["Status B/N/L"] === "N").every(row => row.Lieferant === "Muster"), "Neue Zeilen sind mit dem gewählten Lieferanten vorbelegt");
    const supplierList = await invoke(routes["get:/admin/api/materials"], { query: { supplier: "Muster", limit: "5000" } });
    assert.equal(supplierList.statusCode, 200);
    assert(supplierList.body.materials.every(row => row.supplier === "Muster"), "Lieferantenfilter zeigt ausschließlich den gewählten Lieferanten");
    assert.equal(supplierList.body.summary.bySupplier.Muster, 1, "Lieferantenauswahl enthält die Trefferzahl");
    const littleGreeneRows = await invoke(routes["get:/admin/api/materials"], { query: { supplier: "Little Greene", limit: "5000" } });
    assert.equal(littleGreeneRows.body.materials.length, 2, "LG und Little Greene erscheinen als gemeinsamer Lieferant");
    assert(littleGreeneRows.body.materials.every(row => row.supplier === "Little Greene"), "Dropdown und Liste verwenden nur den kanonischen Lieferantennamen");
    const lgArticle = littleGreeneRows.body.materials.find(row => row.materialId === "M3");
    assert.equal(lgArticle.purchasePrice, 21, "Little-Greene-EK wird aus dem LG-Stamm kopiert");
    assert.equal(lgArticle.salePrice, 49.17, "Little-Greene-VK netto wird aus der LG-Retailpreisliste kopiert");
    assert.equal(lgArticle.priceSource, "Little Greene");

    const suppliers = await invoke(routes["get:/admin/api/material-suppliers"], { query: {} });
    const lgSupplier = suppliers.body.suppliers.find(row => row.name === "Little Greene");
    assert.equal(lgSupplier.materialCount, 2);
    assert.deepEqual(lgSupplier.aliases, ["LG", "Little Greene"]);
    const linked = await invoke(routes["post:/admin/api/material-suppliers/link-winworker"], { body: {
      localKey: lgSupplier.key,
      localName: lgSupplier.name,
      wwSupplier: { addressId: "4711", name: "Little Greene Deutschland", supplierNumber: "815", ourCustomerNumber: "FAR207", address: "Musterweg 1" },
    } });
    assert.equal(linked.body.updatedMaterials, 2);
    const linkedRows = await service.readMaterials();
    assert(linkedRows.filter(row => ["M3", "M4"].includes(row.materialId)).every(row => row.wwSupplierAddressId === "4711"));
    assert(linkedRows.filter(row => ["M3", "M4"].includes(row.materialId)).every(row => row.ourCustomerNumberAtSupplier === "FAR207"));
    const futureLg = await invoke(routes["post:/admin/api/materials/auto"], { body: { materialId: "M5", product: "LG Zukunftsartikel", supplier: "LG", unit: "Stk" } });
    assert.equal(futureLg.body.material.supplier, "Little Greene Deutschland", "Neue Alias-Artikel verwenden automatisch den WW-Stammlieferanten");
    assert.equal(futureLg.body.material.ourCustomerNumberAtSupplier, "FAR207", "Unsere Kundennummer wird für spätere Bestellungen mitgeführt");

    const wwReport = await service.syncWinWorkerMaterials([
      {
        sourceId: "880079",
        product: "3M Abdeckfolie Masking Film AMF48 121",
        unit: "Stk",
        purchasePrice: 15.23,
        salePrice: 27.414,
        supplier: "DRACO HANDELS GMBH",
        supplierArticleNumber: "D2-AMF48 A 01",
        orderNumber: "D2-AMF48 A 01",
        priceCheckedAt: "2023-08-17",
      },
      {
        sourceId: "880080",
        product: "3M Abdeckfolie Masking Film AMF99 251",
        unit: "Stk",
        purchasePrice: 14.43,
        salePrice: 25.974,
        supplier: "DRACO HANDELS GMBH",
        supplierArticleNumber: "D2-AMF99 A 01",
        orderNumber: "D2-AMF99 A 01",
        priceCheckedAt: "2023-08-17",
      },
    ]);
    assert.equal(wwReport.added, 2);
    const wwRows = await service.readMaterials();
    assert.equal(wwRows.find(row => row.materialId === "880079").purchasePrice, 15.23);
    assert.equal(wwRows.find(row => row.materialId === "880080").salePrice, 25.974);
    assert(wwRows.find(row => row.materialId === "880079").searchTextCompact.includes("a01"), "A 01 ist auch ohne Leerzeichen suchbar");

    const singleReport = await service.syncWinWorkerMaterials([{
      sourceId: "880079",
      product: "3M Abdeckfolie Masking Film AMF48 121",
      unit: "Stk",
      purchasePrice: 16,
      salePrice: 28,
      supplier: "DRACO HANDELS GMBH",
      supplierArticleNumber: "D2-AMF48 A 01",
      priceCheckedAt: "2026-09-04",
    }], { deactivateMissing: false });
    assert.equal(singleReport.changed, 1);
    const afterSingleImport = await service.readMaterials();
    assert.equal(afterSingleImport.find(row => row.materialId === "880079").purchasePrice, 16);
    assert.notEqual(afterSingleImport.find(row => row.materialId === "880080").active, false, "Einzelübernahme legt andere WW-Artikel nicht still");
    console.log("OK: Materialpflege importiert B/N/L sicher, bewahrt Stammdaten und exportiert nur aktive Artikel.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
