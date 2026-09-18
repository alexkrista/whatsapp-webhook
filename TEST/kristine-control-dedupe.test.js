"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../public/kristine.html"), "utf8");
const source = html.match(/function normalizedEmployeeIdentity\([\s\S]*?\r?\n}\r?\n\r?\nfunction employeeOperationalOnDate\([\s\S]*?\r?\n}\r?\n\r?\nfunction canonicalControlEmployees/)?.[0]
  .replace(/\r?\n\r?\nfunction canonicalControlEmployees$/, "");

assert.ok(source, "Identitäts- und Personalregeln im Leitstand gefunden");
const helpers = new Function(`${source}; return {normalizedEmployeeIdentity,employeeOperationalOnDate};`)();
const { normalizedEmployeeIdentity, employeeOperationalOnDate } = helpers;

assert.equal(
  normalizedEmployeeIdentity({ id: "employee-new", name: "Alain" }, "employee-new"),
  normalizedEmployeeIdentity({ id: "employee-old", employeeName: "Alain" }, "employee-old"),
  "Gleicher Mitarbeitername wird trotz unterschiedlicher Alt- und Neu-ID zusammengeführt"
);
assert.notEqual(
  normalizedEmployeeIdentity({ id: "one", name: "Alain" }, "one"),
  normalizedEmployeeIdentity({ id: "two", name: "Alexander Krista" }, "two"),
  "Verschiedene Mitarbeiternamen bleiben getrennt"
);

assert.equal(employeeOperationalOnDate({ active:false }, "2026-09-18"), false);
assert.equal(employeeOperationalOnDate({ active:true, employmentStart:"2026-10-01" }, "2026-09-18"), false);
assert.equal(employeeOperationalOnDate({ active:true, employmentEnd:"2026-09-17" }, "2026-09-18"), false);
assert.equal(employeeOperationalOnDate({ active:true, employmentEnd:"2026-09-18" }, "2026-09-18"), true);
assert.match(html, /if\(!master\)return;/, "Alte Planung oder Status darf keine ausgeschiedene Person zurückholen");

console.log("OK: Leitstand hält Identität und Beschäftigungsregeln ein.");
