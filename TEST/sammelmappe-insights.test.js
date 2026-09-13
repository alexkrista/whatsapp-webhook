"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const I = require("../public/ui/sammelmappe-insights"), D = require("../public/ui/baustellen-data"), B = require("../public/ui/regie-billing-state");
const root = path.join(__dirname, "..");
const report = (jobId, extra = {}) => ({ jobId, projectNumber: jobId, type: "regie_report", source: "WW", sourceId: jobId + "-report-6", reportNumber: "M 06", sheetNumber: "6", reportDate: "2026-02-09", totalHours: 31.5, laborCost: 2520, materialCost: 219.54, totalNet: 2739.54, description: "Wände vorbereiten\nZweiter Anstrich", employeeDetails: [{ name: "Max", hours: 31.5, cost: 2520 }], materials: [{ sourceId: "paint-line", name: "Wandfarbe", quantity: 15, unit: "l", unitPrice: 14.636, cost: 219.54, purchaseUnitPrice: 8, purchaseCost: 120 }], ...extra });

test("same report number in different projects keeps materials separate, WW plus PDF counts once", () => {
  const ww = report("25047"), pdf = { ...ww, source: "PDF", sourceId: undefined, url: "/admin/api/job/25047/documentation/signed.pdf" };
  const unique = B.dedupeReports([ww, pdf, report("26018")]);
  const materials = I.reportMaterials(unique);
  assert.equal(unique.length, 2); assert.equal(materials.items.length, 2);
  assert.equal(materials.sales, 439.08); assert.equal(materials.purchase, 240);
  assert.deepEqual(materials.items.map(row => row.jobId).sort(), ["25047", "26018"]);
  assert.equal(unique.find(row => row.jobId === "25047").url, pdf.url);
});

test("unknown purchase prices and flat material amounts are not treated as zero-cost known material", () => {
  const unknown = report("25047", { materials: [{ name: "Farbe", quantity: 3, cost: 30, purchaseCost: 0, purchaseUnitPrice: 0 }], materialCost: 30 });
  const result = I.reportMaterials([unknown, report("26018", { materials: [], materialFlatPercent: 10, materialCost: 70 })]);
  assert.equal(result.items[0].purchaseCost, null); assert.equal(result.missing.length, 2); assert.equal(result.flat[0].percent, 10);
  assert.equal(result.sales, 100); assert.equal(result.purchase, 0);
});

test("all member material sources are visible without adding stock evidence to report costs", () => {
  const rows = [{ jobId: "25047", job: { surfaceMaterialMeta: [{ custom: true, name: "Spachtel", quantity: 2, unit: "kg" }] }, regies: [{ day: "2026-02-09", regie: { materials: [{ name: "Farbe", quantity: "1,5", unit: "l" }], specialMaterial: "Farbton Altbestand" } }] }];
  const materials = I.additionalMaterials(rows, [{ jobId: "26018", source: "innovatint-history", product: "Farbe", colourTone: "Blau", liters: 15, component: "Bad" }]);
  assert.equal(materials.length, 4); assert.equal(materials.find(row => row.source === "Mischmaschine").jobId, "26018");
  assert.equal(materials.find(row => row.source === "Tageserfassung").quantity, "1,5");
  assert.equal(I.reportMaterials([report("25047")]).purchase, 120);
});

test("month bars cross year boundaries, retain empty months and reconcile undated hours exactly", () => {
  const chart = I.monthlyHours([{ date: "2025-12-03", hours: 8 }, { date: "2026-02-05", hours: 3.75 }, { date: "2026-02-06", hours: 4.25 }], 18, 15);
  assert.deepEqual(chart.months.map(row => [row.month, row.hours]), [["2025-12", 8], ["2026-01", 0], ["2026-02", 8]]);
  assert.equal(chart.first, "2025-12-03"); assert.equal(chart.dated + chart.unassigned, chart.total); assert.equal(chart.balance, -3);
  assert.equal(chart.unassigned, 2); assert.equal(chart.months[2].cumulative, 16);
  // Hours supplied by the fusion already contain the pause deduction.
  assert.equal(I.monthlyHours([{ date: "2026-02-09", hours: 7.75 }], 7.75, 10).months[0].hours, 7.75);
  assert.equal(I.monthlyHours([{ date: "2026-02-09", hours: 9 }], 8, 10).consistent, false);
  assert.equal(I.monthlyHours([], 0, 0).months.length, 0);
});

test("revenue/hour uses issued net increments, latest versions, signed credits and one total denominator", () => {
  const data = { rows: [{ errors: [], job: { calculation: { materialAmount: 1000 } } }], billing: { partial: false, invoices: [
    { jobId: "25047", invoiceNumber: "TR-1", id: 1, status: "issued", net: 900, changedAt: "2026-02-01" },
    { jobId: "25047", invoiceNumber: "TR-1", id: 2, status: "issued", net: 1000, changedAt: "2026-02-02" },
    { jobId: "26018", invoiceNumber: "SR-1", status: "issued", net: 500 },
    { jobId: "26018", invoiceNumber: "GS-1", status: "issued", net: -100 },
    { jobId: "26018", invoiceNumber: "draft", status: "draft", net: 9999 }
  ] } };
  const cost = { total: 500, totalHours: 20, ratesAvailable: true, rows: [{ matched: true }] }, snapshot = { total: 20, complete: true }, material = I.reportMaterials([report("25047")]);
  const value = I.economy(data, snapshot, cost, material, true);
  assert.equal(value.revenue, 1400); assert.equal(value.revenuePerHour, 70);
  assert.equal(value.materialEk, 720); assert.equal(value.profit, 180); assert.equal(value.profitPerHour, 9);
  assert.equal(I.economy(data, { ...snapshot, total: 0 }, cost, material, true).revenuePerHour, null);
  assert.equal(I.economy(data, { ...snapshot, complete: false }, cost, material, true).revenuePerHour, null);
  assert.equal(I.economy(data, snapshot, { ...cost, totalHours: 19 }, material, true).profit, null);
  assert.equal(I.economy(data, snapshot, cost, { ...material, missing: [{}] }, true).profit, null);
});

function page(responder) {
  const elements = {};
  for (const match of fs.readFileSync(path.join(root, "public/sammelmappe.html"), "utf8").matchAll(/id="([^"]+)"/g)) elements[match[1]] = { textContent: "", innerHTML: "", open: false, disabled: false, classList: { toggle() {} }, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener() {} };
  const listeners = new Map(), document = { readyState: "loading", getElementById: id => elements[id], addEventListener: (type, fn) => listeners.set(type, fn) };
  const snapshot = { total: 63, target: 100, ww: 63, kristine: 0, remaining: 37, overrun: 0, complete: true, memberHours: ["25047", "26018"].map(jobId => ({ jobId, total: 31.5, target: 50 })) };
  const window = { BaustellenData: D, KristaRegieBilling: B, SammelmappeInsights: I, BaustellenLiveHours: { summary: () => snapshot, sourceStatus: () => ({ label: "aktuell" }) }, BaustellenSources: { performance: () => null } };
  const source = fs.readFileSync(path.join(root, "public/ui/sammelmappe.js"), "utf8").replace("  function boot() {", "  window.previewTest={openReport,renderDocuments,renderHours,loadSavedView,loadMaterialBookings,openAddMember,addMember,set(j,c,d,g=0){jobs=j;collection=c;data=d;dataGeneration=g},setSaved(view,at){savedView=view;savedAt=at}};\n  function boot() {");
  const requests = [];
  const fetch = async (raw, init = {}) => { const url = new URL(raw, "https://protokoll.krista.at"); requests.push(url); return { ok: true, json: async () => responder ? responder(url, init) : ({ items: [{ product: "Wandfarbe", liters: 5 }] }) }; };
  elements.memberSearch.focus = () => {};
  vm.runInNewContext(source, { window, document, location: { origin: "https://protokoll.krista.at", search: "?token=test-token", hash: "#S24177", reload() { window.reloaded = true; } }, URL, URLSearchParams, Intl, Date, fetch, AbortSignal });
  return { window, elements, requests, snapshot };
}

test("quick preview opens the clicked original project and safely displays work, employees, material and optional PDF", async () => {
  const { window, elements, requests } = page(), api = window.previewTest;
  const a = report("25047", { description: '<img src=x onerror="bad()">\nArbeit', url: "/admin/api/job/25047/documentation/original.pdf" }), b = report("26018", { url: "javascript:bad()", materials: [], materialCost: 30 });
  const rows = [a, b].map(report => ({ jobId: report.jobId, documents: [report], errors: [], regies: [], regieSources: [], billingSources: [], job: {} })), data = { rows, billing: { invoices: [], summary: {} }, documents: [] };
  api.set([], { jobId: "S24177", kind: "collection", collectionMemberJobIds: ["25047", "26018"] }, data); api.renderDocuments();
  assert.equal((elements.collectionReports.innerHTML.match(/data-report-preview=/g) || []).length, 2);
  api.openReport(0); assert.equal(elements.reportPreview.open, true);
  assert(elements.reportPreviewReference.innerHTML.includes("#25047"));
  assert(elements.reportPreviewBody.innerHTML.includes("Wandfarbe")); assert(elements.reportPreviewBody.innerHTML.includes("Max"));
  assert(elements.reportPreviewBody.innerHTML.includes("&lt;img")); assert(!elements.reportPreviewBody.innerHTML.includes("<img"));
  assert(elements.reportPreviewBody.innerHTML.includes("original.pdf?token=test-token"));
  api.openReport(1); assert(elements.reportPreviewReference.innerHTML.includes("#26018"));
  assert(elements.reportPreviewBody.innerHTML.includes("einzelne Materialien")); assert(!elements.reportPreviewBody.innerHTML.includes("javascript:"));
  assert(!elements.reportPreviewBody.innerHTML.includes("<iframe")); assert.equal(elements.nextReport.disabled, true);
  api.openReport(-1); assert.equal(elements.reportPreviewPosition.textContent, "2 / 2");
  await api.loadMaterialBookings(0);
  assert.deepEqual(requests.map(url => url.searchParams.get("jobId")).sort(), ["25047", "26018"]);
  assert(!requests.some(url => url.pathname.includes("/S24177"))); assert(elements.additionalMaterials.innerHTML.includes("Wandfarbe"));
});

test("saved collection numbers appear before refresh and do not flash partial new totals", () => {
  const { window, elements, snapshot } = page(), api = window.previewTest;
  const jobs = ["25047", "26018"].map(jobId => ({ jobId, name: jobId }));
  const collection = { jobId: "S24177", name: "Test", kind: "collection", collectionMainJobId: "25047", collectionMemberJobIds: jobs.map(row => row.jobId) };
  const data = { rows: jobs.map(job => ({ job, jobId: job.jobId, documents: [report(job.jobId)], errors: [], regies: [], regieSources: [], billingSources: [] })), billing: { invoices: [], summary: {}, partial: false }, documents: [] };
  api.setSaved({ jobs, collection, data, hours: structuredClone(snapshot), bookings: [], bookingsReady: true, bookingFailures: 0, performance: null }, "2026-09-13T14:00:00Z");
  snapshot.total = 0; snapshot.complete = false;
  api.renderHours(); assert.equal(elements.collectionActual.textContent, "63 h");
  assert(elements.collectionStatus.textContent.includes("Gespeicherter Stand:"));
  assert(elements.collectionStatus.textContent.includes("2/2 Akten geprüft"));
  api.set(jobs, collection, data); api.renderHours(); assert.equal(elements.collectionActual.textContent, "63 h");
  snapshot.total = 70; snapshot.complete = true; snapshot.remaining = 30;
  api.renderHours(); assert.equal(elements.collectionActual.textContent, "70 h");
});

test("a closed KRISTINE-only job can join a collection and existing members are retained", async () => {
  const jobs = [{ jobId: "24177", name: "Hauptakte" }, { jobId: "26018", name: "Weitere Akte" }, { jobId: "christian_lutz", name: "Christian Lutz", status: "Geschlossen" }, { jobId: "25047", name: "Gerade hinzugefügt" }];
  let read = 0, written;
  const { window, elements } = page((url, init) => {
    if (url.pathname === "/admin/api/jobs") return { jobs, collections: [{ jobId: "S24177", kind: "collection", collectionMemberJobIds: ++read > 1 ? ["24177", "26018", "25047"] : ["24177", "26018"] }] };
    assert.equal(url.pathname, "/admin/api/job/S24177/collection"); assert.equal(init.method, "PUT"); written = JSON.parse(init.body); return { ok: true };
  });
  await window.previewTest.openAddMember();
  assert(elements.memberChoice.innerHTML.includes("Christian Lutz")); assert(!elements.memberChoice.innerHTML.includes("Hauptakte"));
  elements.memberChoice.value = "christian_lutz"; await window.previewTest.addMember();
  assert.deepEqual(written.memberJobIds, ["24177", "26018", "25047", "christian_lutz"]);
  assert.deepEqual(Object.keys(written), ["memberJobIds"]); assert.equal(jobs[2].status, "Geschlossen"); assert.equal(window.reloaded, true);
});

test("a saved view arriving after document data is still used while the hours refresh is pending",async()=>{
  const jobs=["25047","26018"].map(jobId=>({jobId,name:jobId})),collection={jobId:"S24177",kind:"collection",name:"Test",collectionMainJobId:"25047",collectionMemberJobIds:jobs.map(row=>row.jobId),registryUpdatedAt:"2026-09-13T12:00:00Z"};
  const data={rows:jobs.map(job=>({job,jobId:job.jobId,documents:[],errors:[],regies:[],regieSources:[],billingSources:[]})),billing:{invoices:[],summary:{},partial:false},documents:[]};
  let saved;
  const {window,elements,snapshot}=page(()=>({snapshot:saved}));
  saved={version:1,savedAt:"2026-09-13T14:00:00Z",view:{jobs,collection,data,hours:structuredClone(snapshot),bookings:[],bookingsReady:true,bookingFailures:0,performance:null}};
  snapshot.total=0;snapshot.complete=false;
  window.previewTest.set(jobs,collection,data,1);
  await window.previewTest.loadSavedView();assert.equal(elements.collectionActual.textContent,"63 h");assert.match(elements.collectionStatus.textContent,/Gespeicherter Stand/);
});
