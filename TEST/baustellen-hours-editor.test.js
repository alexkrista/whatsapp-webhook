"use strict";

const assert=require("assert");
const fs=require("fs");
const path=require("path");

const root=path.resolve(__dirname,"..");
const hub=fs.readFileSync(path.join(root,"public","ui","baustellen-knowledge-hub.js"),"utf8");
const kristine=fs.readFileSync(path.join(root,"kristine.js"),"utf8");

assert.match(hub,/Fehlerhafte Stunden korrigieren/);
assert.match(hub,/Bearbeiten \/ umbuchen/);
assert.match(hub,/Ganzen Tag löschen/);
assert.match(hub,/kristine\/api\/segments/);
assert.match(hub,/moveLinked:true/);
assert.match(hub,/Korrektur bleibt in der Historie/);
assert.match(kristine,/if \(date === localDateISO\(\)\)/);
assert.match(kristine,/alten Tag darf den heutigen Live-Status/);

console.log("baustellen hours editor test: ok");
