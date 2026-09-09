"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ui = fs.readFileSync(path.join(__dirname, "..", "public", "material-admin.html"), "utf8");
const home = fs.readFileSync(path.join(__dirname, "..", "public", "ui", "krisadmin-home.js"), "utf8");
const regie = fs.readFileSync(path.join(__dirname, "..", "public", "regie-workbench.html"), "utf8");
const regieApproval = fs.readFileSync(path.join(__dirname, "..", "public", "ui", "kristine-regie-approval.js"), "utf8");
const topbar = fs.readFileSync(path.join(__dirname, "..", "public", "ui", "topbar.js"), "utf8");
const brain = fs.readFileSync(path.join(__dirname, "..", "archive-connector.py"), "utf8");
const inlineScript = ui.match(/<script>([\s\S]*?)<\/script>/);
assert(inlineScript, "Materialverwaltung enthält ihr Seitenskript");
new vm.Script(inlineScript[1], { filename: "material-admin.inline.js" });

for (const text of ["Preiswarnungen", "+ Neues Material", "Bearbeiten", "Kopieren", "copyMaterial", "forceCreate", "next-id", "nextIdRequest", "deleteMaterial", "Excel importieren", "Excel exportieren", "Alle Lieferanten", "printMaterials", "Drucken", "Lieferanten verwalten", "openSupplierManager", "linkWwSupplier", "unsere KdNr.", "supplierArticleNumber", "In WW suchen", "searchWinWorker", "prepareWinWorkerImport", "WW-Material übernehmen und ergänzen", "supplierGroups", "ww-supplier-count", "Übernehmen", "editMaterialId", "ID / Kürzel", "editContainerSize", "Gebindegröße", "editGross", "VK brutto €", "editFixedVk", "Fix-VK", "updateGrossFromNet", "updateNetFromGross"]) {
  assert(ui.includes(text), `Materialverwaltung enthält ${text}`);
}
assert(!ui.includes("WW jetzt einlesen"), "WW-Materialien werden nur einzeln ausgewählt übernommen");
assert(home.includes("/admin/material"), "KRISADMIN enthält den Material-Reiter");
assert(regie.includes("hasSale=owns(item,['salePrice','vkNet'])"), "Gespeicherte Regiepreise bleiben als Snapshot erhalten");
assert(regie.includes("hasPurchase=owns(item,['purchasePrice','unitPrice','ek'])"), "Gespeicherte Einkaufspreise werden nicht später aus dem Stamm ersetzt");
assert(regie.includes("queue-delete"), "Offene Regieberichte können nach Rückfrage gelöscht werden");
assert(regie.includes("m?.supplierArticleNumber"), "Regiebericht-Suche zeigt auch WW-Kürzel wie A 01");
assert(regie.includes('placeholder="25 oder 5*5"'), "Mengenfeld weist auf die Rechenfunktion hin");
assert(regie.includes("applyProjectPricing"), "Baustellen-Stundensatz und -Aufschlag werden auf alle normalen Zeilen angewendet");
assert(regie.includes("fixedSalePrice"), "Fix-VK-Artikel werden ohne Baustellen-Aufschlag übernommen");
assert(regie.includes("openMaterialMaster"), "Ein ausgewähltes Regiematerial öffnet direkt seine Materialstamm-Maske");
assert(regie.includes("mat-package"), "Die Regie-Maske zeigt die Gebindegröße statt der Lieferantenspalte");
assert(regie.includes("<th>Name</th><th>Von</th><th>Bis</th><th>Von</th><th>Bis</th><th>Stunden</th><th>Stundensatz</th>"), "Zwei Zeitblöcke sowie schmale Stunden- und Stundensatzspalten sind vorhanden");
assert(regie.includes("emp-from-2") && regie.includes("emp-to-2"), "Der zweite Von-bis-Zeitblock ist direkt bearbeitbar");
assert(regie.includes("Zuletzt bearbeitet") && regie.includes("slice(0,10)"), "Die letzten zehn bearbeiteten Regieberichte erscheinen als Kacheln");
for (const text of ["Nein – ändern", "Ja – nur ablegen", "Ja – versenden", "Zur Prüfung an Alex"]) assert(regie.includes(text), `Regie-Freigabe enthält ${text}`);
assert(regieApproval.includes("Regiebericht prüfen") && regieApproval.includes("reportId"), "Alex kann die Freigabe-Aufgabe direkt im richtigen Regiebericht öffnen");
assert(topbar.includes("kristine-regie-approval.js"), "Die Regiebericht-Freigabe wird in Alex' Aufgabenliste geladen");
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
for (const text of ["ww_material_master_rows", "MatLieferInfo_MIdx", "/ww-materials/sync", "/ww-materials/search", "/ww-suppliers/search", "ourCustomerNumber", "sync-winworker", "import-winworker"]) {
  assert(brain.includes(text) || ui.includes(text), `WW-Materialabgleich enthält ${text}`);
}
console.log("OK: KRISADMIN-Materialpflege und feste Regiebericht-Preise sind verdrahtet.");
