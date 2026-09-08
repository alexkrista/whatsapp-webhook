"use strict";

const assert = require("node:assert/strict");
const { parseAccessEventTime } = require("./access-learn-multi");

assert.equal(
  new Date(parseAccessEventTime("2026-09-08T08:15:30")).toISOString(),
  "2026-09-08T06:15:30.000Z",
);
assert.equal(
  new Date(parseAccessEventTime("2026-01-08T08:15:30")).toISOString(),
  "2026-01-08T07:15:30.000Z",
);
assert.equal(
  new Date(parseAccessEventTime("2026-09-08T06:15:30Z")).toISOString(),
  "2026-09-08T06:15:30.000Z",
);

console.log("PASS: Gantner-Lokalzeit wird als Europe/Vienna ausgewertet");
