"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "kristine.html"), "utf8");
const calendar = fs.readFileSync(path.join(__dirname, "..", "public", "ui", "kristine-task-calendar.js"), "utf8");

assert.match(html, /id="tDueDateField"><label>Fällig<\/label>/, "ordinary due-date field must remain");
assert.match(html, /id="tAppointmentDate"[^>]*type="date"/, "appointment date is missing");
assert.match(html, /id="tAppointmentFrom"[^>]*type="time"/, "appointment start is missing");
assert.match(html, /id="tAppointmentTo"[^>]*type="time"/, "appointment end is missing");
assert.match(html, /id="tCalendarAlex"[^>]*checked disabled/, "Alex must be selected in V1");
assert.match(html, /selectedTaskType\(\)==='Termin'/, "field switch must only target appointments");
assert.match(html, /dueDate:isAppointment\?'':tDueDate\.value/, "non-appointment due dates must remain unchanged");
assert.match(html, /await persistTasks\(\);\s*let outlookResult=null;\s*if\(isAppointment\)/, "internal task must save before Outlook sync");
assert.match(html, /requestId:'new-task-'\+newTask\.id/, "Outlook creation must be idempotent");
assert.match(html, /newTask\.appointment\.outlook=outlookResult\.appointment\.outlook/, "Outlook Event-ID/status must be stored on the KRISTINE task");
assert.match(html, /Outlook-Termin erstellt ✅/, "success status is missing");
assert.match(html, /Outlook noch nicht synchronisiert/, "retry status is missing");
assert.match(calendar, /Termin ausgemacht/, "saved appointments must show information instead of opening a second appointment form");

console.log("OK: Termin fields and additive Outlook save are wired into Neue Aufgabe");
