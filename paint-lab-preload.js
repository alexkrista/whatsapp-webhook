"use strict";

// Registriert Farben/Lager + Little-Greene-Bestellwesen direkt nach dem ersten app.use().
const path = require("path");
const expressPath = require.resolve("express");
const originalExpress = require("express");
const { registerPaintLab } = require("./paint-lab");
const { registerPaintCommercial } = require("./paint-commercial");

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  const originalUse = app.use.bind(app);
  let registered = false;

  app.use = function patchedUse(...useArgs) {
    const result = originalUse(...useArgs);
    if (!registered) {
      registered = true;
      const opts = {
        dataDir: process.env.DATA_DIR || "/var/data",
        publicDir: path.join(process.cwd(), "public"),
      };
      try {
        registerPaintLab(app, opts);
        registerPaintCommercial(app, opts);
        console.log("KRISTINE Farben & Lager + LG Bestellwesen registriert");
      } catch (error) {
        console.error("KRISTINE Farben/Lager konnte nicht registriert werden:", error?.message || error);
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
