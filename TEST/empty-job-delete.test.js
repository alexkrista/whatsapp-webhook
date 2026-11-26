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
for(const check of ["hasPlanning","hasTimeEvents","hasRegieReports","hasWorkData","hasFinancialData","hasRecordedHours"])assert.match(server,new RegExp("if \\("+check+"\\) reasons.push"));
assert.match(server, /Löschen gesperrt/);
assert.match(page, /Umbuchung bestätigen/);
assert.match(page, /empty-delete-check/);

console.log("empty job delete tests passed");
