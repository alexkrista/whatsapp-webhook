"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path"),root=path.resolve(__dirname,"..");
const moduleSource=fs.readFileSync(path.join(root,"brain_invoice_material_review.py"),"utf8");
const inventory=fs.readFileSync(path.join(root,"paint-inventory.js"),"utf8");
for(const text of ["Materialstamm prüfen","Preis gleich","Neuen EK übernehmen","Neu im Materialstamm speichern","Verknüpfen + EK übernehmen","materialReview","/incoming/capture/material-review"])assert.ok(moduleSource.includes(text),text);
assert.ok(inventory.includes("Keine eindeutigen LG-Lagerpositionen"));
console.log("invoice material review UI checks passed");
