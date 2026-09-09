"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "kristine.html"), "utf8");

assert.match(html, /daybar-switch-marker/);
assert.match(html, /let cursor=dayStart,html='',markers='',lastWork=null/);
assert.match(html, /if\(lastWork&&jobKey&&jobKey!==lastWork\.key\)/);
assert.match(html, /Baustellenwechsel \$\{formatAxisHM\(from\)\}/);
assert.match(html, /legend-switch/);
assert.match(html, /let rows='',lastWork=null/);
assert.doesNotMatch(html, /previous\?\.type==='work'/);

console.log("kristine site switch marker tests passed");
