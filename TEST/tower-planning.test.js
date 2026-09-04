"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { registerTowerPlanning, cleanPlan, calculatePlan, calculateActualHours } = require("../tower-planning");

test("Büro und Verwaltung zählen nicht zur produktiven Planung", () => {
  const employees = [
    { id: "maler", name: "Maler", role: "Maler", employmentPercent: 100, active: true },
    { id: "buero", name: "Büro", role: "Büro", employmentPercent: 100, active: true },
    { id: "verwaltung", name: "Verwaltung", team: "Verwaltung", employmentPercent: 50, active: true },
  ];
  const plan = cleanPlan({ employees: [
    { employeeId: "buero", employeeName: "Büro", monthlyPercent: Array(12).fill(100) },
  ] }, employees, 2026);
  assert.deepEqual(plan.employees.map(row => row.employeeId), ["maler"]);
  assert.equal(calculatePlan(plan).monthlyStaffFactor[0], 1);
});

test("Tower-Planung bildet die Werte der Referenzplanung ab", () => {
  const percentages = [100, 80, 100, 100, 100, 50, 70, 100, 100];
  const employees = percentages.map((employmentPercent, index) => ({
    id: `ma-${index + 1}`,
    name: `MA ${index + 1}`,
    employmentPercent,
    active: true,
  }));
  const plan = cleanPlan({}, employees, 2026);
  const result = calculatePlan(plan);

  assert.equal(result.monthlyStaffFactor[0], 8);
  assert.equal(result.monthlyPlanHours[0], 784.16);
  assert.equal(result.monthlyLaborRevenue[1], 57243.68);
  assert.equal(result.monthlyMaterialRevenue[1], 10303.86);
  assert.equal(result.monthlyPlanRevenue[1], 67547.54);
  assert.equal(result.monthlyPlanRevenue[0], result.monthlyWorkPlanRevenue[11]);
  assert.equal(result.annualPlanHours, 13628.16);
  assert.equal(result.annualPlanRevenue, 1173929.7);
  assert.equal(result.productiveHoursPerFte, 1703.52);
  assert.equal(result.targetProductivityPercent, 84);
});

test("Mitarbeiter-Prozente werden je Monat getrennt gerechnet", () => {
  const employees = [{ id: "1", name: "A", employmentPercent: 100, active: true }];
  const plan = cleanPlan({ employees: [{ employeeId: "1", monthlyPercent: [50, 100] }] }, employees, 2026);
  const result = calculatePlan(plan);

  assert.equal(result.monthlyStaffFactor[0], .5);
  assert.equal(result.monthlyStaffFactor[1], 1);
  assert.equal(result.monthlyGrossHours[0], 84.5);
  assert.equal(result.monthlyGrossHours[1], 169);
});

test("Umsatzplan verschiebt die Arbeitsleistung in den Folgemonat", () => {
  const employees = [{ id: "1", name: "A", employmentPercent: 100, active: true }];
  const plan = cleanPlan({
    billingRate: 100,
    materialPercent: 0,
    productivityPercent: [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50],
  }, employees, 2026);
  const result = calculatePlan(plan, { labor: 1234, material: 0 });

  assert.equal(result.monthlyPlanRevenue[0], 1234);
  assert.equal(result.monthlyPlanRevenue[1], result.monthlyWorkPlanRevenue[0]);
  assert.equal(result.monthlyPlanRevenue[2], 0);
  assert.equal(result.nextJanuaryPlanRevenue, result.monthlyWorkPlanRevenue[11]);
});

test("Stunden-Ist summiert abgeschlossene KRISZEIT-Arbeitsabschnitte", () => {
  const actual = calculateActualHours([
    { employeeId: "1", date: "2026-01-05", type: "start", at: "07:00" },
    { employeeId: "1", date: "2026-01-05", type: "pause", at: "10:00" },
    { employeeId: "1", date: "2026-01-05", type: "weiter", at: "10:15" },
    { employeeId: "1", date: "2026-01-05", type: "ende", at: "16:00" },
    { employeeId: "2", date: "2026-02-03", type: "start", at: "08:00" },
    { employeeId: "2", date: "2026-02-03", type: "ende", at: "12:30" },
    { employeeId: "1", date: "2025-01-05", type: "start", at: "07:00" },
    { employeeId: "1", date: "2025-01-05", type: "ende", at: "16:00" },
  ], 2026);

  assert.equal(actual[0], 8.75);
  assert.equal(actual[1], 4.5);
  assert.equal(actual.slice(2).reduce((sum, value) => sum + value, 0), 0);
});

test("Planungs-API speichert ein Jahr und liefert es wieder an den Tower", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krista-tower-plan-"));
  const app = express();
  app.use(express.json());
  registerTowerPlanning(app, {
    dataDir,
    requireAdmin: () => true,
    readEmployees: async () => [{ id: "ma-1", name: "MA 1", employmentPercent: 100, active: true }],
  });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const first = await fetch(`${base}/kristine/api/tower-plan?year=2027`).then(response => response.json());
  assert.equal(first.ok, true);
  assert.equal(first.plan.year, 2027);
  assert.equal(first.plan.employees.length, 1);

  first.plan.billingRate = 81;
  first.plan.productivityPercent[0] = 66;
  const saved = await fetch(`${base}/kristine/api/tower-plan`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan: first.plan }),
  }).then(response => response.json());
  assert.equal(saved.ok, true);
  assert.equal(saved.plan.billingRate, 81);

  const reloaded = await fetch(`${base}/kristine/api/tower-plan?year=2027`).then(response => response.json());
  assert.equal(reloaded.plan.billingRate, 81);
  assert.equal(reloaded.plan.productivityPercent[0], 66);
  assert.equal(reloaded.calculation.monthlyPlanRevenue[0], saved.calculation.monthlyPlanRevenue[0]);
});
