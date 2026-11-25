"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { onlvMeasurements } = require("../offer-inquiry");

test("ONLV import keeps only square-metre positions and preserves Eventualposition status", () => {
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
    </grundtextnr></positionen></ulg></lg></og>
  </onlv>`;
  const rows = onlvMeasurements(xml);
  assert.deepEqual(rows.map(({ area, title, quantity, eventual, alternative }) =>
    [area, title, quantity, eventual, alternative]), [
    ["Außen", "40.48.41.60A · Reinigen", 530, false, false],
    ["Außen", "40.48.41.60B · Beschichten", 71.5, true, true],
  ]);
});
