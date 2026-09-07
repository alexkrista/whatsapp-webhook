"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { employeeScheduledToWork } = require("../task-digest");

test("08:30-Aufgabenliste beachtet freie Tage aus dem Zeitmodell", () => {
  const employee = { id: "edmund-mock-mreyk5vk-k27g", name: "Edmund Mock", worktimeModelId: "edmund" };
  const models = [{
    id: "edmund",
    seasons: [{
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      weekdays: {
        "1": { free: true, from: "", to: "", targetHours: 0 },
        "2": { free: false, from: "07:00", to: "17:00", targetHours: 9.25 },
      },
    }],
  }];

  assert.equal(employeeScheduledToWork(employee, "2026-09-07", models), false, "Montag ist laut Modell frei");
  assert.equal(employeeScheduledToWork(employee, "2026-09-08", models), true, "Dienstag ist Arbeitstag");
});

test("Zeitmodell Version 2 erkennt fehlende Planung am Montag als frei", () => {
  const employee = { id: "edi", worktimeModelId: "edi-v2" };
  const models = [{
    id: "edi-v2",
    configured: true,
    timeModelVersion: 2,
    blocks: { planning: { rows: [{ days: [2, 3, 4, 5], from: "07:00", to: "17:00" }] } },
  }];

  assert.equal(employeeScheduledToWork(employee, "2026-09-07", models), false);
  assert.equal(employeeScheduledToWork(employee, "2026-09-08", models), true);
});
