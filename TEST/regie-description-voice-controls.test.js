"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "regie-assistant.html"), "utf8");
const inlineScript = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].at(-1)?.[1] || "";

new vm.Script(inlineScript, { filename: "regie-assistant-inline.js" });
assert.match(html, /id="clearDescription"[^>]*disabled/);
assert.match(inlineScript, /Weiter sprechen/);
assert.match(inlineScript, /Beschreibung wirklich vollständig löschen/);
assert.match(inlineScript, /\[\$\('description'\)\.value\.trim\(\),spoken\]/);

console.log("OK: Sprachtext kann erweitert, bearbeitet und bewusst gelöscht werden.");
