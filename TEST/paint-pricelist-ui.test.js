"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const html=fs.readFileSync(path.join(root,"public/paint-lab.html"),"utf8");
const inventory=fs.readFileSync(path.join(root,"public/paint-inventory-ui.js"),"utf8");
const commercial=fs.readFileSync(path.join(root,"paint-commercial.js"),"utf8");
const preload=fs.readFileSync(path.join(root,"paint-lab-preload.js"),"utf8");
for(const text of ["Farben Retail · wird geprüft","Preislisten hochladen","Farben · Retail-/Preisliste","/admin/api/paint/lg-pricelist","Aktive Farbenliste"])
  assert.ok(html.includes(text),`Farben-Preisliste ist eindeutig sichtbar: ${text}`);
assert.ok(html.includes('id="priceUploadBtn" data-tab="admin"'),"Preislisten hochladen öffnet zuverlässig den bestehenden Import-Reiter");
assert.ok(html.includes("document.getElementById('priceImport')?.addEventListener"),"Farben-Import ist unabhängig von ausgeblendeten Alt-Importen gebunden");
assert.ok(html.includes("Bitte zuerst eine Farben-Preisliste auswählen."),"Farben-Import meldet eine fehlende Datei sichtbar");
assert.ok(commercial.includes("/(wallpaper|tapete)/i.test(name)"),"Tapetenlisten werden im Farben-Import abgewiesen");
for(const text of ["Tapeten · Retail-Preisliste","Hier nur Tapeten hochladen","Tapeten Retail · fehlt","wallpaper-pricelist/status","Aktive Tapetenliste"])
  assert.ok(html.includes(text)||inventory.includes(text),`Tapeten-Preisliste ist eindeutig sichtbar: ${text}`);
for(const id of ['id="wallpaperPriceAdmin"','id="wallRetailFile"','id="wallRetailImport"','id="wallTradeFile"','id="wallTradeImport"'])
  assert.ok(html.includes(id),`Tapeten-Upload ist fest in der Seite vorhanden: ${id}`);
assert.ok(preload.includes('Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate'),"Die Verwaltungsseite liefert keine veraltete Upload-Maske aus");
assert.ok(!html.includes("window.open('/public/lg-retail-preisliste-2025.html'"),"Der Retail-Button öffnet nicht länger die fest eingebaute Alt-Liste");
console.log("OK: Farben- und Tapetenpreislisten sind getrennt hochladbar und sichtbar.");
