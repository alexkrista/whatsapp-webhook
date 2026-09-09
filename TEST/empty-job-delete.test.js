"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "public", "baustellen.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

assert.match(page, /id="deleteEmptyJob"/);
assert.match(page, /Fehlanlage löschen/);
assert.match(page, /a<=\.005&&t<=\.005&&p<=\.005&&contractAmount\(j\)<=\.005/);
assert.match(page, /\?emptyOnly=1/);
assert.match(server, /String\(req\.query\.emptyOnly \|\| ""\) === "1"/);
assert.match(server, /hasPlanning \|\| hasTimeEvents \|\| hasRegieReports \|\| hasWorkData \|\| hasFinancialData \|\| hasRecordedHours/);
assert.match(server, /kann deshalb nicht als Fehlanlage gelöscht werden/);

console.log("empty job delete tests passed");
