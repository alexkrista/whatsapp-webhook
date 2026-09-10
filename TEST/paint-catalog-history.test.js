"use strict";
const assert=require("node:assert/strict"),fs=require("fs"),os=require("os"),path=require("path"),vm=require("vm");
const express=require("express");
const {activateCatalog,searchColors,formulaChanged}=require("../paint-catalog-history");
const {reconcile,reference,registerPaintEanReconcile}=require("../paint-ean-reconcile");
const {registerPaintLab}=require("../paint-lab");
const {registerPaintCatalogSync}=require("../paint-catalog-sync");
const old={colors:[{colourId:"1",colourCode:"Adventurer 7"},{colourId:"2",colourCode:"Removed colour"}],products:[{productId:"11",productCode:"0206",productName:"Absolute Matt Emulsion"},{productId:"12",productCode:"0217",productName:"Intelligent Matt Emulsion",parentProductId:"11"}],formulas:[{formulaId:"1",colourId:"1",aBaseId:"1",cntInFormula:"[[1],[10]]"}],colorInProduct:[{colourId:"1",productId:"11",version:"0",formulaId:"1"}],basePaints:[{baseId:"1",productId:"11",aBaseId:"1",baseCode:"Extra Deep"},{baseId:"2",productId:"11",aBaseId:"2",baseCode:"Transparent"}],canSizes:[{canSizeId:"1",canSizeCode:"1 L",nominalAmount:"1000"},{canSizeId:"2",canSizeCode:"5 L",nominalAmount:"5000"}],cans:[{canId:"1",baseId:"1",canSizeId:"1",defaultBarcode:"123"},{canId:"2",baseId:"2",canSizeId:"1",defaultBarcode:"456"}],colorants:[{cntId:"1",cntCode:"AK"}]};
(async()=>{
 const next=JSON.parse(JSON.stringify(old));next.colors=[{colourId:"1",colourCode:"Adventurer new 7"},{colourId:"3",colourCode:"Adventurer* 7"}];next.formulas.push({formulaId:"2",colourId:"1",aBaseId:"2",cntInFormula:"[[1],[12]]"});next.colorInProduct[0].formulaId="2";
 const active=activateCatalog(old,next);assert.deepEqual(active.previousCatalog,old);assert.equal(searchColors(active).find(c=>c.colourId==='2').archiveOnly,true);assert.equal(searchColors(active).find(c=>c.colourId==='3').legacy,true);
 assert.equal(formulaChanged(old.formulas[0],next.formulas[1]),true);assert.equal(formulaChanged(old.formulas[0],{...old.formulas[0],formulaId:'9'}),false);
 const row={id:'a',stockCode:'020603XXXXX',product:'Absolute Matt',baseCode:'XD',size:'1 L',ean:'wrong-old',stock:7,minimumStock:2};
 const plan=reconcile([row],active);assert.equal(plan.rows[0].ean,'123');assert.deepEqual(plan.rows[0].eanAliases,[]);for(const k of Object.keys(row).filter(k=>k!=='ean'))assert.deepEqual(plan.rows[0][k],row[k]);assert.equal(reconcile(plan.rows,active).changes.length,0);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paint-history-'));const root=path.join(dir,'_kristine','paint');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'innovatint-catalog.json'),JSON.stringify(active));fs.writeFileSync(path.join(root,'articles.json'),JSON.stringify([row]));
 const app=express();app.use(express.json({limit:'30mb'}));registerPaintCatalogSync(app,{dataDir:dir});registerPaintEanReconcile(app,{dataDir:dir});registerPaintLab(app,{dataDir:dir});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const get=async p=>(await fetch(base+p)).json();
  let d=await get('/admin/api/paint/color/1');assert.equal(d.products[0].oldRecipe.baseName,'Extra Deep');assert.equal(d.products[1].oldRecipe.baseName,'Extra Deep');
  d=await get('/admin/api/paint/recipe?colourId=1&productId=11&canSizeId=1');assert.equal(d.baseName,'Transparent');assert.equal(d.recipe[0].ml,12);
  d=await get('/admin/api/paint/recipe?colourId=1&productId=11&canSizeId=1&catalogVersion=before-2026-09');assert.equal(d.baseName,'Extra Deep');assert.equal(d.recipe[0].ml,10);assert.equal(d.legacy,true);
  assert.equal((await fetch(base+'/admin/api/paint/recipe?colourId=1&productId=11&canSizeId=2')).status,400);
  d=await get('/admin/api/paint/search?q=Removed');assert.equal(d.results[0].id,'old:2');d=await get('/admin/api/paint/color/old:2');assert.equal(d.color.legacy,true);
  d=await get('/admin/api/paint/search?q=Adventurer%207');assert(d.results.some(r=>r.id===1));
  const p=await get('/admin/api/paint/ean-reconcile');const changed=await fetch(base+'/admin/api/paint/ean-reconcile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:p.revision})});assert.equal(changed.status,200);assert.equal((await get('/admin/api/paint/ean-reconcile')).changes.length,0);
  assert.equal((await fetch(base+'/admin/api/paint/ean-reconcile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:p.revision})})).status,409);
  const html=fs.readFileSync(path.join(__dirname,'../public/paint-lab.html'),'utf8');for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
  console.log('Catalog history, inherited recipes, deleted colour search, EAN preservation and stale-write tests passed');
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
