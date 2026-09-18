"use strict";

const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { installOutlookCalendar } = require("../kristine-outlook-calendar");
const moduleSource = fs.readFileSync(path.join(__dirname, "..", "kristine-outlook-calendar.js"), "utf8");
assert.match(moduleSource, /Calendars\.ReadWrite Calendars\.ReadWrite\.Shared Mail\.Read Mail\.Read\.Shared/, "Outlook-Verbindung muss eigene und freigegebene Kalender sowie Mails anfordern");
assert.match(moduleSource, /hasRequiredScopes/);

function appHarness() {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post", "patch"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  return { app, routes };
}

function response() {
  return {
    statusCode:200, body:null, headers:{}, redirectedTo:"",
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    type(value) { this.headers["content-type"] = value; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    redirect(code, value) { this.statusCode = Number(code) || 302; this.redirectedTo = value; return this; },
  };
}

async function call(routes, method, route, { body = {}, params = {}, query = {} } = {}) {
  const handler = routes.get(`${method} ${route}`); assert(handler, `Route missing: ${method} ${route}`);
  const res = response(); await handler({ body, params, query }, res); return res;
}

function jwt(account) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg:"none" })}.${encode({ preferred_username:account, name:"Alexander Krista" })}.signature`;
}

(async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "kristine-outlook-test-"));
  const originalFetch = global.fetch;
  const originalKey = process.env.KRISTINE_OUTLOOK_TOKEN_KEY;
  process.env.KRISTINE_OUTLOOK_TOKEN_KEY = "test-only-encryption-key";
  const { app, routes } = appHarness();
  installOutlookCalendar(app, { dataDir:temporary, requireAdmin:() => true, publicBaseUrl:"https://protokoll.krista.at", logger:{ log(){}, error(){} } });

  try {
    const kristineRoot = path.join(temporary, "_kristine");
    await fsp.mkdir(path.join(kristineRoot, "vehicle-tracking"), { recursive:true });
    await fsp.writeFile(path.join(kristineRoot, "tasks.json"), JSON.stringify([{
      id:"task-42", title:"Kundentermin", jobId:"26099", jobName:"Kunde Bregenz",
      address:"Musterstraße 1, 6900 Bregenz", contactPhone:"+43 660 1234567",
    }], null, 2));
    await fsp.writeFile(path.join(kristineRoot, "vehicle-tracking", "rides.json"), JSON.stringify([{
      id:"ride-1", startedAt:"2026-09-01T07:00:00.000Z", closedAt:"2026-09-01T07:35:00.000Z",
      startPosition:{ address:"Hauptstraße 12, 6820 Frastanz" },
      lastPosition:{ address:"Musterstraße 8, 6900 Bregenz" },
    }], null, 2));

    global.fetch = async () => { throw new Error("network unavailable"); };
    const create = await call(routes, "POST", "/kristine/api/appointments", { body:{
      requestId:"request-1", taskId:"task-42", title:"Kundentermin", date:"2026-09-03", allDay:false,
      from:"14:00", to:"14:30", location:"Musterstraße 1, 6900 Bregenz", details:"Besprechung vor Ort",
    } });
    assert.equal(create.statusCode, 201);
    assert.equal(create.body.internalSaved, true);
    assert.equal(create.body.outlookSynced, false);
    assert.equal(create.body.appointment.outlook.status, "failed");
    assert.equal(create.body.appointment.jobId, "26099");
    assert.equal(create.body.appointment.travelSource, "krisdrive");
    assert.equal(create.body.appointment.travelMinutes, 35);
    assert.equal(create.body.appointment.departureBufferMinutes, 15);
    assert.equal(create.body.appointment.departureLeadMinutes, 50);

    let graphPayload = null;
    let departurePayload = null;
    global.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/devicecode")) return new Response(JSON.stringify({ device_code:"device", user_code:"ABCD-EFGH", verification_uri:"https://login.microsoft.com/device", expires_in:900, interval:1 }), { status:200, headers:{ "Content-Type":"application/json" } });
      if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token:"access", refresh_token:"refresh", id_token:jwt("alexander.krista@krista.at"), expires_in:3600, scope:"Calendars.ReadWrite Calendars.ReadWrite.Shared Mail.Read Mail.Read.Shared" }), { status:200, headers:{ "Content-Type":"application/json" } });
      if (String(url).includes("/me/calendarView?")) return new Response(JSON.stringify({ value:[
        { id:"outlook-morning", subject:"Baustellentermin", isAllDay:false, showAs:"busy", start:{ dateTime:"2026-09-18T08:30:00.0000000" }, end:{ dateTime:"2026-09-18T09:15:00.0000000" }, location:{ displayName:"Rankweil" } },
        { id:"outlook-day", subject:"Urlaub", isAllDay:true, showAs:"free", start:{ dateTime:"2026-09-18T00:00:00.0000000" }, end:{ dateTime:"2026-09-19T00:00:00.0000000" } },
      ] }), { status:200, headers:{ "Content-Type":"application/json" } });
      if (String(url).includes("/me/calendar/getSchedule")) return new Response(JSON.stringify({ value:[{ scheduleItems:[
        { subject:"Baustellentermin", status:"busy", start:{ dateTime:"2026-09-18T08:30:00.0000000" }, end:{ dateTime:"2026-09-18T09:15:00.0000000" }, location:"Rankweil" },
        { subject:"Nur in Frei/Belegt", status:"busy", start:{ dateTime:"2026-09-18T13:00:00.0000000" }, end:{ dateTime:"2026-09-18T14:00:00.0000000" } },
      ] }] }), { status:200, headers:{ "Content-Type":"application/json" } });
      if (String(url).includes("graph.microsoft.com")) {
        const payload = options.body ? JSON.parse(options.body) : {};
        if (String(payload.subject || "").startsWith("🚗 Jetzt los")) {
          departurePayload = payload;
          return new Response(JSON.stringify({ id:"outlook-departure-123", webLink:"https://outlook.example/event/departure" }), { status:200, headers:{ "Content-Type":"application/json" } });
        }
        graphPayload = payload;
        return new Response(JSON.stringify({ id:"outlook-event-123", webLink:"https://outlook.example/event/123" }), { status:200, headers:{ "Content-Type":"application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const start = await call(routes, "POST", "/kristine/api/outlook/login/start");
    assert.equal(start.body.ok, true);
    const poll = await call(routes, "POST", "/kristine/api/outlook/login/poll", { body:{ sessionId:start.body.sessionId } });
    assert.equal(poll.body.account, "alexander.krista@krista.at");

    const restarted = appHarness();
    installOutlookCalendar(restarted.app, { dataDir:temporary, requireAdmin:() => true, publicBaseUrl:"https://protokoll.krista.at", logger:{ log(){}, error(){} } });
    const statusAfterRestart = await call(restarted.routes, "GET", "/kristine/api/outlook/status");
    assert.equal(statusAfterRestart.body.connected, true, "persisted token must load in a new process/module instance");
    assert.equal(statusAfterRestart.body.account, "alexander.krista@krista.at");

    const day = await call(routes, "GET", "/kristine/api/outlook/day", { query:{ date:"2026-09-18" } });
    assert.equal(day.statusCode, 200);
    assert.deepEqual(day.body.appointments.map(row => [row.title, row.allDay, row.from, row.to]), [
      ["Urlaub", true, "", ""],
      ["Baustellentermin", false, "08:30", "09:15"],
      ["Nur in Frei/Belegt", false, "13:00", "14:00"],
    ]);
    const badDay = await call(routes, "GET", "/kristine/api/outlook/day", { query:{ date:"2026-02-31" } });
    assert.equal(badDay.statusCode, 400);

    const retry = await call(routes, "POST", "/kristine/api/appointments/:id/retry", { params:{ id:create.body.appointment.id } });
    assert.equal(retry.body.outlookSynced, true);
    assert.equal(retry.body.appointment.outlook.eventId, "outlook-event-123");
    assert.match(graphPayload.body.content, /https:\/\/protokoll\.krista\.at\/kristine\/outlook-entry\?task=task-42&sig=/);
    assert.match(graphPayload.body.content, /https:\/\/protokoll\.krista\.at\/kristine\/departure-entry\?task=task-42&sig=/);
    assert.match(graphPayload.body.content, /Kristine blockiert 50 Min\. vor dem Termin/);
    assert.equal(graphPayload.isReminderOn, false);
    assert.equal(graphPayload.transactionId, create.body.appointment.id);
    assert(departurePayload, "departure block must be created");
    assert.equal(departurePayload.subject, "🚗 Jetzt los · Kundentermin");
    assert.equal(departurePayload.isReminderOn, true);
    assert.equal(departurePayload.reminderMinutesBeforeStart, 0);
    assert.equal(departurePayload.start.dateTime, "2026-09-03T13:10:00");
    assert.equal(departurePayload.end.dateTime, "2026-09-03T14:00:00");
    assert.match(departurePayload.body.content, /Vorbereitung\/Puffer: mindestens 15 Min\./);
    assert.match(departurePayload.body.content, /Navigation starten:/);
    assert.match(departurePayload.body.content, /Fahrmodus öffnen:/);

    const departurePage = await call(routes, "GET", "/kristine/departure", { query:{ task:"task-42" } });
    assert.equal(departurePage.statusCode, 200);
    assert.match(String(departurePage.body), /Jetzt los/);
    assert.match(String(departurePage.body), /Navigation starten/);
    assert.match(String(departurePage.body), /\/admin\/akte\/26099/);
    assert.match(String(departurePage.body), /ca\. 35 Min\. Fahrt/);

    const updated = await call(routes, "PATCH", "/kristine/api/appointments/:id", { params:{ id:create.body.appointment.id }, body:{
      taskId:"task-42", title:"Kundentermin geändert", date:"2026-09-04", allDay:false,
      from:"15:00", to:"16:00", location:"Neue Straße 2", details:"Neue Hinweise",
    } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.outlookSynced, true);
    assert.equal(updated.body.appointment.title, "Kundentermin geändert");
    assert.equal(graphPayload.subject, "Kundentermin geändert");
    assert.equal(graphPayload.start.dateTime, "2026-09-04T15:00:00");
    assert.equal(graphPayload.transactionId, undefined, "Graph PATCH darf keine neue Transaktions-ID senden");

    const duplicate = await call(routes, "POST", "/kristine/api/appointments", { body:{
      requestId:"request-2", taskId:"task-42", title:"Kundentermin geändert", date:"2026-09-04", allDay:false,
      from:"15:00", to:"16:00", location:"Neue Straße 2", details:"Neue Hinweise",
    } });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.body.duplicatePrevented, true, "same natural appointment must not create a second Outlook event");
    assert.equal(duplicate.body.appointment.id, create.body.appointment.id);

    const stored = JSON.parse(fs.readFileSync(path.join(temporary, "_kristine", "appointments.json"), "utf8"));
    assert.equal(stored.length, 1, "Idempotent request must only create one internal appointment");
    assert.equal(stored[0].outlook.status, "synced");
    assert.equal(stored[0].outlook.eventId, "outlook-event-123");
    assert.equal(stored[0].outlook.departureBlockEventId, "outlook-departure-123");
    assert.equal(stored[0].outlook.departureBlockStatus, "synced");
    const audit = fs.readFileSync(path.join(temporary, "_kristine", "outlook-calendar.jsonl"), "utf8");
    for (const event of ["auth_success", "token_cache_saved", "token_cache_loaded", "graph_create_event_error", "appointment_duplicate_prevented"]) assert.match(audit, new RegExp(`\"type\":\"${event}\"`));
    console.log("OK: Outlook save/retry, departure reminder, KrisDrive estimate, Fahrmodus link and deduplication work");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KRISTINE_OUTLOOK_TOKEN_KEY; else process.env.KRISTINE_OUTLOOK_TOKEN_KEY = originalKey;
    await fsp.rm(temporary, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
