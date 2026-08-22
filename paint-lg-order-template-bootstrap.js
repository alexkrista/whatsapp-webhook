"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const root = path.join(DATA_DIR, "_kristine", "paint");
const target = path.join(root, "lg-order-template.xlsx");
const metaFile = path.join(root, "lg-order-template.json");
const chunksDir = path.join(process.cwd(), "assets", "lg-order-template");
const CHUNKS = [
  "part00.b64", "part01.b64", "part02.b64", "part03.b64", "part04.b64",
  "part05.b64", "part06.b64", "part07.b64", "part08.b64",
];
const EXPECTED_B64_LENGTH = 83312;
const EXPECTED_BYTE_LENGTH = 62484;
const BUNDLE_SHA256 = "dfb79a7103ba911563f29202d8ad73454bfeabc12191912a3bedcbad74dee49c";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readMeta() {
  try { return JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch { return null; }
}

function bundledBytes() {
  const parts = CHUNKS.map(name => {
    const file = path.join(chunksDir, name);
    if (!fs.existsSync(file)) throw new Error(`Vorlagen-Teil fehlt: ${name}`);
    return fs.readFileSync(file, "utf8").replace(/\s+/g, "");
  });
  const base64 = parts.join("");
  if (base64.length !== EXPECTED_B64_LENGTH) {
    throw new Error(`Vorlagen-Base64 unvollständig (${base64.length}/${EXPECTED_B64_LENGTH})`);
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== EXPECTED_BYTE_LENGTH) {
    throw new Error(`Vorlagen-Dateigröße falsch (${bytes.length}/${EXPECTED_BYTE_LENGTH})`);
  }
  const digest = sha256(bytes);
  if (digest !== BUNDLE_SHA256) throw new Error(`Vorlagen-Prüfsumme falsch (${digest})`);
  return bytes;
}

function ensureBundledLgOrderTemplate() {
  try {
    const bytes = bundledBytes();
    fs.mkdirSync(root, { recursive: true });
    const meta = readMeta();
    const manualTemplate = meta?.source === "manual-upload" && fs.existsSync(target);
    const bundleCurrent = meta?.source === "bundled-krista-template" && meta?.bundleSha256 === BUNDLE_SHA256 && fs.existsSync(target);

    // Eine später bewusst hochgeladene neue LG-Preisliste bleibt erhalten.
    // Ansonsten installiert KRISTINE automatisch die freigegebene KRISTA-Vorlage.
    if (!manualTemplate && !bundleCurrent) {
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, target);
      fs.writeFileSync(metaFile, JSON.stringify({
        name: "Order form MAY 2026 LG_PRICE KRISTA.xlsx",
        installedAt: new Date().toISOString(),
        source: "bundled-krista-template",
        bundleSha256: BUNDLE_SHA256,
        byteLength: EXPECTED_BYTE_LENGTH,
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
