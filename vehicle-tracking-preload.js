"use strict";

// Modularer Hook ohne Eingriff in die große server.js:
// Wir ersetzen nur die exportierte express()-Factory und registrieren
// unsere Fahrzeug-Routen direkt nach Erzeugung der App.
const expressPath = require.resolve("express");
const originalExpress = require(expressPath);
const { registerVehicleTracking } = require("./vehicle-tracking");

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  registerVehicleTracking(app, {
    express: originalExpress,
    dataDir: process.env.DATA_DIR || "/var/data",
    adminToken: process.env.ADMIN_TOKEN || "",
  });
  return app;
}

Object.assign(wrappedExpress, originalExpress);
require.cache[expressPath].exports = wrappedExpress;
