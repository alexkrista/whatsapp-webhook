"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "db");
const core = fs.readFileSync(path.join(root, "migrations", "001_core.sql"), "utf8");
const views = fs.readFileSync(path.join(root, "migrations", "002_hour_views.sql"), "utf8");
const controls = fs.readFileSync(path.join(root, "controls", "001_hours_consistency.sql"), "utf8");

for (const table of [
  "source_imports", "jobs", "job_collections", "job_collection_members",
  "employees", "job_budgets", "work_segments", "offers",
  "offer_documents", "offer_acceptances", "audit_log"
]) {
  assert.match(core, new RegExp(`CREATE TABLE IF NOT EXISTS kristine\\.${table}\\b`));
}

assert.match(core, /UNIQUE \(source_system, source_key\)/);
assert.match(core, /UNIQUE \(job_no\)/);
assert.match(core, /billing_type IN \('order', 'regie'\)/);
assert.match(core, /ON DELETE RESTRICT/g);

assert.match(views, /CREATE OR REPLACE VIEW kristine\.job_hour_summary_v1/);
assert.match(views, /WHEN f\.status = 'Auftrag' THEN f\.total_target_minutes/);
assert.match(views, /WHEN f\.status = 'Laufend' THEN GREATEST\(f\.total_target_minutes - f\.actual_total_minutes, 0\)/);
assert.match(views, /NOT EXISTS \([\s\S]*job_collection_members/);
assert.match(views, /CREATE OR REPLACE VIEW kristine\.portfolio_hour_kpi_v1/);

assert.match(controls, /FROM kristine\.portfolio_hour_rows_v1/);
assert.match(controls, /HAVING COUNT\(\*\) > 1/);

function openMinutes(status, target, actual) {
  if (status === "Auftrag") return target;
  if (status === "Laufend") return Math.max(0, target - actual);
  return 0;
}

assert.equal(openMinutes("Auftrag", 600, 120), 600);
assert.equal(openMinutes("Laufend", 600, 120), 480);
assert.equal(openMinutes("Laufend", 600, 720), 0);
assert.equal(openMinutes("Fertig – nicht abgerechnet", 600, 120), 0);

console.log("SQL foundation contract: OK");
