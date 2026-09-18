"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const kristine = fs.readFileSync(path.join(root, "kristine.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const fahrmodus = fs.readFileSync(path.join(root, "public", "fahrmodus.html"), "utf8");
const outlook = fs.readFileSync(path.join(root, "kristine-outlook-calendar.js"), "utf8");

assert.match(kristine, /\/kristine\/api\/voice\/transcribe/);
assert.match(kristine, /\/kristine\/api\/voice\/interpret/);
assert.match(kristine, /\/kristine\/api\/voice\/note/);
assert.match(kristine, /\/kristine\/api\/voice\/task/);
assert.match(kristine, /\/kristine\/api\/voice\/jobs/);
assert.match(kristine, /fahrmodus\.html/);
assert.match(kristine, /kristine\.html/);

assert.match(server, /async function interpretKristineVoice/);
assert.match(server, /readKristineVoiceJobs/);
assert.match(server, /interpretVoiceText: interpretKristineVoice/);
assert.match(server, /appendJobHistory/);

assert.match(fahrmodus, /navigator\.platform==='MacIntel'&&navigator\.maxTouchPoints>1/);
assert.match(fahrmodus, /\/kristine\/app/);
assert.match(fahrmodus, /\/kristine\/api\/appointments/);
assert.match(fahrmodus, /appointmentDate/);
assert.match(fahrmodus, /appointmentTime/);
assert.match(fahrmodus, /Gesprächsnotiz/);
assert.match(fahrmodus, /keine Audiodatei/);

assert.match(outlook, /\/kristine\/app\?task=/);
assert.match(outlook, /Jetzt los/);
assert.match(outlook, /departureBlockEventId/);

console.log("OK: Sprechmodus ist für iPhone/iPad verdrahtet, Desktop bleibt in der App und Sprach-Termine nutzen Outlook.");
