"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { registerRegieAssistant } = require("../regie-assistant");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "krista-regie-test-"));
const routes = new Map();
const app = {
  get(route, handler) { routes.set(`GET ${route}`, handler); },
  post(route, handler) { routes.set(`POST ${route}`, handler); },
  delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
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
  assert.equal(first.body.report.reportSequence, 1);
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
  assert.equal(second.body.report.reportSequence, 2);
  assert.equal(second.body.report.employees[0].hours, 5);

  const remove = routes.get("DELETE /kristine/api/regie-reports/:id");
  const removed = await invoke(remove, { params: { id: second.body.report.id } });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.body.deleted, second.body.report.id);
  const protectedReport = await invoke(remove, { params: { id: first.body.report.id } });
  assert.equal(protectedReport.statusCode, 409);
  assert.match(protectedReport.body.error, /geschützt/);

  const individualRate = await invoke(save, { body: {
    finish: false,
    jobId: "26096",
    reportSequence: 7,
    date: "2026-09-03",
    description: "Eigener Stundensatz",
    hourlyRate: 75,
    employees: [{ id: "ma-1", name: "Max Muster", hours: 2, hourlyRate: 90 }],
  } });
  assert.equal(individualRate.body.report.reportNumber, "26096007");
  assert.equal(individualRate.body.report.totals.laborTotal, 180);

  const duplicate = await invoke(save, { body: {
    finish: false,
    jobId: "26096",
    reportSequence: 7,
    date: "2026-09-03",
    description: "Doppelte Nummer",
    employees: [{ id: "ma-1", name: "Max Muster", hours: 1 }],
  } });
  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.body.error, /bereits vergeben/);

  fs.mkdirSync(path.join(temporaryRoot, "_kristine"), { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, "_system"), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, "_system", "employees.json"), JSON.stringify([
    { id: "ma-real", name: "Max Muster", active: true },
  ]));
  fs.writeFileSync(path.join(temporaryRoot, "_kristine", "time-events.json"), JSON.stringify([
    { employeeId: "ma-real", employeeName: "", date: "2026-09-03", jobId: "26096", at: "07:00", type: "start" },
    { employeeId: "ma-real", employeeName: "", date: "2026-09-03", jobId: "26096", at: "12:37", type: "stop" },
  ]));
  fs.writeFileSync(path.join(temporaryRoot, "_kristine", "assignments.json"), JSON.stringify([
    { employeeId: "ma-real", employeeName: "Max Muster", date: "2026-09-03", jobId: "26096", from: "07:00", to: "17:00", hours: 10 },
  ]));
  const suggestions = await invoke(routes.get("GET /kristine/api/regie-reports/time-suggestions"), { query: { jobId: "26096", date: "2026-09-03" } });
  assert.equal(suggestions.body.suggestions.length, 1);
  assert.equal(suggestions.body.suggestions[0].name, "Max Muster");
  assert.equal(suggestions.body.suggestions[0].hours, 5.62);

  const print = routes.get("GET /kristine/regie-report/:id/print");
  const printed = await invoke(print, { params: { id: first.body.report.id } });
  assert.equal(printed.type, "html");
  assert.match(printed.body, /Regiebericht/);
  assert.match(printed.body, /Max Muster/);
  assert.match(printed.body, /Nr\. 1 vom/);
  assert.match(printed.body, /Durchgeführte Arbeiten/);
  assert.match(printed.body, /Stundensatz/);
  assert.match(printed.body, />Ort, Datum</);
  assert.match(printed.body, />Auftraggeber</);
  assert.doesNotMatch(printed.body, /<th>Lieferant<\/th>/);
  assert.doesNotMatch(printed.body, /Rapport Nr\./);
  assert.doesNotMatch(printed.body, /<strong>Baustelle<\/strong>/);
  assert.doesNotMatch(printed.body, /Gesamtübersicht/);

  if (process.env.REGIE_PRINT_FIXTURE_DIR) {
    const fixtureDir = path.resolve(process.env.REGIE_PRINT_FIXTURE_DIR);
    fs.mkdirSync(fixtureDir, { recursive: true });
    const publicAsset = relative => pathToFileURL(path.join(__dirname, "..", "public", relative)).href;
    const logoAsset = pathToFileURL(path.join(__dirname, "..", "krista-logo.png")).href;
    const standalone = html => html
      .replaceAll("/public/krista-logo.png", logoAsset)
      .replaceAll("/public/fonts/TitilliumWeb-Regular.ttf", publicAsset(path.join("fonts", "TitilliumWeb-Regular.ttf")))
      .replaceAll("/public/fonts/TitilliumWeb-SemiBold.ttf", publicAsset(path.join("fonts", "TitilliumWeb-SemiBold.ttf")));
    fs.writeFileSync(path.join(fixtureDir, "regie-one-page.html"), standalone(printed.body));

    const longReport = await invoke(save, { body: {
      finish: false,
      jobId: "26096",
      reportSequence: 8,
      date: "2026-09-03",
      description: "Ausführliche Arbeiten mit mehreren Materialzeilen zur Prüfung des sauberen Seitenumbruchs.",
      employees: [{ id: "ma-1", name: "Max Muster", from: "07:00", to: "12:00", hourlyRate: 82 }],
      materials: Array.from({ length: 34 }, (_, index) => ({ product: `Prüfmaterial ${index + 1}`, quantity: index + 1, unit: "Stk", salePrice: 2.5 })),
    } });
    const longPrinted = await invoke(print, { params: { id: longReport.body.report.id } });
    fs.writeFileSync(path.join(fixtureDir, "regie-multi-page.html"), standalone(longPrinted.body));
  }

  console.log("OK: Regiebericht wird berechnet, nummeriert, archiviert und ohne Gesamtübersicht gedruckt.");
})().finally(() => {
  if (temporaryRoot.startsWith(os.tmpdir())) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
