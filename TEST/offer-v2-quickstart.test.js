"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const C=require("../public/ui/offer-v2-core.js");
const Quick=require("../public/ui/offer-v2-quickstart-core.js");
const fs=require("node:fs"),path=require("node:path");

const wallner="Eingang und Stiegenhaus: Wände 48,20 m², Decke 16,40 m², Boden 16,40 m², Acrylfugen 22 m. Abdecken, spachteln, grundieren, streichen und Acrylfugen herstellen.";

test("30-Sekunden-Kurzbrief ist dasselbe Angebotsmodell wie im vollständigen Studio",()=>{
 const result=Quick.build({customer:"Familie Wallner",title:"Eingang und Stiegenhaus",brief:wallner,preset:"innen"});
 const offer=result.offer,sec=offer.sections[0],room=sec.rooms[0];
 assert.equal(offer.schemaVersion,2);
 assert.equal(offer.customer,"Familie Wallner");
 assert.equal(room.name,"Eingang und Stiegenhaus");
 assert.equal(sec.measurements.length,4);
 assert.deepEqual(sec.measurements.map(x=>C.measured(x).value),[48.2,16.4,16.4,22]);
 assert.equal(room.positions.length,6);
 assert.equal(new Set(room.positions.map(x=>x.id)).size,6);
 assert.deepEqual(room.positions.map(x=>C.positionQuantity(sec,x).value),[16.4,48.2,48.2,48.2,22,16.4]);
 assert.equal(result.missingQuantity,0);
 assert.equal(result.missingPrice,1);
 assert.ok(C.printMarkup(offer).includes(C.currency(C.totals(offer).gross)));
 assert.equal(C.parseOffer(JSON.parse(JSON.stringify(offer))).sections[0].rooms[0].positions.length,6);
});

test("Missing measurements remain empty rather than guessed; prices stay changeable",()=>{
 const {offer,missingQuantity}=Quick.build({customer:"Test",title:"Unbekannt",brief:"Wohnzimmer: Wände streichen, Decke streichen",preset:"einfach"});
 const room=offer.sections[0].rooms[0];
 assert.ok(missingQuantity>=1);
 assert.ok(room.positions.every(p=>p.quantity===0));
 assert.equal(offer.sections[0].measurements.length,0);
 const p=room.positions[0];p.unitPrice=27;p.quantity=12;
 assert.equal(C.totals(offer).net>=324,true);
});

test("Deleting one package position never reintroduces it and print matches totals",()=>{
 const {offer}=Quick.build({customer:"Wallner",title:"Malern",brief:wallner,preset:"innen"});
 const sec=offer.sections[0],room=sec.rooms[0],before=C.totals(offer).net;
 const deleted=room.positions.find(p=>p.text.includes("spachteln"));
 assert.ok(deleted);
 assert.equal(C.removePosition(offer,sec.id,room.id,deleted.id),true);
 const after=C.totals(offer).net;
 assert.ok(after<before);
 assert.equal(room.positions.length,5);
 const pdf=C.printMarkup(offer);
 assert.ok(pdf.includes(C.currency(after)));
 assert.ok(!pdf.includes("Untergrund spachteln für Tapete"));
});

test("One explicit wall measurement can drive multiple independent positions",()=>{
 const {offer}=Quick.build({customer:"Test",title:"Wände",brief:"Wohnzimmer: Wände 20 m² spachteln, grundieren und streichen",preset:"innen"});
 const sec=offer.sections[0],walls=sec.measurements.find(m=>m.label==="Wände"),linked=sec.rooms[0].positions.filter(p=>p.measurementIds.includes(walls.id));
 assert.ok(linked.length>=2);
 walls.formula="25,5";
 assert.ok(linked.every(p=>C.positionQuantity(sec,p).value===25.5));
 linked[0].quantityMode="manual";linked[0].quantity=10;
 assert.equal(C.positionQuantity(sec,linked[0]).value,10);
 assert.equal(C.positionQuantity(sec,linked[1]).value,25.5);
});

test("Quickstart stays within isolated GET-only preview and shares the editor's draft key",()=>{
 const server=fs.readFileSync(path.join(__dirname,"../tools/kristine-v2-preview-server.js"),"utf8");
 const page=fs.readFileSync(path.join(__dirname,"../public/angebot-v2-schnell.html"),"utf8");
 const quick=fs.readFileSync(path.join(__dirname,"../public/ui/offer-v2-quickstart-ui.js"),"utf8");
 const studio=fs.readFileSync(path.join(__dirname,"../public/ui/offer-v2-app.js"),"utf8");
 assert.match(server,/page\.pathname === '\/angebot-v2\/schnell'/);
 assert.ok(server.indexOf("if (!authenticated(req, password))")<server.indexOf("page.pathname === '/angebot-v2/schnell'"));
 assert.ok(server.indexOf("if (req.method !== 'GET' && req.method !== 'HEAD')")<server.indexOf("page.pathname === '/angebot-v2/schnell'"));
 assert.match(page,/id="quickGenerate"/);
 assert.match(page,/offer-v2-core\.js/);
 assert.match(page,/offer-v2-quickstart-core\.js/);
 assert.match(quick,/krista\.angebot-v2\.isolated-preview\.v1/);
 assert.match(studio,/krista\.angebot-v2\.isolated-preview\.v1/);
 assert.doesNotMatch(quick,/\bfetch\s*\(|\bXMLHttpRequest\b/);
 assert.doesNotMatch(page,/protokoll\.krista\.at/);
});
