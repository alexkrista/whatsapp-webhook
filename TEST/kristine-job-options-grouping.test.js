"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "kristine.html"), "utf8");

const labels = [...html.matchAll(/\{key:'(?:running|order|finished|offer|closed)',label:'([^']+)'\}/g)].map(match => match[1]);
assert.deepStrictEqual(labels, ["1. Laufend", "2. Auftrag", "3. Fertig", "4. Angebot", "5. Geschlossen"]);
assert.match(html, /status\.includes\('angebot'\)/);
assert.match(html, /status\.includes\('fertig'\)/);
assert.match(html, /job\?\.active===false\|\|status\.includes\('geschlossen'\)/);
assert.match(html, /time-editor-job-statusbar/);
assert.match(html, /setTimeEditorJobGroup\(\$\{index\},'\$\{group\.key\}'\)/);
assert.doesNotMatch(html, /\[\.\.\.masterJobs\]\.filter\(j=>j\.active!==false\)/);

const implementation = html.match(/(const JOB_OPTION_GROUPS=\[[\s\S]*?\r?\n}\r?\n)(?=function segmentTypeLabel)/)?.[1];
assert.ok(implementation, "jobOptions implementation not found");
const context = {
  masterJobs: [
    {jobId:"1", name:"Zulu", status:"Geschlossen", active:false},
    {jobId:"2", name:"Beta", status:"Angebot – abgelehnt"},
    {jobId:"3", name:"Alpha", status:"Fertig – nicht abgerechnet"},
    {jobId:"4", name:"Delta", status:"Auftrag"},
    {jobId:"5", name:"Charlie", status:"Laufend"}
  ],
  normalizedJobStatus: job => String(job?.status || "").trim().toLowerCase(),
  esc: value => String(value),
  rendered: ""
};
vm.runInNewContext(`${implementation}\nrendered=JOB_OPTION_GROUPS.map(group=>group.label+":"+jobOptions("4",group.key)).join("|");`, context);
assert.match(context.rendered, /value="4"[^>]*selected/);
assert.ok(context.rendered.indexOf("5 · Charlie") < context.rendered.indexOf("4 · Delta"));
assert.ok(context.rendered.indexOf("4 · Delta") < context.rendered.indexOf("3 · Alpha"));
assert.ok(context.rendered.indexOf("3 · Alpha") < context.rendered.indexOf("2 · Beta"));
assert.ok(context.rendered.indexOf("2 · Beta") < context.rendered.indexOf("1 · Zulu"));

console.log("kristine job option grouping tests passed");
