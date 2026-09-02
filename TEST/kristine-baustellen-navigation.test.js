"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const kristine = fs.readFileSync(path.join(root, "kristine.js"), "utf8");
const page = fs.readFileSync(path.join(root, "public", "kristine.html"), "utf8");
const topbar = fs.readFileSync(path.join(root, "public", "ui", "topbar.js"), "utf8");
const hub = fs.readFileSync(path.join(root, "public", "ui", "baustellen-knowledge-hub.js"), "utf8");

assert.match(kristine, /\/kristine\/baustellen/);
assert.match(kristine, /baustellen\.html/);
assert.match(page, /withToken\('\/kristine\/baustellen'\)/);
assert.match(topbar, /Leitstand, Planung und Baustellen/);
assert.match(topbar, /key: "krisadmin"[^\n]+href: "\/admin\/ui"/);
assert.match(hub, /KRISTINE · Baustellen-Wissensdrehscheibe/);
assert.match(hub, /Alter Einstieg · bleibt vorerst erreichbar/);

console.log("OK: Baustellen sind als wiederverwendeter KRISTINE-Bereich eingebunden.");
