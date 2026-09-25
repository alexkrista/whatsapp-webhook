"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createAddressQueue } = require("../krisdrive-address-queue");

test("queue survives restarts, backs off failures, drains untouched points first and persists results", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krisdrive-queue-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "queue.json"); let now = 1000, calls = 0;
  let queue = createAddressQueue({ file, now: () => now, lookup: async () => { calls++; throw Error("offline"); } });
  const points = Array.from({ length: 8 }, (_, i) => [String(i), { lat: 47 + i / 100, lng: 9.6 }]);
  await queue.enqueue(points);
  await Promise.all([queue.drain(), queue.drain()]);
  assert.equal(calls, 4, "only one consumer");
  assert.deepEqual((await queue.status()).errors, { provider_unavailable: 4 });
  queue = createAddressQueue({ file, now: () => now, lookup: async () => { calls++; return "Buchholzstrasse, Rüthi (SG)"; } });
  await queue.drain();
  assert.equal(calls, 8);
  await queue.drain(); assert.equal(calls, 8, "failed jobs retain retry time after restart");
  now += 60001; await queue.drain(); assert.equal(calls, 12);
  queue = createAddressQueue({ file, now: () => now, lookup: async () => { throw Error("must use persisted cache"); } });
  const result = await queue.enqueue(points); assert.equal(Object.values(result).filter(Boolean).length, 8);
  assert.equal((await queue.status()).resolved, 8);
  assert.equal(await queue.drain(), 0);
});

test("obsolete/private jobs are not requested, and corrupt storage is never replaced", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krisdrive-queue-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "queue.json");
  const queue = createAddressQueue({ file, lookup: async () => { throw Error("must not request"); } });
  await queue.enqueue([["private", { lat: 47, lng: 9 }]]);
  assert.equal(await queue.drain({ wanted: new Set() }), 0);
  await fs.writeFile(file, "broken");
  const restarted = createAddressQueue({ file, lookup: async () => "" });
  await assert.rejects(restarted.enqueue([]));
  assert.equal(await fs.readFile(file, "utf8"), "broken");
});
