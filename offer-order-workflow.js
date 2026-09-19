"use strict";

function number(value, min = 0, max = 1000000000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

function money(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function roundToTen(value) {
  return Math.round(number(value) / 10) * 10;
}

function positionId(position, index) {
  const raw = String(position?.id || `offer-pos-${index + 1}`).trim().replace(/[^A-Za-z0-9_.:-]/g, "_");
  return raw.slice(0, 80) || `offer-pos-${index + 1}`;
}

const ACCEPTED_PAYMENT_TERMS = Object.freeze({
  net14: Object.freeze({ label:"14 Tage netto", dueDays:14, skontoEnabled:false, skontoPercent:0, skontoDays:0, skontoBasisPercent:0, prepaymentEnabled:false }),
  skonto5_2: Object.freeze({ label:"2 % Skonto bei Zahlung binnen 5 Tagen", dueDays:14, skontoEnabled:true, skontoPercent:2, skontoDays:5, skontoBasisPercent:100, prepaymentEnabled:false }),
  deposit50: Object.freeze({ label:"4 % Skonto bei 50 % Anzahlung, fällig bei Auftragserteilung", dueDays:0, skontoEnabled:true, skontoPercent:4, skontoDays:0, skontoBasisPercent:50, prepaymentEnabled:true }),
});

function applyAcceptedPaymentTerm(draft = {}, paymentTerm = "", paymentLabel = "") {
  const key = String(paymentTerm || "").trim(), term = ACCEPTED_PAYMENT_TERMS[key];
  if (!term) return { ...draft, financials:{ ...(draft.financials && typeof draft.financials === "object" ? draft.financials : {}) } };
  return {
    ...draft,
    financials:{
      ...(draft.financials && typeof draft.financials === "object" ? draft.financials : {}),
      paymentTerm:key,
      paymentLabel:String(paymentLabel || term.label).slice(0, 240),
      dueDays:term.dueDays,
      skontoEnabled:term.skontoEnabled,
      skontoPercent:term.skontoPercent,
      skontoDays:term.skontoDays,
      skontoBasisPercent:term.skontoBasisPercent,
      prepaymentEnabled:term.prepaymentEnabled,
      prepaymentPercent:term.prepaymentEnabled ? 50 : 0,
    },
  };
}

function selectedOfferPositions(draft = {}, selectedAlternativeIds = []) {
  const selected = new Set((Array.isArray(selectedAlternativeIds) ? selectedAlternativeIds : []).map(String));
  return (Array.isArray(draft.positions) ? draft.positions : []).map((position, index) => ({
    ...position,
    id: positionId(position, index),
    sourceIndex: index,
  })).filter(position => position.isAlternative !== true || selected.has(position.id));
}

function isHourUnit(value) {
  return /^(?:std\.?|stunde(?:n)?|h)$/i.test(String(value || "").trim());
}

function isRegieOrderPosition(position = {}, order = {}) {
  if (String(position.kind || "").toLowerCase() === "regie") return true;
  if (String(order.offerType || "") === "regie_material") return true;
  const hay = `${position.groupName || ""} ${position.text || position.shortText || position.description || ""}`.toLowerCase();
  return /\bregie/.test(hay);
}

function offerOrderTotals(draft = {}, selectedAlternativeIds = []) {
  const financials = draft.financials && typeof draft.financials === "object" ? draft.financials : {};
  const vatRate = number(financials.vatRate, 0, 100);
  const globalDiscountPercent = number(financials.discountPercent, 0, 100);
  const priceMode = financials.priceMode === "gross" ? "gross" : "net";
  const groupDiscounts = draft.groupDiscounts && typeof draft.groupDiscounts === "object" ? draft.groupDiscounts : {};
  const positions = selectedOfferPositions(draft, selectedAlternativeIds).map(position => {
    const quantity = number(position.quantity);
    const enteredUnitPrice = number(position.unitPrice);
    const enteredAmount = quantity * enteredUnitPrice;
    const groupDiscountPercent = number(groupDiscounts[String(position.groupName || "")], 0, 100);
    const afterGroupDiscount = enteredAmount * (1 - groupDiscountPercent / 100);
    const afterAllDiscounts = afterGroupDiscount * (1 - globalDiscountPercent / 100);
    const netAmount = priceMode === "gross" ? afterAllDiscounts / (1 + vatRate / 100) : afterAllDiscounts;
    return {
      ...position,
      quantity,
      enteredUnitPrice: money(enteredUnitPrice),
      enteredAmount: money(enteredAmount),
      groupDiscountPercent,
      globalDiscountPercent,
      netUnitPrice: quantity ? money(netAmount / quantity) : 0,
      netAmount: money(netAmount),
    };
  });
  const enteredTotal = positions.reduce((sum, row) => sum + row.enteredAmount, 0);
  const net = money(positions.reduce((sum, row) => sum + row.netAmount, 0));
  const vat = money(net * vatRate / 100);
  const gross = money(net + vat);
  const prepaymentEnabled = financials.prepaymentEnabled === true;
  const prepaymentNet = prepaymentEnabled ? money(roundToTen(net * 0.5)) : 0;
  const prepaymentVat = prepaymentEnabled ? money(prepaymentNet * vatRate / 100) : 0;
  const prepaymentGross = money(prepaymentNet + prepaymentVat);
  return {
    priceMode,
    vatRate,
    enteredTotal: money(enteredTotal),
    net,
    vat,
    gross,
    discountPercent: globalDiscountPercent,
    prepaymentEnabled,
    prepaymentPercent: prepaymentEnabled ? 50 : 0,
    prepaymentNet,
    prepaymentVat,
    prepaymentGross,
    balanceGross: money(Math.max(0, gross - prepaymentGross)),
    positions,
  };
}

function buildAcceptedOrder({ draft = {}, jobId = "", customer = "", selectedAlternativeIds = [], acceptedAt = new Date().toISOString(), acceptedBy = {}, requestedDate = "", requestedBy = {} } = {}) {
  const totals = offerOrderTotals(draft, selectedAlternativeIds);
  const financials = draft.financials && typeof draft.financials === "object" ? draft.financials : {};
  const cleanRequestedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(requestedDate || "")) ? String(requestedDate) : "";
  return {
    version: 1,
    jobId: String(jobId),
    offerNumber: String(draft.offerNumber || ""),
    offerRevision: Math.max(1, Number(draft.offerRevision || 1)),
    acceptedAt,
    acceptedBy: {
      id: String(acceptedBy.id || "").slice(0, 100),
      name: String(acceptedBy.name || "").slice(0, 160),
    },
    customerRequest: cleanRequestedDate ? {
      requestedDate: cleanRequestedDate,
      requestedAt: acceptedAt,
      requestedBy: {
        id: String(requestedBy.id || acceptedBy.id || "").slice(0, 100),
        name: String(requestedBy.name || acceptedBy.name || "").slice(0, 160),
      },
      status: "unconfirmed",
    } : null,
    customer: String(customer || "").slice(0, 180),
    offerType: String(draft.offerType || "").slice(0, 40),
    presentation: { showQuantities:draft.showQuantities !== false },
    subject: String(draft.scopeDescription || "Auftrag aus angenommenem Angebot").slice(0, 500),
    intro: String(draft.intro || "").slice(0, 2000),
    financials: {
      priceMode: totals.priceMode,
      vatRate: totals.vatRate,
      discountPercent: totals.discountPercent,
      paymentTerm: String(financials.paymentTerm || "").slice(0, 30),
      paymentLabel: String(financials.paymentLabel || "").slice(0, 240),
      dueDays: Math.round(number(financials.dueDays, 0, 365)),
      skontoEnabled: financials.skontoEnabled === true,
      skontoPercent: number(financials.skontoPercent, 0, 100),
      skontoDays: Math.round(number(financials.skontoDays, 0, 365)),
      skontoBasisPercent: number(financials.skontoBasisPercent, 0, 100),
      prepaymentEnabled: totals.prepaymentEnabled,
      prepaymentPercent: totals.prepaymentPercent,
      prepaymentRounding: totals.prepaymentEnabled ? "nearest_10_eur_net" : "",
    },
    totals: {
      net: totals.net,
      vat: totals.vat,
      gross: totals.gross,
      prepaymentNet: totals.prepaymentNet,
      prepaymentVat: totals.prepaymentVat,
      prepaymentGross: totals.prepaymentGross,
      balanceGross: totals.balanceGross,
    },
    selectedAlternativeIds: totals.positions.filter(row => row.isAlternative === true).map(row => row.id),
    positions: totals.positions.map((row, index) => ({
      id: row.id,
      number: String(index + 1),
      sourceIndex: row.sourceIndex,
      groupId: String(row.groupId || "").slice(0, 120),
      groupName: String(row.groupName || "").slice(0, 160),
      text: String(row.text || "").slice(0, 1000),
      quantity: row.quantity,
      unit: String(row.unit || "").slice(0, 20),
      enteredUnitPrice: row.enteredUnitPrice,
      groupDiscountPercent: row.groupDiscountPercent,
      globalDiscountPercent: row.globalDiscountPercent,
      unitPriceNet: row.netUnitPrice,
      amountNet: row.netAmount,
      isAlternative: row.isAlternative === true,
      laborHoursPerUnit: number(row.laborHoursPerUnit, 0, 10000),
      workSteps: Array.isArray(row.workSteps) ? row.workSteps : [],
      materials: Array.isArray(row.materials) ? row.materials : [],
    })),
  };
}

function buildOrderCalculation(order = {}) {
  return {
    version: 1,
    parseVersion: 1,
    sourceType: "accepted_offer",
    sourceDocument: null,
    orderNo: String(order.offerNumber || ""),
    projectNo: String(order.jobId || ""),
    documentDate: String(order.acceptedAt || "").slice(0, 10),
    customer: String(order.customer || ""),
    subject: String(order.subject || ""),
    netTotal: money(order.totals?.net),
    vatAmount: money(order.totals?.vat),
    grossTotal: money(order.totals?.gross),
    materialPercent: 0,
    billingRate: 0,
    rawText: `Auftrag aus angenommenem Angebot ${order.offerNumber || ""}`.trim(),
    positions: (Array.isArray(order.positions) ? order.positions : []).map(row => {
      const regie = isRegieOrderPosition(row, order);
      const plannedHours = regie && isHourUnit(row.unit)
        ? number(row.quantity)
        : money(number(row.laborHoursPerUnit) * number(row.quantity));
      return {
        id: String(row.id || ""),
        number: String(row.number || ""),
        title: String(row.groupName || row.text || ""),
        shortText: String(row.text || ""),
        description: String(row.text || ""),
        quantity: number(row.quantity),
        unit: String(row.unit || ""),
        unitPrice: money(row.unitPriceNet),
        amount: money(row.amountNet),
        plannedHours,
        kind: regie ? "regie" : "auftrag",
        suggestedKind: regie ? "regie" : "auftrag",
        needsReview: false,
        alternative: row.isAlternative === true,
        calcIncluded: true,
        employeeVisible: true,
        addToContract: false,
        source: "accepted_offer",
      };
    }),
    updatedAt: String(order.acceptedAt || new Date().toISOString()),
  };
}

function acceptedOrderTargets(order = {}) {
  const calculation = buildOrderCalculation(order);
  const fixedCalculatedHours = calculation.positions.filter(row => row.kind !== "regie").reduce((sum, row) => sum + number(row.plannedHours), 0);
  const plannedRegieHours = calculation.positions.filter(row => row.kind === "regie").reduce((sum, row) => sum + number(row.plannedHours), 0);
  return { contractAmount:money(order.totals?.net), fixedCalculatedHours, plannedRegieHours, calculatedHours:fixedCalculatedHours + plannedRegieHours };
}

function buildPrepaymentInvoiceDraft(order = {}) {
  if (order.financials?.prepaymentEnabled !== true) return null;
  const net = money(order.totals?.prepaymentNet);
  const vatRate = number(order.financials?.vatRate, 0, 100);
  const vat = money(net * vatRate / 100);
  return {
    version: 1,
    id: `vorkassa-${String(order.jobId || "")}-${String(order.offerNumber || "")}`,
    status: "draft",
    documentType: "TR",
    jobId: String(order.jobId || ""),
    customer: String(order.customer || ""),
    subject: `Vorkassa zu Auftrag aus Angebot ${order.offerNumber || ""}`.trim(),
    sourceOfferNumber: String(order.offerNumber || ""),
    sourceOfferRevision: Math.max(1, Number(order.offerRevision || 1)),
    percentageOfOrderNet: 50,
    rounding: "nearest_10_eur_net",
    netAmount: net,
    vatRate,
    vatAmount: vat,
    grossAmount: money(net + vat),
    positions: [{
      text: `Vorkassa 50 % netto zu Angebot ${order.offerNumber || ""}`.trim(),
      quantity: 1,
      unit: "PA",
      unitPriceNet: net,
      amountNet: net,
    }],
    createdAt: String(order.acceptedAt || new Date().toISOString()),
  };
}

module.exports = {
  money,
  roundToTen,
  positionId,
  ACCEPTED_PAYMENT_TERMS,
  applyAcceptedPaymentTerm,
  selectedOfferPositions,
  offerOrderTotals,
  isRegieOrderPosition,
  buildAcceptedOrder,
  buildOrderCalculation,
  acceptedOrderTargets,
  buildPrepaymentInvoiceDraft,
};
