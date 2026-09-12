"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const chronik = fs.readFileSync(path.join(root, "public", "ui", "baustellen-chronik.js"), "utf8");
const topbar = fs.readFileSync(path.join(root, "public", "ui", "topbar.js"), "utf8");

assert.match(chronik, /collectSurface\(regies,documents=\[\],metaRows=\[\],jobMaterials=\[\]\)/, "Qualitätsansicht kann Baustellen-Materialbuchungen aufnehmen");
assert.match(chronik, /admin\/api\/paint\/job-materials\?jobId=/, "Baustellen-Materialbuchungen werden für die aktuelle Baustelle geladen");
assert.match(chronik, /Mischmaschine/, "Mischmaschinen-History wird als Materialquelle sichtbar");
assert.match(chronik, /Lager → Baustelle/, "Einlagerung auf Baustelle wird als Materialquelle sichtbar");
assert.match(chronik, /state\.surface=collectSurface\(regies,documents,j\.surfaceMaterialMeta\|\|\[\],jobMaterials\)/, "Geladene Baustellen-Materialien fließen in Qualität & Oberfläche ein");
assert.match(topbar, /baustellen-chronik\.js\?v=20260912-lg-surface-1/, "Cache-Version lädt die neue Qualitätsansicht");

console.log("OK: Baustellenmaterial aus Lager und Misch-History erscheint in Qualität & Oberfläche.");
