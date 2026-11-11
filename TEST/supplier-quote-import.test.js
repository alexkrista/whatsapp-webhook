const assert=require('assert');
const {parse,money}=require('../supplier-quote-position-parser');
const sample=['Lieferantenangebot 2026/471','Pos ArtNr Bezeichnung Menge EH Einzelpreis Gesamtpreis','1 186101 CLAYTEC Lehmbauplatte 24 Stk 15,90 381,60','2 201234 Lehmklebe- und ArmierungsmÃ¶rtel 12 Sack 22,40 268,80','3 998876 Schrauben verzinkt 240 Stk 0,19 45,60','Gesamtsumme EUR 696,00'].join('\n');
const r=parse(sample);assert.equal(r.length,3,JSON.stringify(r));assert.equal(r[0].articleNumber,'186101');assert.equal(r[0].unitPrice,15.9);assert.equal(r[1].unitPrice,22.4);assert.equal(r[2].unitPrice,0.19);
assert.strictEqual(money('1.234,56'),1234.56);assert.strictEqual(money('24.50'),24.5);
const fs=require('fs'),ui=fs.readFileSync('public/ui/baustellen-offer-builder.js','utf8'),server=fs.readFileSync('server.js','utf8');
for(const key of ['data-import-recognize','data-import-add','data-import-confirm','data-import-table','data-import-status','/admin/api/materials/auto','data-source-target','materialMaster.push(material)','sourceQuote:{documentId:item.sourceDocumentId'])assert(ui.includes(key),key);
assert(server.includes('/admin/api/offer-supplier-document/:id/positions'));
console.log('PASS: CLAYTEC-like multi-line item list, prices, import controls, source references');
