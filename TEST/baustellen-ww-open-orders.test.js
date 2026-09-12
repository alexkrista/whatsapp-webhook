"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path");
const root=path.join(__dirname,"..");
const brain=fs.readFileSync(path.join(root,"archive-connector.py"),"utf8");
const ui=fs.readFileSync(path.join(root,"public","ui","baustellen-ww-import.js"),"utf8");
const topbar=fs.readFileSync(path.join(root,"public","ui","topbar.js"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");

assert.match(brain,/@app\.get\("\/project\/open-orders"\)/);
for(const filter of ["bAktiv", "bArchiv", "bIstAbgeschlossen", "bAbgerechnet", "AuftragErteilt"]){
  assert.ok(brain.includes(filter),`WW-Offenfilter enthält ${filter}`);
}
assert.match(topbar,/baustellen-ww-import\.js\?v=20260912-open-orders-2/);
assert.match(ui,/Mit vorhandener Akte verbinden/);
assert.match(ui,/data-wwi-link/);
assert.match(ui,/\/admin\/api\/job\/\$\{encodeURIComponent\(sourceJobId\)\}\/merge/);
assert.match(ui,/ZUSAMMEN/);
for(const text of ["Offene Aufträge aus WinWorker","Aus WW übernehmen","Ausgewählte übernehmen","bereits da","wwProjectIndex","wwProjectNumber"]){
  assert.ok(ui.includes(text),`Auswahl enthält ${text}`);
}
assert.match(ui,/isExisting\(row/);
assert.match(ui,/\/admin\/api\/jobs/);
assert.match(server,/wwProjectIndex/);
assert.match(server,/wwProjectNumber/);
assert.match(server,/sourceSystem/);
console.log("baustellen WW open orders test: ok");
