"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function registerVehicleTracking(app, options = {}) {
  const express = options.express || require("express");
  const DATA_DIR = options.dataDir || process.env.DATA_DIR || "/var/data";
  const ADMIN_TOKEN = String(options.adminToken ?? process.env.ADMIN_TOKEN ?? "");
  const TRACKER_SECRET = String(process.env.VEHICLE_TRACKING_SECRET || "").trim();
  const TRACCAR_BASE_URL = String(process.env.TRACCAR_BASE_URL || "").replace(/\/$/, "");
  const TRACCAR_TOKEN = String(process.env.TRACCAR_TOKEN || "").trim();
  const BUZZER_ON_COMMAND = String(process.env.TRACCAR_BUZZER_ON_COMMAND || "").trim();
  const BUZZER_OFF_COMMAND = String(process.env.TRACCAR_BUZZER_OFF_COMMAND || "").trim();
  const BUZZER_DELAY_MS = Math.max(5000, Number(process.env.VEHICLE_BUZZER_DELAY_MS || 20000));

  const ROOT = path.join(DATA_DIR, "_kristine", "vehicle-tracking");
  const SYSTEM_DIR = path.join(DATA_DIR, "_system");
  const VEHICLE_MASTER = path.join(SYSTEM_DIR, "vehicles.json");
  const EMPLOYEE_MASTER = path.join(SYSTEM_DIR, "employees.json");
  const TRACKER_CONFIG = path.join(ROOT, "tracker-config.json");
  const SESSIONS = path.join(ROOT, "sessions.json");
  const RIDES = path.join(ROOT, "rides.json");
  const EVENTS = path.join(ROOT, "events.jsonl");
  const POSITION_DIR = path.join(ROOT, "positions");

  const buzzerTimers = new Map();
  let initialized = false;

  async function ensureRoot() {
    await fsp.mkdir(ROOT, { recursive: true });
    await fsp.mkdir(POSITION_DIR, { recursive: true });
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async function writeJson(file, value) {
    await ensureRoot();
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  async function appendEvent(type, payload = {}) {
    await ensureRoot();
    await fsp.appendFile(EVENTS, `${JSON.stringify({ at: new Date().toISOString(), type, ...payload })}\n`, "utf8");
  }

  function safeId(value) {
    return String(value || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
  }

  function newToken() {
    return crypto.randomBytes(18).toString("base64url");
  }

  function normalizeBool(value) {
    if (value === true || value === 1 || value === "1") return true;
    if (value === false || value === 0 || value === "0") return false;
    const text = String(value ?? "").trim().toLowerCase();
    if (["true", "on", "yes", "ein"].includes(text)) return true;
    if (["false", "off", "no", "aus"].includes(text)) return false;
    return null;
  }

  function iso(value, fallback = new Date().toISOString()) {
    const d = value ? new Date(value) : new Date(fallback);
    return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
  }

  function viennaDate(value = new Date()) {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date(value));
  }

  function employeeDisplayName(employee) {
    return String(employee?.nickname || employee?.rufname || employee?.name || employee?.employeeName || "Mitarbeiter").trim();
  }

  async function employees() {
    const rows = await readJson(EMPLOYEE_MASTER, []);
    return Array.isArray(rows) ? rows : [];
  }

  async function vehicles() {
    const rows = await readJson(VEHICLE_MASTER, []);
    return Array.isArray(rows) ? rows : [];
  }

  async function trackerConfig() {
    const rows = await readJson(TRACKER_CONFIG, []);
    return Array.isArray(rows) ? rows : [];
  }

  async function saveTrackerConfig(rows) {
    await writeJson(TRACKER_CONFIG, rows);
  }

  async function sessions() {
    const data = await readJson(SESSIONS, {});
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  }

  async function rides() {
    const data = await readJson(RIDES, []);
    return Array.isArray(data) ? data : [];
  }

  async function resolveVehicleByConfig({ vehicleId, vehicleKey, traccarDeviceId, uniqueId } = {}) {
    const master = await vehicles();
    const config = await trackerConfig();
    const wantedVehicleId = safeId(vehicleId || vehicleKey);
    let row = null;
    if (wantedVehicleId) row = config.find(item => String(item.vehicleId) === wantedVehicleId) || null;
    if (!row && traccarDeviceId !== undefined && traccarDeviceId !== null) {
      row = config.find(item => String(item.traccarDeviceId || "") === String(traccarDeviceId)) || null;
    }
    if (!row && uniqueId) row = config.find(item => String(item.trackerUniqueId || "") === String(uniqueId)) || null;
    if (!row) return null;
    const vehicle = master.find(item => String(item.id) === String(row.vehicleId)) || null;
    return { config: row, vehicle };
  }

  function publicVehicle(config, vehicle) {
    return {
      id: String(config?.vehicleId || vehicle?.id || ""),
      label: String(vehicle?.label || [vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || config?.label || config?.vehicleId || "Fahrzeug"),
      plate: String(vehicle?.plate || ""),
    };
  }

  function requireAdmin(req, res) {
    if (!ADMIN_TOKEN) return true;
    const token = String(req.headers["x-admin-token"] || req.query.token || "");
    if (token === ADMIN_TOKEN) return true;
    res.status(403).json({ ok: false, error: "Forbidden" });
    return false;
  }

  function requireTracker(req, res) {
    if (!TRACKER_SECRET) {
      res.status(503).json({ ok: false, error: "VEHICLE_TRACKING_SECRET ist noch nicht gesetzt." });
      return false;
    }
    const header = String(req.headers["x-kristine-tracker-key"] || req.headers["authorization"] || "");
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim();
    const a = Buffer.from(token);
    const b = Buffer.from(TRACKER_SECRET);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    res.status(401).json({ ok: false, error: "Ungültiger Tracker-Key" });
    return false;
  }

  async function sendTraccarCustomCommand(config, text) {
    if (!text) return { ok: false, skipped: true, reason: "command_not_configured" };
    if (!TRACCAR_BASE_URL || !TRACCAR_TOKEN || !config?.traccarDeviceId) {
      return { ok: false, skipped: true, reason: "traccar_not_configured" };
    }
    const response = await fetch(`${TRACCAR_BASE_URL}/api/commands/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TRACCAR_TOKEN}`,
      },
      body: JSON.stringify({
        deviceId: Number(config.traccarDeviceId),
        type: "custom",
        textChannel: false,
        attributes: { data: text },
      }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Traccar ${response.status}: ${body.slice(0, 300)}`);
    return { ok: true, status: response.status, body: body.slice(0, 500) };
  }

  async function setBuzzer(vehicleId, on, reason = "") {
    const resolved = await resolveVehicleByConfig({ vehicleId });
    if (!resolved) return { ok: false, error: "vehicle_not_configured" };
    const all = await sessions();
    const session = all[vehicleId];
    if (session) {
      session.buzzerWanted = Boolean(on);
      session.buzzerChangedAt = new Date().toISOString();
      session.buzzerReason = String(reason || "");
      await writeJson(SESSIONS, all);
    }
    let commandResult;
    try {
      commandResult = await sendTraccarCustomCommand(resolved.config, on ? BUZZER_ON_COMMAND : BUZZER_OFF_COMMAND);
      await appendEvent("buzzer", { vehicleId, on: Boolean(on), reason, commandResult });
      return { ok: true, commandResult };
    } catch (error) {
      await appendEvent("buzzer_error", { vehicleId, on: Boolean(on), reason, error: String(error?.message || error) });
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function clearBuzzerTimer(vehicleId) {
    const timer = buzzerTimers.get(vehicleId);
    if (timer) clearTimeout(timer);
    buzzerTimers.delete(vehicleId);
  }

  async function scheduleBuzzer(vehicleId, session) {
    clearBuzzerTimer(vehicleId);
    if (!session || session.driver?.employeeId || session.closedAt) return;
    const deadline = new Date(session.buzzerDueAt || Date.now() + BUZZER_DELAY_MS).getTime();
    const delay = Math.max(0, deadline - Date.now());
    const timer = setTimeout(async () => {
      buzzerTimers.delete(vehicleId);
      const all = await sessions();
      const current = all[vehicleId];
      if (!current || current.closedAt || current.driver?.employeeId) return;
      await setBuzzer(vehicleId, true, "driver_missing_after_grace_period");
    }, delay);
    buzzerTimers.set(vehicleId, timer);
  }

  async function startSession(vehicleId, at, position = null, source = "traccar") {
    const all = await sessions();
    const existing = all[vehicleId];
    if (existing && !existing.closedAt) return existing;
    const startedAt = iso(at);
    const session = {
      id: `ride-${vehicleId}-${Date.now().toString(36)}`,
      vehicleId,
      startedAt,
      closedAt: null,
      source,
      driver: null,
      driverAssignedAt: null,
      buzzerDueAt: new Date(new Date(startedAt).getTime() + BUZZER_DELAY_MS).toISOString(),
      buzzerWanted: false,
      startPosition: position || null,
      lastPosition: position || null,
      odometerStart: numberOrNull(position?.odometer),
      odometerEnd: numberOrNull(position?.odometer),
      distanceMeters: 0,
      unresolvedDriver: true,
    };
    all[vehicleId] = session;
    await writeJson(SESSIONS, all);
    await appendEvent("session_started", { vehicleId, sessionId: session.id, startedAt, source });
    await scheduleBuzzer(vehicleId, session);
    return session;
  }

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizedPosition(payload = {}) {
    const attrs = payload.attributes && typeof payload.attributes === "object" ? payload.attributes : {};
    const odometerRaw = attrs.totalDistance ?? attrs.odometer ?? attrs.totalMileage ?? payload.odometer;
    return {
      traccarPositionId: payload.id ?? null,
      deviceId: payload.deviceId ?? null,
      at: iso(payload.fixTime || payload.deviceTime || payload.serverTime || new Date().toISOString()),
      lat: numberOrNull(payload.latitude),
      lng: numberOrNull(payload.longitude),
      speedKnots: numberOrNull(payload.speed),
      course: numberOrNull(payload.course),
      address: String(payload.address || ""),
      ignition: normalizeBool(attrs.ignition),
      odometer: numberOrNull(odometerRaw),
      batteryLevel: numberOrNull(attrs.batteryLevel ?? attrs.battery ?? attrs.power),
      can: {
        totalDistance: numberOrNull(attrs.totalDistance ?? attrs.totalMileage),
        fuel: numberOrNull(attrs.fuel ?? attrs.fuelLevel),
        rpm: numberOrNull(attrs.rpm),
      },
      rawAttributes: attrs,
    };
  }

  async function appendPosition(vehicleId, position) {
    const date = viennaDate(position.at);
    await fsp.mkdir(POSITION_DIR, { recursive: true });
    await fsp.appendFile(path.join(POSITION_DIR, `${date}.jsonl`), `${JSON.stringify({ vehicleId, ...position })}\n`, "utf8");
  }

  async function updatePosition(vehicleId, position) {
    const all = await sessions();
    const session = all[vehicleId];
    if (!session || session.closedAt) return null;
    session.lastPosition = position;
    if (position.odometer !== null) session.odometerEnd = position.odometer;
    all[vehicleId] = session;
    await writeJson(SESSIONS, all);
    return session;
  }

  async function closeSession(vehicleId, at, position = null, source = "traccar") {
    clearBuzzerTimer(vehicleId);
    const all = await sessions();
    const session = all[vehicleId];
    if (!session || session.closedAt) return session || null;
    session.closedAt = iso(at);
    if (position) session.lastPosition = position;
    if (position?.odometer !== null && position?.odometer !== undefined) session.odometerEnd = position.odometer;
    session.buzzerWanted = false;
    session.unresolvedDriver = !session.driver?.employeeId;
    all[vehicleId] = session;
    await writeJson(SESSIONS, all);
    await setBuzzer(vehicleId, false, "ignition_off");

    const list = await rides();
    const ride = {
      ...session,
      source,
      date: viennaDate(session.startedAt),
      distanceKm: session.odometerStart !== null && session.odometerEnd !== null
        ? Math.max(0, Number(session.odometerEnd) - Number(session.odometerStart))
        : null,
      createdAt: new Date().toISOString(),
    };
    const existingIndex = list.findIndex(item => item.id === ride.id);
    if (existingIndex >= 0) list[existingIndex] = ride; else list.push(ride);
    await writeJson(RIDES, list.slice(-25000));
    await appendEvent("session_closed", { vehicleId, sessionId: session.id, driver: session.driver || null, unresolvedDriver: session.unresolvedDriver });
    return ride;
  }

  async function assignDriver(vehicleId, employeeId, source = "nfc", rideId = "") {
    const empRows = await employees();
    const employee = empRows.find(item => String(item.id || item.employeeId) === String(employeeId));
    if (!employee || employee.active === false) throw new Error("Mitarbeiter nicht gefunden oder inaktiv.");
    const driver = { employeeId: String(employee.id || employee.employeeId), employeeName: employeeDisplayName(employee), source };

    if (rideId) {
      const list = await rides();
      const ride = list.find(item => item.id === rideId);
      if (!ride) throw new Error("Fahrt nicht gefunden.");
      if (vehicleId && String(ride.vehicleId) !== String(vehicleId)) throw new Error("Fahrt gehört zu einem anderen Fahrzeug.");
      ride.driver = driver;
      ride.driverAssignedAt = new Date().toISOString();
      ride.unresolvedDriver = false;
      await writeJson(RIDES, list);
      await appendEvent("driver_assigned_late", { vehicleId: ride.vehicleId, rideId: ride.id, driver });
      return { ride, driver, late: true };
    }

    const all = await sessions();
    let session = all[vehicleId];
    if (!session || session.closedAt) {
      session = await startSession(vehicleId, new Date().toISOString(), null, "nfc_without_ignition_event");
    }
    const fresh = (await sessions())[vehicleId];
    fresh.driver = driver;
    fresh.driverAssignedAt = new Date().toISOString();
    fresh.unresolvedDriver = false;
    fresh.buzzerWanted = false;
    const current = await sessions();
    current[vehicleId] = fresh;
    await writeJson(SESSIONS, current);
    clearBuzzerTimer(vehicleId);
    await setBuzzer(vehicleId, false, "driver_checked_in");
    await appendEvent("driver_checked_in", { vehicleId, sessionId: fresh.id, driver });
    return { session: fresh, driver, late: false };
  }

  async function handlePosition(payload) {
    const deviceId = payload.deviceId ?? payload.device?.id ?? null;
    const uniqueId = payload.uniqueId ?? payload.device?.uniqueId ?? "";
    const resolved = await resolveVehicleByConfig({ traccarDeviceId: deviceId, uniqueId });
    if (!resolved) {
      await appendEvent("unmapped_position", { deviceId, uniqueId, positionId: payload.id ?? null });
      return { mapped: false, deviceId, uniqueId };
    }
    const vehicleId = String(resolved.config.vehicleId);
    const position = normalizedPosition(payload);
    await appendPosition(vehicleId, position);

    const current = (await sessions())[vehicleId];
    if (position.ignition === true && (!current || current.closedAt)) {
      await startSession(vehicleId, position.at, position, "traccar_position");
    } else if (position.ignition === false && current && !current.closedAt) {
      await updatePosition(vehicleId, position);
      await closeSession(vehicleId, position.at, position, "traccar_position");
    } else if (current && !current.closedAt) {
      await updatePosition(vehicleId, position);
    }
    return { mapped: true, vehicleId, position };
  }

  async function handleEvent(payload) {
    const deviceId = payload.deviceId ?? payload.device?.id ?? null;
    const uniqueId = payload.uniqueId ?? payload.device?.uniqueId ?? "";
    const resolved = await resolveVehicleByConfig({ traccarDeviceId: deviceId, uniqueId });
    if (!resolved) {
      await appendEvent("unmapped_event", { deviceId, uniqueId, eventType: payload.type || "" });
      return { mapped: false, deviceId, uniqueId };
    }
    const vehicleId = String(resolved.config.vehicleId);
    const type = String(payload.type || "");
    const when = iso(payload.eventTime || new Date().toISOString());
    if (["ignitionOn", "deviceMoving"].includes(type)) await startSession(vehicleId, when, null, `traccar_event:${type}`);
    if (["ignitionOff", "deviceStopped"].includes(type)) await closeSession(vehicleId, when, null, `traccar_event:${type}`);
    await appendEvent("traccar_event", { vehicleId, eventType: type, eventId: payload.id ?? null });
    return { mapped: true, vehicleId, eventType: type };
  }

  async function restoreTimers() {
    const all = await sessions();
    for (const [vehicleId, session] of Object.entries(all)) {
      if (session && !session.closedAt && !session.driver?.employeeId) await scheduleBuzzer(vehicleId, session);
    }
  }

  async function ensureInitialConfig() {
    await ensureRoot();
    if (!fs.existsSync(TRACKER_CONFIG)) await writeJson(TRACKER_CONFIG, []);
    if (!fs.existsSync(SESSIONS)) await writeJson(SESSIONS, {});
    if (!fs.existsSync(RIDES)) await writeJson(RIDES, []);
    if (!initialized) await restoreTimers();
    initialized = true;
  }

  const jsonSmall = express.json({ limit: "1mb" });

  app.get("/kristine/api/vehicle-tracking/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensureInitialConfig();
      const cfg = await trackerConfig();
      const sess = await sessions();
      const rideRows = await rides();
      res.json({
        ok: true,
        configuredVehicles: cfg.length,
        activeSessions: Object.values(sess).filter(item => item && !item.closedAt).length,
        unresolvedRides: rideRows.filter(item => item.unresolvedDriver).length,
        traccarConfigured: Boolean(TRACCAR_BASE_URL && TRACCAR_TOKEN),
        trackerSecretConfigured: Boolean(TRACKER_SECRET),
        buzzerCommandsConfigured: Boolean(BUZZER_ON_COMMAND && BUZZER_OFF_COMMAND),
        buzzerDelaySeconds: Math.round(BUZZER_DELAY_MS / 1000),
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/vehicle-tracking/config", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensureInitialConfig();
      const master = await vehicles();
      const cfg = await trackerConfig();
      const merged = master.map(vehicle => ({
        vehicle,
        tracking: cfg.find(item => String(item.vehicleId) === String(vehicle.id)) || null,
      }));
      res.json({ ok: true, vehicles: merged });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/kristine/api/vehicle-tracking/config/:vehicleId", jsonSmall, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensureInitialConfig();
      const vehicleId = safeId(req.params.vehicleId);
      const master = await vehicles();
      if (!master.some(item => String(item.id) === vehicleId)) return res.status(404).json({ ok: false, error: "Fahrzeug nicht gefunden" });
      const cfg = await trackerConfig();
      const index = cfg.findIndex(item => String(item.vehicleId) === vehicleId);
      const previous = index >= 0 ? cfg[index] : {};
      const row = {
        vehicleId,
        trackerModel: String(req.body?.trackerModel || previous.trackerModel || "FMC250").slice(0, 60),
        trackerUniqueId: String(req.body?.trackerUniqueId ?? previous.trackerUniqueId ?? "").trim().slice(0, 100),
        traccarDeviceId: String(req.body?.traccarDeviceId ?? previous.traccarDeviceId ?? "").trim().slice(0, 40),
        nfcToken: String(req.body?.nfcToken || previous.nfcToken || newToken()).slice(0, 100),
        buzzerEnabled: req.body?.buzzerEnabled ?? previous.buzzerEnabled ?? true,
        canEnabled: req.body?.canEnabled ?? previous.canEnabled ?? true,
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) cfg[index] = row; else cfg.push(row);
      await saveTrackerConfig(cfg);
      res.json({ ok: true, tracking: row, nfcUrl: `/public/vehicle-checkin.html?vehicle=${encodeURIComponent(vehicleId)}&tag=${encodeURIComponent(row.nfcToken)}` });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/vehicle-tracking/nfc-info", async (req, res) => {
    try {
      await ensureInitialConfig();
      const vehicleId = safeId(req.query.vehicle);
      const tag = String(req.query.tag || "");
      const resolved = await resolveVehicleByConfig({ vehicleId });
      if (!resolved || !tag || tag !== String(resolved.config.nfcToken || "")) return res.status(404).json({ ok: false, error: "NFC-Tag ungültig" });
      res.json({ ok: true, vehicle: publicVehicle(resolved.config, resolved.vehicle) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/vehicle-tracking/checkin", jsonSmall, async (req, res) => {
    try {
      await ensureInitialConfig();
      const vehicleId = safeId(req.body?.vehicleId);
      const tag = String(req.body?.nfcToken || "");
      const employeeId = safeId(req.body?.employeeId);
      const resolved = await resolveVehicleByConfig({ vehicleId });
      if (!resolved || !tag || tag !== String(resolved.config.nfcToken || "")) return res.status(404).json({ ok: false, error: "NFC-Tag ungültig" });
      if (!employeeId) return res.status(400).json({ ok: false, error: "Mitarbeiter fehlt" });
      const result = await assignDriver(vehicleId, employeeId, "nfc");
      res.json({ ok: true, vehicle: publicVehicle(resolved.config, resolved.vehicle), driver: result.driver, session: result.session });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/vehicle-tracking/traccar/position", jsonSmall, async (req, res) => {
    if (!requireTracker(req, res)) return;
    try {
      await ensureInitialConfig();
      const result = await handlePosition(req.body || {});
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/vehicle-tracking/traccar/event", jsonSmall, async (req, res) => {
    if (!requireTracker(req, res)) return;
    try {
      await ensureInitialConfig();
      const result = await handleEvent(req.body || {});
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/vehicle-tracking/rides", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensureInitialConfig();
      const date = String(req.query.date || "").slice(0, 10);
      const unresolvedOnly = String(req.query.unresolved || "") === "1";
      let list = await rides();
      if (date) list = list.filter(item => String(item.date) === date);
      if (unresolvedOnly) list = list.filter(item => item.unresolvedDriver);
      res.json({ ok: true, rides: list.slice().sort((a,b) => String(b.startedAt).localeCompare(String(a.startedAt))) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/vehicle-tracking/rides/:rideId/driver", jsonSmall, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensureInitialConfig();
      const rideId = String(req.params.rideId || "").slice(0, 140);
      const employeeId = safeId(req.body?.employeeId);
      const list = await rides();
      const ride = list.find(item => item.id === rideId);
      if (!ride) return res.status(404).json({ ok: false, error: "Fahrt nicht gefunden" });
      const result = await assignDriver(ride.vehicleId, employeeId, "kristool_next_day", rideId);
      res.json({ ok: true, ride: result.ride, driver: result.driver });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/vehicle-tracking/test/ignition", jsonSmall, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensureInitialConfig();
      const vehicleId = safeId(req.body?.vehicleId);
      const on = normalizeBool(req.body?.on);
      if (on === null) return res.status(400).json({ ok: false, error: "on muss true/false sein" });
      const resolved = await resolveVehicleByConfig({ vehicleId });
      if (!resolved) return res.status(404).json({ ok: false, error: "Tracking für Fahrzeug nicht konfiguriert" });
      const result = on ? await startSession(vehicleId, new Date().toISOString(), null, "manual_test") : await closeSession(vehicleId, new Date().toISOString(), null, "manual_test");
      res.json({ ok: true, on, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/vehicle-tracking/test/buzzer", jsonSmall, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensureInitialConfig();
      const vehicleId = safeId(req.body?.vehicleId);
      const on = normalizeBool(req.body?.on);
      if (on === null) return res.status(400).json({ ok: false, error: "on muss true/false sein" });
      const result = await setBuzzer(vehicleId, on, "manual_test");
      res.json({ ok: result.ok, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  ensureInitialConfig().catch(error => console.error("KRISTINE Fahrzeugtracking Init:", error));
  console.log("✅ KRISTINE Fahrzeugtracking vorbereitet (FMC250 / NFC / Traccar)");

  return {
    handlePosition,
    handleEvent,
    assignDriver,
    startSession,
    closeSession,
    setBuzzer,
    status: () => ({ initialized, traccarConfigured: Boolean(TRACCAR_BASE_URL && TRACCAR_TOKEN) }),
  };
}

module.exports = { registerVehicleTracking };
