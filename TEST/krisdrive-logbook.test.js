"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const express = require("express");
const { registerKrisdriveLogbook, dateRange, trackerMileage, normalizeLocal } = require("../krisdrive-logbook");

const trip = (extra = {}) => ({ deviceId: 17, startPositionId: 101, startTime: "2026-09-22T06:00:00Z", endTime: "2026-09-22T06:30:00Z", startAddress: "Frastanz Werkstatt", endAddress: "Feldkirch Baustelle", startLat: 47.21, startLon: 9.62, endLat: 47.24, endLon: 9.59, distance: 12500, startOdometer: 26734817.503, endOdometer: 26747317.503, ...extra });
async function harness(t, { local = [], config, request } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krisdrive-logbook-"));
  const root = path.join(dir, "_kristine", "vehicle-tracking");
  await fs.mkdir(path.join(dir, "_system"), { recursive: true }); await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(dir, "_system", "vehicles.json"), JSON.stringify([{ id: "byd", label: "BYD", plate: "FK 2589" }, { id: "van", label: "Bus" }]));
  await fs.writeFile(path.join(dir, "_system", "employees.json"), JSON.stringify([{ id: "alex", name: "Alexander Krista" }, { id: "inactive", name: "Inaktiv", active: false }]));
  await fs.writeFile(path.join(root, "tracker-config.json"), JSON.stringify(config || [{ vehicleId: "byd", traccarDeviceId: 17 }]));
  await fs.writeFile(path.join(root, "rides.json"), JSON.stringify(local));
  const calls = [], state = { offline: false, trips: [trip()] };
  const app = express();
  registerKrisdriveLogbook(app, { dataDir: dir, traccarBaseUrl: "https://gps.example", traccarToken: "gps-test-only", request: async (raw, opts) => {
    const url = new URL(raw); calls.push({ url, opts });
    if (request) return request(url, opts, state);
    if (state.offline) throw Error("Network unavailable");
    return { ok: true, json: async () => url.pathname === "/api/devices" ? [{ id: 17, uniqueId: "imei-byd" }] : state.trips };
  }, requireAdmin: require("../admin-auth").requireAdmin });
  const oldToken = process.env.ADMIN_TOKEN; process.env.ADMIN_TOKEN = "logbook-test-only";
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/kristine/api/krisdrive/logbook`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); if (oldToken === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = oldToken; });
  const query = "?vehicleId=byd&from=2026-09-22&to=2026-09-22";
  const get = async (suffix = query, auth = true) => fetch(base + suffix, { headers: auth ? { "x-admin-token": "logbook-test-only" } : {} });
  const patch = async (row, extra = {}, vehicleId = "byd") => fetch(base + `/${vehicleId}/${row.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-admin-token": "logbook-test-only" }, body: JSON.stringify({ revision: row.revision, category: "business", employeeId: "alex", purpose: "Baustellenbesprechung", startLocation: row.startLocation, endLocation: row.endLocation, odometerStartKm: "", odometerEndKm: "", ...extra }) });
  return { dir, root, state, calls, get, patch, query };
}

test("Austrian date filters handle both DST changes and invalid ranges", () => {
  const spring = dateRange({ from: "2026-03-29", to: "2026-03-29" });
  const autumn = dateRange({ from: "2026-10-25", to: "2026-10-25" });
  assert.equal(spring.end - spring.start, 23 * 3600000); assert.equal(autumn.end - autumn.start, 25 * 3600000);
  for (const query of [{ from: "2026-02-30", to: "2026-03-01" }, { from: "2026-02-01", to: "2026-02-30" }, { from: "2026-04-01", to: "2026-01-01" }, { from: "2026-01-01", to: "2026-12-31" }]) assert.throws(() => dateRange(query));
  assert.equal(trackerMileage({ totalDistance: 26734817.503 }).km, 26734.817503);
  assert.equal(trackerMileage({ totalDistance: null }).km, null);
  assert.equal(trackerMileage({ totalMileage: 500 }).km, null);
  assert.equal(trackerMileage({ odometer: 100000, totalDistance: 230000 }).source, "odometer");
});

test("imports only the configured vehicle and selected Austrian dates; does not invent missing distances", async t => {
  const h = await harness(t);
  h.state.trips.push(trip({ deviceId: 999 }), trip({ startPositionId: 102, startTime: "2026-09-21T21:50:00Z", endTime: "2026-09-21T22:10:00Z" }), trip({ startPositionId: 103, startTime: "2026-09-21T22:15:00Z", endTime: "2026-09-21T23:00:00Z", distance: null, startOdometer: null, endOdometer: null }));
  const data = await (await h.get()).json();
  assert.equal(data.rows.length, 2); assert.equal(data.totals.km, 12.5); assert.equal(data.totals.missingKm, 1);
  assert.equal(data.rows[0].distanceKm, null); assert.equal(data.rows[1].odometerStartKm, 26734.817503);
  assert.equal(h.calls[0].url.searchParams.get("deviceId"), "17");
  assert.equal(h.calls[0].opts.headers.Authorization, "Bearer gps-test-only");
  assert.equal((await h.get(h.query, false)).status, 403);
  assert.equal((await h.get(h.query.replace("byd", "unknown"))).status, 404);
  const csv = await h.get("/export.csv" + h.query); assert.equal(csv.status, 200); assert.match(csv.headers.get("content-disposition"), /\.csv/);
  assert.equal((await h.get("/export.pdf" + h.query, false)).status, 403);
});

test("edits survive refresh, private destinations are redacted in API and exports, stale writes fail", async t => {
  const h = await harness(t);
  let row = (await (await h.get()).json()).rows[0];
  assert.equal((await h.patch(row, {}, "van")).status, 404);
  const edited = await h.patch(row); assert.equal(edited.status, 200); row = (await edited.json()).row;
  assert.deepEqual(row.missing, []); assert.equal(row.driver.employeeName, "Alexander Krista");
  assert.equal((await h.patch({ ...row, revision: 0 })).status, 409);
  row = (await (await h.patch(row, { category: "private", purpose: "Secret location" })).json()).row;
  assert.equal(row.startLocation, ""); assert.equal(row.endLocation, ""); assert.equal(row.startPoint, null); assert.equal(row.purpose, "");
  const csv = await (await h.get("/export.csv" + h.query)).text();
  assert.ok(csv.includes("Privat")); assert.ok(!csv.includes("Frastanz Werkstatt")); assert.ok(!csv.includes("Feldkirch Baustelle")); assert.ok(!csv.includes("Baustellenbesprechung"));
  const refreshed = await (await h.get(h.query + "&refresh=1")).json();
  assert.equal(refreshed.rows.length, 1); assert.equal(refreshed.rows[0].category, "private");
  const [file] = await fs.readdir(path.join(h.root, "logbook"));
  const stored = JSON.parse(await fs.readFile(path.join(h.root, "logbook", file)));
  const saved = Object.values(stored.records)[0];
  assert.equal(saved.original.endLocation, "Feldkirch Baustelle"); assert.equal(saved.history.length, 2); assert.equal(saved.history[0].after.category, "business");
  h.state.offline = true;
  const offline = await (await h.get(h.query + "&refresh=1")).json();
  assert.equal(offline.rows[0].category, "private"); assert.match(offline.warning, /gespeicherte Fahrten/); assert.ok(offline.lastSync);
});

test("concurrent corrections preserve both records and reject incomplete or inverted odometers", async t => {
  const h = await harness(t);
  h.state.trips.push(trip({ startPositionId: 105, startTime: "2026-09-22T10:00:00Z", endTime: "2026-09-22T10:20:00Z" }));
  const [a, b] = (await (await h.get()).json()).rows;
  assert.equal((await h.patch(a, { odometerStartKm: "500", odometerEndKm: "" })).status, 400);
  assert.equal((await h.patch(a, { odometerStartKm: "500", odometerEndKm: "499" })).status, 400);
  assert.equal((await h.patch(a, { employeeId: "inactive" })).status, 400);
  const updates = await Promise.all([h.patch(a, { odometerStartKm: 30000, odometerEndKm: 30012.5, purpose: "=HYPERLINK(1)" }), h.patch(b, { category: "private" })]);
  assert.deepEqual(updates.map(row => row.status), [200, 200]);
  const result = await (await h.get()).json();
  assert.equal(result.rows[0].distanceKm, 12.5); assert.equal(result.rows[0].odometerCorrected, true); assert.equal(result.rows[1].category, "private");
  assert.match(await (await h.get("/export.csv" + h.query)).text(), /'=HYPERLINK/);
});

test("local ignition fallback is deduplicated when GPS returns and retains driver / classification", async t => {
  const local = [{ id: "ride-byd-one", vehicleId: "byd", startedAt: trip().startTime, closedAt: trip().endTime, driver: { employeeId: "alex", employeeName: "Alexander Krista" }, distanceKm: 12500, startPosition: { address: "Frastanz Werkstatt", rawAttributes: { totalDistance: 100000 } }, lastPosition: { address: "Feldkirch Baustelle", rawAttributes: { totalDistance: 112500 } } }];
  assert.equal(normalizeLocal(local[0], "byd").distanceKm, 12.5);
  const h = await harness(t, { local, config: [{ vehicleId: "byd", trackerUniqueId: "imei-byd" }] });
  h.state.offline = true;
  let data = await (await h.get()).json(); assert.equal(data.rows.length, 1); assert.equal(data.rows[0].distanceKm, 12.5);
  assert.equal((await h.patch(data.rows[0], { category: "private" })).status, 200);
  h.state.offline = false;
  data = await (await h.get(h.query + "&refresh=1")).json();
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].source, "traccar"); assert.equal(data.rows[0].category, "private"); assert.equal(data.rows[0].driver.employeeId, "alex");
});

test("corrupt persisted data is never overwritten with an empty book", async t => {
  const h = await harness(t); await h.get();
  const [file] = await fs.readdir(path.join(h.root, "logbook")); const target = path.join(h.root, "logbook", file);
  await fs.writeFile(target, "broken");
  assert.equal((await h.get(h.query + "&refresh=1")).status, 500); assert.equal(await fs.readFile(target, "utf8"), "broken");
});

test("missing trip addresses resolve through known places and the Traccar geocoder without losing manual edits", async t => {
  const h = await harness(t, { request: async (url, opts, state) => {
    if (url.pathname === "/api/reports/trips") return { ok: true, json: async () => state.trips };
    if (url.pathname === "/api/server/geocode") return { ok: true, text: async () => "Bahnhofstraße, Feldkirch" };
    throw Error("Unexpected GPS request");
  } });
  h.state.trips = [trip({ startAddress: "", endAddress: "", startLat: 47.22429, startLon: 9.61752, endLat: 47.26821, endLon: 9.64093 }),
    trip({ startPositionId: 106, startTime: "2026-09-22T08:00:00Z", endTime: "2026-09-22T08:20:00Z", startAddress: "", endAddress: "", startLat: 47.24, startLon: 9.59, endLat: 47.26821, endLon: 9.64093 })];
  let rows = (await (await h.get()).json()).rows;
  assert.equal(rows[0].startLocation, "Schmittengasse, Frastanz");
  assert.equal(rows[0].endLocation, "Torkelgässele, Rankweil");
  assert.equal(rows[1].startLocation, "Bahnhofstraße, Feldkirch");
  assert.equal(h.calls.filter(call => call.url.pathname === "/api/server/geocode").length, 1);
  const edited = await h.patch(rows[0], { startLocation: "Mein Ziel", endLocation: rows[0].endLocation });
  assert.equal(edited.status, 200);
  rows = (await (await h.get(h.query + "&refresh=1")).json()).rows;
  assert.equal(rows[0].startLocation, "Mein Ziel");
  assert.equal(rows[1].startLocation, "Bahnhofstraße, Feldkirch");
  assert.equal(h.calls.filter(call => call.url.pathname === "/api/server/geocode").length, 1);
});

test("old saved coordinate labels resolve in the page and exports even when GPS is offline", async t => {
  const h = await harness(t);
  h.state.trips = [trip({ startAddress: "", endAddress: "", startLat: 47.22429, startLon: 9.61752, endLat: 47.26821, endLon: 9.64093 })];
  await h.get();
  const [name] = await fs.readdir(path.join(h.root, "logbook"));
  const file = path.join(h.root, "logbook", name);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  const record = Object.values(saved.records)[0];
  record.data.startLocation = "47.22429, 9.61752";
  record.data.endLocation = "47.26821, 9.64093";
  await fs.writeFile(file, JSON.stringify(saved));
  h.state.offline = true;
  const result = await (await h.get(h.query + "&refresh=1")).json();
  assert.match(result.warning, /gespeicherte Fahrten/);
  assert.equal(result.rows[0].startLocation, "Schmittengasse, Frastanz");
  assert.equal(result.rows[0].endLocation, "Torkelgässele, Rankweil");
  const csv = await (await h.get("/export.csv" + h.query)).text();
  assert.match(csv, /Schmittengasse, Frastanz/);
  assert.match(csv, /Torkelgässele, Rankweil/);
});

test("adjacent trips supply missing start and end in both directions across midnight", async t => {
  const h = await harness(t);
  h.state.trips = [
    trip({ startPositionId: 201, startTime: "2026-09-21T20:00:00Z", endTime: "2026-09-21T20:30:00Z", endAddress: "Schmittengasse, Frastanz" }),
    trip({ startPositionId: 202, startTime: "2026-09-22T06:00:00Z", endTime: "2026-09-22T06:30:00Z", startAddress: "", endAddress: "", startLat: null, startLon: null, endLat: null, endLon: null }),
    trip({ startPositionId: 203, startTime: "2026-09-22T07:00:00Z", endTime: "2026-09-22T07:30:00Z", startAddress: "Torkelgässele, Rankweil" }),
  ];
  const rows = (await (await h.get()).json()).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].startLocation, "Schmittengasse, Frastanz");
  assert.equal(rows[0].endLocation, "Torkelgässele, Rankweil");
  assert.equal(rows[0].inferredStart, true);
  assert.equal(rows[0].inferredEnd, true);
  assert.ok(!rows[0].missing.includes("Start/Ziel"));
  const csv = await (await h.get("/export.csv" + h.query)).text();
  assert.match(csv, /aus vorheriger Fahrt/);
  assert.match(csv, /aus nächster Fahrt/);
  const privateRow = (await h.patch(rows[0], { category: "private" })).status;
  assert.equal(privateRow, 200);
  const hidden = (await (await h.get()).json()).rows[0];
  assert.equal(hidden.startLocation, ""); assert.equal(hidden.endLocation, "");
});
