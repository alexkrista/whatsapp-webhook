"use strict";

const assert=require("assert");
const fs=require("fs");
const path=require("path");

const root=path.resolve(__dirname,"..");
const hub=fs.readFileSync(path.join(root,"public","ui","baustellen-knowledge-hub.js"),"utf8");
const page=fs.readFileSync(path.join(root,"public","baustellen.html"),"utf8");

assert.match(hub,/data-bk-tab="master">Stammdaten</,"Baustellenansicht braucht einen sichtbaren Stammdaten-Reiter");
assert.match(hub,/function renderMasterData\(j\)/,"Stammdaten müssen aus dem aktuellen Baustellendatensatz gerendert werden");
assert.match(hub,/WW-Kundennummer/);
assert.match(hub,/WW-Stammindex/);
assert.match(hub,/customerMasterStatus/);
assert.match(hub,/Stammdaten bearbeiten/);
assert.match(page,/id="detailAdmin" href="#">Stammdaten</);
assert.match(page,/id="linkAdmin" href="#">⚙ Stammdaten bearbeiten/);

console.log("baustellen master data tab test: ok");
