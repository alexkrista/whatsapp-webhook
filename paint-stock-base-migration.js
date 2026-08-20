"use strict";

// Little-Greene-Lagerstamm: Kurzbasen aus dem alten Excel (H/M/D/XD/...)
// werden auf Innovatint-Namen vereinheitlicht. Der Watcher greift auch nach
// einem späteren Excel-Import, nicht nur beim Serverstart.
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
let busy = false;

function migrate() {
  if (busy || !fs.existsSync(file)) return;
  busy = true;
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) return;
    let changed = 0;
    for (const row of rows) {
      const raw = String(row?.baseCode || row?.baseName || "").trim();
      const full = BASES[raw.toUpperCase()];
      if (!full) continue;
      if (!row.baseCodeOriginal && raw !== full) row.baseCodeOriginal = raw;
      if (row.baseCode !== full || row.baseName !== full) {
        row.baseCode = full;
        row.baseName = full;
        row.updatedAt = new Date().toISOString();
        changed += 1;
      }
    }
    if (changed) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8");
      fs.renameSync(tmp, file);
      console.log(`KRISTINE Farben & Lager: ${changed} Basis-Codes vereinheitlicht`);
    }
  } catch (error) {
    console.error("KRISTINE Farben & Lager: Basis-Migration fehlgeschlagen:", error?.message || error);
  } finally { busy = false; }
}

migrate();
fs.watchFile(file, { interval: 1000 }, () => setTimeout(migrate, 50));
