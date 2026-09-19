"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  requestSchedule,
  proposeSchedule,
  confirmSchedule,
  declineProposal,
  buildPlanningAssignments,
  customerScheduleView,
} = require("../order-schedule-workflow");

test("Kundenwunsch bleibt unbestätigt und erzeugt noch keine Einteilung", () => {
  const schedule = requestSchedule({}, { jobId:"26001", date:"2026-10-05", at:"2026-09-18T10:00:00.000Z", actor:{id:"customer",name:"Egon"}, source:"customer" });
  assert.equal(schedule.status, "requested");
  assert.equal(schedule.requestedDate, "2026-10-05");
  assert.deepEqual(schedule.assignmentIds, []);
  assert.equal(schedule.appointmentId, "");
});

test("Bestätigung erzeugt pro gewähltem Mitarbeiter eine Planungskarte", () => {
  const requested = requestSchedule({}, { jobId:"26001", date:"2026-10-05" });
  const employees = [{id:"mario",name:"Mario"},{id:"lukas",name:"Lukas"}];
  const assignments = buildPlanningAssignments({ jobId:"26001", job:{name:"Egon Sauna",street:"Musterweg",houseNumber:"3",postalCode:"6820",city:"Frastanz",contactName:"Egon"}, date:"2026-10-05", from:"07:00", to:"17:00", employees, scheduleRevision:2 });
  assert.equal(assignments.length, 2);
  assert.ok(assignments.every(row => row.source === "order_schedule" && row.jobId === "26001"));
  const confirmed = confirmSchedule(requested, { date:"2026-10-05", from:"07:00", to:"17:00", employees, assignments, appointment:{id:"appt-1",outlook:{status:"synced",eventId:"outlook-1"}}, at:"2026-09-18T11:00:00.000Z", actor:{id:"alex",name:"Alex"} });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.assignmentIds.length, 2);
  assert.equal(confirmed.outlook.status, "synced");
  assert.equal(customerScheduleView(confirmed).confirmedDate, "2026-10-05");
});

test("Alternativtermin braucht Kundenantwort", () => {
  const requested = requestSchedule({}, { jobId:"26001", date:"2026-10-05" });
  const proposed = proposeSchedule(requested, { date:"2026-10-07", from:"08:00", to:"16:00" });
  assert.equal(proposed.status, "proposed");
  assert.equal(customerScheduleView(proposed).canRespond, true);
  const declined = declineProposal(proposed, { comment:"Mittwoch geht leider nicht." });
  assert.equal(declined.status, "proposal_declined");
  assert.equal(declined.customerResponse, "Mittwoch geht leider nicht.");
});

test("ungültige Zeit oder Datum werden nicht bestätigt", () => {
  assert.throws(() => requestSchedule({}, { jobId:"26001", date:"05.10.2026" }), /gültigen Terminwunsch/);
  assert.throws(() => confirmSchedule({}, { date:"2026-10-05", from:"17:00", to:"07:00" }), /gültige Zeit/);
});
