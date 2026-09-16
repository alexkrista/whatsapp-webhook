"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { registerPaintMixHistory } = require("../paint-mix-history");

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mix-task-repair-"));
  await fs.mkdir(path.join(dir, "_system"), { recursive: true });
  await fs.writeFile(path.join(dir, "_system", "employees.json"), JSON.stringify([
    { id: "alex-real", name: "Alexander Krista", active: true },
  ]));

  process.env.ADMIN_TOKEN = "";
  process.env.KRISTINE_LG_BRIDGE_TOKEN = "test";
  const routes = {};
  const app = {
    get: (route, handler) => { routes[`GET ${route}`] = handler; },
    post: (route, handler) => { routes[`POST ${route}`] = handler; },
  };
  registerPaintMixHistory(app, { dataDir: dir });

  async function call(method, route, body = {}, headers = {}) {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
    };
    await routes[`${method} ${route}`]({ body, query: {}, params: {}, headers }, res);
    return res;
  }

  const row = {
    id: "mix-from-2026-09-15",
    completedAt: "2026-09-15T14:30:00Z",
    productName: "Absolute Matt Emulsion",
    baseCode: "LG-W",
    size: "2.5 L",
    colourCode: "French Grey",
    quantity: 1,
  };
  const bridgeHeaders = { "x-lg-bridge-token": "test" };
  const first = await call("POST", "/admin/api/paint/bridge/history", { rows: [row] }, bridgeHeaders);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.tasksCreated, 1);

  const tasksFile = path.join(dir, "_kristine", "tasks.json");
  let tasks = JSON.parse(await fs.readFile(tasksFile, "utf8"));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].assigneeId, "alex-real");
  assert.equal(tasks[0].assigneeName, "Alexander Krista");

  tasks[0].assigneeId = "";
  tasks[0].assigneeName = "";
  await fs.writeFile(tasksFile, JSON.stringify(tasks));
  const repaired = await call("POST", "/admin/api/paint/bridge/history", { rows: [row] }, bridgeHeaders);
  assert.equal(repaired.body.added, 0);
  assert.equal(repaired.body.tasksCreated, 0);
  assert.equal(repaired.body.tasksRepaired, 1);
  tasks = JSON.parse(await fs.readFile(tasksFile, "utf8"));
  assert.equal(tasks[0].assigneeId, "alex-real");

  await fs.writeFile(tasksFile, "[]");
  const recreated = await call("POST", "/admin/api/paint/bridge/history", { rows: [row] }, bridgeHeaders);
  assert.equal(recreated.body.added, 0);
  assert.equal(recreated.body.tasksCreated, 1);
  tasks = JSON.parse(await fs.readFile(tasksFile, "utf8"));
  assert.equal(tasks.length, 1);

  await fs.writeFile(tasksFile, "[]");
  const manualRepair = await call("POST", "/admin/api/paint/mix-history/tasks/repair");
  assert.equal(manualRepair.body.created, 1);
  tasks = JSON.parse(await fs.readFile(tasksFile, "utf8"));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].assigneeName, "Alexander Krista");

  console.log("paint mix task repair passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
