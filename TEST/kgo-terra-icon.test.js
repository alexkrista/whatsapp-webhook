const assert=require('node:assert/strict');
const {recipes,calculate}=require('../public/kgo-terra-icon.js');
for(const [key,r] of Object.entries(recipes).filter(([key])=>key!=="power")){
  const referenceTotal=r.a+r.b+r.c;
  const fromArea=calculate(key,'m2',r.area);
  assert.ok(Math.abs(fromArea.a-r.a)<1e-9);
  assert.ok(Math.abs(fromArea.b-r.b)<1e-9);
  assert.ok(Math.abs(fromArea.c-r.c)<1e-9);
  const inputs=[['total',referenceTotal],['ab',r.a+r.b],['a',r.a],['b',r.b],['c',r.c]];
  for(const [field,value] of inputs) {
    const result=calculate(key,field,value);
    assert.ok(Math.abs(result.m2-r.area)<1e-9, key+' '+field);
    assert.ok(Math.abs(result.total-referenceTotal)<1e-9,key+' '+field);
  }
  const premix=calculate(key,'ab',(r.a+r.b)/2);
  assert.ok(Math.abs(premix.c-r.c/2)<1e-9);
  assert.ok(Math.abs(premix.m2-r.area/2)<1e-9);
  const half=calculate(key,'total',referenceTotal/2);
  assert.ok(Math.abs(half.a-r.a/2)<1e-9);
}
assert.equal(calculate('fein','m2',0),null);
assert.equal(calculate('mittel','a',-1),null);
for(const layers of [1,2,3]) {
  const x=calculate('power','m2',10,layers);
  assert.ok(Math.abs(x.total-1.1*layers)<1e-9);
  assert.ok(Math.abs(x.a-x.total*0.8)<1e-9);
  assert.ok(Math.abs(x.b-x.total*0.2)<1e-9);
  for(const key of ['total','a','b']) {
    const y=calculate('power',key,x[key],layers);
    assert.ok(Math.abs(y.m2-10)<1e-9,key+' '+layers);
  }
}
assert.equal(calculate('power','c',1),null);
console.log('PASS: Terra Icon Fein/Mittel inklusive A+B sowie POWER 110g/m² je Lage und A:B 4:1');
