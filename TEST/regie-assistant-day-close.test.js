"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "..", "public", "regie-assistant.html"), "utf8");
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1, "Regie-Assistent enthält genau ein Seitenskript");
new vm.Script(scripts[0][1], { filename: "regie-assistant.inline.js" });

assert.match(page, /Tagesabschluss gleich mitmachen\?/);
assert.match(page, /id="finishAndDayClose"/);
assert.match(page, /id="finishReportOnly"/);
assert.doesNotMatch(page, /hoursMode==='day'&&workRunning\)return show\(0\)/, "Der Bericht darf nicht mehr vorab zum Ausstempeln zwingen");
assert.match(page, /bootstrap\.states\?\.\[employeeId\]\?\.mode/, "Vor dem Ausstempeln wird der aktuelle Zustand erneut geprüft");
assert.match(page, /\['working','pause','lunch'\]\.includes\(mode\)/);
assert.match(page, /\/public\/kristine-go-abschluss\.html\?/);
assert.match(page, /if\(!p\.hoursEdited\)p\.hours=rounded\/60/, "Bewusst geänderte Regiestunden bleiben erhalten");

console.log("OK: Regiebericht fragt erst am Ende nach Ausstempeln und Tagesabschluss.");
