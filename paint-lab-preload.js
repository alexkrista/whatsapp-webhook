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
const { registerPaintOrderformFix } = require("./paint-orderform-fix");
const { registerPaintWallpaperOrder } = require("./paint-wallpaper-order");
const { registerPaintOrderSummaryFix } = require("./paint-order-summary-fix");
const { registerPaintOrderReview } = require("./paint-order-review");
const { registerPaintLgOrderExcel } = require("./paint-lg-order-excel");
const { registerPaintLgSentOrder } = require("./paint-lg-sent-order");
const { registerPaintInventoryExcel } = require("./paint-inventory-excel");
const { registerPaintLab } = require("./paint-lab");
const { registerPaintCommercial } = require("./paint-commercial");
const { registerPaintInventory } = require("./paint-inventory");
const { registerPaintReturnStock } = require("./paint-return-stock");
const { registerPaintInventoryInsights } = require("./paint-inventory-insights");
const { registerPaintInventoryCounter } = require("./paint-inventory-counter");
const { registerPaintLegacySollImport } = require("./paint-legacy-soll-import");
const { registerPaintInventoryRecovery } = require("./paint-inventory-recovery");

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
      if (!fixed.includes("/public/paint-inventory-ui.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-inventory-ui.js"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-wallpaper-order-ui.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-wallpaper-order-ui.js"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-camera-scan.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-camera-scan.js"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-inventory-plan-fix.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-inventory-plan-fix.js"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-inventory-readability.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-inventory-readability.js"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-scan-compat.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-scan-compat.js?v=20260821-1535"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-colourant-ean-fix.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-colourant-ean-fix.js?v=20260821-1535"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-inventory-scan.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-inventory-scan.js?v=20260821-1018"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-inventory-scan-insights.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-inventory-scan-insights.js?v=20260821-1038"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-inventory-ist-input.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-inventory-ist-input.js?v=20260821-1535"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-inventory-counter-fix.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-inventory-counter-fix.js?v=20260821-1152"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-legacy-soll-ui.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-legacy-soll-ui.js?v=20260821-1248"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-inventory-recovery-ui.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-inventory-recovery-ui.js?v=20260821-1535"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-order-review-ui.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-order-review-ui.js?v=20260821-2211"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-lg-order-excel-ui.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-lg-order-excel-ui.js?v=20260822-1845"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-lg-sent-order-ui.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-lg-sent-order-ui.js?v=20260822-2134"></script>\n</body>');
      }
      if (!fixed.includes("/public/paint-return-stock-ui.js")) {
        fixed = fixed.replace("</body>", '<script src="/public/paint-return-stock-ui.js?v=20260822-2058"></script>\n</body>');
      }

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
        registerPaintLiveFix(app, opts);
        registerPaintHtmlHotfix(app, opts.publicDir);
        registerPaintOrderformFix(app, opts);
        registerPaintWallpaperOrder(app, opts);
        registerPaintOrderReview(app, opts);
        registerPaintLgOrderExcel(app, opts);
        registerPaintLgSentOrder(app, opts);
        registerPaintOrderSummaryFix(app, opts);
        registerPaintInventoryExcel(app, opts);
        registerPaintInventory(app, opts);
        registerPaintReturnStock(app, opts);
        registerPaintInventoryInsights(app, opts);
        registerPaintInventoryCounter(app, opts);
        registerPaintLegacySollImport(app, opts);
        registerPaintInventoryRecovery(app, opts);
        registerPaintLab(app, opts);
        registerPaintCommercial(app, opts);
        console.log("KRISTINE Farben & Lager + LG + Inventur + Rueckware + Bestellpruefung + LG-Excel + Gesendet-Snapshot + sauberer Recovery-Neuaufbau registriert");
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
