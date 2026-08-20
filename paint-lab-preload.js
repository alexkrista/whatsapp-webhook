"use strict";

// Registriert das Farben-/Lager-Modul direkt nach dem ersten app.use().
// In server.js ist das erste Middleware-Setup express.json(...), dadurch
// funktionieren unsere POST/PUT-Routen bereits mit req.body, ohne server.js
// selbst anfassen zu müssen.
const path = require("path");
const expressPath = require.resolve("express");
const originalExpress = require("express");
const { registerPaintLab } = require("./paint-lab");

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  const originalUse = app.use.bind(app);
  let registered = false;

  app.use = function patchedUse(...useArgs) {
    const result = originalUse(...useArgs);
    if (!registered) {
      registered = true;
      try {
        registerPaintLab(app, {
          dataDir: process.env.DATA_DIR || "/var/data",
          publicDir: path.join(process.cwd(), "public"),
        });
        console.log("KRISTINE Farben & Lager registriert");
      } catch (error) {
        console.error("KRISTINE Farben & Lager konnte nicht registriert werden:", error?.message || error);
      }
    }
    return result;
  };

  return app;
}

Object.assign(wrappedExpress, originalExpress);
wrappedExpress.application = originalExpress.application;
wrappedExpress.request = originalExpress.request;
wrappedExpress.response = originalExpress.response;
require.cache[expressPath].exports = wrappedExpress;
