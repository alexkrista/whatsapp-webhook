"use strict";

// Registriert das Farben-/Lager-Modul, ohne server.js anfassen zu müssen.
const path = require("path");
const expressPath = require.resolve("express");
const originalExpress = require("express");
const { registerPaintLab } = require("./paint-lab");

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  try {
    registerPaintLab(app, {
      dataDir: process.env.DATA_DIR || "/var/data",
      publicDir: path.join(process.cwd(), "public"),
    });
    console.log("KRISTINE Farben & Lager registriert");
  } catch (error) {
    console.error("KRISTINE Farben & Lager konnte nicht registriert werden:", error?.message || error);
  }
  return app;
}

Object.assign(wrappedExpress, originalExpress);
wrappedExpress.application = originalExpress.application;
wrappedExpress.request = originalExpress.request;
wrappedExpress.response = originalExpress.response;
require.cache[expressPath].exports = wrappedExpress;
