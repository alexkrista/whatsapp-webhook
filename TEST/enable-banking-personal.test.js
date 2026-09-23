"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { register, jwt, normalize } = require("../enable-banking-personal");

test("JWT is signed with the application key and only booked debits become negative", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength:2048 });
  const token = jwt("app-id", privateKey);
  const [head, body, signature] = token.split(".");
  assert.equal(JSON.parse(Buffer.from(head, "base64url")).kid, "app-id");
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, "base64url")));
  assert.equal(normalize({ status:"BOOK", credit_debit_indicator:"DBIT", booking_date:"2026-09-22", entry_reference:"a", transaction_amount:{ amount:"12.50", currency:"EUR" } }, "IBAN").amount, "-12.50");
  assert.equal(normalize({ status:"PDNG", credit_debit_indicator:"DBIT", booking_date:"2026-09-22", transaction_amount:{ amount:"12", currency:"EUR" } }, "IBAN"), null);
});

test("bank authorization verifies account, consumes state, paginates and caches", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kristine-bank-"));
  try {
    const routes = {};
    const app = { get:(url,handler) => routes[`GET ${url}`]=handler, post:(url,handler) => routes[`POST ${url}`]=handler };
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength:2048 });
    const calls = [];
    const request = async (url, opts) => {
      calls.push(`${opts.method} ${url.pathname}${url.search}`);
      let value;
      if (url.pathname === "/auth") value = { url:"https://auth.enablebanking.com/ais/start" };
      else if (url.pathname === "/sessions") value = { session_id:"session", access:{ valid_until:"2027-01-01T00:00:00Z" }, accounts:[{ uid:"account-uid", account_id:{ iban:"AT611904300234573201" } }] };
      else if (url.pathname.endsWith("balances")) value = { balances:[{ balance_type:"CLAV", balance_amount:{ amount:"99.50", currency:"EUR" } }] };
      else value = url.searchParams.has("continuation_key") ? { transactions:[{ status:"BOOK", credit_debit_indicator:"DBIT", booking_date:"2026-09-22", entry_reference:"2", transaction_amount:{ amount:"5", currency:"EUR" } }] } : { transactions:[{ status:"BOOK", credit_debit_indicator:"CRDT", booking_date:"2026-09-21", entry_reference:"1", transaction_amount:{ amount:"10", currency:"EUR" } }], continuation_key:"next" };
      return { ok:true, json:async () => value };
    };
    register(app, { dataDir:dir, requireAdmin:() => true, request, config:{ ENABLE_BANKING_ACTIVE:"1", ENABLE_BANKING_APP_ID:"app-id", ENABLE_BANKING_EXPECTED_IBAN:"AT611904300234573201", ENABLE_BANKING_PRIVATE_KEY:privateKey.export({ type:"pkcs8", format:"pem" }) } });
    async function run(route, query={}) {
      const response = { code:200, status(n){ this.code=n; return this }, set(){ return this }, json(x){ this.data=x; return this }, redirect(n,url){ this.code=n; this.url=url; return this }, type(){ return this }, send(x){ this.data=x; return this } };
      await routes[route]({ query }, response);
      return response;
    }
    const started = await run("POST /banking/enablebanking/connect");
    assert.equal(started.data.ok, true);
    const record = JSON.parse(await fs.readFile(path.join(dir,"_kristine","enable-banking-personal.json")));
    const rejected = await run("GET /banking/enablebanking/callback", { state:"wrong", code:"abc" });
    assert.equal(rejected.code, 400);
    const accepted = await run("GET /banking/enablebanking/callback", { state:record.pending.state, code:"abc" });
    assert.equal(accepted.code, 303);
    assert.equal((await run("GET /banking/enablebanking/callback", { state:record.pending.state, code:"abc" })).code, 400);
    const data = (await run("GET /banking/enablebanking/status")).data;
    assert.equal(data.transactions.length, 2);
    assert.equal(data.balances[0].amount, "99.50");
    const count = calls.length;
    await run("GET /banking/enablebanking/status");
    assert.equal(calls.length, count, "repeat reading is cached for a day");
  } finally { await fs.rm(dir, { recursive:true, force:true }); }
});
