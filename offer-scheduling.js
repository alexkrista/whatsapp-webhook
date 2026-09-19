"use strict";

const { cleanDate, cleanTime } = require("./order-schedule-workflow");
const invalid = message => Object.assign(new Error(message), { status:400 });

function cleanOfferSchedule(value) {
  if (!value || !value.mode) return null; // Previously issued offers keep their optional wish.
  if (value.mode === "customer_request") return { mode:"customer_request" };
  if (value.mode !== "fixed") throw invalid("Bitte festlegen, ob ein Termin vereinbart ist oder der Kunde einen Termin wünschen soll.");
  const date = cleanDate(value.date), from = cleanTime(value.from), to = cleanTime(value.to);
  if (!date) throw invalid("Bitte einen gültigen vereinbarten Termin auswählen.");
  if (!from || !to || to <= from) throw invalid("Bitte eine gültige Uhrzeit von/bis eingeben.");
  return { mode:"fixed", date, from, to };
}

function customerOfferSchedule(draft, preferredDate) {
  const offerSchedule = cleanOfferSchedule(draft.offerSchedule);
  // The binding date comes only from the immutable offer, never from the request.
  if (offerSchedule?.mode === "fixed") return { offerSchedule, preferredDate:"" };
  const requested = String(preferredDate || "").trim(), date = cleanDate(requested);
  if (requested && !date) throw invalid("Bitte einen gültigen Wunschtermin wählen.");
  if (offerSchedule?.mode === "customer_request" && !date) throw invalid("Bitte Ihren Wunschtermin auswählen. Farben Krista bestätigt ihn anschließend.");
  return { offerSchedule, preferredDate:date };
}

async function applyAcceptedSchedule(order, { read, request, confirm }) {
  const current = await read(order.jobId);
  if (!["none", "requested"].includes(current.status)) return current;
  const terms = cleanOfferSchedule(order.offerSchedule), actor = order.acceptedBy || {};
  if (terms?.mode === "fixed") {
    const customerAccepted = String(actor.id || "").startsWith("customer-portal:");
    return confirm(order.jobId, { date:terms.date, from:terms.from, to:terms.to, actor }, {
      notifyCustomer:!customerAccepted,
      customerConfirmedAt:customerAccepted ? order.acceptedAt : null,
    });
  }
  const date = cleanDate(order.customerRequest?.requestedDate);
  return date && (current.status !== "requested" || current.requestedDate !== date)
    ? request(order.jobId, date, actor, "customer") : current;
}

module.exports = { cleanOfferSchedule, customerOfferSchedule, applyAcceptedSchedule };
