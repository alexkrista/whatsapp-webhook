"use strict";

const assert=require("assert");
const fs=require("fs");
const path=require("path");

const root=path.resolve(__dirname,"..");
const hub=fs.readFileSync(path.join(root,"public","ui","baustellen-knowledge-hub.js"),"utf8");
const page=fs.readFileSync(path.join(root,"public","baustellen.html"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");

assert.match(hub,/data-bk-tab="master">Stammdaten</,"Baustellenansicht braucht einen sichtbaren Stammdaten-Reiter");
assert.match(hub,/function renderMasterData\(j\)/,"Stammdaten müssen aus dem aktuellen Baustellendatensatz gerendert werden");
assert.match(hub,/function renderMasterDataEditor\(j\)/,"Stammdaten müssen direkt in der Baustelle bearbeitet werden");
assert.match(hub,/function wireMasterLinks\(\)/,"Auch die bestehenden Stammdaten-Links müssen im Baustellen-Reiter bleiben");
assert.match(hub,/Nur mit diesem Projekt verknüpft/);
assert.match(hub,/Bauherrschaft/);
assert.match(hub,/Wohnstraße/);
assert.match(hub,/Telefon Bauherrin/);
assert.match(hub,/Telefon Bauherr/);
assert.match(hub,/Bauleitung/);
assert.match(hub,/Architekt/);
assert.match(hub,/Gemeinsamer Nachname/);
assert.match(hub,/Titel Bauherrin/);
assert.match(hub,/Vorname Bauherr/);
assert.match(hub,/auch Architekt/);
assert.match(hub,/deliveryRecipients/);
for(const text of ["Angebot","Auftrag","Regieberichte","Rechnungen"])assert.ok(hub.includes(text),`Versandmatrix enthält ${text}`);
assert.match(hub,/freie Kontaktzeile/);
assert.match(hub,/🚩 Maps/);
assert.match(hub,/function masterMapsUrl/);
assert.match(hub,/projectContacts/);
assert.match(hub,/WW-Kundennummer/);
assert.match(hub,/WW-Stammindex/);
assert.match(hub,/customerMasterStatus/);
assert.match(hub,/Stammdaten bearbeiten/);
assert.match(server,/function sanitizeProjectContacts/);
assert.match(server,/projectContacts:/);
assert.match(server,/deliveryRecipients/);
assert.match(page,/id="detailAdmin" href="#">Stammdaten</);
assert.match(page,/id="linkAdmin" href="#">⚙ Stammdaten bearbeiten/);

console.log("baustellen master data tab test: ok");
