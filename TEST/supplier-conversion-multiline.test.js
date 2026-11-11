const assert=require('assert'),{parse}=require('../supplier-quote-position-parser');
const t=`10 16610122 CLAYTEC LEHMBAUPL. 40,000 QMT 26,64 1065,60
1250X625X22MM D22 1 QMT
Variante
16610121 CLAYTEC LEHMBAUPL. 40,000 QMT 25,01
1250X625X16MM D16 1 QMT
20 16610235 LEHMKLEBER UND 8,000 SACK 32,63 261,04
AMIERUNGSMÖRTEL 1 SACK
A25KG
30 16610233 CLAYTEC LEHMBAU- 5,000 PAK 25,44 127,20
PLATTENSCHRAUBEN 1 PAK
5X50MM A 100 STK.
40 1510716 UNIVERSALGEWEBE 50,000 QMT 1,27 63,50
MW. 7X7MM 50X1M 1,000 ROL 1 QMT
BLAU 110GR/M2
50 16610220 YOSIMA LEHM DESIGN- 6,000 GEB 59,88 359,28
PUTZ WEISS A 20 KG 1 GEB
EIMER
Variante
16616610 YOSIMA LEHM DESIGN- 120,000 KG 3,38
PUTZ F.MISCHCENTER 6,000 GEB 1 KG
146 Farbtöne!
Variante
16616618 YOSIMA EIMER LEER 6,000 STK 0,01
NUR FÜR MISCHCENTER 1 STK`;
const rows=parse(t);console.log(rows.map(r=>({id:r.articleNumber,name:r.name,pack:r.packContent,unit:r.calcUnit,price:r.calcUnitPrice})));
assert(rows.length>=7,'expected at least 7 positions, got '+rows.length);
const glue=rows.find(r=>r.articleNumber==='16610235');assert(glue.name.includes('AMIERUNGSMÖRTEL'));assert.equal(glue.packContent,25);assert.equal(glue.calcUnitPrice,1.3052);
const screws=rows.find(r=>r.articleNumber==='16610233');assert.equal(screws.packContent,100);assert.equal(screws.calcUnitPrice,0.2544);
const white=rows.find(r=>r.articleNumber==='16610220');assert.equal(white.packContent,20);assert.equal(white.calcUnitPrice,2.994);
console.log('PASS multiple wrapped supplier offer items and package conversion')