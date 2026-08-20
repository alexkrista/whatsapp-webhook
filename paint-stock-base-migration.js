"use strict";

// Einmalige/harmlos wiederholbare Migration für den Little-Greene-Lagerstamm.
// Das alte Excel speichert die Basis als Kurzcode (H, M, D, XD ...),
// Innovatint liefert dagegen die ausgeschriebenen Namen (Hi White, Medium ...).
// Für die Lagerzuordnung vereinheitlichen wir deshalb den gespeicherten baseCode.

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const file = path.join(DATA_DIR, "_kristine", "paint", "articles.json");

const BASES = {
  H: "Hi White",
  HI: "Hi White",
  M: "Medium",
  D: "Deep",
  XD: "Extra Deep",
  X: "Extra Deep",
  T: "Transparent",
  Y: "Yellow",
  W: "White ASP",
  P: "Pastel",
  BC: "Blue BC",
  TC: "Blue TC",
};

try {
  if (fs.existsSync(file)) {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(rows)) {
      let changed = 0;
      for (const row of rows) {
        const raw = String(row?.baseCode || "").trim();
        const key = raw.toUpperCase();
        const full = BASES[key];
        if (!full) continue;
        if (!row.baseCodeOriginal) row.baseCodeOriginal = raw;
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
        console.log(`KRISTINE Farben & Lager: ${changed} Basis-Codes für Lagerzuordnung vereinheitlicht`);
      }
    }
  }
} catch (error) {
  console.error("KRISTINE Farben & Lager: Basis-Migration fehlgeschlagen:", error?.message || error);
}
