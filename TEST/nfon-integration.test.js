"use strict";

const assert = require("node:assert/strict");
const { parseOfficeExtensions, registerNfonIntegration } = require("../nfon-integration");

assert.deepEqual(parseOfficeExtensions("Bettina:101, Dunja:102, Alex:103"), [
  { name: "Bettina", extension: "101" },
  { name: "Dunja", extension: "102" },
  { name: "Alex", extension: "103" },
]);
assert.deepEqual(parseOfficeExtensions("falsch,Ohne Nummer:x, Alex:103"), [{ name: "Alex", extension: "103" }]);

function responseDouble() {
  return {
    statusCode: 200, body: null, ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}

async function testProtectedClickToDialRoute() {
  const routes = {};
  const app = {
    get(path, handler) { routes[`GET ${path}`] = handler; },
    post(path, handler) { routes[`POST ${path}`] = handler; },
    delete(path, handler) { routes[`DELETE ${path}`] = handler; },
  };
  const originated = [];
  const client = {
    kAccount: "KC7BV",
    configured: () => true,
    getPhoneExtensions: async () => [],
    getStates: async () => [],
    originateCall: async payload => { originated.push(payload); return { uuid: "call-id", state: "start" }; },
    cancelCall: async () => true,
  };
  registerNfonIntegration(app, {
    client,
    requireAdmin: () => true,
    officeExtensions: "Bettina:101,Dunja:102,Alex:103",
  });

  const response = responseDouble();
  await routes["POST /kristine/api/nfon/calls"]({ body: { extension: "102", phone: "+43552212345" } }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.ok, true);
  assert.equal(originated[0].extension, "102");
  assert.equal(originated[0].callee, "+43552212345");

  const rejected = responseDouble();
  await routes["POST /kristine/api/nfon/calls"]({ body: { extension: "999", phone: "+43552212345" } }, rejected);
  assert.equal(rejected.statusCode, 500);
  assert.match(rejected.body.error, /nicht freigegeben/);
}

testProtectedClickToDialRoute().then(() => {
  console.log("NFON integration tests passed");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
