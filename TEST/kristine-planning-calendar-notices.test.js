"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "kristine.html"), "utf8");

assert.match(html, /function employeeAnnualNotices\(date,employeeId=''/);
assert.match(html, /employee\.birthDate/);
assert.match(html, /employee\.employmentStart/);
assert.match(html, /annualNoticesHtml\(day,employee\.id\)/);
assert.match(html, /sharedCalendarNoticesHtml\(ds\)/);
assert.match(html, /Persönliche Termine/);
assert.match(html, /Alle anderen gemeinsamen Einträge sind ganztägig und als frei markiert/);
assert.match(html, /function siteStartNotices\(date\)/);
assert.match(html, /Baustellenstart/);
assert.match(html, /function sharedCalendarAbsences\(date\)/);
assert.match(html, /\['urlaub','krank'\]\.includes\(cardTypeOf\(a\)\)/);
assert.match(html, /Gemeinsamer Kalender: nur Krank, Urlaub, Geburtstage, Eintrittsjahrestage und jeder Baustellenstart genau einmal/);
for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (script[1].trim()) new Function(script[1]);
}

console.log("kristine planning calendar notices test: ok");
