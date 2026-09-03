"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildBillingSummary } = require("../outgoing-billing-bridge");

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
        invoice_number: "202607011", issue_date: "2026-07-30", due_date: "2026-07-31",
        increment_net: 4850, increment_vat: 970, increment_gross: 5820,
      }],
      payments: [{
        id: 1, invoiceId: 33, paymentDate: "2026-08-03",
        net: 4850, vat: 970, gross: 5820, source: "WW",
      }],
    }}]
  );

  assert.equal(billing.found, true);
  assert.equal(billing.projectNumber, "26082");
  assert.deepEqual(billing.summary, {
    invoiceCount: 1,
    billedNet: 4850,
    billedGross: 5820,
    paidGross: 5820,
    openGross: 0,
  });
  assert.equal(billing.invoices[0].invoiceNumber, "202607011");
  assert.equal(billing.invoices[0].paidGross, 5820);
  assert.equal(billing.invoices[0].openGross, 0);
});
