"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { onlvMeasurements } = require("../offer-inquiry");

test("ONLV import keeps priced positions across units and preserves Eventualposition status", () => {
  const position = (letter, title, unit, quantity, kind) => `
    <folgeposition ftnr="${letter}"><pos-eigenschaften>
      <stichwort>${title}</stichwort><einheit>${unit}</einheit>
      <lvmenge>${quantity}</lvmenge><pzzv><${kind}/></pzzv>
    </pos-eigenschaften></folgeposition>`;
  const xml = `<onlv xmlns="http://www.oenorm.at/schema/A2063/2009-06-01">
    <og nr="40"><lg nr="48"><ulg nr="41"><ulg-eigenschaften>
      <ueberschrift>Fassade</ueberschrift><vorbemerkung>Vorbemerkung mit 50 m²</vorbemerkung>
    </ulg-eigenschaften><positionen><grundtextnr nr="60">
      ${position("A", "Reinigen", "m²", "530", "normalposition")}
      ${position("B", "Beschichten", "m²", "71,5", "eventualposition")}
      ${position("C", "Fugen", "m", "22", "normalposition")}
      ${position("D", "Bauteile", "Stk", "3", "normalposition")}
      ${position("E", "Hinweis", "", "", "normalposition")}
    </grundtextnr></positionen></ulg></lg></og>
  </onlv>`;
  const rows = onlvMeasurements(xml);
  assert.deepEqual(rows.map(({ area, title, quantity, unit, eventual, alternative }) =>
    [area, title, quantity, unit, eventual, alternative]), [
    ["Außen", "40.48.41.60A · Reinigen", 530, "m²", false, false],
    ["Außen", "40.48.41.60B · Beschichten", 71.5, "m²", true, true],
    ["Außen", "40.48.41.60C · Fugen", 22, "m", false, false],
    ["Außen", "40.48.41.60D · Bauteile", 3, "Stk", false, false],
  ]);
});

test("submitted ONLV preserves quoted unit prices and reconciles only normal positions", () => {
  const {readOnlvInquiry}=require("../offer-inquiry");
  const position=(nr,kind,price)=>`<grundtextnr nr="${nr}"><folgeposition ftnr="A"><pos-eigenschaften>
    <stichwort>Arbeiten</stichwort><einheit>m²</einheit><lvmenge>2</lvmenge><pzzv><${kind}/></pzzv>
    <preis><gesamt>${price}</gesamt></preis><pospreis>${price*2}</pospreis>
    </pos-eigenschaften></folgeposition></grundtextnr>`;
  const xml=`<onlv><angebots-lv><kenndaten><vorhaben>Keckeis</vorhaben></kenndaten>
    ${position("11","normalposition",12.50)}${position("12","eventualposition",9)}
    <summenormalausfuehrung><gesamtpreis>25.00</gesamtpreis><ust><ustsatz>20</ustsatz></ust><angebotspreis>30.00</angebotspreis></summenormalausfuehrung>
    </angebots-lv></onlv>`;
  const data=readOnlvInquiry(Buffer.from(xml));
  assert.equal(data.subject,"Keckeis");
  assert.deepEqual(data.documents[0].groups.map(x=>[x.unitPrice,x.eventual]),[[12.5,false],[9,true]]);
  assert.deepEqual(data.offer,{net:25,gross:30,vatRate:20,calculated:25,matches:true});
});
