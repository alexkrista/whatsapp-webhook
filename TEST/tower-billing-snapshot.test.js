"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const snapshot = fs.readFileSync(path.join(root, "brain_tower_billing_snapshot.py"), "utf8");
const outgoing = fs.readFileSync(path.join(root, "brain_outgoing_invoices.py"), "utf8");
const incoming = fs.readFileSync(path.join(root, "brain_incoming_op.py"), "utf8");
const archive = fs.readFileSync(path.join(root, "archive-connector.py"), "utf8");
const tower = fs.readFileSync(path.join(root, "public", "ui", "tower-baustellen-signals.js"), "utf8");
const topbar = fs.readFileSync(path.join(root, "public", "ui", "topbar.js"), "utf8");

assert.match(snapshot, /ACTIVE_BILLING_STATUSES = \{"Auftrag", "Laufend", "Fertig – nicht abgerechnet"\}/);
assert.match(snapshot, /collectionMemberJobIds/);
assert.match(snapshot, /before_date=cutoff_exclusive/);
assert.match(snapshot, /reportDate/);
assert.match(snapshot, /hour=2, minute=30/);
assert.match(snapshot, /methods=\["GET", "POST", "OPTIONS"\]/);
assert.match(snapshot, /temporary\.replace\(path\)/);
assert.match(outgoing, /def project_recorded_hours_net\(project_number, before_date=None, project=None\)/);
assert.match(outgoing, /cutoff and day >= cutoff/);
assert.match(incoming, /_tower_billing_snapshot_install\(ns\)/);
assert.match(archive, /"\/tower\/billing-snapshot"/);
assert.match(archive, /"version": "0\.14\.79"/);
assert.match(tower, /brainApi\('\/tower\/billing-snapshot',240000,\{method:'POST'/);
assert.match(tower, /hoursThroughDate:billingThroughDate/);
assert.match(tower, /href="\$\{tokenUrl\('\/kristine\/baustellen'\)\}#\$\{encodeURIComponent\(row\.job\.jobId\)\}"/);
assert.match(tower, /billingReady\?money\(total\)/);
assert.match(tower, /row\.amountToInvoice!==null\?B\.formatMoney\(row\.amountToInvoice\)/);
assert.match(topbar, /tower-baustellen-signals\.js\?v=20260915-billing-snapshot-5/);

console.log("OK: Tower-Abrechnungsstand ist nachts gespeichert, manuell aktualisierbar und bis Vortag begrenzt.");
