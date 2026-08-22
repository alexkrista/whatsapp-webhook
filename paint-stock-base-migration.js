"use strict";

// Little-Greene-Lagerstamm: Kurzbasen aus dem alten Excel (H/M/D/XD/...)
// werden auf Innovatint-Namen vereinheitlicht. Der Watcher greift auch nach
// einem späteren Excel-Import, nicht nur beim Serverstart.
// Zusätzlich werden ausschließlich die vier verifizierten Intelligent-ASP-EANs
// per SKU abgesichert. Andere EANs werden bewusst NICHT verändert.
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const file = path.join(DATA_DIR, "_kristine", "paint", "articles.json");
const BASES = {
  H:"Hi White", HI:"Hi White", "HI WHITE":"Hi White",
  M:"Medium", MEDIUM:"Medium",
  D:"Deep", DEEP:"Deep",
  XD:"Extra Deep", X:"Extra Deep", "EXTRA DEEP":"Extra Deep",
  T:"Transparent", TRANSPARENT:"Transparent",
  Y:"Yellow", YELLOW:"Yellow",
  W:"White ASP", "WHITE ASP":"White ASP",
  P:"Pastel", PASTEL:"Pastel",
  BC:"Blue BC", "BLUE BC":"Blue BC",
  TC:"Blue TC", "BLUE TC":"Blue TC"
};

const ASP_EANS_BY_SKU = Object.freeze({
  "021503WWWWW": "5050173077922", // Intelligent ASP 1 L White
  "021503XXXXX": "5050173077939", // Intelligent ASP 1 L Extra Deep
  "021502WWWWW": "5050173075157", // Intelligent ASP 2.5 L White
  "021502XXXXX": "5050173075164", // Intelligent ASP 2.5 L Extra Deep
});

let busy = false;

function migrate() {
  if (busy || !fs.existsSync(file)) return;
  busy = true;
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) return;
    let changedBases = 0;
    let changedAspEans = 0;
    for (const row of rows) {
      const raw = String(row?.baseCode || row?.baseName || "").trim();
      const full = BASES[raw.toUpperCase()];
      if (full) {
        if (!row.baseCodeOriginal && raw !== full) row.baseCodeOriginal = raw;
        if (row.baseCode !== full || row.baseName !== full) {
          row.baseCode = full;
          row.baseName = full;
          row.updatedAt = new Date().toISOString();
          changedBases += 1;
        }
      }

      const sku = String(row?.stockCode || "").trim().toUpperCase();
      const aspEan = ASP_EANS_BY_SKU[sku];
      if (aspEan && String(row?.ean || "").trim() !== aspEan) {
        row.ean = aspEan;
        changedAspEans += 1;
      }
    }
    if (changedBases || changedAspEans) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8");
      fs.renameSync(tmp, file);
      if (changedBases) console.log(`KRISTINE Farben & Lager: ${changedBases} Basis-Codes vereinheitlicht`);
      if (changedAspEans) console.log(`KRISTINE Farben & Lager: ${changedAspEans} Intelligent-ASP-EANs per SKU korrigiert`);
    }
  } catch (error) {
    console.error("KRISTINE Farben & Lager: Stamm-Migration fehlgeschlagen:", error?.message || error);
  } finally { busy = false; }
}

migrate();
fs.watchFile(file, { interval: 1000 }, () => setTimeout(migrate, 50));
