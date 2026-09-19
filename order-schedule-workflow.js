"use strict";

const crypto = require("node:crypto");

const VALID_STATES = new Set(["none", "requested", "proposed", "confirmed", "proposal_declined"]);

function cleanDate(value) {
  const date = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : "";
}

function cleanTime(value, fallback = "") {
  const time = String(value || "").trim().slice(0, 5);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : fallback;
}

function cleanActor(actor = {}) {
  return {
    id: String(actor.id || "").trim().slice(0, 100),
    name: String(actor.name || "").trim().slice(0, 160),
  };
}

function cleanEmployees(employees = []) {
  const seen = new Set();
  const rows = [];
  for (const employee of Array.isArray(employees) ? employees : []) {
    const id = String(employee?.id || employee?.employeeId || "").trim().slice(0, 100);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, name:String(employee?.name || employee?.employeeName || id).trim().slice(0, 160) });
  }
  return rows.slice(0, 50);
}

function cleanOutlook(value = {}) {
  return {
    status:["pending", "synced", "failed"].includes(value?.status) ? value.status : "",
    eventId:String(value?.eventId || "").slice(0, 500),
    webLink:String(value?.webLink || "").slice(0, 1000),
    error:String(value?.error || "").slice(0, 1000),
    syncedAt:value?.syncedAt || null,
  };
}

function scheduleBase(value = {}, jobId = "") {
  return {
    version:1,
    jobId:String(jobId || value.jobId || "").slice(0, 80),
    status:VALID_STATES.has(value.status) ? value.status : "none",
    requestedDate:cleanDate(value.requestedDate),
    requestedAt:value.requestedAt || null,
    requestedBy:cleanActor(value.requestedBy),
    proposedDate:cleanDate(value.proposedDate),
    proposedFrom:cleanTime(value.proposedFrom),
    proposedTo:cleanTime(value.proposedTo),
    proposedAt:value.proposedAt || null,
    proposedBy:cleanActor(value.proposedBy),
    confirmedDate:cleanDate(value.confirmedDate),
    confirmedFrom:cleanTime(value.confirmedFrom),
    confirmedTo:cleanTime(value.confirmedTo),
    confirmedAt:value.confirmedAt || null,
    confirmedBy:cleanActor(value.confirmedBy),
    customerConfirmedAt:value.customerConfirmedAt || null,
    customerResponse:String(value.customerResponse || "").slice(0, 1000),
    employees:cleanEmployees(value.employees),
    assignmentIds:[...new Set((Array.isArray(value.assignmentIds) ? value.assignmentIds : []).map(String).filter(Boolean))].slice(0, 50),
    appointmentId:String(value.appointmentId || "").slice(0, 160),
    outlook:cleanOutlook(value.outlook),
    notification:value.notification && typeof value.notification === "object" ? {
      sent:value.notification.sent === true,
      channels:(Array.isArray(value.notification.channels) ? value.notification.channels : []).map(String).slice(0, 5),
      error:String(value.notification.error || "").slice(0, 1000),
      sentAt:value.notification.sentAt || null,
    } : null,
    history:(Array.isArray(value.history) ? value.history : []).slice(-100),
    revision:Math.max(0, Math.trunc(Number(value.revision || 0))),
    createdAt:value.createdAt || null,
    updatedAt:value.updatedAt || null,
  };
}

function event(kind, at, actor, data = {}) {
  return { kind, at, actor:cleanActor(actor), ...data };
}

function requestSchedule(current, { jobId, date, at = new Date().toISOString(), actor = {}, source = "office" } = {}) {
  const requestedDate = cleanDate(date);
  if (!requestedDate) throw new Error("Bitte einen gültigen Terminwunsch auswählen.");
  const base = scheduleBase(current, jobId);
  if (base.status === "confirmed") throw new Error("Der Auftragstermin ist bereits bestätigt.");
  return {
    ...base,
    jobId:String(jobId || base.jobId),
    status:"requested",
    requestedDate,
    requestedAt:at,
    requestedBy:cleanActor(actor),
    proposedDate:"",
    proposedFrom:"",
    proposedTo:"",
    proposedAt:null,
    proposedBy:cleanActor({}),
    customerConfirmedAt:null,
    customerResponse:"",
    employees:[],
    assignmentIds:[],
    appointmentId:"",
    outlook:cleanOutlook({}),
    notification:null,
    revision:base.revision + 1,
    createdAt:base.createdAt || at,
    updatedAt:at,
    history:[...base.history, event("requested", at, actor, { date:requestedDate, source:String(source || "office").slice(0, 40) })].slice(-100),
  };
}

function proposeSchedule(current, { date, from = "07:00", to = "17:00", employees = [], at = new Date().toISOString(), actor = {} } = {}) {
  const base = scheduleBase(current);
  const proposedDate = cleanDate(date), proposedFrom = cleanTime(from), proposedTo = cleanTime(to);
  if (!proposedDate) throw new Error("Bitte einen gültigen Alternativtermin auswählen.");
  if (!proposedFrom || !proposedTo || proposedTo <= proposedFrom) throw new Error("Bitte eine gültige Zeit von/bis eingeben.");
  if (base.status === "confirmed") throw new Error("Der Auftragstermin ist bereits bestätigt.");
  const selected = cleanEmployees(employees);
  return {
    ...base,
    status:"proposed",
    proposedDate,
    proposedFrom,
    proposedTo,
    proposedAt:at,
    proposedBy:cleanActor(actor),
    customerConfirmedAt:null,
    customerResponse:"",
    employees:selected,
    notification:null,
    revision:base.revision + 1,
    createdAt:base.createdAt || at,
    updatedAt:at,
    history:[...base.history, event("proposed", at, actor, { date:proposedDate, from:proposedFrom, to:proposedTo, employeeIds:selected.map(row => row.id) })].slice(-100),
  };
}

function confirmSchedule(current, { date, from = "07:00", to = "17:00", employees = [], assignments = [], appointment = null, at = new Date().toISOString(), actor = {}, customerConfirmedAt = null } = {}) {
  const base = scheduleBase(current);
  const confirmedDate = cleanDate(date), confirmedFrom = cleanTime(from), confirmedTo = cleanTime(to);
  if (!confirmedDate) throw new Error("Bitte einen gültigen Termin auswählen.");
  if (!confirmedFrom || !confirmedTo || confirmedTo <= confirmedFrom) throw new Error("Bitte eine gültige Zeit von/bis eingeben.");
  const selected = cleanEmployees(employees);
  const outlook = cleanOutlook(appointment?.outlook || base.outlook);
  return {
    ...base,
    status:"confirmed",
    confirmedDate,
    confirmedFrom,
    confirmedTo,
    confirmedAt:at,
    confirmedBy:cleanActor(actor),
    customerConfirmedAt:customerConfirmedAt || base.customerConfirmedAt,
    customerResponse:"",
    employees:selected,
    assignmentIds:(Array.isArray(assignments) ? assignments : []).map(row => String(row?.id || row)).filter(Boolean).slice(0, 50),
    appointmentId:String(appointment?.id || base.appointmentId || "").slice(0, 160),
    outlook,
    revision:base.revision + 1,
    createdAt:base.createdAt || at,
    updatedAt:at,
    history:[...base.history, event("confirmed", at, actor, { date:confirmedDate, from:confirmedFrom, to:confirmedTo, employeeIds:selected.map(row => row.id), customerConfirmed:!!customerConfirmedAt })].slice(-100),
  };
}

function declineProposal(current, { comment = "", at = new Date().toISOString(), actor = {} } = {}) {
  const base = scheduleBase(current);
  if (base.status !== "proposed") throw new Error("Es ist kein Alternativtermin zur Bestätigung offen.");
  const response = String(comment || "").trim().slice(0, 1000);
  return {
    ...base,
    status:"proposal_declined",
    customerResponse:response,
    customerConfirmedAt:null,
    revision:base.revision + 1,
    updatedAt:at,
    history:[...base.history, event("proposal_declined", at, actor, { comment:response })].slice(-100),
  };
}

function buildPlanningAssignments({ jobId, job = {}, date, from = "07:00", to = "17:00", employees = [], scheduleRevision = 0 } = {}) {
  const selected = cleanEmployees(employees), day = cleanDate(date), start = cleanTime(from), end = cleanTime(to);
  if (!day || !start || !end || end <= start) throw new Error("Der bestätigte Termin ist für die Planung ungültig.");
  const address = String(job.address || [[job.street, job.houseNumber].filter(Boolean).join(" "), [job.postalCode, job.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")).trim();
  return selected.map(employee => ({
    id:`order_${String(jobId).replace(/[^A-Za-z0-9_-]/g, "_")}_${String(employee.id).replace(/[^A-Za-z0-9_-]/g, "_")}_${crypto.createHash("sha1").update(`${day}|${start}|${end}|${scheduleRevision}`).digest("hex").slice(0, 10)}`,
    date:day,
    cardType:"site",
    jobId:String(jobId),
    jobName:String(job.name || `#${jobId}`).trim().slice(0, 140),
    city:String(job.city || "").trim().slice(0, 100),
    address:address.slice(0, 300),
    contactName:String(job.contactName || job.customerMaster?.name || "").trim().slice(0, 140),
    contactPhone:String(job.contactPhone || "").trim().slice(0, 80),
    employeeId:employee.id,
    employeeName:employee.name,
    from:start,
    to:end,
    hours:Math.max(0, ((Number(end.slice(0,2)) * 60 + Number(end.slice(3))) - (Number(start.slice(0,2)) * 60 + Number(start.slice(3)))) / 60),
    note:"Bestätigter Auftragstermin",
    source:"order_schedule",
    orderScheduleJobId:String(jobId),
  }));
}

function customerScheduleView(value = {}) {
  const row = scheduleBase(value);
  return {
    status:row.status,
    requestedDate:row.requestedDate,
    proposedDate:row.proposedDate,
    proposedFrom:row.proposedFrom,
    proposedTo:row.proposedTo,
    confirmedDate:row.confirmedDate,
    confirmedFrom:row.confirmedFrom,
    confirmedTo:row.confirmedTo,
    customerConfirmedAt:row.customerConfirmedAt,
    customerResponse:row.customerResponse,
    canRespond:row.status === "proposed",
    updatedAt:row.updatedAt,
  };
}

module.exports = {
  cleanDate,
  cleanTime,
  scheduleBase,
  requestSchedule,
  proposeSchedule,
  confirmSchedule,
  declineProposal,
  buildPlanningAssignments,
  customerScheduleView,
};
