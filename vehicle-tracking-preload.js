"use strict";

// Modularer Hook ohne Eingriff in die große server.js:
// Wir ersetzen nur die exportierte express()-Factory und registrieren
// unsere Fahrzeug-Routen direkt nach Erzeugung der App.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const expressPath = require.resolve("express");
const originalExpress = require(expressPath);
const { registerVehicleTracking } = require("./vehicle-tracking");

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  const jsonForward = originalExpress.json({ limit: "1mb" });
  const dataDir = process.env.DATA_DIR || "/var/data";
  const adminToken = String(process.env.ADMIN_TOKEN || "");

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = String(req.headers["x-admin-token"] || req.query.token || "");
    if (token === adminToken) return true;
    res.status(403).json({ ok: false, error: "Forbidden" });
    return false;
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  function safeImportId(value) {
    const raw = String(value || "latest");
    if (raw === "latest") return "latest";
    return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || "latest";
  }

  function gpsImportPath(importId) {
    const root = path.join(dataDir, "_kristine", "gps-imports");
    return importId === "latest" ? path.join(root, "latest.json") : path.join(root, `${importId}.json`);
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function normalizePlate(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function hmMinutes(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function viennaDateTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return { date: "", time: "" };
    const parts = new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }

  function vehicleLabel(vehicle) {
    return String(vehicle?.label || [vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || vehicle?.plate || "Fahrzeug").trim();
  }

  function effectiveLegacyDriver(data, row) {
    const mapping = data?.mappings?.[row.driverKey] || {};
    return {
      employeeId: String(row.assignedEmployeeId || mapping.employeeId || row.effectiveDriver?.employeeId || ""),
      employeeName: String(row.assignedEmployeeName || mapping.employeeName || row.effectiveDriver?.employeeName || row.driverName || ""),
      source: row.assignedEmployeeId ? "manual-or-krisdrive" : (mapping.employeeId ? "mapping" : "legacy-gps"),
    };
  }

  function mergePassengers(a = [], b = []) {
    const map = new Map();
    for (const item of [...a, ...b]) {
      const id = String(item?.employeeId || "").trim();
      if (!id) continue;
      map.set(id, { employeeId: id, employeeName: String(item?.employeeName || item?.name || id) });
    }
    return [...map.values()];
  }

  function sameRide(legacy, live) {
    if (!legacy || !live || String(legacy.date || "") !== String(live.date || "")) return false;
    const plateA = normalizePlate(legacy.licensePlate);
    const plateB = normalizePlate(live.licensePlate);
    const nameA = normalizeText(legacy.vehicleName);
    const nameB = normalizeText(live.vehicleName);
    const sameVehicle = (plateA && plateB && plateA === plateB) || (!plateA && !plateB && nameA && nameB && nameA === nameB);
    if (!sameVehicle) return false;
    const startA = hmMinutes(legacy.startTime);
    const startB = hmMinutes(live.startTime);
    if (startA === null || startB === null || Math.abs(startA - startB) > 8) return false;
    const endA = hmMinutes(legacy.arrivalTime);
    const endB = hmMinutes(live.arrivalTime);
    return endA === null || endB === null || Math.abs(endA - endB) <= 15;
  }

  function rideToGpsRow(ride, vehicle) {
    const start = viennaDateTime(ride.startedAt);
    const stop = viennaDateTime(ride.closedAt);
    const started = ride.startedAt ? new Date(ride.startedAt).getTime() : NaN;
    const closed = ride.closedAt ? new Date(ride.closedAt).getTime() : NaN;
    const travelSeconds = Number.isFinite(started) && Number.isFinite(closed) ? Math.max(0, Math.round((closed - started) / 1000)) : 0;
    const driver = ride.driver || {};
    const distanceVerified = ride.distanceVerified === true || Number.isFinite(Number(ride.gpsDistanceKm));
    const distanceKm = Number.isFinite(Number(ride.gpsDistanceKm))
      ? Math.max(0, Number(ride.gpsDistanceKm))
      : distanceVerified && Number.isFinite(Number(ride.distanceKm)) ? Math.max(0, Number(ride.distanceKm)) : 0;
    return {
      id: String(ride.id || `krisdrive_${Date.now()}`),
      date: String(ride.date || start.date || ""),
      driverName: String(driver.employeeName || "Ohne Fahrer"),
      driverKey: `krisdrive_${String(driver.employeeId || ride.id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}`,
      gpsEmployeeId: String(driver.employeeId || ""),
      vehicleName: vehicleLabel(vehicle),
      vehicleNumber: String(vehicle?.id || ride.vehicleId || ""),
      licensePlate: String(vehicle?.plate || ""),
      startLocation: String(ride.startPosition?.address || ""),
      stopLocation: String(ride.lastPosition?.address || ""),
      startTime: start.time,
      arrivalTime: stop.time,
      departureTime: "",
      travelSeconds,
      staySeconds: 0,
      idleSeconds: Math.max(0, Number(ride.idleSeconds || 0)),
      distanceKm,
      distancePendingVerification: !distanceVerified,
      odometerStart: 0,
      odometerEnd: 0,
      rawOdometerStart: ride.odometerStart ?? null,
      rawOdometerEnd: ride.odometerEnd ?? null,
      startLat: Number(ride.startPosition?.lat || 0),
      startLng: Number(ride.startPosition?.lng || 0),
      stopLat: Number(ride.lastPosition?.lat || 0),
      stopLng: Number(ride.lastPosition?.lng || 0),
      fuelType: "",
      isPrivate: ride.isPrivate === true,
      privateMarkedAt: ride.privateMarkedAt || null,
      assignedEmployeeId: String(driver.employeeId || ""),
      assignedEmployeeName: String(driver.employeeName || ""),
      assignmentUpdatedAt: ride.driverAssignedAt || null,
      passengers: Array.isArray(ride.passengers) ? ride.passengers : [],
      changeHistory: [],
      source: "krisdrive",
      krisdriveRideId: String(ride.id || ""),
      effectiveDriver: {
        employeeId: String(driver.employeeId || ""),
        employeeName: String(driver.employeeName || ""),
        source: String(driver.source || "krisdrive"),
      },
    };
  }

  function mergeLegacyAndLive(legacyRow, liveRow) {
    const liveDriver = liveRow.effectiveDriver || {};
    const merged = {
      ...legacyRow,
      source: "legacy+krisdrive",
      krisdriveRideId: liveRow.krisdriveRideId,
      krisdriveLinked: true,
      passengers: mergePassengers(legacyRow.passengers, liveRow.passengers),
      startLocation: legacyRow.startLocation || liveRow.startLocation,
      stopLocation: legacyRow.stopLocation || liveRow.stopLocation,
      startLat: Number(legacyRow.startLat || 0) || Number(liveRow.startLat || 0),
      startLng: Number(legacyRow.startLng || 0) || Number(liveRow.startLng || 0),
      stopLat: Number(legacyRow.stopLat || 0) || Number(liveRow.stopLat || 0),
      stopLng: Number(legacyRow.stopLng || 0) || Number(liveRow.stopLng || 0),
    };
    // NFC/KRISDRIVE ist für die Fahreridentität führend, sobald dort ein Fahrer feststeht.
    if (liveDriver.employeeId) {
      merged.assignedEmployeeId = String(liveDriver.employeeId);
      merged.assignedEmployeeName = String(liveDriver.employeeName || "");
      merged.assignmentUpdatedAt = new Date().toISOString();
      merged.krisdriveDriver = liveDriver;
    }
    return merged;
  }

  async function combinedEmployeeDay(importId, employeeId, date) {
    const legacyData = await readJson(gpsImportPath(importId), null);
    const rides = await readJson(path.join(dataDir, "_kristine", "vehicle-tracking", "rides.json"), []);
    const vehicles = await readJson(path.join(dataDir, "_system", "vehicles.json"), []);
    const vehicleMap = new Map((Array.isArray(vehicles) ? vehicles : []).map(vehicle => [String(vehicle.id || ""), vehicle]));

    const legacyRows = (Array.isArray(legacyData?.rows) ? legacyData.rows : [])
      .filter(row => String(row.date || "") === date)
      .map(row => ({ ...row, source: row.source || "legacy" }));

    const liveRows = (Array.isArray(rides) ? rides : [])
      .filter(ride => !ride.closedAt ? false : String(ride.date || viennaDateTime(ride.startedAt).date) === date)
      .map(ride => rideToGpsRow(ride, vehicleMap.get(String(ride.vehicleId || "")) || null));

    const combined = legacyRows.map(row => ({ ...row }));
    const usedLive = new Set();
    for (let liveIndex = 0; liveIndex < liveRows.length; liveIndex += 1) {
      const live = liveRows[liveIndex];
      const legacyIndex = combined.findIndex(row => sameRide(row, live));
      if (legacyIndex >= 0) {
        combined[legacyIndex] = mergeLegacyAndLive(combined[legacyIndex], live);
        usedLive.add(liveIndex);
      }
    }
    liveRows.forEach((row, index) => { if (!usedLive.has(index)) combined.push(row); });

    const ownRows = [];
    const passengerRows = [];
    for (const row of combined) {
      const driver = effectiveLegacyDriver(legacyData || {}, row);
      if (driver.employeeId && driver.employeeId === employeeId) ownRows.push({ ...row, effectiveDriver: driver });
      const passenger = (row.passengers || []).find(item => String(item.employeeId || "") === employeeId);
      if (passenger) {
        passengerRows.push({
          rideId: row.id,
          date: row.date,
          startTime: row.startTime,
          arrivalTime: row.arrivalTime,
          departureTime: row.departureTime,
          startLocation: row.startLocation,
          stopLocation: row.stopLocation,
          distanceKm: row.distanceKm,
          travelSeconds: row.travelSeconds,
          staySeconds: row.staySeconds,
          vehicleName: row.vehicleName,
          licensePlate: row.licensePlate,
          startLat: row.startLat,
          startLng: row.startLng,
          stopLat: row.stopLat,
          stopLng: row.stopLng,
          driver,
          passenger,
          source: row.source,
          krisdriveRideId: row.krisdriveRideId || "",
        });
      }
    }
    ownRows.sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")));
    passengerRows.sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")));
    return {
      importId: legacyData?.id || importId,
      ownRows,
      passengerRows,
      sources: {
        legacyRows: legacyRows.length,
        krisdriveRows: liveRows.length,
        combinedRows: combined.length,
      },
    };
  }

  // Übergangsphase: bestehender GPS-Bericht bleibt erhalten, KRISDRIVE ergänzt automatisch.
  // Diese Route wird vor der alten Kristine-Route registriert und liefert dasselbe Antwortformat.
  app.get("/kristine/api/gps/employee-day", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.query.employeeId || "").trim();
      const date = String(req.query.date || "").slice(0, 10);
      if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ ok: false, error: "Mitarbeiter und Datum fehlen." });
      }
      const importId = safeImportId(req.query.importId || "latest");
      const result = await combinedEmployeeDay(importId, employeeId, date);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  // Traccar 6.14 sendet Positions-Forwarding als { position, device }.
  // Das bestehende Fahrzeugmodul arbeitet intern mit einer flachen Position.
  // Hier normalisieren wir nur die offizielle Traccar-Hülle.
  app.post(
    "/kristine/api/vehicle-tracking/traccar/position",
    jsonForward,
    (req, res, next) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (body.position && typeof body.position === "object") {
        const position = body.position;
        const device = body.device && typeof body.device === "object" ? body.device : {};
        req.body = {
          ...position,
          device,
          deviceId: position.deviceId ?? device.id ?? null,
          uniqueId: String(device.uniqueId ?? position.uniqueId ?? ""),
        };
      }
      return next();
    }
  );

  // Traccar 6.14 sendet Event-Forwarding als
  // { event, position, device, geofence?, maintenance? }.
  // Moving/Stopped sind KEINE Zündung und dürfen Fahrten nicht öffnen/schließen.
  app.post(
    "/kristine/api/vehicle-tracking/traccar/event",
    jsonForward,
    (req, res, next) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const event = body.event && typeof body.event === "object" ? body.event : body;
      const device = body.device && typeof body.device === "object" ? body.device : {};
      const position = body.position && typeof body.position === "object" ? body.position : null;
      const type = String(event.type || "");

      if (["deviceMoving", "deviceStopped"].includes(type)) {
        return res.json({ ok: true, ignored: true, eventType: type, reason: "motion_event_not_ignition" });
      }

      req.body = {
        ...event,
        device,
        position,
        deviceId: event.deviceId ?? position?.deviceId ?? device.id ?? null,
        uniqueId: String(device.uniqueId ?? ""),
      };
      return next();
    }
  );

  registerVehicleTracking(app, {
    express: originalExpress,
    dataDir,
    adminToken,
  });
  return app;
}

Object.assign(wrappedExpress, originalExpress);
require.cache[expressPath].exports = wrappedExpress;
