"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { requireAdmin } = require("./admin-auth");

const DAY = 86400000;
const ZONE = "Europe/Vienna";
const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const stampFormat = new Intl.DateTimeFormat("de-AT", { timeZone: ZONE, dateStyle: "short", timeStyle: "short" });
const array = value => Array.isArray(value) ? value : [];
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
const text = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function number(value) {
  if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
const km = value => number(value) === null || number(value) < 0 ? null : number(value) / 1000;
const iso = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const day = value => dateFormat.format(new Date(value));
const displayDate = value => value ? stampFormat.format(new Date(value)) : "";
function coordinates(lat, lng) {
  lat = number(lat); lng = number(lng);
  return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
}
function location(address, point) {
  return text(address) || (point ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : "");
}
function pointKey(point) { return point && `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`; }
function coordinateLabel(value) {
  const match = /^\s*([+-]?\d{1,2}(?:\.\d+)?),\s*([+-]?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(value || ""));
  return match ? coordinates(match[1], match[2]) : null;
}
const isCoordinates = value => Boolean(coordinateLabel(value));
const hasAddress = value => Boolean(text(value)) && !isCoordinates(value);
function metresBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot((a.lat - b.lat) * 111195, (a.lng - b.lng) * 111195 * Math.cos(a.lat * Math.PI / 180));
}
// Verified from the two locations reported by Alex. Limit these labels to
// nearby GPS fixes; other destinations must come from the geocoder.
const knownPlaces = [
  { lat: 47.22429, lng: 9.61752, label: "Schmittengasse, Frastanz" },
  { lat: 47.26821, lng: 9.64093, label: "Torkelgässele, Rankweil" },
];
function knownPlace(point) {
  if (!point) return "";
  const match = knownPlaces.find(place => metresBetween(point, place) <= 70);
  return match?.label || "";
}

// Date-only filters mean Austrian calendar days, including the DST transitions.
function midnight(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw fail("Ungültiges Datum.");
  const target = Date.parse(`${date}T00:00:00Z`);
  let result = target;
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(result)).map(part => [part.type, part.value]));
    result += target - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  }
  return result;
}
const nextDate = date => new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);
function dateRange(query = {}, now = Date.now()) {
  const today = day(now);
  const from = text(query.from || today.slice(0, 8) + "01", 10);
  const to = text(query.to || today, 10);
  midnight(to);
  const start = midnight(from), end = midnight(nextDate(to));
  if (from > to) throw fail("Das Ende liegt vor dem Beginn.");
  if ((Date.parse(to) - Date.parse(from)) / DAY > 92) throw fail("Bitte höchstens 93 Tage auf einmal auswählen.");
  return { from, to, start, end };
}

function trackerMileage(attrs = {}) {
  // Traccar's standard distance attributes use metres. totalMileage is not a
  // standard attribute and is deliberately not guessed to be a CAN odometer.
  for (const key of ["odometer", "obdOdometer", "totalDistance"]) {
    if (km(attrs[key]) !== null) return { km: km(attrs[key]), raw: number(attrs[key]), source: key, label: key === "totalDistance" ? "GPS-Zähler" : "Kilometerstand (Tracker)" };
  }
  return { km: null, raw: null, source: "", label: "Kilometerstand" };
}

function normalizeTrip(trip, vehicleId, deviceId) {
  const startedAt = iso(trip.startTime), closedAt = iso(trip.endTime);
  if (!startedAt || !closedAt || closedAt < startedAt || String(trip.deviceId) !== String(deviceId)) return null;
  const startPoint = coordinates(trip.startLat, trip.startLon), endPoint = coordinates(trip.endLat, trip.endLon);
  const noCounter = number(trip.startOdometer) === 0 && number(trip.endOdometer) === 0 && number(trip.distance) > 0;
  return {
    id: "trip-" + hash(`${vehicleId}:${deviceId}:${trip.startPositionId || startedAt}`),
    vehicleId: String(vehicleId), deviceId: String(deviceId), source: "traccar", startedAt, closedAt,
    startPositionId: text(trip.startPositionId, 30), endPositionId: text(trip.endPositionId, 30),
    startLocation: location(trip.startAddress, startPoint), endLocation: location(trip.endAddress, endPoint),
    startPoint, endPoint, distanceKm: km(trip.distance),
    odometerStartKm: noCounter ? null : km(trip.startOdometer), odometerEndKm: noCounter ? null : km(trip.endOdometer),
    driver: null,
  };
}

function normalizeLocal(ride, vehicleId) {
  const startedAt = iso(ride.startedAt), closedAt = iso(ride.closedAt);
  if (!ride.id || !startedAt || !closedAt || closedAt < startedAt) return null;
  const first = ride.startPosition || {}, last = ride.lastPosition || {};
  const startPoint = coordinates(first.lat, first.lng), endPoint = coordinates(last.lat, last.lng);
  // Old distanceKm values contain unconverted metres. Derive from the recorded
  // standard attribute rather than silently trusting that legacy field.
  let startKm = null, endKm = null;
  for (const key of ["odometer", "obdOdometer", "totalDistance"]) {
    if (km(first.rawAttributes?.[key]) !== null && km(last.rawAttributes?.[key]) !== null) {
      startKm = km(first.rawAttributes[key]); endKm = km(last.rawAttributes[key]); break;
    }
  }
  let distanceKm = number(ride.gpsDistanceKm);
  if (distanceKm === null && ride.distanceVerified === true) distanceKm = number(ride.distanceKm);
  if (distanceKm === null && startKm !== null && endKm !== null && endKm >= startKm) distanceKm = endKm - startKm;
  return {
    id: "local-" + hash(`${vehicleId}:${ride.id}`), vehicleId, source: "kristine", startedAt, closedAt,
    startLocation: location(first.address, startPoint), endLocation: location(last.address, endPoint), startPoint, endPoint,
    distanceKm: distanceKm !== null && distanceKm >= 0 ? distanceKm : null,
    odometerStartKm: startKm, odometerEndKm: endKm, driver: ride.driver || null,
  };
}

function matchingLocal(trip, local) {
  return local.filter(ride => ride.startedAt <= trip.startedAt && ride.closedAt >= trip.closedAt ||
    Math.abs(Date.parse(ride.startedAt) - Date.parse(trip.startedAt)) <= 120000 && Math.abs(Date.parse(ride.closedAt) - Date.parse(trip.closedAt)) <= 300000);
}
function view(record) {
  const row = { ...record.data, ...(record.edits || {}) };
  // A saved trip must stay readable even if Traccar is temporarily unavailable:
  // sync cannot enrich existing records while the GPS report is offline.
  for (const [field, pointField] of [["startLocation", "startPoint"], ["endLocation", "endPoint"]]) {
    // Older edit forms submitted unchanged coordinate placeholders as edits.
    // A subsequently resolved GPS address must still be allowed to replace them.
    if (!hasAddress(row[field]) && hasAddress(record.data[field])) row[field] = record.data[field];
    row[pointField] = coordinates(row[pointField]?.lat, row[pointField]?.lng) || coordinateLabel(row[field]);
    if (!row[field] || isCoordinates(row[field])) row[field] = knownPlace(row[pointField]) || row[field];
  }
  if (Object.hasOwn(record.edits || {}, "odometerStartKm") && row.odometerStartKm !== null && row.odometerEndKm !== null) row.distanceKm = row.odometerEndKm - row.odometerStartKm;
  row.category = row.category || "unassigned";
  row.purpose = row.purpose || "";
  row.revision = record.revision || 0;
  row.updatedAt = record.updatedAt || null;
  row.changedBy = record.changedBy || "";
  row.changeCount = array(record.history).length;
  row.odometerCorrected = Object.hasOwn(record.edits || {}, "odometerStartKm");
  row.missing = [];
  if (!row.driver?.employeeId) row.missing.push("Fahrer");
  if (row.category === "unassigned") row.missing.push("Fahrtart");
  if (row.distanceKm === null) row.missing.push("Kilometer");
  if (row.odometerStartKm === null || row.odometerEndKm === null) row.missing.push("km-Stand");
  else if (row.odometerEndKm < row.odometerStartKm) row.missing.push("km-Stand prüfen");
  if (row.category === "business") {
    if (!row.startLocation || !row.endLocation) row.missing.push("Start/Ziel");
    if (!row.purpose) row.missing.push("Zweck");
  }
  if (row.category === "private") {
    row.startLocation = ""; row.endLocation = ""; row.startPoint = null; row.endPoint = null; row.purpose = "";
    row.startPositionId = ""; row.endPositionId = "";
  }
  return row;
}
function linkTripEndpoints(rows) {
  const quality = value => hasAddress(value) ? 2 : isCoordinates(value) ? 1 : 0;
  for (let i = 1; i < rows.length; i++) {
    const before = rows[i - 1], after = rows[i];
    const gap = Date.parse(after.startedAt) - Date.parse(before.closedAt);
    // Only adjacent recorded trips of this vehicle are linked. Never derive
    // a private destination from a neighboring business trip or vice versa.
    if (!Number.isFinite(gap) || gap < 0 || before.vehicleId !== after.vehicleId || before.category === "private" || after.category === "private") continue;
    const oldEnd = before.endLocation, oldStart = after.startLocation;
    if (quality(oldEnd) < quality(oldStart)) {
      before.endLocation = oldStart;
      before.endPoint ||= after.startPoint;
      before.inferredEnd = true;
      if (before.startLocation) before.missing = before.missing.filter(item => item !== "Start/Ziel");
    }
    if (quality(oldStart) < quality(oldEnd)) {
      after.startLocation = oldEnd;
      after.startPoint ||= before.endPoint;
      after.inferredStart = true;
      if (after.endLocation) after.missing = after.missing.filter(item => item !== "Start/Ziel");
    }
  }
  return rows;
}
function reuseStopAddresses(rows) {
  // Build from this vehicle's visible records, never from redacted private trips.
  // Keep actual GPS points, including small differences between arrival/departure.
  const places = new Map();
  for (const row of rows) {
    if (row.category === "private") continue;
    for (const [field, pointField] of [["startLocation", "startPoint"], ["endLocation", "endPoint"]]) {
      if (hasAddress(row[field]) && row[pointField]) {
        places.set(`${row.vehicleId}:${pointKey(row[pointField])}`, { vehicleId: row.vehicleId, point: row[pointField], label: row[field] });
      }
    }
  }
  for (const row of rows) {
    if (row.category === "private") continue;
    for (const [field, pointField] of [["startLocation", "startPoint"], ["endLocation", "endPoint"]]) {
      if (hasAddress(row[field]) || !row[pointField]) continue;
      let nearest = null, distance = 40;
      for (const place of places.values()) {
        if (place.vehicleId !== row.vehicleId) continue;
        const gap = metresBetween(row[pointField], place.point);
        if (gap <= distance) { nearest = place; distance = gap; }
      }
      if (nearest) row[field] = nearest.label;
    }
  }
  return rows;
}
function resolvedRows(records) {
  const rows = records.map(view).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  // Resolve known coordinates before joining the stops. Then learn the other
  // GPS fix of each joined stop, so recurring visits and old records benefit too.
  linkTripEndpoints(reuseStopAddresses(rows));
  linkTripEndpoints(reuseStopAddresses(rows));
  for (const row of rows) {
    row.missing = row.missing.filter(item => item !== "Start/Ziel");
    if (row.category === "business" && (!hasAddress(row.startLocation) || !hasAddress(row.endLocation))) row.missing.push("Start/Ziel");
  }
  return rows;
}
function totals(rows) {
  return rows.reduce((sum, row) => {
    const value = row.distanceKm || 0;
    sum.count++; sum.km += value;
    sum[row.category + "Km"] += value;
    if (row.missing.length) sum.open++;
    if (row.distanceKm === null) sum.missingKm++;
    return sum;
  }, { count: 0, km: 0, businessKm: 0, privateKm: 0, unassignedKm: 0, open: 0, missingKm: 0 });
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

function registerKrisdriveLogbook(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const root = path.join(dataDir, "_kristine", "vehicle-tracking");
  const auth = options.requireAdmin || requireAdmin;
  const request = options.request || globalThis.fetch;
  const base = String(options.traccarBaseUrl ?? process.env.TRACCAR_BASE_URL ?? "").replace(/\/$/, "");
  const token = String(options.traccarToken ?? process.env.TRACCAR_TOKEN ?? "").trim();
  const express = options.express || require("express");
  const json = express.json({ limit: "24kb" });
  const locks = new Map(), refreshed = new Map(), inFlight = new Map();
  const addressCache = new Map();
  const fileFor = id => path.join(root, "logbook", hash(id) + ".json");
  async function stateFor(id) {
    const state = await readJson(fileFor(id), { version: 1, records: {}, lastSync: null });
    if (state.version !== 1 || !state.records || typeof state.records !== "object" || Array.isArray(state.records)) throw fail("Die gespeicherten Fahrtenbuchdaten können nicht gelesen werden.", 500);
    return state;
  }
  async function mutate(id, fn) {
    const previous = locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const state = await stateFor(id);
      const result = await fn(state);
      const file = fileFor(id), tmp = `${file}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(tmp, file);
      return result;
    });
    locks.set(id, current);
    try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
  }
  async function traccar(apiPath, timeout = 25000) {
    if (!base || !token) throw fail("Der GPS-Zugang ist noch nicht eingerichtet.", 503);
    const response = await request(base + apiPath, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw fail(`GPS-Abruf fehlgeschlagen (HTTP ${response.status}).`, 502);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw fail("Der GPS-Dienst hat keine Fahrtenliste geliefert.", 502);
    return rows;
  }
  async function context(vehicleId) {
    const [master, config, people, rides] = await Promise.all([
      readJson(path.join(dataDir, "_system", "vehicles.json"), []), readJson(path.join(root, "tracker-config.json"), []),
      readJson(path.join(dataDir, "_system", "employees.json"), []), readJson(path.join(root, "rides.json"), []),
    ]);
    const vehicle = array(master).find(row => String(row.id) === vehicleId);
    if (!vehicle) throw fail("Fahrzeug nicht gefunden.", 404);
    return {
      vehicle: { id: vehicleId, label: text(vehicle.label || [vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicle.plate || "Fahrzeug", 160), plate: text(vehicle.plate, 60) },
      tracking: array(config).find(row => String(row.vehicleId) === vehicleId),
      employees: array(people).filter(row => row.active !== false).map(row => ({ id: String(row.id || row.employeeId), name: text(row.nickname || row.rufname || row.name || row.employeeName, 150) })),
      local: array(rides).filter(row => String(row.vehicleId) === vehicleId).map(row => normalizeLocal(row, vehicleId)).filter(Boolean),
    };
  }
  async function sync(ctx, range, force) {
    if (range.start > Date.now()) return "";
    const key = `${ctx.vehicle.id}:${range.from}:${range.to}`;
    if (!force && Date.now() - (refreshed.get(key) || 0) < 60000) return "";
    if (inFlight.has(key)) return inFlight.get(key);
    const work = (async () => {
      let trips = [], warning = "", gpsOk = false;
      try {
        if (!ctx.tracking) throw fail("Dieses Fahrzeug ist noch keinem GPS-Tracker zugeordnet.", 503);
        let deviceId = text(ctx.tracking.traccarDeviceId, 30);
        if (!/^\d+$/.test(deviceId)) {
          const devices = await traccar("/api/devices");
          deviceId = String(devices.find(row => String(row.uniqueId) === String(ctx.tracking.trackerUniqueId))?.id || "");
        }
        if (!/^\d+$/.test(deviceId)) throw fail("Der zugeordnete GPS-Tracker wurde nicht gefunden.", 503);
        // Padding avoids cutting ordinary overnight trips at the filter boundary.
        const query = new URLSearchParams({ deviceId, from: new Date(range.start - DAY).toISOString(), to: new Date(Math.min(range.end + DAY, Date.now())).toISOString() });
        trips = (await traccar("/api/reports/trips?" + query)).map(row => normalizeTrip(row, ctx.vehicle.id, deviceId)).filter(Boolean);
        const previous = await stateFor(ctx.vehicle.id);
        // A report can omit an endpoint while still referring to its original
        // position. Recover that exact fix, not the first later fix while moving.
        const endpoints = trips.filter(trip => previous.records[trip.id]?.edits?.category !== "private").flatMap(trip =>
          [["startLocation", "startPoint", "startPositionId"], ["endLocation", "endPoint", "endPositionId"]]
            .filter(([field, pointField, idField]) => !hasAddress(trip[field]) && !trip[pointField] && /^[1-9]\d*$/.test(trip[idField]))
            .map(([field, pointField, idField]) => ({ trip, field, pointField, id: trip[idField] })));
        const ids = [...new Set(endpoints.map(endpoint => endpoint.id))].slice(0, 40);
        if (ids.length) {
          try {
            const positions = await traccar("/api/positions?" + new URLSearchParams(ids.map(id => ["id", id])), 5000);
            for (const endpoint of endpoints) {
              const position = positions.find(row => String(row.id) === endpoint.id && String(row.deviceId) === deviceId && row.valid !== false);
              if (!position) continue;
              const point = coordinates(position.latitude, position.longitude);
              endpoint.trip[endpoint.pointField] = point;
              endpoint.trip[endpoint.field] = location(position.address, point) || endpoint.trip[endpoint.field];
            }
          } catch { /* The report remains usable if individual positions are unavailable. */ }
        }
        let geocoderUnavailable = false, lookups = 0;
        for (const trip of trips) {
          if (previous.records[trip.id]?.edits?.category === "private") continue;
          for (const [field, pointField] of [["startLocation", "startPoint"], ["endLocation", "endPoint"]]) {
            const point = trip[pointField], key = pointKey(point);
            if (!key || (trip[field] && !isCoordinates(trip[field]))) continue;
            const old = previous.records[trip.id]?.data;
            if (pointKey(old?.[pointField]) === key && old?.[field] && !isCoordinates(old[field])) { trip[field] = old[field]; continue; }
            let address = knownPlace(point) || addressCache.get(key) || "";
            if (!address && !geocoderUnavailable && lookups < 12) {
              lookups++;
              try {
                const params = new URLSearchParams({ latitude: point.lat, longitude: point.lng });
                const response = await request(base + "/api/server/geocode?" + params, { headers: { Accept: "text/plain", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
                if (response.ok) address = text(await response.text());
                else if (response.status === 500 || response.status === 401 || response.status === 403) geocoderUnavailable = true;
              } catch { geocoderUnavailable = true; }
            }
            if (address && !isCoordinates(address)) {
              trip[field] = address;
              if (addressCache.size > 500) addressCache.clear();
              addressCache.set(key, address);
            }
          }
        }
        for (const trip of trips) {
          const matches = matchingLocal(trip, ctx.local);
          const drivers = new Map(matches.filter(row => row.driver?.employeeId).map(row => [row.driver.employeeId, row.driver]));
          if (drivers.size === 1) trip.driver = [...drivers.values()][0];
        }
        gpsOk = true;
      } catch (error) {
        warning = error.status ? error.message : "Der GPS-Dienst ist gerade nicht erreichbar.";
        warning += " Angezeigt werden bereits gespeicherte Fahrten.";
      }
      await mutate(ctx.vehicle.id, state => {
        const now = new Date().toISOString();
        // The report is authoritative when available; the ignition archive is a
        // fallback, never a second copy of the same trip.
        const candidates = gpsOk ? trips : ctx.local.filter(row => Date.parse(row.startedAt) >= range.start - DAY && Date.parse(row.startedAt) < range.end + DAY);
        for (const trip of candidates) {
          if (trip.source === "kristine" && Object.values(state.records).some(record => record.data.source === "traccar" && matchingLocal(record.data, [trip]).length)) continue;
          let record = state.records[trip.id];
          if (!record && trip.source === "traccar") {
            const previous = Object.entries(state.records).filter(([, row]) => row.data.source === "kristine" && matchingLocal(trip, [row.data]).length);
            if (previous.length === 1) {
              const [oldId, old] = previous[0];
              // Preserve an edited ignition session if it was split into multiple
              // GPS trips; don't silently move its annotation onto just one part.
              const counterparts = trips.filter(row => matchingLocal(row, [old.data]).length);
              if (counterparts.length === 1) {
                record = old; delete state.records[oldId];
                record.history.push({ type: "source_link", at: now, previous: old.data });
                record.revision++;
              } else if (old.revision > 0) continue;
              else delete state.records[oldId];
            }
          }
          if (!record) record = { data: trip, original: trip, edits: {}, history: [], revision: 0 };
          else if (JSON.stringify(record.data) !== JSON.stringify(trip)) {
            if (record.revision > 0) record.history.push({ type: "gps_refresh", at: now, previous: record.data });
            record.revision++;
            record.data = trip;
          }
          state.records[trip.id] = record;
        }
        if (gpsOk) state.lastSync = now;
      });
      if (gpsOk) {
        if (refreshed.size > 200) refreshed.clear();
        refreshed.set(key, Date.now());
      }
      return warning;
    })();
    inFlight.set(key, work);
    try { return await work; } finally { inFlight.delete(key); }
  }
  async function report(query) {
    const range = dateRange(query), vehicleId = text(query.vehicleId, 100);
    const ctx = await context(vehicleId);
    const warning = await sync(ctx, range, query.refresh === "1");
    const state = await stateFor(vehicleId);
    const rows = resolvedRows(Object.values(state.records))
      .filter(row => day(row.startedAt) >= range.from && day(row.startedAt) <= range.to);
    return { ok: true, vehicle: ctx.vehicle, employees: ctx.employees, range: { from: range.from, to: range.to }, rows, totals: totals(rows), warning, lastSync: state.lastSync, generatedAt: new Date().toISOString() };
  }
  const api = "/kristine/api/krisdrive/logbook";
  const route = handler => async (req, res) => {
    if (!auth(req, res)) return;
    res.set("Cache-Control", "no-store");
    try { await handler(req, res); }
    catch (error) { res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : "Das Fahrtenbuch konnte nicht verarbeitet werden." }); }
  };
  app.get(api, route(async (req, res) => res.json(await report(req.query))));
  app.patch(api + "/:vehicleId/:rideId", json, route(async (req, res) => {
    const ctx = await context(text(req.params.vehicleId, 100));
    const body = req.body || {};
    const result = await mutate(ctx.vehicle.id, state => {
      const record = state.records[text(req.params.rideId, 100)];
      if (!record) throw fail("Fahrt nicht gefunden. Bitte die Liste aktualisieren.", 404);
      if (!Number.isInteger(body.revision) || body.revision !== record.revision) throw fail("Diese Fahrt wurde inzwischen geändert. Bitte neu laden.", 409);
      if (!["unassigned", "business", "private"].includes(body.category)) throw fail("Bitte eine gültige Fahrtart auswählen.");
      const employeeId = text(body.employeeId, 100);
      const employee = ctx.employees.find(row => row.id === employeeId);
      const current = view(record);
      if (employeeId && !employee && current.driver?.employeeId !== employeeId) throw fail("Mitarbeiter nicht gefunden oder inaktiv.");
      const edits = { ...record.edits, category: body.category, driver: employee ? { employeeId, employeeName: employee.name, source: "logbook" } : employeeId ? current.driver : null };
      if (body.category !== "private") {
        for (const key of ["startLocation", "endLocation", "purpose"]) {
          if (Object.hasOwn(body, key)) edits[key] = text(body[key], key === "purpose" ? 1000 : 500);
        }
      }
      const start = number(body.odometerStartKm), end = number(body.odometerEndKm);
      if (start === null && end === null && [body.odometerStartKm, body.odometerEndKm].every(value => value === "" || value === null || value === undefined)) {
        delete edits.odometerStartKm; delete edits.odometerEndKm;
      } else if (start === null || end === null || start < 0 || end < start || end > 10000000) throw fail("Bitte beide Kilometerstände gültig eingeben; Ende muss mindestens Beginn sein.");
      else { edits.odometerStartKm = start; edits.odometerEndKm = end; }
      const actor = text(req.kristineActor?.name || "KRISTINE-Administration", 160);
      const at = new Date().toISOString();
      if (JSON.stringify(edits) !== JSON.stringify(record.edits)) {
        record.history.push({ type: "edit", at, actor, actorId: text(req.kristineActor?.id, 100), before: record.edits, after: edits });
        record.edits = edits; record.updatedAt = at; record.changedBy = actor; record.revision++;
      }
      return view(record);
    });
    res.json({ ok: true, row: result });
  }));
  app.get(api + "/export.:format", route(async (req, res) => {
    if (!["csv", "pdf"].includes(req.params.format)) throw fail("Unbekanntes Exportformat.");
    const data = await report(req.query);
    const file = `Fahrtenbuch-${data.vehicle.plate || data.vehicle.id}-${data.range.from}-${data.range.to}`.replace(/[^A-Za-z0-9_-]/g, "_");
    res.set("Content-Disposition", `attachment; filename="${file}.${req.params.format}"`);
    if (req.params.format === "csv") res.type("text/csv; charset=utf-8").send(createCsv(data));
    else res.type("application/pdf").send(await require("./krisdrive-logbook-pdf").createLogbookPdf(data));
  }));
  return { report };
}

const categoryLabel = category => ({ business: "Geschäftlich", private: "Privat", unassigned: "Offen" })[category] || "Offen";
const decimal = value => value === null || value === undefined ? "" : Number(value).toLocaleString("de-AT", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
function createCsv(data) {
  // Text remains text in spreadsheet applications, including leading whitespace.
  const cell = value => { let str = String(value ?? ""); if (/^[\s]*[=+@-]/.test(str)) str = "'" + str; return '"' + str.replace(/"/g, '""') + '"'; };
  const rows = [
    ["Fahrzeug", data.vehicle.label, "Kennzeichen", data.vehicle.plate],
    ["Zeitraum", data.range.from, data.range.to, "Stand", displayDate(data.generatedAt)],
    ["GPS-Abruf", data.warning || "Aktuell", "Letzter Abruf", displayDate(data.lastSync)],
    ["Beginn", "Ende", "Fahrer", "Fahrtart", "Start", "Ziel", "Zweck / Kunde / Baustelle", "km Beginn (Tracker/Korrektur)", "km Ende (Tracker/Korrektur)", "Kilometer", "Zu ergänzen", "Geändert am"],
    ...data.rows.map(row => [displayDate(row.startedAt), displayDate(row.closedAt), row.driver?.employeeName || "", categoryLabel(row.category), row.category === "private" ? "" : row.startLocation + (row.inferredStart ? " (aus vorheriger Fahrt)" : ""), row.category === "private" ? "" : row.endLocation + (row.inferredEnd ? " (aus nächster Fahrt)" : ""), row.category === "private" ? "" : row.purpose, decimal(row.odometerStartKm), decimal(row.odometerEndKm), decimal(row.distanceKm), row.missing.join(", "), displayDate(row.updatedAt)]),
    [], ["Summe km", decimal(data.totals.km)], ["Geschäftlich km", decimal(data.totals.businessKm)], ["Privat km", decimal(data.totals.privateKm)], ["Nicht zugeordnet km", decimal(data.totals.unassignedKm)], ["Fahrten ohne Kilometerangabe", data.totals.missingKm],
  ];
  return "\uFEFF" + rows.map(row => row.map(cell).join(";")).join("\r\n") + "\r\n";
}

module.exports = { registerKrisdriveLogbook, trackerMileage, number, coordinates, dateRange, normalizeTrip, normalizeLocal, view, totals, createCsv, displayDate, decimal, categoryLabel };
