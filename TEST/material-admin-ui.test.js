"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ui = fs.readFileSync(path.join(__dirname, "..", "public", "material-admin.html"), "utf8");
const home = fs.readFileSync(path.join(__dirname, "..", "public", "ui", "krisadmin-home.js"), "utf8");
const regie = fs.readFileSync(path.join(__dirname, "..", "public", "regie-workbench.html"), "utf8");
const brain = fs.readFileSync(path.join(__dirname, "..", "archive-connector.py"), "utf8");

for (const text of ["Preiswarnungen", "+ Neues Material", "Bearbeiten", "deleteMaterial", "Excel importieren", "Excel exportieren", "supplierArticleNumber", "In WW suchen", "searchWinWorker", "prepareWinWorkerImport", "WW-Material übernehmen und ergänzen", "supplierGroups", "ww-supplier-count", "Übernehmen", "editMaterialId", "ID / Kürzel", "editGross", "VK brutto €", "updateGrossFromNet", "updateNetFromGross"]) {
  assert(ui.includes(text), `Materialverwaltung enthält ${text}`);
}
assert(!ui.includes("WW jetzt einlesen"), "WW-Materialien werden nur einzeln ausgewählt übernommen");
assert(home.includes("/admin/material"), "KRISADMIN enthält den Material-Reiter");
assert(regie.includes("hasSale=owns(item,['salePrice','vkNet'])"), "Gespeicherte Regiepreise bleiben als Snapshot erhalten");
assert(regie.includes("hasPurchase=owns(item,['purchasePrice','unitPrice','ek'])"), "Gespeicherte Einkaufspreise werden nicht später aus dem Stamm ersetzt");
assert(regie.includes("queue-delete"), "Offene Regieberichte können nach Rückfrage gelöscht werden");
assert(regie.includes("m?.supplierArticleNumber"), "Regiebericht-Suche zeigt auch WW-Kürzel wie A 01");
assert(regie.includes('placeholder="25 oder 5*5"'), "Mengenfeld weist auf die Rechenfunktion hin");
const quantityFunction = regie.split(/\r?\n/).find(line => line.startsWith("function calculateQuantity"));
const quantityContext = {};
vm.runInNewContext(`const round=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;${quantityFunction};this.calculateQuantity=calculateQuantity`, quantityContext);
assert.equal(quantityContext.calculateQuantity("25"), 25);
assert.equal(quantityContext.calculateQuantity("5*5"), 25);
assert.equal(quantityContext.calculateQuantity("1,5 × 4"), 6);
assert.equal(quantityContext.calculateQuantity("(2+3)*4"), 20);
assert.equal(quantityContext.calculateQuantity("10/4"), 2.5);
assert.equal(quantityContext.calculateQuantity("5*alert(1)"), null, "Mengenrechner führt keinen Code aus");
assert.equal(quantityContext.calculateQuantity("10/0"), null, "Division durch null wird abgelehnt");
for (const text of ["ww_material_master_rows", "MatLieferInfo_MIdx", "/ww-materials/sync", "/ww-materials/search", "sync-winworker", "import-winworker"]) {
  assert(brain.includes(text) || ui.includes(text), `WW-Materialabgleich enthält ${text}`);
}
console.log("OK: KRISADMIN-Materialpflege und feste Regiebericht-Preise sind verdrahtet.");
