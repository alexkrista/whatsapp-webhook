"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerRegieAssistant } = require("../regie-assistant");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "krista-regie-test-"));
const routes = new Map();
const app = {
  get(route, handler) { routes.set(`GET ${route}`, handler); },
  post(route, handler) { routes.set(`POST ${route}`, handler); },
};
let documentation = [];
let savedMeta = null;

registerRegieAssistant(app, {
  dataDir: temporaryRoot,
  publicDir: path.join(__dirname, "..", "public"),
  requireAdmin: () => true,
  readJobMeta: async () => ({ name: "Musterbaustelle", regieHourlyRate: 75, regieMaterialMarkup: 80 }),
  writeJobMeta: async (_jobId, patch) => { savedMeta = patch; return patch; },
  appendJobHistory: async () => {},
  readDocumentation: async () => documentation,
  writeDocumentation: async (_jobId, rows) => { documentation = rows; },
});

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const result = { statusCode: 200, body: null, type: "" };
    const res = {
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; resolve(result); },
      type(value) { result.type = value; return this; },
      send(body) { result.body = body; resolve(result); },
      sendFile(file) { result.body = file; resolve(result); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

(async () => {
  const save = routes.get("POST /kristine/api/regie-reports/save");
  const first = await invoke(save, { body: {
    finish: true,
    jobId: "26096",
    date: "2026-09-03",
    description: "Wand ausgebessert",
    hourlyRate: 75,
    materialMarkup: 80,
    employees: [{ id: "ma-1", name: "Max Muster", hours: 7.5 }],
    materials: [{ product: "Farbe", quantity: 2, unit: "kg", purchasePrice: 10, markup: 80, salePrice: 18 }],
    uploads: [{ name: "Original.pdf", data: "data:application/pdf;base64,JVBERi0xLjQ=" }],
  } });
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.report.reportNumber, "26096001");
  assert.equal(first.body.report.totals.laborHours, 7.5);
  assert.equal(first.body.report.totals.laborTotal, 562.5);
  assert.equal(first.body.report.totals.materialTotal, 36);
  assert.equal(first.body.report.totals.net, 598.5);
  assert.deepEqual(savedMeta, { regieHourlyRate: 75, regieMaterialMarkup: 80 });
  assert.equal(documentation.length, 1);
  assert.equal(documentation[0].employeeDetails[0].hours, 7.5);
  assert.equal(documentation[0].materials[0].cost, 36);
  assert.equal(first.body.report.attachments.length, 1);

  const second = await invoke(save, { body: {
    finish: false,
    jobId: "26096",
    date: "2026-09-03",
    description: "Zweiter Bericht",
    employees: [{ id: "ma-1", name: "Max Muster", from: "07:00", to: "12:00" }],
  } });
  assert.equal(second.body.report.reportNumber, "26096002");
  assert.equal(second.body.report.employees[0].hours, 5);

  const print = routes.get("GET /kristine/regie-report/:id/print");
  const printed = await invoke(print, { params: { id: first.body.report.id } });
  assert.equal(printed.type, "html");
  assert.match(printed.body, /Regiebericht/);
  assert.match(printed.body, /Max Muster/);
  assert.doesNotMatch(printed.body, /Gesamtübersicht/);

  console.log("OK: Regiebericht wird berechnet, nummeriert, archiviert und ohne Gesamtübersicht gedruckt.");
})().finally(() => {
  if (temporaryRoot.startsWith(os.tmpdir())) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
