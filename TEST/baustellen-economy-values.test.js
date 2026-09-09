"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const hub = fs.readFileSync(path.join(root, "public", "ui", "baustellen-knowledge-hub.js"), "utf8");
const cockpit = fs.readFileSync(path.join(root, "public", "ui", "baustellen-cockpit.js"), "utf8");
const liveHours = fs.readFileSync(path.join(root, "public", "ui", "baustellen-live-hours.js"), "utf8");
const chronik = fs.readFileSync(path.join(root, "public", "ui", "baustellen-chronik.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "order-calculation-v2-preload.js"), "utf8");

assert.match(preload, /totalCalculatedHours = d\.calculatedHours \+ d\.plannedRegieHours/);
assert.match(hub, /fixedMaterialEk=material\*\.8,totalMaterialEk=fixedMaterialEk\+regieMaterialEk/);
assert.match(hub, /documentPerHour=recorded>0\?documentNet\/recorded:0/);
assert.match(hub, /gespeicherte \+ ausgestellte Rechnungen netto/);
assert.match(cockpit, /documents\.filter\(x=>x\?\.type==="regie_report"\)/);
assert.match(cockpit, /liveInvoiceNet=num\(bs\.billedNet\)\+num\(bs\.draftNet\)/);
assert.match(cockpit, /emailCount\+\(emailCount===1\?" E-Mail":" E-Mails"\)/);
assert.match(cockpit, /wwAdditionalHours=Math\.max\(0,actual-peopleHours\)/);
assert.match(cockpit, /WinWorker – zusätzlich/);
assert.match(hub, /regieReportHours=String\(reportRegie\)/);
assert.match(liveHours, /function fusedPeople\(jobId\)/);
assert.match(liveHours, /function patchHoursTab\(id\)/);
assert.match(liveHours, /patchHoursTab\(id\)/);
assert.match(chronik, /function collectSurface\(regies,documents=\[\],metaRows=\[\]\)/);
assert.match(chronik, /function collectSurfacePeople\(regies,documents=\[\]\)/);
assert.match(chronik, /\/documentation`\)\.catch\(\(\)=>\(\{items:\[\]\}\)\)/);
assert.match(chronik, /data-bz-relevant/);
assert.match(chronik, /data-bz-save/);
assert.match(server, /surfaceMaterialMeta: cleanSurfaceMaterialMeta/);

console.log("baustellen economy value tests passed");
