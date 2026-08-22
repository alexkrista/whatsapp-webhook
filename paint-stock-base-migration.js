"use strict";

// Little-Greene-Lagerstamm: Kurzbasen aus dem alten Excel (H/M/D/XD/...)
// werden auf Innovatint-Namen vereinheitlicht. Der Watcher greift auch nach
// einem späteren Excel-Import, nicht nur beim Serverstart.
//
// EAN-Hinweis 22.08.2026:
// Ein fehlerhafter MariaDB-Abgleich hatte kurzfristig EANs per SKU überschrieben.
// Die unten definierte EINMALIGE Rücksetzung stellt nur dann den vorherigen Wert
// wieder her, wenn aktuell exakt der von diesem fehlerhaften Abgleich gesetzte
// Wert vorhanden ist. Danach werden EANs von diesem Watcher NICHT mehr verändert.
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const root = path.join(DATA_DIR, "_kristine", "paint");
const file = path.join(root, "articles.json");
const rollbackMarker = path.join(root, ".ean-rollback-20260822.done");

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

const EAN_ROLLBACK = Object.freeze({
  "020601YYYYY": {"wrong":"5050173153909","original":""},
  "020610MMMMM": {"wrong":"5050173059676","original":"5050173131723"},
  "021701YYYYY": {"wrong":"5050173175284","original":""},
  "021102YYYYY": {"wrong":"5050173161515","original":""},
  "021101HHHHH": {"wrong":"5050173162734","original":""},
  "021101MMMMM": {"wrong":"5050173162741","original":""},
  "024303HHHHH": {"wrong":"5050173078486","original":"5050173164011"},
  "024303MMMMM": {"wrong":"5050173078493","original":"5050173164028"},
  "024303DDDDD": {"wrong":"5050173078479","original":"5050173164035"},
  "024303XXXXX": {"wrong":"5050173078516","original":"5050173164042"},
  "024303TTTTT": {"wrong":"5050173078509","original":"5050173164059"},
  "024303YYYYY": {"wrong":"5050173078523","original":"5050173164073"},
  "024302HHHHH": {"wrong":"5050173078424","original":""},
  "024302MMMMM": {"wrong":"5050173078431","original":""},
  "024302DDDDD": {"wrong":"5050173078417","original":""},
  "024302XXXXX": {"wrong":"5050173078455","original":""},
  "024302TTTTT": {"wrong":"5050173078448","original":""},
  "024302YYYYY": {"wrong":"5050173078462","original":""},
  "024301HHHHH": {"wrong":"5050173078400","original":"5050173078486"},
  "020903HHHHH": {"wrong":"5050173078363","original":"5050173078493"},
  "020903MMMMM": {"wrong":"5050173078370","original":"5050173078479"},
  "020903DDDDD": {"wrong":"5050173078356","original":"5050173078516"},
  "020903XXXXX": {"wrong":"5050173078394","original":"5050173078509"},
  "020903TTTTT": {"wrong":"5050173078387","original":"5050173078523"},
  "020902HHHHH": {"wrong":"5050173078318","original":"5050173078424"},
  "020902MMMMM": {"wrong":"5050173078325","original":"5050173078431"},
  "020902DDDDD": {"wrong":"5050173078301","original":"5050173078417"},
  "020902XXXXX": {"wrong":"5050173078349","original":"5050173078455"},
  "020902TTTTT": {"wrong":"5050173078332","original":"5050173078448"},
  "020403HHHHH": {"wrong":"5050173164011","original":""},
  "020403MMMMM": {"wrong":"5050173164028","original":""},
  "020403DDDDD": {"wrong":"5050173164035","original":"5050173078363"},
  "020403XXXXX": {"wrong":"5050173164042","original":"5050173078370"},
  "020403TTTTT": {"wrong":"5050173164059","original":"5050173078356"},
  "020403YYYYY": {"wrong":"5050173164073","original":"5050173078394"},
  "020402HHHHH": {"wrong":"","original":"5050173078387"},
  "020402MMMMM": {"wrong":"","original":"5050173078318"},
  "020402DDDDD": {"wrong":"","original":"5050173078325"},
  "020402XXXXX": {"wrong":"","original":"5050173078301"},
  "020402TTTTT": {"wrong":"","original":"5050173078349"},
  "020402YYYYY": {"wrong":"","original":"5050173078332"},
  "025102HHHHH": {"wrong":"5050173176489","original":""},
  "025102DDDDD": {"wrong":"5050173176496","original":""},
  "025102TTTTT": {"wrong":"5050173176502","original":""},
  "022801TTTTT": {"wrong":"5050173175765","original":""},
  "023002WHITE": {"wrong":"5050173176045","original":""},
  "021303PPPPP": {"wrong":"5050173138395","original":""},
  "021303DDDDD": {"wrong":"5050173137701","original":""},
  "021303TTTTT": {"wrong":"5050173139132","original":""},
  "021302PPPPP": {"wrong":"5050173136285","original":""},
  "021302DDDDD": {"wrong":"5050173136230","original":""},
  "021302TTTTT": {"wrong":"5050173136292","original":""},
  "021301PPPPP": {"wrong":"5050173135509","original":""},
  "025002PPPPP": {"wrong":"5050173176427","original":""},
  "025002DDDDD": {"wrong":"5050173176434","original":""},
  "025002TTTTT": {"wrong":"5050173176441","original":""},
  "020102PPPPP": {"wrong":"5050173171699","original":""}
});

let busy = false;

function migrate() {
  if (busy || !fs.existsSync(file)) return;
  busy = true;
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) return;

    const doEanRollback = !fs.existsSync(rollbackMarker);
    let changedBases = 0;
    let restoredEans = 0;

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

      if (doEanRollback) {
        const sku = String(row?.stockCode || "").trim().toUpperCase();
        const fix = EAN_ROLLBACK[sku];
        const current = String(row?.ean || "").trim();
        if (fix && current === fix.wrong) {
          row.ean = fix.original;
          restoredEans += 1;
        }
      }
    }

    if (changedBases || restoredEans) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8");
      fs.renameSync(tmp, file);
      if (changedBases) console.log(`KRISTINE Farben & Lager: ${changedBases} Basis-Codes vereinheitlicht`);
      if (restoredEans) console.log(`KRISTINE Farben & Lager: ${restoredEans} irrtümlich überschriebene EANs zurückgesetzt`);
    }

    if (doEanRollback) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(rollbackMarker, JSON.stringify({at:new Date().toISOString(),restoredEans}, null, 2), "utf8");
      console.log(`KRISTINE Farben & Lager: EAN-Rücksetzung abgeschlossen (${restoredEans})`);
    }
  } catch (error) {
    console.error("KRISTINE Farben & Lager: Stamm-Migration fehlgeschlagen:", error?.message || error);
  } finally { busy = false; }
}

migrate();
fs.watchFile(file, { interval: 1000 }, () => setTimeout(migrate, 50));
