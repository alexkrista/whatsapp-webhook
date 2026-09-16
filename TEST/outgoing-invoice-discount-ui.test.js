"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "..", "brain_outgoing_invoices.py"), "utf8");

assert.match(source, /if\(document\.activeElement!==field\)field\.value=values\.length===1\?values\[0\]:''/);
assert.match(source, /addReportDiscountControls\(\);decorateRegieEditor\(\);updateInvoiceLiveTotals\(\)/);
assert.match(source, /decorateRegieEditor\(\);updateInvoiceLiveTotals\(\)\}\);label\.append/);

console.log("outgoing invoice discount UI checks passed");
