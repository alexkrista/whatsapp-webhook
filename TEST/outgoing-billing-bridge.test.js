"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildBillingSummary, registerOutgoingBillingBridge } = require("../outgoing-billing-bridge");

test("summarizes booked WinWorker invoice and payment for a job", () => {
  const billing = buildBillingSummary(
    { projectNumber: "26082", projectIndex: 2601105 },
    [{ run: {
      id: 32,
      label: "Hauptauftrag · aus WinWorker fortgeführt",
      status: "open",
      currentOpen: 0,
      invoices: [{
        id: 33, status: "issued", kind: "TR", source: "WW",
        source_id: "9f9c-ww-document",
        invoice_number: "202607011", issue_date: "2026-07-30", due_date: "2026-07-31",
        increment_net: 4850, increment_vat: 970, increment_gross: 5820,
      }, {
        id: 34, status: "draft", kind: "RE", source: "KRISTINE",
        issue_date: "2026-08-31", due_date: "2026-09-14",
        increment_net: 1200, increment_vat: 240, increment_gross: 1440,
        progressBilling: { jobId: "26082", reportIdsToBill: ["r14", "r15", "r14", ""] },
      }],
      payments: [{
        id: 1, invoiceId: 33, paymentDate: "2026-08-03",
        net: 4850, vat: 970, gross: 5820, source: "WW",
      }],
    }}]
  );

  assert.equal(billing.found, true);
  assert.equal(billing.projectNumber, "26082");
  assert.equal(billing.summary.invoiceCount, 1);
  assert.equal(billing.summary.draftCount, 1);
  assert.equal(billing.summary.documentCount, 2);
  assert.equal(billing.summary.draftNet, 1200);
  assert.equal(billing.summary.billedNet, 4850);
  assert.equal(billing.summary.billedGross, 5820);
  assert.equal(billing.summary.paidGross, 5820);
  assert.equal(billing.summary.openGross, 0);
  assert.equal(billing.invoices[0].invoiceNumber, "202607011");
  assert.equal(billing.invoices[0].paidGross, 5820);
  assert.equal(billing.invoices[0].openGross, 0);
  assert.equal(billing.invoices[0].sourceId, "9f9c-ww-document");
  assert.equal(billing.invoices[1].status, "draft");
  assert.equal(billing.invoices[1].openGross, 0);
  assert.deepEqual(billing.invoices[1].progressBilling, { jobId: "26082", reportIdsToBill: ["r14", "r15"] });
});

test("only an issued KRISTINE invoice hands its linked reports back as billed", async () => {
  let route;
  const calls = [];
  const app = { post(path, handler) { if (path.includes("outgoing-sync")) route = handler; } };
  const payloads = [
    { ok: true, projects: [{ projectNumber: "26082", projectIndex: 77 }] },
    { ok: true },
    { ok: true, runs: [{ id: 9 }] },
    { ok: true, run: { id: 9, invoices: [
      { id: 1, status: "draft", kind: "TR", progressBilling: { jobId: "26082", reportIdsToBill: ["draft-report"] } },
      { id: 2, status: "issued", kind: "TR", invoice_number: "202609001", progressBilling: { jobId: "26082", reportIdsToBill: ["issued-report"] } },
    ] } },
  ];
  registerOutgoingBillingBridge(app, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => payloads.shift() }),
    onIssuedProgressInvoices: async (value) => calls.push(value),
  });
  let body;
  await route({ params: { jobId: "26082" } }, { json(value) { body = value; return value; }, status() { return this; } });
  assert.equal(body.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].invoices.map((invoice) => invoice.progressBilling.reportIdsToBill), [["issued-report"]]);
});
