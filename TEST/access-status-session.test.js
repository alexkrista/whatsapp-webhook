"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    append(name, value) {
      const key = String(name).toLowerCase();
      this.headers[key] = this.headers[key] ? [].concat(this.headers[key], value) : value;
    },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
}

test("Zutrittsstatus merkt einen gültigen Browser sicher per Cookie", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "access-session-"));
  t.after(() => fs.rm(dataDir, { recursive:true, force:true }));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_TOKEN = "test-access-secret";

  const expressStub = path.join(dataDir, "express-stub.js");
  await fs.writeFile(expressStub, "module.exports = function expressStub() {};\n", "utf8");
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === "express") return expressStub;
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  t.after(() => { Module._resolveFilename = originalResolveFilename; });

  const routes = new Map();
  const app = {
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
  const { installRoutes } = require("../access-bridge-cloud");
  installRoutes(app);
  const status = routes.get("GET /kristine/api/access-status");
  const heartbeat = routes.get("POST /kristine/api/access-heartbeat");
  assert.equal(typeof status, "function");
  assert.equal(typeof heartbeat, "function");

  const forbidden = response();
  await status({ headers:{}, query:{} }, forbidden);
  assert.equal(forbidden.statusCode, 403);

  const first = response();
  await status({ headers:{}, query:{ token:"test-access-secret" } }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.ok, true);
  assert.match(String(first.headers["set-cookie"]), /kristine_session=/);
  assert.match(String(first.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(first.headers["set-cookie"]), /Secure/);
  assert.match(String(first.headers["set-cookie"]), /SameSite=Lax/);

  const cookie = String(first.headers["set-cookie"]).split(";")[0];
  const remembered = response();
  await status({ headers:{ cookie }, query:{} }, remembered);
  assert.equal(remembered.statusCode, 200);
  assert.equal(remembered.body.ok, true);

  const protectedWrite = response();
  await heartbeat({ headers:{ cookie }, query:{}, body:{} }, protectedWrite);
  assert.equal(protectedWrite.statusCode, 403);
});
