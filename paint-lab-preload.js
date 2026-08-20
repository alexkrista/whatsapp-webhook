"use strict";

// Registriert Farben/Lager + Little-Greene-Bestellwesen direkt nach dem ersten app.use().
// Die komplette Farben-Seite ist absichtlich "notranslate": Produkt-, Farb- und
// Basisnamen wie Stock, Hi White, Deep, NCS oder RAL duerfen vom Browser niemals
// uebersetzt werden.
const fs = require("fs");
const path = require("path");
const expressPath = require.resolve("express");
const originalExpress = require("express");
const { registerPaintLiveFix } = require("./paint-live-fix");
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
      let fixed = String(html).replace(
        "function showTabhname){",
        "function showTab(name){"
      );

      if (!/name=["']google["'][^>]*notranslate/i.test(fixed)) {
        fixed = fixed.replace("<head>", '<head>\n<meta name="google" content="notranslate">');
      }
      fixed = fixed.replace(/<body(?:\s[^>]*)?>/i, '<body class="notranslate" translate="no">');

      res.set("Content-Language", "de");
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
        // Muss VOR den eigentlichen APIs stehen: der Middleware-Fix reichert
        // Antworten mit dem echten KRISTINE-Lagerbestand an und uebernimmt
        // beim Excel-Import die historische LG-GJ-Basis.
        registerPaintLiveFix(app, opts);
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
