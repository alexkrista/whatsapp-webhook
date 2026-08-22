"use strict";

// Modularer Hook ohne Eingriff in die große server.js:
// Wir ersetzen nur die exportierte express()-Factory und registrieren
// unsere Fahrzeug-Routen direkt nach Erzeugung der App.
const expressPath = require.resolve("express");
const originalExpress = require(expressPath);
const { registerVehicleTracking } = require("./vehicle-tracking");

function wrappedExpress(...args) {
  const app = originalExpress(...args);

  // Traccar erzeugt neben echten Zündungsereignissen auch Moving/Stopped.
  // Die dürfen eine Fahrt NICHT starten/beenden (Ampel, Stau, kurze Standzeit).
  app.post(
    "/kristine/api/vehicle-tracking/traccar/event",
    originalExpress.json({ limit: "1mb" }),
    (req, res, next) => {
      const type = String(req.body?.type || "");
      if (["deviceMoving", "deviceStopped"].includes(type)) {
        return res.json({ ok: true, ignored: true, eventType: type, reason: "motion_event_not_ignition" });
      }
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
