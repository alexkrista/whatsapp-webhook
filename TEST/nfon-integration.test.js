"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseOfficeExtensions, registerNfonIntegration, phonesMatch } = require("../nfon-integration");

assert.deepEqual(parseOfficeExtensions("Bettina:101, Dunja:102, Alex:103"), [
  { name: "Bettina", extension: "101" },
  { name: "Dunja", extension: "102" },
  { name: "Alex", extension: "103" },
]);
assert.deepEqual(parseOfficeExtensions("falsch,Ohne Nummer:x, Alex:103"), [{ name: "Alex", extension: "103" }]);
assert.equal(phonesMatch("+43 664 123 45 67", "0664/1234567"), true);
assert.equal(phonesMatch("0043 5522 12345", "05522 12345"), true);
assert.equal(phonesMatch("+43 664 1234567", "+43 664 7654321"), false);

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

async function testProtectedPhoneLookupRoute() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kristine-nfon-"));
  try {
    await fs.mkdir(path.join(root, "4711"));
    await fs.mkdir(path.join(root, "_kristine"));
    await fs.writeFile(path.join(root, "_kristine", "tasks.json"), JSON.stringify([{
      id: "task-1", title: "Material klären", contactName: "Farben Huber", contactPhone: "0664 1234567",
      customerMaster: { role: "supplier", phone: "0664 1234567", name: "Farben Huber" },
    }]));
    const routes = {};
    const app = {
      get(route, handler) { routes[`GET ${route}`] = handler; },
      post() {}, delete() {},
    };
    registerNfonIntegration(app, {
      client: { configured: () => false }, requireAdmin: () => true, dataDir: root,
      readJobMeta: async jobId => ({
        name: `Baustelle ${jobId}`, contactName: "Erika Beispiel", contactPhone: "+43 664 1234567",
        street: "Testweg", houseNumber: "1", postalCode: "6800", city: "Feldkirch", projectContacts: {},
      }),
    });
    const response = responseDouble();
    await routes["GET /kristine/api/nfon/lookup"]({ query: { phone: "0664/123 45 67" } }, response);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.matches.some(row => row.kind === "job" && row.jobId === "4711"), true);
    assert.equal(response.body.matches.some(row => row.kind === "task" && row.role === "Lieferant"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

Promise.all([testProtectedClickToDialRoute(), testProtectedPhoneLookupRoute()]).then(() => {
  console.log("NFON integration tests passed");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
