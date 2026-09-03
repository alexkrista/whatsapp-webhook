"use strict";

const assert=require("assert");
const fs=require("fs");
const path=require("path");

const root=path.resolve(__dirname,"..");
const ui=fs.readFileSync(path.join(root,"public","ui","baustellen-live-hours.js"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
const brain=fs.readFileSync(path.join(root,"brain_outgoing_invoices.py"),"utf8");

assert.match(ui,/WW \/ KRISTINE Stundenabgleich/);
assert.match(ui,/WW jetzt abgleichen/);
assert.match(ui,/WinWorker-Daten/);
assert.match(ui,/KRISTINE-Daten/);
assert.match(ui,/data-hr-key/);
assert.match(ui,/als doppelt markieren/);
assert.match(ui,/hours-overlap/);
assert.match(ui,/hoursOverlapExcludedWwKeys/);
assert.match(ui,/Math\.max\(0,row\.hours-\.25\)/);
assert.match(ui,/pauseDeductionHours:\.25/);
assert.match(ui,/personDayHours/);
for(const pair of [["mandi-faes","Manuel Faes"],["edi-mock","Edmund Mock"],["cathrin-grabherr","Anna Cathrin Grabherr"],["cathrin-anna-grabherr","Anna Cathrin Grabherr"]])assert.ok(ui.includes(`"${pair[0]}":"${pair[1]}"`));
assert.match(ui,/person\.hours=Math\.max\(0,person\.hours-\.25\)/);
assert.match(ui,/excluded=selectedExclusions/);
assert.match(ui,/person\.hours\*scale/);
assert.match(ui,/Auswahl geändert – bitte speichern/);
assert.match(ui,/Der Server hat die Auswahl nicht vollständig übernommen/);
assert.match(ui,/reconciliationDrafts\.get\(jobId\)\|\|selected/);
assert.doesNotMatch(ui,/confirm\(`/);
assert.doesNotMatch(ui,/prompt\(/);
assert.match(server,/app\.put\("\/admin\/api\/job\/:jobId\/hours-overlap"/);
assert.match(server,/cleanHoursOverlapKeys/);
assert.match(server,/hours_overlap_history_error/);
assert.match(brain,/"employeeName": str\(row\.get\("employeeName"\)/);
assert.match(brain,/"rows": detail_rows/);

console.log("baustellen live hours reconciliation test: ok");
