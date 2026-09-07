"use strict";

const assert = require("node:assert/strict");
const { NfonCtiClient, dialNumber, parseSse } = require("../nfon-cti-client");

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function testAuthenticationAndExtensions() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/login")) return jsonResponse({ "access-token": "access-secret", "refresh-token": "refresh-secret" });
    return jsonResponse([{ uuid: "101@KC7BV", extension_number: "101", name: "Bettina" }]);
  };
  const client = new NfonCtiClient({
    username: "api-user", password: "api-password", kAccount: "KC7BV", fetchImpl, now: () => 1000,
  });
  const rows = await client.getPhoneExtensions();
  assert.equal(rows[0].extension_number, "101");
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), { username: "api-user", password: "api-password" });
  assert.equal(calls[1].options.headers.Authorization, "Bearer access-secret");
  assert.equal(calls[1].options.headers["User-Agent"], "kristine/2.0.0 (KC7BV)");
}

async function testTokenReuseAndClickToDial() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/login")) return jsonResponse({ "access-token": "access", "refresh-token": "refresh" });
    if (options.method === "POST") return jsonResponse({ uuid: "715a1333-0174-40ea-8b38-67e289069476", state: "start" }, 202);
    return jsonResponse([]);
  };
  const client = new NfonCtiClient({ username: "u", password: "p", kAccount: "KC7BV", fetchImpl, now: () => 1000 });
  await client.getStates(["101", "102"]);
  const result = await client.originateCall({ caller: "101", extension: "101", callee: "+43 5522 12345" });
  assert.equal(result.state, "start");
  assert.equal(calls.filter(call => call.url.endsWith("/login")).length, 1);
  const payload = JSON.parse(calls.at(-1).options.body);
  assert.deepEqual(payload, {
    caller: "101", caller_context: "KC7BV", callee: "43552212345", callee_context: "global", extension: "101", timeout: 20,
  });
  assert.match(calls[1].url, /extension=101&extension=102$/);
}

async function testSseParser() {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"state":"ring",'));
      controller.enqueue(encoder.encode('\n' + 'data: "extension":"101"}\n\n'));
      controller.close();
    },
  });
  const rows = [];
  for await (const row of parseSse(body)) rows.push(row);
  assert.deepEqual(rows, [{ state: "ring", extension: "101" }]);
}

async function run() {
  assert.equal(dialNumber("+43 5522/123-45", "Nummer"), "43552212345");
  assert.equal(dialNumber("0043 5522 12345", "Nummer"), "43552212345");
  await testAuthenticationAndExtensions();
  await testTokenReuseAndClickToDial();
  await testSseParser();
  console.log("NFON CTI client tests passed");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
