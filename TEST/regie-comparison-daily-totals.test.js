"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const { groupRegieComparisonRows } = require(path.join(root, "regie-comparison-rows"));
const ui = fs.readFileSync(path.join(root, "public/ui/baustellen-knowledge-hub.js"), "utf8");
const browserGroup = vm.runInNewContext(ui.slice(ui.indexOf("// Rows"), ui.indexOf("\n(function")) + "\ngroupRegieComparisonRows");
test("three report positions count one working day and retain all reports", () => {
  const rows = [4, 1.5, 4].map((regie, i) => ({ date: "2026-09-15", name: "Clemens Krista", stamped: 9.25, regie, number: String(i) }));
  const result = groupRegieComparisonRows(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].stamped, 9.25);
  assert.equal(result[0].regie, 9.5);
  assert.equal(result[0].diff, 0.25);
  assert.equal(result[0].number, "0, 1, 2");
  assert.equal(JSON.stringify(browserGroup(rows)), JSON.stringify(result));
});
test("missing reports remain distinct from zero hours and other employees/dates", () => {
  const rows = [{date:"2026-09-15",name:"A",stamped:9,regie:null}, {date:"2026-09-15",name:"B",stamped:8,regie:0}, {date:"2026-09-16",name:"A",stamped:7,regie:2}];
  const result = groupRegieComparisonRows(rows);
  assert.equal(result.length, 3);
  assert.equal(result[0].diff, null);
  assert.equal(result[1].diff, -8);
  assert.equal(result[2].diff, -5);
  assert.deepEqual(groupRegieComparisonRows(result), result);
});
test("conflicting repeated totals are rejected rather than silently selected", () => {
  assert.throws(() => groupRegieComparisonRows([{date:"2026-09-15",name:"A",stamped:9,regie:2},{date:"2026-09-15",name:"A",stamped:8,regie:3}]), /Widersprüchliche/);
});

test("original comparison row builder groups positions before sending PDF", () => {
  const start = ui.indexOf('const nk=v=>');
  const end = ui.indexOf(',comparisons=makeComparisons', start);
  const build = vm.runInNewContext(ui.slice(start, end) + ';makeComparisons', {
    num: value => Number(value) || 0,
    groupRegieComparisonRows,
    imported: [4, 1.5, 4].map((hours,i) => ({reportDate:"2026-09-15",reportNumber:String(i),employeeDetails:[{name:"Clemens",hours}]}))
  });
  const result = build([{date:"2026-09-15",name:"Clemens Krista",hours:9.25}]);
  assert.equal(result.length, 1);
  assert.equal(result[0].stamped, 9.25);
  assert.equal(result[0].regie, 9.5);
});
