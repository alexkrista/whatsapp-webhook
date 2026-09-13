"use strict";

const assert=require("assert"),fs=require("fs"),path=require("path"),root=path.resolve(__dirname,"..");
const python=fs.readFileSync(path.join(root,"brain_outgoing_invoices.py"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
const ui=fs.readFileSync(path.join(root,"public","ui","baustellen-knowledge-hub.js"),"utf8");
const topbar=fs.readFileSync(path.join(root,"public","ui","topbar.js"),"utf8");

assert.match(python,/def _rtf_to_text/);
assert.match(python,/FROM dbo\.Rapport AS r/);
assert.match(python,/Rapport_Positionen AS rp/);
assert.match(python,/LohnEmpfaenger AS le/);
assert.match(python,/position_type == 1/);
assert.match(python,/position_type == 2/);
assert.match(python,/project-regie-reports/);
assert.match(python,/netHours is already reduced/);
assert.doesNotMatch(python,/value - 0\.25/);

assert.match(server,/documentation\/regie-report-sync/);
assert.match(server,/source:"WW"/);
assert.match(server,/ww_regie_synced/);
assert.match(server,/description:cleanText\(raw\.description/);
assert.match(server,/removeDuplicateRegiePdfRows/);
assert.match(server,/regie-report-deduplicate/);
assert.match(server,/regie_pdf_duplicates_removed/);

assert.match(ui,/LOCAL_BRAIN_REGIE/);
assert.match(ui,/WW-Rapporte synchronisieren/);
assert.match(ui,/WW direkt \+ PDFs/);
assert.match(ui,/Tätigkeit/);
assert.match(ui,/dedupeReports/);
assert.match(ui,/2026-09-09-regie-dedupe-1/);
assert.match(topbar,/20260913-collection-data-1/);

console.log("ww regie direct sync test: ok");
