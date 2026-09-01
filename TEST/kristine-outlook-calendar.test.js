"use strict";

const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { installOutlookCalendar } = require("../kristine-outlook-calendar");

function appHarness() {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  return { app, routes };
}

function response() {
  return {
    statusCode:200, body:null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
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
    global.fetch = async () => { throw new Error("network unavailable"); };
    const create = await call(routes, "POST", "/kristine/api/appointments", { body:{
      requestId:"request-1", taskId:"task-42", title:"Kundentermin", date:"2026-09-03", allDay:false,
      from:"14:00", to:"14:30", location:"Musterstraße 1", details:"Besprechung vor Ort",
    } });
    assert.equal(create.statusCode, 201);
    assert.equal(create.body.internalSaved, true);
    assert.equal(create.body.outlookSynced, false);
    assert.equal(create.body.appointment.outlook.status, "failed");

    let graphPayload = null;
    global.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/devicecode")) return new Response(JSON.stringify({ device_code:"device", user_code:"ABCD-EFGH", verification_uri:"https://login.microsoft.com/device", expires_in:900, interval:1 }), { status:200, headers:{ "Content-Type":"application/json" } });
      if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token:"access", refresh_token:"refresh", id_token:jwt("alexander.krista@krista.at"), expires_in:3600 }), { status:200, headers:{ "Content-Type":"application/json" } });
      if (String(url).includes("graph.microsoft.com")) {
        graphPayload = JSON.parse(options.body);
        return new Response(JSON.stringify({ id:"outlook-event-123", webLink:"https://outlook.example/event/123" }), { status:201, headers:{ "Content-Type":"application/json" } });
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

    const retry = await call(routes, "POST", "/kristine/api/appointments/:id/retry", { params:{ id:create.body.appointment.id } });
    assert.equal(retry.body.outlookSynced, true);
    assert.equal(retry.body.appointment.outlook.eventId, "outlook-event-123");
    assert.match(graphPayload.body.content, /https:\/\/protokoll\.krista\.at\/kristine\?task=task-42#tasks/);
    assert.equal(graphPayload.transactionId, create.body.appointment.id);

    const stored = JSON.parse(fs.readFileSync(path.join(temporary, "_kristine", "appointments.json"), "utf8"));
    assert.equal(stored.length, 1, "Idempotent request must only create one internal appointment");
    assert.equal(stored[0].outlook.status, "synced");
    assert.equal(stored[0].outlook.eventId, "outlook-event-123");
    const audit = fs.readFileSync(path.join(temporary, "_kristine", "outlook-calendar.jsonl"), "utf8");
    for (const event of ["auth_success", "token_cache_saved", "token_cache_loaded", "graph_create_event_error"]) assert.match(audit, new RegExp(`\"type\":\"${event}\"`));
    console.log("OK: internal save survives Graph failure; login, retry, Event-ID and KGO link work");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KRISTINE_OUTLOOK_TOKEN_KEY; else process.env.KRISTINE_OUTLOOK_TOKEN_KEY = originalKey;
    await fsp.rm(temporary, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
