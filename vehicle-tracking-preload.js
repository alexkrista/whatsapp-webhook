"use strict";

// Modularer Hook ohne Eingriff in die große server.js:
// Wir ersetzen nur die exportierte express()-Factory und registrieren
// unsere Fahrzeug-Routen direkt nach Erzeugung der App.
const expressPath = require.resolve("express");
const originalExpress = require(expressPath);
const { registerVehicleTracking } = require("./vehicle-tracking");

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  const jsonForward = originalExpress.json({ limit: "1mb" });

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
    dataDir: process.env.DATA_DIR || "/var/data",
    adminToken: process.env.ADMIN_TOKEN || "",
  });
  return app;
}

Object.assign(wrappedExpress, originalExpress);
require.cache[expressPath].exports = wrappedExpress;
