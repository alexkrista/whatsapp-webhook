"use strict";

// Little-Greene-Lagerstamm: Kurzbasen aus dem alten Excel (H/M/D/XD/...)
// werden auf Innovatint-Namen vereinheitlicht. Zusätzlich werden die am
// 22.08.2026 gegen Innovatint/MariaDB verifizierten EANs ausschließlich
// über die SKU (stockCode) in den persistenten Lagerstamm übernommen.
// Der Watcher greift auch nach einem späteren Excel-Import, nicht nur beim Serverstart.
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

// Quelle: KRISTINE_LG_Lager_Sollwerte_2026-08-22_MARIA_MASTER.xlsx
// 139 eindeutige SKU->EAN-Zuordnungen. Die 6 Intelligent-Gloss-2.5-L-SKUs
// ohne verifizierte EAN sind absichtlich nicht enthalten.
const EANS_BY_SKU = Object.freeze({
  "020605HHHHH": "5050173173846",
  "020605MMMMM": "5050173173853",
  "020605DDDDD": "5050173173860",
  "020605XXXXX": "5050173173877",
  "020605TTTTT": "5050173173884",
  "020605YYYYY": "5050173173907",
  "020603HHHHH": "5050173151288",
  "020603MMMMM": "5050173151295",
  "020603DDDDD": "5050173151301",
  "020603XXXXX": "5050173151318",
  "020603TTTTT": "5050173151325",
  "020603YYYYY": "5050173151349",
  "020602HHHHH": "5050173152568",
  "020602MMMMM": "5050173152575",
  "020602DDDDD": "5050173152582",
  "020602XXXXX": "5050173152599",
  "020602TTTTT": "5050173152605",
  "020602YYYYY": "5050173152629",
  "020601HHHHH": "5050173153848",
  "020601MMMMM": "5050173153855",
  "020601DDDDD": "5050173153862",
  "020601XXXXX": "5050173153879",
  "020601TTTTT": "5050173153886",
  "020601YYYYY": "5050173153909",
  "020610HHHHH": "5050173175956",
  "020610MMMMM": "5050173059676",
  "021703HHHHH": "5050173175369",
  "021703MMMMM": "5050173175376",
  "021703DDDDD": "5050173175383",
  "021703XXXXX": "5050173175390",
  "021703TTTTT": "5050173175406",
  "021703YYYYY": "5050173175420",
  "021702HHHHH": "5050173175291",
  "021702MMMMM": "5050173175307",
  "021702DDDDD": "5050173175314",
  "021702XXXXX": "5050173175321",
  "021702TTTTT": "5050173175338",
  "021702YYYYY": "5050173175352",
  "021701HHHHH": "5050173175222",
  "021701MMMMM": "5050173175239",
  "021701DDDDD": "5050173175246",
  "021701XXXXX": "5050173175253",
  "021701TTTTT": "5050173175260",
  "021701YYYYY": "5050173175284",
  "021710HHHHH": "5050173175963",
  "021710MMMMM": "5050173023257",
  "021103HHHHH": "5050173160174",
  "021103MMMMM": "5050173160181",
  "021103DDDDD": "5050173160198",
  "021103XXXXX": "5050173160204",
  "021103TTTTT": "5050173160211",
  "021103YYYYY": "5050173160235",
  "021102HHHHH": "5050173161454",
  "021102MMMMM": "5050173161461",
  "021102DDDDD": "5050173161478",
  "021102XXXXX": "5050173161485",
  "021102TTTTT": "5050173161492",
  "021102YYYYY": "5050173161515",
  "021101HHHHH": "5050173162734",
  "021101MMMMM": "5050173162741",
  "024303HHHHH": "5050173078486",
  "024303MMMMM": "5050173078493",
  "024303DDDDD": "5050173078479",
  "024303XXXXX": "5050173078516",
  "024303TTTTT": "5050173078509",
  "024303YYYYY": "5050173078523",
  "024302HHHHH": "5050173078424",
  "024302MMMMM": "5050173078431",
  "024302DDDDD": "5050173078417",
  "024302XXXXX": "5050173078455",
  "024302TTTTT": "5050173078448",
  "024302YYYYY": "5050173078462",
  "024301HHHHH": "5050173078400",
  "020903HHHHH": "5050173078363",
  "020903MMMMM": "5050173078370",
  "020903DDDDD": "5050173078356",
  "020903XXXXX": "5050173078394",
  "020903TTTTT": "5050173078387",
  "020902HHHHH": "5050173078318",
  "020902MMMMM": "5050173078325",
  "020902DDDDD": "5050173078301",
  "020902XXXXX": "5050173078349",
  "020902TTTTT": "5050173078332",
  "020403HHHHH": "5050173164011",
  "020403MMMMM": "5050173164028",
  "020403DDDDD": "5050173164035",
  "020403XXXXX": "5050173164042",
  "020403TTTTT": "5050173164059",
  "020403YYYYY": "5050173164073",
  "025103HHHHH": "5050173176458",
  "025103DDDDD": "5050173176465",
  "025103TTTTT": "5050173176472",
  "025102HHHHH": "5050173176489",
  "025102DDDDD": "5050173176496",
  "025102TTTTT": "5050173176502",
  "022801PPPPP": "5050173175727",
  "022801MMMMM": "5050173175734",
  "022801DDDDD": "5050173175741",
  "022801XXXXX": "5050173175758",
  "022801TTTTT": "5050173175765",
  "022810PPPPP": "5050173175987",
  "022810MMMMM": "5050173025787",
  "021503WWWWW": "5050173077922",
  "021503XXXXX": "5050173077939",
  "021502WWWWW": "5050173075157",
  "021502XXXXX": "5050173075164",
  "023002WHITE": "5050173176045",
  "021303PPPPP": "5050173138395",
  "021303DDDDD": "5050173137701",
  "021303TTTTT": "5050173139132",
  "021302PPPPP": "5050173136285",
  "021302DDDDD": "5050173136230",
  "021302TTTTT": "5050173136292",
  "021301PPPPP": "5050173135509",
  "025003PPPPP": "5050173176397",
  "025003DDDDD": "5050173176403",
  "025003TTTTT": "5050173176410",
  "025002PPPPP": "5050173176427",
  "025002DDDDD": "5050173176434",
  "025002TTTTT": "5050173176441",
  "020103PPPPP": "5050173170418",
  "020103DDDDD": "5050173170432",
  "020103TTTTT": "5050173170456",
  "020102PPPPP": "5050173171699",
  "029803CYANZ": "5050173173655",
  "029803LEMON": "5050173173662",
  "029803SCARL": "5050173173679",
  "029803GREEN": "5050173173686",
  "029803OCHRE": "5050173173716",
  "029803ORANG": "5050173173723",
  "029803UMBER": "5050173173747",
  "029803BLACK": "5050173173754",
  "029803REDOX": "5050173173761",
  "029803VIOLE": "5050173173778",
  "029803WHITE": "5050173173792",
  "029803MAGEN": "5050173175505",
  "029803PRIMR": "5050173176328",
  "029803FASTR": "5050173176335",
  "029803BLUE1": "5050173176342",
});

let busy = false;

function migrate() {
  if (busy || !fs.existsSync(file)) return;
  busy = true;
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) return;
    let changedBases = 0;
    let changedEans = 0;
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
      const expectedEan = EANS_BY_SKU[sku];
      if (expectedEan && String(row?.ean || "").trim() !== expectedEan) {
        // Bewusst NUR das EAN-Feld ändern. Bestand, Mindest, Soll, EK,
        // Bestellmengen und Zeitstempel bleiben unangetastet.
        row.ean = expectedEan;
        changedEans += 1;
      }
    }
    if (changedBases || changedEans) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8");
      fs.renameSync(tmp, file);
      if (changedBases) console.log(`KRISTINE Farben & Lager: ${changedBases} Basis-Codes vereinheitlicht`);
      if (changedEans) console.log(`KRISTINE Farben & Lager: ${changedEans} EANs aus MariaDB-Master per SKU synchronisiert`);
    }
  } catch (error) {
    console.error("KRISTINE Farben & Lager: Stamm-Migration fehlgeschlagen:", error?.message || error);
  } finally { busy = false; }
}

migrate();
fs.watchFile(file, { interval: 1000 }, () => setTimeout(migrate, 50));
