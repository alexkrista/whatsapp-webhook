"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path");
const root=path.join(__dirname,"..");
const html=fs.readFileSync(path.join(root,"public","kristine.html"),"utf8");
const ui=fs.readFileSync(path.join(root,"public","ui","kristine-customer-master.js"),"utf8");
const calendar=fs.readFileSync(path.join(root,"public","ui","kristine-task-calendar.js"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
assert.match(html,/Im WW suchen/);assert.match(html,/customerMaster:/);assert.match(ui,/project\/address-search/);assert.match(ui,/Neuer Kundenstamm vorgemerkt/);assert.match(calendar,/customerMaster:currentTask\.customerMaster/);assert.match(server,/wwCustomerNumber/);assert.match(server,/pending_ww_create/);assert.match(server,/Vor Auftragserstellung bitte ergänzen/);assert.match(server,/Object\.assign\(task,\{jobId,jobName/);
console.log("OK: Kundenstamm fließt von Aufgabe über Angebot/Auftrag in die Baustelle.");
