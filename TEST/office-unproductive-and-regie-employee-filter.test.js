"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");

const office = fs.readFileSync(path.join(root, "kgo-office-core.js"), "utf8");
const kristine = fs.readFileSync(path.join(root, "kristine.js"), "utf8");
const regie = fs.readFileSync(path.join(root, "public", "regie-workbench.html"), "utf8");

assert.match(office, /activityMode:"unproductive"/);
assert.match(office, /billingType:"unproductive"/);
assert.match(kristine, /row\.source === "kgo-office-core"/);
assert.match(kristine, /officeUnproductive \? "up"/);
assert.doesNotMatch(regie, /worktimeModelId&&String\(e\.worktimeModelId\)!=='krista-standard'/);
assert.match(regie, /activityMode!=='unproductive'/);
assert.match(regie, /material-table/);
assert.match(regie, /title="\$\{esc\(full\)\}"/);
assert.match(regie, /list="jobList"/);
assert.match(regie, /placeholder="Nummer oder Baustellenname tippen/);
assert.match(regie, /missingSale=!fixedSalePrice&&purchase>0&&rawSale<=0&&rawMarkup<=-100/);
console.log("OK: Bürozeit ist unproduktiv; eigene Zeitmodelle und Materiallayout stimmen.");
