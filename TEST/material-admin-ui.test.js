"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ui = fs.readFileSync(path.join(__dirname, "..", "public", "material-admin.html"), "utf8");
const home = fs.readFileSync(path.join(__dirname, "..", "public", "ui", "krisadmin-home.js"), "utf8");
const regie = fs.readFileSync(path.join(__dirname, "..", "public", "regie-workbench.html"), "utf8");
const brain = fs.readFileSync(path.join(__dirname, "..", "archive-connector.py"), "utf8");

for (const text of ["Preiswarnungen", "+ Neues Material", "Bearbeiten", "deleteMaterial", "Excel importieren", "Excel exportieren", "supplierArticleNumber", "WW jetzt einlesen", "syncWinWorker"]) {
  assert(ui.includes(text), `Materialverwaltung enthält ${text}`);
}
assert(home.includes("/admin/material"), "KRISADMIN enthält den Material-Reiter");
assert(regie.includes("hasSale=owns(item,['salePrice','vkNet'])"), "Gespeicherte Regiepreise bleiben als Snapshot erhalten");
assert(regie.includes("hasPurchase=owns(item,['purchasePrice','unitPrice','ek'])"), "Gespeicherte Einkaufspreise werden nicht später aus dem Stamm ersetzt");
assert(regie.includes("queue-delete"), "Offene Regieberichte können nach Rückfrage gelöscht werden");
assert(regie.includes("m?.supplierArticleNumber"), "Regiebericht-Suche zeigt auch WW-Kürzel wie A 01");
for (const text of ["ww_material_master_rows", "MatLieferInfo_MIdx", "/ww-materials/sync", "sync-winworker"]) {
  assert(brain.includes(text) || ui.includes(text), `WW-Materialabgleich enthält ${text}`);
}
console.log("OK: KRISADMIN-Materialpflege und feste Regiebericht-Preise sind verdrahtet.");
