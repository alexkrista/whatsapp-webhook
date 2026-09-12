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
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "kristine-shared-calendar-outbound-"));
  const assignmentsFile = path.join(temporary, "_kristine", "assignments.json");
  await fsp.mkdir(path.dirname(assignmentsFile), { recursive:true });
  await fsp.writeFile(assignmentsFile, JSON.stringify([
    { id:"sick-1", date:"2026-09-16", cardType:"krank", employeeId:"edmund", employeeName:"Edmund Mock" },
    { id:"sick-duplicate", date:"2026-09-16", cardType:"krank", employeeId:"edmund", employeeName:"Edmund Mock" },
    { id:"work-1", date:"2026-09-20", cardType:"site", jobId:"26080", jobName:"Fink Loos", employeeId:"edmund", employeeName:"Edmund Mock" },
    { id:"work-2", date:"2026-09-20", cardType:"site", jobId:"26080", jobName:"Fink Loos", employeeId:"manuel", employeeName:"Manuel Faes" },
    { id:"holiday-1", date:"2026-09-17", cardType:"feiertag", employeeId:"edmund", employeeName:"Edmund Mock" },
    { id:"holiday-duplicate", date:"2026-09-17", cardType:"feiertag", employeeId:"manuel", employeeName:"Manuel Faes" },
    { id:"shop-1", date:"2026-09-21", cardType:"werkstatt", employeeId:"manuel", employeeName:"Manuel Faes" },
  ]), "utf8");

  const graphEvents = [], writes = [];
  const fetchMock = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    if (String(url).includes("/calendarView?")) return new Response(JSON.stringify({ value:graphEvents }), { status:200, headers:{ "Content-Type":"application/json" } });
    if (method === "POST" && String(url).endsWith("/events")) {
      const payload = JSON.parse(options.body), id = `event-${graphEvents.length + 1}`;
      graphEvents.push({ id, subject:payload.subject, start:payload.start, end:payload.end, isAllDay:payload.isAllDay, showAs:payload.showAs, categories:payload.categories, bodyPreview:payload.body.content });
      writes.push({ method, payload });
      return new Response(JSON.stringify({ id }), { status:201, headers:{ "Content-Type":"application/json" } });
    }
    if (method === "DELETE" && String(url).includes("/events/")) {
      const id = decodeURIComponent(String(url).split("/events/")[1]);
      const index = graphEvents.findIndex(event => event.id === id);
      if (index >= 0) graphEvents.splice(index, 1);
      writes.push({ method, id });
      return new Response(null, { status:204 });
    }
    throw new Error(`Unexpected Graph request: ${method} ${url}`);
  };

  const { app, routes } = harness();
  installKristineSharedCalendar(app, {
    dataDir:temporary, requireAdmin:() => true, accessToken:async () => "token", fetch:fetchMock, autoStart:false,
    today:() => "2026-09-12",
    readEmployees:async () => [{ id:"edmund", name:"Edmund Mock", active:true, birthDate:"1980-09-18", employmentStart:"2020-09-19" }],
    readJobs:async () => [
      { jobId:"26080", name:"Fink Loos", startDate:"2026-09-20" },
      { jobId:"26081", name:"Zweite Baustelle", startDate:"2026-09-20" },
    ],
    logger:{ warn(){} },
  });

  const first = await call(routes, "POST", "/kristine/api/shared-calendar/sync");
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.outboundCreated, 8, "sick leave, holiday, two birthdays, two anniversaries and two site starts must be created");
  assert.equal(writes.filter(row => row.method === "POST").length, 8);
  assert.equal(graphEvents.filter(event => event.subject.startsWith("Baustellenstart")).length, 2, "site start must be independent of assigned employee count");
  assert.ok(graphEvents.filter(event => !event.subject.startsWith("Baustellenstart")).every(event => event.isAllDay === true), "all entries except site starts must be all-day events");
  assert.ok(graphEvents.every(event => event.showAs === "free"), "shared entries must never block the calendar");
  assert.ok(graphEvents.filter(event => event.subject.startsWith("Baustellenstart")).every(event => event.isAllDay === false), "site starts must have a time");
  assert.deepEqual(graphEvents.filter(event => event.subject.startsWith("Baustellenstart")).map(event => event.start.dateTime.slice(11, 16)).sort(), ["06:00", "06:15"], "site starts on the same day must be staggered by 15 minutes");
  assert(graphEvents.some(event => event.subject === "Krank · Edmund Mock"));
  assert(graphEvents.some(event => event.subject === "Geburtstag · Edmund Mock"));
  assert(graphEvents.some(event => event.subject.includes("Eintrittsjahrestag · Edmund Mock")));
  assert(!graphEvents.some(event => /Werkstatt/.test(event.subject)), "ordinary work entries must stay out of the shared calendar");

  const second = await call(routes, "POST", "/kristine/api/shared-calendar/sync");
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.outboundCreated, 0, "second sync must not create duplicates");
  assert.equal(second.body.outboundUpdated, 0);
  assert.equal(graphEvents.length, 8);
  const assignments = JSON.parse(await fsp.readFile(assignmentsFile, "utf8"));
  assert.equal(assignments.filter(row => row.source === "kristine_shared_calendar").length, 0, "managed Outlook entries must not be imported back into planning");

  await fsp.writeFile(assignmentsFile, JSON.stringify(assignments.filter(row => row.cardType !== "krank")), "utf8");
  const third = await call(routes, "POST", "/kristine/api/shared-calendar/sync");
  assert.equal(third.body.outboundRemoved, 1, "removed managed absence must also disappear from Outlook");
  assert(!graphEvents.some(event => event.subject === "Krank · Edmund Mock"));

  console.log("OK: shared Outlook calendar exports only absences, annual notices and one site start without duplicates");
  await fsp.rm(temporary, { recursive:true, force:true });
})().catch(error => { console.error(error); process.exitCode = 1; });
