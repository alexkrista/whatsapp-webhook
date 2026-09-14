"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const tower = fs.readFileSync(path.join(root, "public", "ui", "tower-baustellen-signals.js"), "utf8");

assert.match(server, /const billed = Boolean\(String\(row\?\.billedDocumentId/);
assert.match(server, /if \(jobIsSettled\) return "billed"/);
assert.match(server, /source === "KGO" && manualStatus === "billed"/);
assert.match(server, /source === "WW" \|\| \(source === "KGO" && manualStatus === "open"\)/);
assert.match(server, /openAmount: regieRows\.filter\(\(entry\) => entry\.state === "open"\)/);
assert.match(tower, /actualRegieAmount:openRegieAmount/);
assert.match(tower, /offene Regie/);
assert.match(tower, /closedCollectionMembers=new Set/);
assert.match(tower, /collection\?\.status\|\|''\)===['"]Geschlossen['"]/);
assert.match(tower, /if\(closedCollectionMembers\.has\(String\(j\?\.jobId\|\|''\)\)\)continue/);

const data = require(path.join(root, "public", "ui", "baustellen-data.js"));
const closed = { status: "Geschlossen", calculation: { calculatedHours: 100, actualHours: 20 } };
assert.strictEqual(data.isSettled(closed), true);
assert.strictEqual(data.openHours(closed, [closed]), 0);

console.log("OK: Im Tower wird nur ausdrücklich offene Regie als noch abzurechnen gezählt.");
