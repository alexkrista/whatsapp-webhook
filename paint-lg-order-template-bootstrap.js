"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const root = path.join(DATA_DIR, "_kristine", "paint");
const target = path.join(root, "lg-order-template.xlsx");
const metaFile = path.join(root, "lg-order-template.json");
const bundled = path.join(process.cwd(), "assets", "Order form MAY 2026 LG_PRICE KRISTA.xlsx");

function ensureBundledLgOrderTemplate() {
  try {
    if (!fs.existsSync(bundled)) {
      console.warn("KRISTINE LG-Excel: gebündelte Vorlage fehlt:", bundled);
      return false;
    }
    fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(target)) {
      fs.copyFileSync(bundled, target);
      fs.writeFileSync(metaFile, JSON.stringify({
        name: "Order form MAY 2026 LG_PRICE KRISTA.xlsx",
        installedAt: new Date().toISOString(),
        source: "bundled-krista-template",
        skuCount: 382,
        sheets: ["Zusammenfassung", "LG BASES", "COLOURANTS", "LG SAMPLE POTS", "LG MARKETING"]
      }, null, 2), "utf8");
      console.log("KRISTINE LG-Excel: KRISTA-Bestellvorlage installiert");
    }
    return true;
  } catch (error) {
    console.error("KRISTINE LG-Excel: Vorlage konnte nicht installiert werden:", error?.message || error);
    return false;
  }
}

ensureBundledLgOrderTemplate();
module.exports = { ensureBundledLgOrderTemplate };
