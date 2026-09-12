"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "kristine.html"), "utf8");

assert.match(html, /function employeeAnnualNotices\(date,employeeId=''/);
assert.match(html, /employee\.birthDate/);
assert.match(html, /employee\.employmentStart/);
assert.match(html, /annualNoticesHtml\(day,employee\.id\)/);
assert.match(html, /annualNoticesHtml\(ds\)/);
assert.match(html, /Persönliche Termine/);
assert.match(html, /ohne Benutzer-Anmeldung und ohne Testtermin/);

console.log("kristine planning calendar notices test: ok");
