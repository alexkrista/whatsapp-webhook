"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { installKristineSharedCalendar } = require("../kristine-shared-calendar");

function harness() {
  const routes = new Map(), app = {};
  for (const method of ["get", "post"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  return { app, routes };
}

async function call(routes, method, route) {
  const handler = routes.get(`${method} ${route}`);
  assert(handler, `Route missing: ${method} ${route}`);
  const res = { statusCode:200, body:null, status(code){ this.statusCode=code; return this; }, json(value){ this.body=value; return this; } };
  await handler({ body:{}, params:{}, query:{} }, res);
  return res;
}

(async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "kristine-shared-calendar-test-"));
  const assignmentsFile = path.join(temporary, "_kristine", "assignments.json");
  await fsp.mkdir(path.dirname(assignmentsFile), { recursive:true });
  await fsp.writeFile(assignmentsFile, JSON.stringify([{ id:"manual", date:"2026-09-14", cardType:"werkstatt", jobId:"__werkstatt__", jobName:"Werkstatt", employeeId:"edmund", employeeName:"Edmund Mock" }]), "utf8");
  let events = [
    { id:"vacation-1", subject:"Urlaub – Edmund Mock", isAllDay:true, start:{ dateTime:"2026-09-14T00:00:00" }, end:{ dateTime:"2026-09-16T00:00:00" }, lastModifiedDateTime:"2026-09-12T09:00:00Z", categories:[] },
    { id:"vacation-unknown", subject:"Urlaub – Unbekannt", isAllDay:true, start:{ dateTime:"2026-09-17T00:00:00" }, end:{ dateTime:"2026-09-18T00:00:00" }, categories:[] },
  ];
  const fetchMock = async url => {
    assert(String(url).includes("/users/kristine%40krista.at/calendarView?"));
    return new Response(JSON.stringify({ value:events }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const { app, routes } = harness();
  installKristineSharedCalendar(app, {
    dataDir:temporary, requireAdmin:() => true, accessToken:async () => "token", fetch:fetchMock, autoStart:false,
    today:() => "2026-09-12", readEmployees:async () => [{ id:"edmund", name:"Edmund Mock", active:true }], logger:{ warn(){} },
  });

  const first = await call(routes, "POST", "/kristine/api/shared-calendar/sync");
  assert.equal(first.statusCode, 200, first.body?.error);
  assert.equal(first.body.importedCount, 2, "two weekdays from the all-day vacation must be imported");
  assert.equal(first.body.unmatched.length, 1);
  let rows = JSON.parse(await fsp.readFile(assignmentsFile, "utf8"));
  assert.equal(rows.filter(row => row.source === "kristine_shared_calendar").length, 2);
  assert(rows.some(row => row.id === "manual"), "manual planning must remain untouched");

  events = [];
  const second = await call(routes, "POST", "/kristine/api/shared-calendar/sync");
  assert.equal(second.statusCode, 200);
  rows = JSON.parse(await fsp.readFile(assignmentsFile, "utf8"));
  assert.equal(rows.filter(row => row.source === "kristine_shared_calendar").length, 0, "deleted calendar events must disappear from planning");
  assert(rows.some(row => row.id === "manual"), "manual planning must survive calendar cleanup");

  const status = await call(routes, "GET", "/kristine/api/shared-calendar/status");
  assert.equal(status.body.mailbox, "kristine@krista.at");
  assert.equal(status.body.syntax, "Urlaub – Vorname Nachname");
  console.log("OK: shared Kristine calendar mirrors absences into planning and removes deleted events");
  await fsp.rm(temporary, { recursive:true, force:true });
})().catch(error => { console.error(error); process.exitCode = 1; });
