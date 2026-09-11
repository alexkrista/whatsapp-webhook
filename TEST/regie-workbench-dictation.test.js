"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "..", "public", "regie-workbench.html"), "utf8");
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1, "Regie-Arbeitsplatz enthält genau ein Seitenskript");
new vm.Script(scripts[0][1], { filename: "regie-workbench.inline.js" });

for (const text of [
  'id="dictateDescription"',
  'id="dictationHint"',
  "window.SpeechRecognition||window.webkitSpeechRecognition",
  "recognition.lang='de-AT'",
  "recognition.continuous=true",
  "appendDescriptionDictation",
  "setRangeText",
  "Mikrofon ist blockiert",
  "Win + H",
]) assert.ok(page.includes(text), `Regie-Diktat enthält ${text}`);

assert.match(page, /dictateDescription'\)\.onclick=startDescriptionDictation/);
assert.match(page, /editorDialog'\)\.addEventListener\('close',stopDescriptionDictation\)/);
console.log("OK: Regie-Arbeiten lassen sich am PC diktieren.");
