"use strict";
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {normalizedRecipe,compareRecipes}=require('../paint-similar-recipes');
const colorants=new Map([1,2,3,4].map(id=>[id,{cntCode:'P'+id}]));
const recipe=(ids,amounts)=>normalizedRecipe({cntInFormula:JSON.stringify([ids,amounts])},colorants,1000);
test('normalization, aggregation and invalid recipes',()=>{
  assert.equal(compareRecipes(recipe([1,2],[40,60]),recipe([1,2],[80,120])).deviation,0);
  assert.equal(compareRecipes(recipe([1,1,2],[20,20,60]),recipe([1,2],[40,60])).deviation,0);
  for(const x of [[[1],[0]],[[1],[-1]],[[1],[null]],[[1],[]],[[9],[1]],[[1],['oops']]]) assert.equal(recipe(...x),null);
});
test('inclusive boundaries and colour-set restrictions',()=>{
  const a=recipe([1,2],[50,50]);
  assert.equal(compareRecipes(a,recipe([1,2],[49,51])).matchClass,1);
  assert.equal(compareRecipes(a,recipe([1,2],[48.999,51.001])).matchClass,3);
  assert.equal(compareRecipes(a,recipe([1,2,3],[48.5,48.5,3])).matchClass,3);
  assert.equal(compareRecipes(a,recipe([1,2,3],[47.5,47.5,5])).matchClass,5);
  assert.equal(compareRecipes(a,recipe([1,2,3],[47.499,47.5,5.001])).matchClass,null);
  assert.equal(compareRecipes(a,recipe([1,2,3,4],[49,49,1,1])).matchClass,null);
  assert.equal(compareRecipes(recipe([1,2],[97,3]),recipe([1,3],[97,3])).matchClass,5);
  assert.equal(compareRecipes(recipe([1,2],[94,6]),recipe([1,3],[94,6])).matchClass,null);
  assert.equal(compareRecipes(a,recipe([1,2,3],[49.75,49.75,.5])).matchClass,3);
});

function fixture(){
  const catalog={colors:[],formulas:[],colorInProduct:[],products:[{productId:11,productName:'Absolute Matt'},{productId:12,productName:'Satin'},{productId:13,productName:'Inherited Matt',parentProductId:11}],
    basePaints:[{baseId:1,productId:11,aBaseId:1,baseCode:'H'},{baseId:2,productId:11,aBaseId:2,baseCode:'D'},{baseId:3,productId:12,aBaseId:1,baseCode:'H'}],
    canSizes:[{canSizeId:1,canSizeCode:'1 L',nominalAmount:1000},{canSizeId:2,canSizeCode:'5 L',nominalAmount:5000}],
    cans:[{baseId:1,canSizeId:1},{baseId:2,canSizeId:1},{baseId:3,canSizeId:1}],colorants:[...colorants].map(([cntId,c])=>({cntId,...c}))};
  function add(id,amounts,opts={}){catalog.colors.push({colourId:id,colourCode:opts.name||'Colour '+id});catalog.formulas.push({formulaId:id,aBaseId:opts.base||1,cntInFormula:JSON.stringify([amounts.map((_,i)=>i+1),amounts])});catalog.colorInProduct.push({colourId:id,productId:opts.product||11,formulaId:id,version:opts.version||0});}
  add(1,[50,50],{name:'NCS S 2050-Y20R'});add(2,[49,51]);add(3,[48.5,48.5,3]);add(4,[47.5,47.5,5]);add(5,[50,50],{base:2});add(6,[50,50],{product:12});add(7,[0,0]);add(8,[50,50],{version:1});add(9,[100,100]);add(10,[50,50],{name:'Archived*'});
  return catalog;
}
module.exports.fixture=fixture;
test('real paint routes: reference lookup, sorted classes, scope, validation and auth',async()=>{
  const express=require('express'), {registerPaintLab}=require('../paint-lab');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paint-similar-')),root=path.join(dir,'_kristine','paint');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'innovatint-catalog.json'),JSON.stringify(fixture()));
  const previous=process.env.ADMIN_TOKEN;process.env.ADMIN_TOKEN='similar-test';
  const app=express();registerPaintLab(app,{dataDir:dir});
  if(previous===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=previous;
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/admin/api/paint/similar-recipes?`;
  const get=async(q)=>{const r=await fetch(base+q,{headers:{'x-admin-token':'similar-test'}});return [r.status,await r.json()];};
  try{
    assert.equal((await fetch(base+'q=NCS')).status,403);
    let [status,d]=await get('q=NCS%202050Y20R');assert.equal(status,200);assert.equal(d.references.length,2);assert(d.references.every(r=>r.canSizeId===1));
    [status,d]=await get('colourId=1&productId=11&canSizeId=1');assert.equal(status,200);assert.deepEqual(d.results.map(r=>r.colourId),[9,2,3,4]);assert.deepEqual(d.results.map(r=>r.matchClass),[1,1,3,5]);assert(d.results.every(r=>r.baseId===1&&r.productId===11&&r.canSizeId===1));
    assert.equal(d.results[2].rows[2].change,'added');assert.equal(d.results[2].rows[2].candidateMl,3);
    assert.deepEqual((await get('colourId=1&productId=11&canSizeId=1&threshold=1'))[1].results.map(r=>r.colourId),[9,2]);
    assert.equal((await get('colourId=1&productId=11&canSizeId=2'))[0],400);
    assert.equal((await get('colourId=1&productId=11&canSizeId=1&threshold=2'))[0],400);
    assert.equal((await get('colourId=1&productId=12&canSizeId=1'))[0],400);
    assert.equal((await get('colourId=1&productId=13&canSizeId=1'))[1].results.length,4);
    assert.deepEqual((await get('q=does-not-exist'))[1].references,[]);
    assert.equal(fs.readFileSync(path.join(root,'innovatint-catalog.json'),'utf8'),JSON.stringify(fixture()));
  }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('UI: reference selection, comparison, escaping, empty results and stale responses',async()=>{
  const {JSDOM}=require('jsdom');const dom=new JSDOM('<section id="tab-search"></section>',{url:'https://test.invalid/?token=test',runScripts:'outside-only'});
  const w=dom.window;let pending;
  w.fetch=async()=>({ok:true,json:async()=>({ok:true,references:[{colourId:1,name:'NCS 2050Y20R',productId:11,productName:'Absolute Matt',baseCode:'H',canSizeId:1,canSize:'1 L'}]})});
  w.eval(fs.readFileSync(path.join(__dirname,'../public/paint-similar-recipes-ui.js'),'utf8'));
  const el=id=>w.document.getElementById('similar-'+id),tick=()=>new Promise(r=>setImmediate(r));
  el('query').value='NCS 2050Y20R';el('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(el('options').hidden,false);
  w.fetch=async()=>({ok:true,json:async()=>({ok:true,reference:{name:'Ref',productName:'Absolute Matt',baseCode:'H',canSize:'1 L'},results:[{name:'<img src=x onerror=alert(1)>',deviation:1,matchClass:1,formulaId:2,changedColorants:[],rows:[],productName:'Absolute Matt',baseCode:'H',canSize:'1 L'}]})});
  el('run').click();await tick();assert.equal(el('results').querySelectorAll('details').length,1);assert.equal(el('results').querySelector('img'),null);assert.match(el('results').textContent,/Referenz ml/);
  w.fetch=()=>new Promise(r=>pending=r);el('run').click();el('query').value='New';el('query').dispatchEvent(new w.Event('input'));
  pending({ok:true,json:async()=>({ok:true,reference:{},results:[]})});await tick();assert.equal(el('options').hidden,true);assert.equal(el('results').textContent,'');assert.equal(el('status').textContent,'');dom.window.close();
});
