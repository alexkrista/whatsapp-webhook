"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const html=fs.readFileSync(path.join(root,"public/paint-lab.html"),"utf8");
const inventory=fs.readFileSync(path.join(root,"public/paint-inventory-ui.js"),"utf8");
for(const text of ["Farben Retail · wird geprüft","Preislisten hochladen","Farben · Retail-/Preisliste","/admin/api/paint/lg-pricelist","Aktive Farbenliste"])
  assert.ok(html.includes(text),`Farben-Preisliste ist eindeutig sichtbar: ${text}`);
for(const text of ["Tapeten · Retail-Preisliste","Hier nur Tapeten hochladen","Tapeten Retail · fehlt","wallpaper-pricelist/status","Aktive Tapetenliste"])
  assert.ok(inventory.includes(text),`Tapeten-Preisliste ist eindeutig sichtbar: ${text}`);
assert.ok(!html.includes("window.open('/public/lg-retail-preisliste-2025.html'"),"Der Retail-Button öffnet nicht länger die fest eingebaute Alt-Liste");
console.log("OK: Farben- und Tapetenpreislisten sind getrennt hochladbar und sichtbar.");
