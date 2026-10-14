"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const C=require("../public/ui/offer-v2-core.js");

test("Rechenausdrücke verwenden Komma, Klammern, Faktor und Abzug – niemals eval",()=>{
  assert.equal(C.formulaValue("(4,67 + 3,8) × 2 × 2,37 - 4"),36.15);
  assert.equal(C.formulaValue("22,14"),22.14);
  for(const value of ["2+", "4/0", "-3", "1+(5", "Math.random()", "1;process.exit()", "0x10", "2abc", ""]) {
    if(value==="")assert.equal(C.formulaValue(value),null);
    else assert.throws(()=>C.formulaValue(value),undefined,value);
  }
});

test("Ein Aufmaß versorgt mehrere Positionen, manuelle Menge bleibt davon unabhängig",()=>{
  const offer=C.fresh(),s=offer.sections[0],r=s.rooms[0];
  const m=C.addMeasurement(offer,s.id,r.id);
  m.label="Wände";m.formula="22,14";m.unit="m²";
  const p=C.addPosition(offer,s.id,r.id,"prepare-wall");
  const q=C.addPosition(offer,s.id,r.id,"paint-wall");
  for(const x of [p,q]){x.quantityMode="linked";x.measurementIds=[m.id];}
  assert.equal(C.positionQuantity(s,p).value,22.14);
  assert.equal(C.positionQuantity(s,q).value,22.14);
  p.quantityMode="manual";p.quantity=10;
  m.formula="30";
  assert.equal(C.positionQuantity(s,p).value,10);
  assert.equal(C.positionQuantity(s,q).value,30);
  assert.equal(C.totals(offer).errors.length,0);
  assert.equal(C.totals(offer).net,round(10*30+30*8.14));
  function round(n){return Math.round(n*100)/100;}
});

test("Einzel- und Sammelpositionen sind nach Einfügen unabhängig löschbar und werden nie wieder erzeugt",()=>{
  const offer=C.fresh(),s=offer.sections[0],r=s.rooms[0];
  const set=C.addBulk(offer,s.id,r.id,["prepare-wall","paint-wall","acryl"]);
  assert.equal(r.positions.length,3);
  assert.equal(new Set(set.map(p=>p.id)).size,3);
  assert.ok(C.removePosition(offer,s.id,r.id,set[1].id));
  assert.deepEqual(r.positions.map(p=>p.text),[set[0].text,set[2].text]);
  r.positions[0].unitPrice=999;assert.equal(r.positions[1].unitPrice,2.24);
  assert.equal(C.totals(offer).net,1001.24);
  assert.equal(C.parseOffer(JSON.parse(JSON.stringify(offer))).sections[0].rooms[0].positions.length,2);
  assert.equal(C.removePosition(offer,s.id,r.id,set[1].id),false);
});

test("Neuer Abschnitt: übernehmen, ergänzen, leer beginnen – Positionen werden nicht automatisch kopiert",()=>{
  const o=C.fresh(),s=o.sections[0],r=s.rooms[0];
  const m=C.addMeasurement(o,s.id,r.id);m.formula="12";C.addPosition(o,s.id,r.id,"paint-wall");
  const copy=C.addSection(o,"copy");
  assert.equal(copy.measurements.length,1);assert.equal(copy.rooms.length,1);
  assert.equal(copy.rooms[0].positions.length,0);
  assert.notEqual(copy.measurements[0].id,m.id);
  assert.equal(copy.measurements[0].roomId,copy.rooms[0].id);
  const extended=C.addSection(o,"extend");
  assert.equal(extended.measurements.length,2);
  assert.equal(extended.rooms[0].positions.length,0);
  const fresh=C.addSection(o,"new");
  assert.equal(fresh.measurements.length,0);
  assert.equal(fresh.rooms[0].positions.length,0);
});

test("Druckansicht enthält exakt die gleichen Preise, Menge, Abschnitts- und Raumsummen",()=>{
  const o=C.sample(),summary=C.totals(o),markup=C.printMarkup(o);
  assert.equal(summary.errors.length,0);
  assert.match(markup,/Malerarbeiten/);assert.match(markup,/Stiegenhaus/);assert.match(markup,/Wallner/);
  assert.match(markup,/22,14/);assert.ok(markup.includes(C.currency(summary.net)));
  assert.ok(markup.includes(C.currency(summary.vat)));
  assert.ok(markup.includes(C.currency(summary.gross)));
  o.sections[0].rooms[0].positions.pop();
  assert.notEqual(C.totals(o).gross,summary.gross);
  assert.ok(C.printMarkup(o).includes(C.currency(C.totals(o).gross)));
  assert.ok(!C.printMarkup(o).includes("Anschlussfugen"));
});

test("Fehlerhafte Aufmaßformeln verhindern den Ausdruck, kein stillschweigendes Rechnen mit 0",()=>{
  const o=C.sample();o.sections[0].measurements[0].formula="3+";
  const sums=C.totals(o);
  assert.ok(sums.errors.length);
  assert.throws(()=>C.printMarkup(o),/Aufmaß bitte prüfen/);
});

test("Alternativen erscheinen, zählen aber nicht zur Angebotssumme",()=>{
  const o=C.fresh(),s=o.sections[0],r=s.rooms[0];
  const regular=C.addPosition(o,s.id,r.id,"paint-wall");regular.quantity=4;
  const alt=C.addPosition(o,s.id,r.id,"wallpaper");alt.quantity=12;alt.unitPrice=35;alt.alternative=true;
  const sum=C.totals(o);
  assert.equal(sum.net,32.56);assert.equal(sum.alternatives,420);
  const page=C.printMarkup(o);
  assert.match(page,/Alternative/);assert.match(page,/nicht enthalten/);
});

test("Import älterer KRISTINE-Entwürfe erhält jede Position und ihren Preis, ohne neue Autopositionen",()=>{
  const legacy={version:5,offerNumber:"2610007",scopeDescription:"Stiegenhaus",
    rooms:[{id:"old-r",name:"Raum 2"}],
    positions:[{groupId:"old-r",groupName:"Raum 2",text:"Untergrund spachteln für Tapete",quantity:22.14,unit:"m²",unitPrice:30},
               {groupId:"old-r",groupName:"Raum 2",text:"Deckend streichen",quantity:22.14,unit:"m²",unitPrice:8.14},
               {groupName:"Weitere Arbeiten",text:"Pauschale",quantity:1,unit:"PA",unitPrice:50}],
    financials:{vatRate:20,discountPercent:0}};
  const v2=C.parseOffer(legacy);
  assert.equal(v2.sections.length,1);
  assert.equal(v2.sections[0].rooms.length,2);
  assert.equal(v2.sections[0].rooms.flatMap(x=>x.positions).length,3);
  assert.equal(v2.sections[0].rooms[0].positions[0].unitPrice,30);
  assert.equal(v2.sections[0].rooms[0].positions[0].quantity,22.14);
  assert.ok(C.printMarkup(v2).includes("Untergrund spachteln"));
});

test("Gedruckte Felder sind HTML-escaped und enthalten kein ausführbares HTML aus dem Entwurf",()=>{
  const o=C.sample();o.customer='<img src=x onerror=alert(1)>';
  o.sections[0].rooms[0].positions[0].text='<script>alert("hi")</script>';
  const page=C.printMarkup(o);
  assert.doesNotMatch(page,/<script>|<img src=/);
  assert.match(page,/&lt;script&gt;/);
  assert.match(page,/&lt;img/);
});
