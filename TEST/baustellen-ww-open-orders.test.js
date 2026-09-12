"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path");
const root=path.join(__dirname,"..");
const brain=fs.readFileSync(path.join(root,"archive-connector.py"),"utf8");
const ui=fs.readFileSync(path.join(root,"public","ui","baustellen-ww-import.js"),"utf8");
const topbar=fs.readFileSync(path.join(root,"public","ui","topbar.js"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");

assert.match(brain,/@app\.get\("\/project\/open-orders"\)/);
for(const filter of ["bAktiv", "bArchiv", "bIstAbgeschlossen", "AuftragErteilt"]){
  assert.ok(brain.includes(filter),`WW-Offenfilter enthält ${filter}`);
}
assert.match(brain,/@app\.get\("\/project\/search"\)/);
assert.match(brain,/Abschlagsrechnungen bleiben offen/);
assert.match(topbar,/baustellen-ww-import\.js\?v=20260912-project-search-4/);
assert.match(ui,/Mit vorhandener Akte verbinden/);
assert.match(ui,/Mit anderer Akte verbinden/);
assert.match(ui,/data-wwi-link/);
assert.match(ui,/\/admin\/api\/job\/\$\{encodeURIComponent\(sourceJobId\)\}\/merge/);
assert.match(ui,/ZUSAMMEN/);
for(const text of ["WinWorker-Aufträge übernehmen","Aus WW übernehmen","Ausgewählte übernehmen","bereits da","wwProjectIndex","wwProjectNumber"]){
  assert.ok(ui.includes(text),`Auswahl enthält ${text}`);
}
for(const text of ["Ganz WW durchsuchen","Offene anzeigen","/project/search?q="]){
  assert.ok(ui.includes(text),`Gesamtsuche enthält ${text}`);
}
assert.match(ui,/isExisting\(row/);
assert.match(ui,/\/admin\/api\/jobs/);
assert.match(server,/wwProjectIndex/);
assert.match(server,/wwProjectNumber/);
assert.match(server,/sourceSystem/);
console.log("baustellen WW open orders test: ok");
