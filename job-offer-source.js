"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { buildAcceptedOrder, buildOrderCalculation, buildPrepaymentInvoiceDraft, applyAcceptedPaymentTerm } = require("./offer-order-workflow");
const { cleanDate, scheduleBase } = require("./order-schedule-workflow");

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function matchingAcceptance(draft) {
  const acceptance = draft?.customerAcceptance;
  return acceptance?.status === "accepted" && acceptance.acceptedAt &&
    String(acceptance.offerNumber) === String(draft.offerNumber) &&
    Number(acceptance.offerRevision || 1) === Number(draft.offerRevision || 1) ? acceptance : null;
}

// Read existing evidence only. A budget fallback never accepts an offer, sends
// a confirmation, creates an invoice or changes the job's status.
async function readJobOfferSource(dataDir, jobId, { meta, allowDraft = false } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(jobId))) throw new Error("Invalid jobId");
  const dir = path.join(dataDir, String(jobId));
  const existing = await readJson(path.join(dir, ".accepted-order.json"));
  if (existing) return { order:existing, accepted:true, sourceType:"accepted_offer" };
  const files = await fs.readdir(path.join(dir, "_offers")).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const accepted = [];
  for (const file of files.filter(name => /^offer-\d+-v\d+\.json$/.test(name))) {
    const snapshot = await readJson(path.join(dir, "_offers", file));
    if (matchingAcceptance(snapshot)) accepted.push(snapshot);
  }
  // Conflicting accepted versions need human resolution; do not pick one.
  if (accepted.length > 1) return null;
  const current = await readJson(path.join(dir, ".offer-draft.json"));
  const draft = accepted[0] || (matchingAcceptance(current) ? current : null);
  if (draft) {
    const acceptance = matchingAcceptance(draft);
    const actor = { id:`customer-portal:${acceptance.grantId || "customer"}`, name:acceptance.customerName || "Kunde" };
    return { accepted:true, recovered:true, sourceType:"accepted_offer", order:buildAcceptedOrder({
      draft:applyAcceptedPaymentTerm(draft, acceptance.paymentTerm, acceptance.paymentLabel), jobId,
      acceptedAt:acceptance.acceptedAt, acceptedBy:actor, customer:acceptance.customerName,
      requestedDate:acceptance.preferredDate, requestedBy:actor,
    }) };
  }
  const job = meta || await readJson(path.join(dir, ".meta.json")) || {};
  if (!allowDraft || !["Auftrag", "Laufend"].includes(job.status) || !current?.positions?.length || Number(job.contractAmount) > 0 || Number(job.plannedRegieHours) > 0) return null;
  const existingCalculation=await readJson(path.join(dir,".order-calculation.json"));
  if(existingCalculation&&(existingCalculation.positions?.length||Number(existingCalculation.netTotal)>0||existingCalculation.sourceDocument))return null;
  return { accepted:false, sourceType:"offer_draft", order:buildAcceptedOrder({
    draft:current, jobId, acceptedAt:current.updatedAt || current.offerCreatedAt || "", customer:job.contactName || job.name,
  }) };
}

async function readJobCalculation(dataDir, jobId) {
  const stored = await readJson(path.join(dataDir, String(jobId), ".order-calculation.json"));
  if (stored && (stored.positions?.length || Number(stored.netTotal) > 0 || stored.sourceDocument)) return stored;
  const source = await readJobOfferSource(dataDir, jobId, { allowDraft:true });
  if (!source) return stored;
  const calculation = buildOrderCalculation(source.order);
  return { ...calculation, sourceType:source.sourceType,
    rawText:source.accepted ? calculation.rawText : "Kalkulation aus dem Angebot dieser Baustelle" };
}

function scheduleWithOfferRequest(value, order, jobId) {
  const schedule = scheduleBase(value || {}, jobId);
  const request = order?.customerRequest;
  const requestedDate = cleanDate(request?.requestedDate);
  if (schedule.status !== "none" || schedule.requestedDate || !requestedDate) return schedule;
  return { ...schedule, status:"requested", requestedDate, requestedAt:request.requestedAt || order.acceptedAt,
    requestedBy:request.requestedBy || order.acceptedBy, source:"customer" };
}

async function restoreCustomerAcceptedOrders(dataDir) {
  const entries=await fs.readdir(dataDir,{withFileTypes:true}).catch(error=>{if(error.code==="ENOENT")return [];throw error});
  let restored=0;
  for(const entry of entries){
    if(!entry.isDirectory()||!/^\d{2,12}$/.test(entry.name))continue;
    const source=await readJobOfferSource(dataDir,entry.name);
    if(!source?.recovered)continue;
    const order=source.order;
    if(!order.positions.length||order.totals.net<=0)continue;
    const invoice=buildPrepaymentInvoiceDraft(order);
    const files=[[".accepted-order.json",order],[".order-calculation.json",buildOrderCalculation(order)]];
    if(invoice)files.push([".prepayment-invoice-draft.json",invoice]);
    for(const [name,value] of files){
      try{await fs.writeFile(path.join(dataDir,entry.name,name),JSON.stringify(value,null,2),{flag:"wx"});}
      catch(error){if(error.code!=="EEXIST")throw error;}
    }
    restored++;
  }
  return {restored};
}

module.exports = { readJobOfferSource, readJobCalculation, scheduleWithOfferRequest, restoreCustomerAcceptedOrders };
