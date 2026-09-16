"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "archive-connector.py"), "utf8");

assert.match(source, /CREATE TABLE IF NOT EXISTS brain_customer_links/);
assert.match(source, /def customer_link_members\(customer_index, con=None\):/);
assert.match(source, /def link_customers\(customer_indices\):/);
assert.match(source, /UPDATE brain_contacts SET entity_id=\?, updated_at=\?/);
assert.match(source, /WHERE p\.KundenIndex IN \(\{placeholders\}\)/);
assert.match(source, /"customerIndexes": linked_customer_indices/);
assert.match(source, /Linked WW records are one visible Brain customer/);
assert.match(source, /key = f"linked:\{linked\[0\]\}"/);
assert.match(source, /@app\.post\("\/project\/customer-links"\)/);

assert.match(source, /Doppelte Kunden verbinden/);
assert.match(source, /Zum Verbinden markieren/);
assert.match(source, /async function connectMarkedProjectCustomers\(\)/);
assert.match(source, /fetch\('\/project\/customer-links',\{method:'POST'/);
assert.match(source, /WinWorker wird dabei nicht verändert/);
assert.match(source, /Kunden verbunden/);

const browserBlock = source.match(/(function renderProjectAddressCandidates\(\)[\s\S]*?)(?=\r?\nfunction renderProjectCustomerOverview)/)?.[1];
assert.ok(browserBlock, "customer link browser code not found");
assert.doesNotThrow(() => new Function(browserBlock));

console.log("brain customer link tests passed");
