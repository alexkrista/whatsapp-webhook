"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const root = path.join(DATA_DIR, "_kristine", "paint");
const target = path.join(root, "lg-order-template.xlsx");
const metaFile = path.join(root, "lg-order-template.json");
const bundled = path.join(process.cwd(), "assets", "Order form MAY 2026 LG_PRICE KRISTA.xlsx");
const BUNDLE_SHA256 = "dfb79a7103ba911563f29202d8ad73454bfeabc12191912a3bedcbad74dee49c";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readMeta() {
  try { return JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch { return null; }
}

function ensureBundledLgOrderTemplate() {
  try {
    if (!fs.existsSync(bundled)) {
      console.warn("KRISTINE LG-Excel: gebündelte Vorlage fehlt:", bundled);
      return false;
    }
    const bytes = fs.readFileSync(bundled);
    const digest = sha256(bytes);
    if (digest !== BUNDLE_SHA256) throw new Error(`Vorlagen-Prüfsumme falsch (${digest})`);

    fs.mkdirSync(root, { recursive: true });
    const meta = readMeta();
    const manualTemplate = meta?.source === "manual-upload" && fs.existsSync(target);
    const bundleCurrent = meta?.source === "bundled-krista-template" && meta?.bundleSha256 === BUNDLE_SHA256 && fs.existsSync(target);

    // Eine später bewusst hochgeladene LG-Preisliste bleibt erhalten. Ansonsten
    // wird beim ersten Deploy (oder bei einer neuen gebündelten Version) die
    // freigegebene KRISTA-Vorlage installiert.
    if (!manualTemplate && !bundleCurrent) {
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, target);
      fs.writeFileSync(metaFile, JSON.stringify({
        name: "Order form MAY 2026 LG_PRICE KRISTA.xlsx",
        installedAt: new Date().toISOString(),
        source: "bundled-krista-template",
        bundleSha256: BUNDLE_SHA256,
        sheets: ["Zusammenfassung", "LG BASES", "COLOURANTS", "LG SAMPLE POTS", "LG MARKETING"]
      }, null, 2), "utf8");
      console.log("KRISTINE LG-Excel: freigegebene KRISTA-Bestellvorlage installiert");
    }
    return true;
  } catch (error) {
    console.error("KRISTINE LG-Excel: Vorlage konnte nicht installiert werden:", error?.message || error);
    return false;
  }
}

ensureBundledLgOrderTemplate();
module.exports = { ensureBundledLgOrderTemplate, BUNDLE_SHA256 };
