const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'../public/outgoing-invoice-book.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
test('outgoing invoice book remains valid JavaScript',()=>{
  assert.ok(script,'missing UI script');
  assert.doesNotThrow(()=>new vm.Script(script));
});
const start='// BEGIN outgoing annual totals',end='// END outgoing annual totals';
const block=html.split(start)[1]?.split(end)[0];
assert.ok(block,'annual total helper missing');
const scope=vm.createContext({});
vm.runInContext(block,scope);

test('yearly cents match the sum of monthly cards including credits',()=>{
  const months=[
    {month:'2026-01',currency:'EUR',count:2,net:100.05,vat:20.01,gross:120.06,paid:80,open:40.06},
    {month:'2026-02',currency:'EUR',count:3,net:200.15,vat:40.03,gross:240.18,paid:240.18,open:0},
    {month:'2026-03',currency:'EUR',count:1,net:-10.11,vat:-2.02,gross:-12.13,paid:-12.13,open:0}
  ];
  const year=scope.annualTotals(months)[0];
  assert.deepEqual(JSON.parse(JSON.stringify(year)),{
    year:'2026',currency:'EUR',count:6,net:29009,vat:5802,gross:34811,paid:30805,open:4006
  });
  assert.equal(year.gross,year.paid+year.open);
});
test('currencies and invoice years stay separate',()=>{
  const months=[
    {month:'2026-10',currency:'EUR',count:2,net:100,vat:20,gross:120,paid:80,open:40},
    {month:'2026-10',currency:'CHF',count:1,net:300,vat:24,gross:324,paid:324,open:0},
    {month:'2025-12',currency:'EUR',count:4,net:20,vat:4,gross:24,paid:24,open:0}
  ];
  const result=scope.annualTotals(months);
  assert.deepEqual(JSON.parse(JSON.stringify(result.map(x=>x.year+' '+x.currency))),
                   ['2026 CHF','2026 EUR','2025 EUR']);
  assert.equal(result.find(x=>x.currency==='CHF').gross,32400);
  assert.equal(result.find(x=>x.year==='2025').count,4);
});
test('UI positions annual total above monthly cards and refreshes both',()=>{
  assert.match(html, /id="years"[^>]*><\/section><section id="months"/);
  assert.match(script,/function render\(\)\{renderAges\(\);renderYears\(\);/);
  assert.match(script,/Entwürfe gehören nicht zu den Jahresumsätzen/);
  assert.match(script,/aktuelle Filterauswahl/);
  assert.deepEqual(JSON.parse(JSON.stringify(scope.annualTotals([]))),[]);
});
