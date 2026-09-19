"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { registerKristine } = require("../kristine");

test("Aufgaben speichern Namen und Adresse in strukturierten Stammdaten statt in der Beschreibung", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krista-task-master-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const app = express();
  app.use(express.json());
  registerKristine(app, {
    dataDir,
    publicDir: path.join(__dirname, "../public"),
    requireAdmin: () => true,
    readEmployees: async () => [],
    readJobMeta: async () => ({}),
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/kristine/api/tasks`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks: [{
      id: "task-1",
      title: "Fenster streichen",
      address: "Im Tobel 14, 6820 Frastanz",
      contactName: "Egon Beispiel",
      contactPhone: "+43 664 123",
      contactEmail: "egon@example.at",
      reminder: "Fenster außen prüfen und streichen.",
      customerMaster: { role: "customer", name: "Egon Beispiel", address: "Alte Straße 1, 6800 Feldkirch" },
    }] }),
  });
  assert.equal(response.status, 200);
  const task = (await response.json()).tasks[0];
  assert.equal(task.customerMaster.name, "Egon Beispiel");
  assert.equal(task.customerMaster.street, "Im Tobel");
  assert.equal(task.customerMaster.houseNumber, "14");
  assert.equal(task.customerMaster.postalCode, "6820");
  assert.equal(task.customerMaster.city, "Frastanz");
  assert.equal(task.customerMaster.addressExtra, "");
  assert.equal(task.projectContacts.owner.customer, "Egon Beispiel");
  assert.equal(task.reminder, "Fenster außen prüfen und streichen.");
  assert(!task.reminder.includes("Im Tobel"));
});
