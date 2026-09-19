"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  roundToTen,
  applyAcceptedPaymentTerm,
  offerOrderTotals,
  buildAcceptedOrder,
  buildOrderCalculation,
  acceptedOrderTargets,
  buildPrepaymentInvoiceDraft,
} = require("../offer-order-workflow");

const draft = {
  offerNumber: "2609001",
  offerRevision: 3,
  scopeDescription: "Wohnzimmer ausmalen",
  groupDiscounts: { Wohnzimmer: 10 },
  financials: {
    priceMode: "net",
    vatRate: 20,
    discountPercent: 5,
    prepaymentEnabled: true,
    prepaymentPercent: 77,
  },
  positions: [
    { id: "standard", groupName: "Wohnzimmer", text: "Wände", quantity: 10, unit: "m²", unitPrice: 20 },
    { id: "alternative", groupName: "Wohnzimmer", text: "Decke optional", quantity: 5, unit: "m²", unitPrice: 20, isAlternative: true },
  ],
};

test("nur ausdrücklich gewählte Alternativen werden in den Auftrag übernommen", () => {
  assert.equal(offerOrderTotals(draft).positions.length, 1);
  const totals = offerOrderTotals(draft, ["alternative"]);
  assert.equal(totals.positions.length, 2);
  assert.equal(totals.net, 256.5);
  assert.equal(totals.gross, 307.8);
});

test("Vorkassa ist fix 50 Prozent netto und wird kaufmännisch auf zehn Euro gerundet", () => {
  assert.equal(roundToTen(124), 120);
  assert.equal(roundToTen(125), 130);
  const totals = offerOrderTotals(draft, ["alternative"]);
  assert.equal(totals.prepaymentPercent, 50);
  assert.equal(totals.prepaymentNet, 130);
  assert.equal(totals.prepaymentVat, 26);
  assert.equal(totals.prepaymentGross, 156);
});

test("angenommenes Angebot erzeugt Auftrag, Kalkulation und genau passenden Rechnungsentwurf", () => {
  const order = buildAcceptedOrder({ draft, jobId: "26001", customer: "Egon Beispiel", selectedAlternativeIds: ["alternative"], acceptedAt: "2026-09-18T10:00:00.000Z", requestedDate:"2026-10-05", requestedBy:{id:"customer",name:"Egon Beispiel"} });
  assert.equal(order.financials.prepaymentPercent, 50);
  assert.deepEqual(order.selectedAlternativeIds, ["alternative"]);
  assert.deepEqual(order.customerRequest, { requestedDate:"2026-10-05", requestedAt:"2026-09-18T10:00:00.000Z", requestedBy:{id:"customer",name:"Egon Beispiel"}, status:"unconfirmed" });
  const calculation = buildOrderCalculation(order);
  assert.equal(calculation.sourceType, "accepted_offer");
  assert.equal(calculation.netTotal, 256.5);
  assert.equal(calculation.positions.reduce((sum, row) => sum + row.amount, 0), 256.5);
  const invoice = buildPrepaymentInvoiceDraft(order);
  assert.equal(invoice.status, "draft");
  assert.equal(invoice.percentageOfOrderNet, 50);
  assert.equal(invoice.netAmount, 130);
  assert.equal(invoice.grossAmount, 156);
});

test("ohne Vorkassa wird kein Rechnungsentwurf angelegt", () => {
  const order = buildAcceptedOrder({ draft: { ...draft, financials: { ...draft.financials, prepaymentEnabled: false } }, jobId: "26001" });
  assert.equal(buildPrepaymentInvoiceDraft(order), null);
});

test("die im Kundenportal gewählte Zahlungsbedingung wird unverändert in den Auftrag übernommen", () => {
  const source = { ...draft, financials:{ ...draft.financials, prepaymentEnabled:false } };
  const acceptedDraft = applyAcceptedPaymentTerm(source, "deposit50", "4 % Skonto bei 50 % Anzahlung, fällig bei Auftragserteilung");
  const order = buildAcceptedOrder({ draft:acceptedDraft, jobId:"26001", customer:"Egon Beispiel" });
  assert.equal(order.financials.paymentTerm, "deposit50");
  assert.equal(order.financials.paymentLabel, "4 % Skonto bei 50 % Anzahlung, fällig bei Auftragserteilung");
  assert.equal(order.financials.prepaymentEnabled, true);
  assert.equal(order.financials.prepaymentPercent, 50);
  assert.equal(order.financials.skontoEnabled, true);
  assert.equal(order.financials.skontoPercent, 4);
  assert.equal(order.financials.skontoBasisPercent, 50);
  assert.equal(buildPrepaymentInvoiceDraft(order).netAmount, 90);
  const net14 = buildAcceptedOrder({ draft:applyAcceptedPaymentTerm(draft, "net14"), jobId:"26001" });
  assert.equal(net14.financials.paymentTerm, "net14");
  assert.equal(net14.financials.dueDays, 14);
  assert.equal(net14.financials.prepaymentEnabled, false);
  assert.equal(buildPrepaymentInvoiceDraft(net14), null);
});

test("Regieangebot übernimmt die angebotene Stundenmenge als Sollstunden", () => {
  const regieDraft = {
    offerType: "regie_material",
    offerNumber: "2609002",
    financials: { priceMode: "net", vatRate: 20 },
    positions: [
      { id: "labor", text: "Regiearbeiten durch Facharbeiter", quantity: 20, unit: "Std", unitPrice: 75 },
      { id: "material", text: "Material und Maschinen für Regiearbeiten", quantity: 1, unit: "PA", unitPrice: 300 },
    ],
  };
  const order = buildAcceptedOrder({ draft: regieDraft, jobId: "26100" });
  const calculation = buildOrderCalculation(order);
  assert.equal(order.offerType, "regie_material");
  assert.deepEqual(calculation.positions.map(row => row.kind), ["regie", "regie"]);
  assert.equal(calculation.positions[0].plannedHours, 20);
  assert.equal(calculation.positions[1].plannedHours, 0);
  assert.deepEqual(acceptedOrderTargets(order), { contractAmount:1800, fixedCalculatedHours:0, plannedRegieHours:20, calculatedHours:20 });
});

test("Mischauftrag addiert Fix- und Regiestunden genau einmal", () => {
  const order=buildAcceptedOrder({jobId:"26101",draft:{offerNumber:"2609003",financials:{priceMode:"net",vatRate:20},positions:[
    {id:"fixed",text:"Pauschalarbeit",quantity:2,unit:"PA",unitPrice:500,laborHoursPerUnit:3},
    {id:"regie",text:"Regie",quantity:4,unit:"Std",unitPrice:75},
  ]}});
  assert.deepEqual(acceptedOrderTargets(order), { contractAmount:1300, fixedCalculatedHours:6, plannedRegieHours:4, calculatedHours:10 });
});
