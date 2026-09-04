"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ui = fs.readFileSync(path.join(__dirname, "..", "public", "material-admin.html"), "utf8");
const home = fs.readFileSync(path.join(__dirname, "..", "public", "ui", "krisadmin-home.js"), "utf8");
const regie = fs.readFileSync(path.join(__dirname, "..", "public", "regie-workbench.html"), "utf8");

for (const text of ["Preiswarnungen", "+ Neues Material", "Bearbeiten", "deleteMaterial", "Excel importieren", "Excel exportieren", "supplierArticleNumber"]) {
  assert(ui.includes(text), `Materialverwaltung enthält ${text}`);
}
assert(home.includes("/admin/material"), "KRISADMIN enthält den Material-Reiter");
assert(regie.includes("hasSale=owns(item,['salePrice','vkNet'])"), "Gespeicherte Regiepreise bleiben als Snapshot erhalten");
assert(regie.includes("hasPurchase=owns(item,['purchasePrice','unitPrice','ek'])"), "Gespeicherte Einkaufspreise werden nicht später aus dem Stamm ersetzt");
console.log("OK: KRISADMIN-Materialpflege und feste Regiebericht-Preise sind verdrahtet.");
