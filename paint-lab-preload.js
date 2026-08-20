"use strict";

// Registriert Farben/Lager + Little-Greene-Bestellwesen direkt nach dem ersten app.use().
// Zusätzlich wird /admin/paint vorübergehend über einen kleinen HTML-Hotfix ausgeliefert,
// damit ein Tippfehler im Inline-JavaScript die Oberfläche nicht blockiert.
const fs = require("fs");
const path = require("path");
const expressPath = require.resolve("express");
const originalExpress = require("express");
const { registerPaintLab } = require("./paint-lab");
const { registerPaintCommercial } = require("./paint-commercial");

function registerPaintHtmlHotfix(app, publicDir) {
  app.get("/admin/paint", (req, res, next) => {
    const adminToken = process.env.ADMIN_TOKEN || "";
    if (adminToken) {
      const token = req.headers["x-admin-token"] || req.query.token || "";
      if (String(token) !== String(adminToken)) return res.status(403).send("Forbidden");
    }

    const file = path.join(publicDir, "paint-lab.html");
    fs.readFile(file, "utf8", (error, html) => {
      if (error) return next(error);
      const fixed = String(html).replace(
        "function showTabhname){",
        "function showTab(name){"
      );
      res.type("html").send(fixed);
    });
  });
}

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
        registerPaintHtmlHotfix(app, opts.publicDir);
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
