"use strict";
// Browser regression test: install jsdom in a test environment before running.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

(async () => {
  const dom = new JSDOM('<div class="tabs"></div><div class="wrap"></div>', {
    url: "https://example.test/paint", runScripts: "outside-only",
  });
  const w = dom.window;
  const observers = [];
  const Observer = w.MutationObserver;
  w.MutationObserver = class extends Observer {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const el = (id) => w.document.getElementById(id);
  const requests = [];
  let failBooking = false;
  let item = { id: "R-7", returnNo: 7, manufacturer: "Little Greene", material: "Matt", colour: "Stock", weightKg: 3.4, jobId: "A", jobName: "Alt", revision: 0, history: [], createdAt: "2026-09-01T10:00:00Z" };
  const response = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data, clone: () => response(data, ok) });
  w.fetch = async (url, options = {}) => {
    const u = new URL(url, w.location.href);
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ path: u.pathname, query: u.searchParams.toString(), method: options.method || "GET", body });
    if (u.pathname.endsWith("/remove")) { item = {...item, status: body.reason, revision: item.revision + 1}; return response({ok:true,item}); }
    if (u.pathname === "/health") return response({ scale: { available: true }, printer: { available: true } });
    if (u.pathname === "/print" || u.pathname.endsWith("/ack")) return response({ ok: true });
    if (u.pathname.endsWith("/jobs")) return response({ jobs: [{ id: "A", name: "Alt" }, { id: "B", name: "Neu" }] });
    if (u.pathname.endsWith("/materials")) return response({ materials: [] });
    if (u.pathname.endsWith("/lookup")) return response({ known: true, material: { manufacturer: "Little Greene", material: "Matt" } });
    if (u.pathname.endsWith("/update")) {
      item = { ...item, ...body, revision: 1, history: [{ changedAt: "2026-09-10T10:00:00Z", before: { weightKg: item.weightKg, jobId: item.jobId, jobName: item.jobName }, after: body }] };
      return response({ ok: true, item });
    }
    if (options.method === "POST") {
      if (failBooking) return response({ error: "Testfehler" }, false);
      return response({ ok: true, item: { ...item, returnNo: 8 }, printJob: { id: "print-new", big: "8", small: "10.09.2026" } });
    }
    return response({ items: item.status && item.status !== "available" && u.searchParams.get("includeUsed") !== "1" ? [] : [item], manufacturers:["Little Greene","Sto"] });
  };
  w.localStorage.setItem("kristineReturnJob", JSON.stringify({ id: "STALE", name: "Falsch" }));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    for (const file of ["paint-return-stock-ui.js", "paint-return-local-hardware-ui.js", "paint-return-enhancements-ui.js"])
      w.eval(fs.readFileSync(path.join(__dirname, "../public", file), "utf8"));
    el("returnStockTabBtn").click();
    await tick();
    assert.equal(w.localStorage.getItem("kristineReturnJob"), null);
    assert.equal(el("returnProjectValue").textContent, "Lager / keine Baustelle");
    // With no selection, even the first booking uses Lager rather than a stale saved project.
    el("returnEan").value = "1234567890123";
    await el("returnLookupBtn").onclick();
    el("returnColour").value = "Stock";
    el("returnWeight").value = "2";
    failBooking = true;
    await el("returnBookBtn").onclick();
    const firstBooking = requests.find((r) => r.path === "/admin/api/paint/returns" && r.method === "POST");
    assert.equal(firstBooking.body.jobId, "__lager__");
    assert.equal(firstBooking.body.jobName, "Lager / keine Baustelle");
    assert.equal(el("returnProjectModal").hidden, true);
    failBooking = false;
    assert.equal(w.document.querySelector("[data-return-edit]").textContent, "Ändern");
    assert.equal(w.document.querySelector(".return-reprint-btn").textContent, "Etikett nochmal");

    el("returnProjectBtn").click();
    w.document.querySelector('[data-job="A"]').click();
    w.document.querySelector("[data-return-edit]").click();
    el("returnEditProjectBtn").click();
    w.document.querySelector('[data-job="B"]').click();
    el("returnEditWeight").value = "1.25";
    await el("returnEditSave").onclick();
    await tick();
    assert.equal(item.weightKg, 1.25);
    assert.equal(item.jobId, "B");
    assert.equal(el("returnProjectValue").textContent, "A · Alt");
    assert.equal(requests.filter((r) => r.path === "/print").length, 0);
    w.document.querySelector("[data-return-edit]").click();
    assert.match(el("returnEditHistory").textContent, /Vorher: 3,4 kg/);
    assert.match(el("returnEditHistory").textContent, /Danach: 1,25 kg/);
    el("returnEditWeight").value = "9";
    el("returnEditClose").click();
    assert.equal(item.weightKg, 1.25);
    w.document.querySelector(".return-reprint-btn").click();
    await tick();
    const reprint = requests.find((r) => r.path === "/print");
    assert.equal(reprint.body.big, "LG-7");
    assert.equal(reprint.body.job, "B - Neu");

    el("returnEan").value = "1234567890123";
    await el("returnLookupBtn").onclick();
    el("returnColour").value = "Stock";
    el("returnWeight").value = "2";
    failBooking = true;
    await el("returnBookBtn").onclick();
    assert.equal(el("returnProjectValue").textContent, "A · Alt");
    failBooking = false;
    await el("returnBookBtn").onclick();
    await tick();
    assert.equal(el("returnProjectValue").textContent, "Lager / keine Baustelle");
    assert.equal(requests.filter((r) => r.path === "/admin/api/paint/returns" && r.method === "POST").at(-1).body.jobId, "A");
    assert.equal(requests.filter((r) => r.path === "/print").length, 2);
    assert(requests.some((r) => r.path.endsWith("/print-new/ack")));
    await el("returnLookupBtn").onclick(); // Empty scan cannot create a return.
    el("returnEan").value = "1234567890123";
    await el("returnLookupBtn").onclick();
    el("returnColour").value = "Stock";
    el("returnWeight").value = "2";
    const bookings = () => requests.filter((r) => r.path === "/admin/api/paint/returns" && r.method === "POST");
    const count = bookings().length;
    await el("returnBookBtn").onclick();
    assert.equal(bookings().length, count + 1);
    assert.equal(bookings().at(-1).body.jobId, "__lager__");
    assert.equal(bookings().at(-1).body.jobName, "Lager / keine Baustelle");
    assert.equal(el("returnProjectModal").hidden, true);
    assert.equal(el("returnProjectValue").textContent, "Lager / keine Baustelle");
    el("returnProjectBtn").click();
    w.document.querySelector('[data-job="A"]').click();
    el("returnKeepProject").checked = true;
    el("returnKeepSupplier").checked = true;
    el("returnSupplier").value = "Sto";
    el("returnEan").value = "1234567890123";
    await el("returnLookupBtn").onclick();
    el("returnColour").value = "Stock";
    el("returnWeight").value = "2";
    await el("returnBookBtn").onclick();
    assert.equal(el("returnProjectValue").textContent,"A · Alt");
    assert.equal(el("returnSupplier").value,"Sto");
    el("returnManufacturerFilter").value = "Sto";
    await el("returnManufacturerFilter").onchange();
    await tick();
    assert(requests.some(r => r.query.includes("manufacturer=Sto")));
    w.document.querySelector("[data-return-remove]").click();
    el("returnRemoveReason").value = "dried";
    await el("returnRemoveSave").onclick();
    assert.equal(item.status,"dried");
    assert.equal(w.document.querySelector("[data-return-remove]"),null);
    el("returnIncludeRemoved").checked = true;
    await el("returnIncludeRemoved").onchange();
    await tick();
    assert.match(el("returnResults").textContent,/Eingetrocknet/);
    assert.equal(w.document.querySelector("[data-return-edit]").textContent,"Verlauf");
    console.log("paint-return-stock UI + hardware regression test ok");
  } finally { observers.forEach((observer) => observer.disconnect()); w.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
