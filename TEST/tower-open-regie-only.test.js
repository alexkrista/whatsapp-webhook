"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const tower = fs.readFileSync(path.join(root, "public", "ui", "tower-baustellen-signals.js"), "utf8");

assert.match(server, /const automaticBilled = Boolean\(String\(row\?\.billedDocumentId/);
assert.match(server, /if \(jobIsSettled\) return "billed"/);
assert.match(server, /manualStatus === "billed" \|\| \(manualStatus !== "open" && automaticBilled\)/);
assert.match(server, /const open = !billed/);
assert.match(server, /openAmount: regieRows\.filter\(\(entry\) => entry\.state !== "billed"\)/);
assert.match(tower, /performanceForJob\(sourceJob,\{billing,reports,actualHours:totalHours,regieHours/);
assert.match(tower, /!performance\.complete\|\|performance\.amountToInvoice>\.005/);
assert.doesNotMatch(tower, /orderHours\+regieHours/);
assert.match(tower, /billing-snapshot/);
assert.match(tower, /recordedHoursNet/);
assert.match(tower, /projectTimeArchive/);
assert.match(tower, /wwHours\+kristineHours/);
assert.match(tower, /Math\.max\([\s\S]*calc\(sourceJob\)\.actualHours[\s\S]*calc\(j\)\.actualHours/);
assert.match(tower, /reportsByProject/);
assert.match(tower, /Jetzt neu berechnen/);
assert.match(tower, /Klick öffnet die vollständige Berechnung in der Baustelle/);
assert.doesNotMatch(tower, /B\.renderCalculation\(row\)/);
assert.match(tower, /closedCollectionMembers=new Set/);
assert.match(tower, /collection\?\.status\|\|''\)===['"]Geschlossen['"]/);
assert.match(tower, /if\(closedCollectionMembers\.has\(String\(j\?\.jobId\|\|''\)\)\)continue/);

const data = require(path.join(root, "public", "ui", "baustellen-data.js"));
const closed = { status: "Geschlossen", calculation: { calculatedHours: 100, actualHours: 20 } };
assert.strictEqual(data.isSettled(closed), true);
assert.strictEqual(data.openHours(closed, [closed]), 0);

console.log("OK: Tower liest den gespeicherten Vortagsstand und verlinkt zur Baustelle.");
