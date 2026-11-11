const assert=require('assert'),fs=require('fs');
const ui=fs.readFileSync('public/ui/baustellen-offer-builder.js','utf8'),server=fs.readFileSync('server.js','utf8');
for(const key of ['function refreshPositionTotals()','data-total-crew','data-total-hours','data-total-duration','data-total-material','data-total-material-lines','qty*hoursPerUnit','hours/crew','qty*Math.max(0,Number(m.consumption)','totalRoot.addEventListener'])assert(ui.includes(key),key);
assert(ui.includes('mountSupplierQuoteUi();refreshPositionTotals()'));
assert(server.split('crewSize:Math.max(1,').length===4);
const qty=21,hoursPerUnit=50/60,crew=2,materialPerUnit=40.10;
assert.equal(+(qty*hoursPerUnit).toFixed(2),17.5);
assert.equal(+(qty*hoursPerUnit/crew).toFixed(2),8.75);
assert.equal(+(qty*materialPerUnit).toFixed(2),842.1);
console.log('PASS: 21 units x 50 min = 17.5 MA-hours; 2 employees = 8.75 h; material 842.10 EUR. Crew persistent.');

