"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "ui", "baustellen-chronik.js"), "utf8");

assert.match(source, /list="bzMaterialMaster"/, "Materialbezeichnung verwendet eine filterbare Auswahlliste");
assert.match(source, /api\('\/api\/regie\/materials'\)/, "Materialstamm wird für die Auswahlliste geladen");
assert.match(source, /input\[type=checkbox\]\{width:16px;height:16px/, "Kontrollkästchen bleibt kompakt");
assert.match(source, /\.wide>span\{display:inline-flex;align-items:center/, "Kontrollkästchen steht direkt beim Text");

console.log("OK: Materialauswahl filtert den Stamm und das Kontrollkästchen ist ausgerichtet.");
