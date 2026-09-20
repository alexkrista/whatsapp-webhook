"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const topbarSource = fs.readFileSync(path.join(root, "public/ui/topbar.js"), "utf8");
const offerSource = fs.readFileSync(path.join(root, "public/ui/baustellen-offer-builder.js"), "utf8");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const response = (body) => ({ ok: true, text: async () => JSON.stringify(body) });

test("topbar replaces a failed existing offer-builder tag", () => {
  const dom = new JSDOM("<!doctype html><script src='/public/ui/baustellen-offer-builder.js?v=old' data-krista-angebot-v16='1' data-krista-load-state='error'></script>", {
    runScripts: "outside-only",
    url: "https://kristine.test/baustellen.html",
  });

  dom.window.eval(topbarSource);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));

  const scripts = [...dom.window.document.scripts].filter((script) => new URL(script.src).pathname === "/public/ui/baustellen-offer-builder.js");
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].getAttribute("data-krista-angebot"), "1");
  assert.match(scripts[0].src, /editor-context-1/);
  assert.equal(scripts[0].dataset.kristaLoadState, "loading");
});

test("topbar reuses an installed old offer-builder without duplicating it", () => {
  const dom = new JSDOM("<!doctype html><script src='/public/ui/baustellen-offer-builder.js?v=old' data-krista-angebot-v16='1'></script>", {
    runScripts:"outside-only", url:"https://kristine.test/baustellen.html",
  });
  dom.window.__kristaOfferBuilderInstalled = true;
  dom.window.eval(topbarSource);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  const scripts = [...dom.window.document.scripts].filter(script => new URL(script.src).pathname === "/public/ui/baustellen-offer-builder.js");
  assert.equal(scripts.length, 1);
  assert.match(scripts[0].src, /v=old/);
  assert.equal(scripts[0].getAttribute("data-krista-angebot"), "1");
});

test("topbar does not duplicate an offer-builder that is still loading", () => {
  const dom = new JSDOM("<!doctype html><script src='/public/ui/baustellen-offer-builder.js?v=old' data-krista-load-state='loading'></script>", {
    runScripts:"outside-only", url:"https://kristine.test/baustellen.html",
  });
  dom.window.eval(topbarSource);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  const scripts = [...dom.window.document.scripts].filter(script => new URL(script.src).pathname === "/public/ui/baustellen-offer-builder.js");
  assert.equal(scripts.length, 1);
  assert.match(scripts[0].src, /v=old/);
  assert.equal(scripts[0].getAttribute("data-krista-angebot"), "1");
});

test("offer-builder load error removes the tag and retries exactly once", async () => {
  const dom = new JSDOM("<!doctype html>", { runScripts:"outside-only", url:"https://kristine.test/baustellen.html" });
  dom.window.eval(topbarSource);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  const select = () => [...dom.window.document.scripts].filter(script => new URL(script.src).pathname === "/public/ui/baustellen-offer-builder.js");
  const first = select()[0];
  first.dispatchEvent(new dom.window.Event("error"));
  await wait(10);
  const second = select()[0];
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(second.dataset.kristaLoadState, "loading");
  second.dispatchEvent(new dom.window.Event("error"));
  await wait(10);
  assert.equal(select().length, 0);
});

test("offer builder initializes only once when evaluated twice", () => {
  const dom = new JSDOM("<!doctype html><div id='kcv2Host'></div>", {
    runScripts: "outside-only",
    url: "https://kristine.test/baustellen",
  });
  dom.window.KristaOfferNotepad = { apply() {}, mount() {} };

  dom.window.eval(offerSource);
  dom.window.eval(offerSource);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));

  assert.equal(dom.window.__kristaOfferBuilderInstalled, true);
  assert.equal(dom.window.document.querySelectorAll("#kofferCss").length, 1);
});

test("normal and wrapped save clicks PUT the owned draft and re-enable the button", async () => {
  const dom = new JSDOM("<!doctype html><button class='job-row' data-job='A'></button><button data-bk-tab='calculation'></button><div id='kcv2Host'></div>", {
    runScripts:"outside-only", url:"https://kristine.test/baustellen",
  });
  dom.window.KristaOfferNotepad = { apply() {}, mount() {}, prepareForSave() {} };
  const writes = [], draft = { version:3, offerNumber:"2609001", offerRevision:1, measurement:{}, positions:[] };
  dom.window.fetch = async (input, options = {}) => {
    const url = String(input), method = String(options.method || "GET").toUpperCase();
    if (url === "/admin/api/job/A/offer-draft" && method === "PUT") { writes.push(url); return response({ draft }); }
    if (url === "/admin/api/job/A/offer-draft") return response({ draft });
    if (url === "/admin/api/jobs") return response({ jobs:[{ jobId:"A", contactName:"Customer A" }] });
    if (url.includes("/accepted-order")) return response({ order:null, schedule:null });
    if (url === "/api/regie/materials") return response({ materials:[] });
    if (url === "/admin/api/offer-position-templates") return response({ templates:[] });
    if (url === "/admin/api/employees") return response({ employees:[] });
    throw new Error(`Unexpected request: ${url}`);
  };
  const startup = '  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{init();mountFreePositionUi();watchLivePreview()},{once:true});else{init();mountFreePositionUi();watchLivePreview()}';
  dom.window.eval(offerSource.replace(startup, `${startup};window.__directOfferSaveTest=save`));
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  dom.window.document.querySelector(".job-row").click();
  await wait(540);

  const button = dom.window.document.querySelector("#kofferSave");
  assert.equal(button.dataset.materialAuto, "1");
  button.click();
  await wait(40);
  assert.equal(writes.length, 1);
  assert.equal(button.disabled, false);
  assert.match(dom.window.document.querySelector("#kofferMsg").textContent, /Angebotsentwurf gespeichert/);

  await dom.window.__directOfferSaveTest(new dom.window.MouseEvent("click"));
  assert.equal(writes.length, 2);
  assert.equal(button.disabled, false);
  assert.match(dom.window.document.querySelector("#kofferMsg").textContent, /Angebotsentwurf gespeichert/);
});

test("a late response from an older job cannot replace the current offer", async () => {
  const dom = new JSDOM("<!doctype html><button class='job-row' data-job='A'></button><button class='job-row' data-job='B'></button><button data-bk-tab='calculation'></button><div id='kcv2Host'></div>", {
    runScripts: "outside-only",
    url: "https://kristine.test/baustellen",
  });
  dom.window.KristaOfferNotepad = { apply() {}, mount() {} };
  const pendingDrafts = new Map();
  dom.window.fetch = async (input) => {
    const url = String(input);
    const draftMatch = url.match(/\/admin\/api\/job\/([^/]+)\/offer-draft/);
    if (draftMatch) return new Promise((resolve) => pendingDrafts.set(draftMatch[1], resolve));
    if (url === "/admin/api/jobs") return response({ jobs: [
      { jobId: "A", contactName: "Customer A" },
      { jobId: "B", contactName: "Customer B" },
    ] });
    if (url.includes("/accepted-order")) return response({ order: null, schedule: null });
    if (url === "/api/regie/materials") return response({ materials: [] });
    if (url === "/admin/api/offer-position-templates") return response({ templates: [] });
    if (url === "/admin/api/employees") return response({ employees: [] });
    throw new Error(`Unexpected request: ${url}`);
  };

  dom.window.eval(offerSource);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  const [rowA, rowB] = dom.window.document.querySelectorAll(".job-row");
  rowA.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await wait(10);
  rowB.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await wait(530);

  pendingDrafts.get("B")(response({ draft: null }));
  await wait(20);
  assert.match(dom.window.document.querySelector("#koffer .bk-source").textContent, /Customer B/);

  pendingDrafts.get("A")(response({ draft: null }));
  await wait(20);
  assert.match(dom.window.document.querySelector("#koffer .bk-source").textContent, /Customer B/);
  assert.equal(dom.window.document.querySelectorAll("#koffer").length, 1);
});

test("saving stays blocked during a failed switch and an empty id clears the editor", async () => {
  const dom = new JSDOM("<!doctype html><button class='job-row' data-job='A'></button><button class='job-row' data-job='B'></button><button class='job-row' data-job=''></button><button data-bk-tab='calculation'></button><div id='kcv2Host'></div>", {
    runScripts: "outside-only",
    url: "https://kristine.test/baustellen",
  });
  dom.window.KristaOfferNotepad = { apply() {}, mount() {}, prepareForSave() {} };
  const pendingDrafts = new Map(), writes = [];
  dom.window.fetch = async (input, options = {}) => {
    const url = String(input), method = String(options.method || "GET").toUpperCase();
    const draftMatch = url.match(/\/admin\/api\/job\/([^/]+)\/offer-draft/);
    if (draftMatch && method === "PUT") {
      writes.push(draftMatch[1]);
      return response({ draft:{} });
    }
    if (draftMatch) return new Promise((resolve, reject) => pendingDrafts.set(draftMatch[1], { resolve, reject }));
    if (url === "/admin/api/jobs") return response({ jobs: [
      { jobId:"A", contactName:"Customer A" },
      { jobId:"B", contactName:"Customer B" },
    ] });
    if (url.includes("/accepted-order")) return response({ order:null, schedule:null });
    if (url === "/api/regie/materials") return response({ materials:[] });
    if (url === "/admin/api/offer-position-templates") return response({ templates:[] });
    if (url === "/admin/api/employees") return response({ employees:[] });
    throw new Error(`Unexpected request: ${url}`);
  };

  dom.window.eval(offerSource);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  const [rowA, rowB, emptyRow] = dom.window.document.querySelectorAll(".job-row");
  rowA.dispatchEvent(new dom.window.MouseEvent("click", { bubbles:true }));
  await wait(520);
  pendingDrafts.get("A").resolve(response({ draft:null }));
  await wait(30);
  assert.equal(dom.window.document.querySelector("#koffer").dataset.jobId, "A");

  rowB.dispatchEvent(new dom.window.MouseEvent("click", { bubbles:true }));
  await wait(520);
  const save = dom.window.document.querySelector("#kofferSave");
  assert.equal(save.disabled, true);
  save.click();
  assert.deepEqual(writes, []);

  pendingDrafts.get("B").reject(new Error("B unavailable"));
  await wait(30);
  assert.equal(dom.window.document.querySelector("#koffer").dataset.jobId, "A");
  assert.equal(dom.window.document.querySelector("#kofferSave").disabled, true);
  assert.match(dom.window.document.querySelector("#kofferMsg").textContent, /nicht geladen/);
  assert.deepEqual(writes, []);

  emptyRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles:true }));
  await wait(520);
  assert.equal(dom.window.document.querySelector("#koffer"), null);
  assert.deepEqual(writes, []);
});

test("accept dialog cannot create an order after its editor switches jobs", async () => {
  const dom = new JSDOM("<!doctype html><button class='job-row' data-job='A'></button><button class='job-row' data-job='B'></button><button data-bk-tab='calculation'></button><div id='kcv2Host'></div>", {
    runScripts:"outside-only",
    url:"https://kristine.test/baustellen",
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function (value = "") { this.returnValue = value; this.open = false; this.dispatchEvent(new dom.window.Event("close")); };
  dom.window.KristaOfferNotepad = { apply() {}, mount() {}, prepareForSave() {} };
  const pendingDrafts = new Map(), acceptedPosts = [];
  const offerDraft = { version:3, offerNumber:"2609001", offerRevision:1, offerSchedule:{ mode:"fixed", date:"2026-10-05", from:"07:00", to:"17:00" }, measurement:{}, financials:{}, positions:[] };
  dom.window.fetch = async (input, options = {}) => {
    const url = String(input), method = String(options.method || "GET").toUpperCase();
    const draftMatch = url.match(/\/admin\/api\/job\/([^/]+)\/offer-draft$/);
    if (draftMatch && method === "PUT") return response({ draft:offerDraft });
    if (draftMatch) return new Promise((resolve, reject) => pendingDrafts.set(draftMatch[1], { resolve, reject }));
    if (/\/offer-draft\/accept$/.test(url)) { acceptedPosts.push(url); return response({ order:{ offerNumber:"2609001", totals:{ net:100 } }, schedule:null }); }
    if (url === "/admin/api/jobs") return response({ jobs:[{ jobId:"A", contactName:"Customer A" },{ jobId:"B", contactName:"Customer B" }] });
    if (url.includes("/accepted-order")) return response({ order:null, schedule:null });
    if (url === "/api/regie/materials") return response({ materials:[] });
    if (url === "/admin/api/offer-position-templates") return response({ templates:[] });
    if (url === "/admin/api/employees") return response({ employees:[{ id:"employee-1", name:"Test" }] });
    throw new Error(`Unexpected request: ${url}`);
  };

  dom.window.eval(offerSource);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  const [rowA, rowB] = dom.window.document.querySelectorAll(".job-row");
  rowA.dispatchEvent(new dom.window.MouseEvent("click", { bubbles:true }));
  await wait(520);
  pendingDrafts.get("A").resolve(response({ draft:offerDraft }));
  await wait(80);

  const accepting = dom.window.KristaAcceptOffer();
  await wait(60);
  const dialog = dom.window.document.getElementById("kofferAcceptDialog");
  assert.ok(dialog?.open);

  rowB.dispatchEvent(new dom.window.MouseEvent("click", { bubbles:true }));
  await wait(520);
  dialog.querySelector('[data-order-employee]').checked = true;
  dialog.querySelector('button[value="accept"]').click();
  await accepting;
  assert.deepEqual(acceptedPosts, []);

  pendingDrafts.get("B").resolve(response({ draft:{ ...offerDraft, offerNumber:"2609002" } }));
  await wait(40);
  assert.equal(dom.window.document.querySelector("#koffer").dataset.jobId, "B");
  assert.deepEqual(acceptedPosts, []);
});

test("late preview A neither replaces nor revokes preview B", async () => {
  const dom = new JSDOM("<!doctype html><button class='job-row' data-job='A'></button><button class='job-row' data-job='B'></button><button data-bk-tab='calculation'></button><div id='kcv2Host'></div>", {
    runScripts:"outside-only", url:"https://kristine.test/baustellen",
  });
  dom.window.KristaOfferNotepad = { apply() {}, mount() {} };
  dom.window.KristaDocumentTemplate = node => node;
  const previews = [], revoked = [];
  let blobNumber = 0;
  dom.window.URL.createObjectURL = () => `blob:${++blobNumber}`;
  dom.window.URL.revokeObjectURL = value => revoked.push(value);
  const draft = id => ({ version:3, offerNumber:id, offerRevision:1, measurement:{}, financials:{}, positions:[] });
  dom.window.fetch = async (input) => {
    const url = String(input), match = url.match(/\/admin\/api\/job\/([^/]+)\/offer-draft$/);
    if (match) return response({ draft:draft(match[1]) });
    if (url === "/admin/api/jobs") return response({ jobs:[{ jobId:"A", contactName:"Customer A" },{ jobId:"B", contactName:"Customer B" }] });
    if (url.includes("/accepted-order")) return response({ order:null, schedule:null });
    if (url === "/api/regie/materials") return response({ materials:[] });
    if (url === "/admin/api/offer-position-templates") return response({ templates:[] });
    if (url === "/admin/api/employees") return response({ employees:[] });
    if (url === "/admin/api/document-layout/render") return new Promise(resolve => previews.push(resolve));
    throw new Error(`Unexpected request: ${url}`);
  };
  const startup = '  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{init();mountFreePositionUi();watchLivePreview()},{once:true});else{init();mountFreePositionUi();watchLivePreview()}';
  dom.window.eval(offerSource.replace(startup, `${startup};window.__offerPreviewTest=renderOfferPdfPreview`));
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  const [rowA, rowB] = dom.window.document.querySelectorAll(".job-row");
  rowA.click();
  await wait(560);
  const previewA = dom.window.__offerPreviewTest();
  await wait(10);

  rowB.click();
  await wait(560);
  const previewB = dom.window.__offerPreviewTest();
  await wait(10);
  assert.equal(previews.length, 2);

  previews[1]({ ok:true, blob:async()=>new dom.window.Blob(["B"], { type:"application/pdf" }) });
  await previewB;
  const currentFrame = dom.window.document.querySelector("#kofferLiveBody iframe");
  assert.equal(currentFrame.src, "blob:1");

  previews[0]({ ok:true, blob:async()=>new dom.window.Blob(["A"], { type:"application/pdf" }) });
  await previewA;
  assert.equal(dom.window.document.querySelector("#kofferLiveBody iframe").src, "blob:1");
  assert.deepEqual(revoked, []);
});
