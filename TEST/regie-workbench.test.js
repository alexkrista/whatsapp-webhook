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
let sentMail = null;

registerRegieAssistant(app, {
  dataDir: temporaryRoot,
  publicDir: path.join(__dirname, "..", "public"),
  requireAdmin: () => true,
  readJobMeta: async () => ({ name: "Musterbaustelle", contactName: "Familie Muster", contactEmail: "kunde@example.test", regieHourlyRate: 75, regieMaterialMarkup: 80 }),
  writeJobMeta: async (_jobId, patch) => { savedMeta = patch; return patch; },
  appendJobHistory: async () => {},
  readDocumentation: async () => documentation,
  writeDocumentation: async (_jobId, rows) => { documentation = rows; },
  sendRegieMail: async input => { sentMail = input; return { messageId: "mail-1" }; },
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

  const issue = routes.get("POST /kristine/api/regie");
  const mobileDraftBody = {
    draft: true,
    date: "2026-09-03",
    segment: { jobId: "26098", jobName: "Express", from: "07:00", to: "12:00" },
    hoursMode: "day",
    teamMode: "all",
    people: [{ id: "ma-1", name: "Max Muster" }],
    employees: [{ id: "ma-1", name: "Max Muster", from: "07:00", to: "12:00", netMinutes: 300 }],
    createdBy: { id: "ma-1", name: "Max Muster" },
    description: "Regie begonnen",
    materials: [{ materialId: "A02", product: "Spachtel", quantity: 2, unit: "kg", salePrice: 9, searchAlias: "feine spachtel" }, { product: "Unbekannte Grundierung", quantity: 1, unit: "Gebinde", provisional: true, unknownMaterialId: "unknown_test_1", regieEntryId: "kgo_test_1", labelPhotoName: "Material-kgo_test_1.jpg" }],
    uploads: [{ name: "entwurf.jpg", data: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" }, { name: "Material-kgo_test_1.jpg", data: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" }],
  };
  const mobileDraft = await invoke(issue, { body: mobileDraftBody });
  assert.equal(mobileDraft.statusCode, 200);
  assert.equal(mobileDraft.body.report.status, "draft");
  assert.equal(mobileDraft.body.report.processingStatus, "draft");
  assert.equal(mobileDraft.body.report.materials[0].searchAlias, "feine spachtel");
  assert.equal(mobileDraft.body.report.materials[1].provisional, true);
  assert.equal(mobileDraft.body.report.materials[1].unknownMaterialId, "unknown_test_1");
  assert.equal(mobileDraft.body.report.materials[1].labelPhotoName, "Material-kgo_test_1.jpg");
  assert.equal(mobileDraft.body.report.attachments.length, 2);
  const draftList = await invoke(routes.get("GET /kristine/api/regie/drafts"), { query: { employeeId: "ma-1", jobId: "26098", date: "2026-09-03" } });
  assert.equal(draftList.body.drafts[0].id, mobileDraft.body.report.id);
  const draftDay = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "26098", "2026", "09", "03", "regie.json"), "utf8"));
  assert.equal(draftDay.status, "Entwurf");
  assert.equal(draftDay.materials[0].name, "Spachtel");
  const completedDraft = await invoke(issue, { body: { ...mobileDraftBody, id: mobileDraft.body.report.id, draft: false, description: "Regie fertig" } });
  assert.equal(completedDraft.body.report.id, mobileDraft.body.report.id);
  assert.equal(completedDraft.body.report.processingStatus, "issued");
  assert.equal(completedDraft.body.report.materials[1].unknownMaterialId, "unknown_test_1");
  const completedDay = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "26098", "2026", "09", "03", "regie.json"), "utf8"));
  assert.equal(completedDay.status, "Ausgestellt");
  assert.equal(completedDay.materials.filter(row => row.reportId === mobileDraft.body.report.id).length, 2);

  const expressOne = await invoke(issue, { body: { ...mobileDraftBody, id: "", draft: false, segment: { ...mobileDraftBody.segment, jobId: "express_20260908_ma1_1" } } });
  const expressTwo = await invoke(issue, { body: { ...mobileDraftBody, id: "", draft: false, createdBy: { id: "ma-2", name: "Erika Beispiel" }, people: [{ id: "ma-2", name: "Erika Beispiel" }], employees: [{ id: "ma-2", name: "Erika Beispiel", from: "07:00", to: "12:00", netMinutes: 300 }], segment: { ...mobileDraftBody.segment, jobId: "express_20260908_ma2_2" } } });
  assert.equal(expressOne.body.report.reportNumber, "Express 202609001");
  assert.equal(expressTwo.body.report.reportNumber, "Express 202609002");
  const reportFile = path.join(temporaryRoot, "_kristine", "regie-reports.json");
  const legacyReports = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  legacyReports.find(row => row.id === expressOne.body.report.id).reportNumber = "express_20260908_ma1_1001";
  fs.writeFileSync(reportFile, JSON.stringify(legacyReports));
  const migratedReports = await invoke(routes.get("GET /kristine/api/regie-reports"), {});
  assert.equal(migratedReports.body.reports.find(row => row.id === expressOne.body.report.id).reportNumber, "Express 202609001");

  const issued = await invoke(issue, { body: {
    date: "2026-09-03",
    segment: { jobId: "26097", jobName: "Handybaustelle", from: "07:00", to: "16:00" },
    hoursMode: "day",
    teamMode: "all",
    people: [{ id: "ma-1", name: "Max Muster" }, { id: "ma-2", name: "Erika Beispiel" }],
    employees: [
      { id: "ma-1", name: "Max Muster", from: "07:00", to: "08:01", netMinutes: 61, hours: 1.02 },
      { id: "ma-2", name: "Erika Beispiel", from: "07:00", to: "08:30", netMinutes: 90, hours: 1.5 },
    ],
    createdBy: { id: "ma-1", name: "Max Muster" },
    description: "Zusatzfläche gestrichen",
    materials: [{ materialId: "A01", product: "Innenfarbe", quantity: 3, unit: "kg", salePrice: 12 }],
    uploads: [{ name: "regie.jpg", data: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" }],
  } });
  assert.equal(issued.statusCode, 200);
  assert.equal(issued.body.report.processingStatus, "issued");
  assert.equal(issued.body.report.billingStatus, "open");
  assert.equal(issued.body.report.employees[0].hours, 1.25, "61 Nettominuten müssen auf 1,25 h aufgerundet werden");
  assert.equal(issued.body.report.employees[1].hours, 1.5);
  assert.equal(issued.body.report.attachments.length, 1);
  const dayRegie = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "26097", "2026", "09", "03", "regie.json"), "utf8"));
  assert.equal(dayRegie.status, "Ausgestellt");
  assert.equal(dayRegie.materials[0].name, "Innenfarbe");
  const reviews = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "_kristine", "day-review-entries.json"), "utf8"));
  const issuedReview = reviews.find(row => row.reportId === issued.body.report.id);
  assert.equal(issuedReview.tag, "Regie");
  assert.equal(issuedReview.jobId, "26097");

  const changeStatus = routes.get("POST /kristine/api/regie-reports/:id/status");
  const approved = await invoke(changeStatus, { params: { id: issued.body.report.id }, body: { processingStatus: "approved", billingStatus: "open" } });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.report.status, "completed");
  assert.equal(approved.body.report.processingStatus, "approved");
  const recipients = await invoke(routes.get("GET /kristine/api/regie-reports/:id/recipients"), { params: { id: issued.body.report.id } });
  assert.equal(recipients.body.recipients[0].email, "kunde@example.test");
  const sent = await invoke(routes.get("POST /kristine/api/regie-reports/:id/send"), { params: { id: issued.body.report.id }, body: { to: "kunde@example.test" } });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.body.report.processingStatus, "sent");
  assert.equal(sentMail.to, "kunde@example.test");
  assert.equal(fs.readFileSync(sentMail.filePath).subarray(0, 4).toString(), "%PDF");

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
