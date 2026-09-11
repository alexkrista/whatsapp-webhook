"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerMaterialMaster } = require("../material-master");

(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"material-alias-"));
 try{
  const routes={},app={};for(const verb of ["get","post","put","delete","patch"])app[verb]=(url,fn)=>routes[verb+":"+url]=fn;
  let authorized=true;
  const service=registerMaterialMaster(app,{dataDir:root,publicDir:path.join(__dirname,"../public"),requireAdmin:(_,res)=>{if(!authorized)res.status(403).json({ok:false});return authorized}});
  async function call(route,body={},params={},query={}){let result={status:200};await routes[route]({body,params,query},{status(n){result.status=n;return this},json(data){result.body=data}});return result}
  const create=await call("post:/admin/api/materials/auto",{materialId:"A1",product:"Offizieller Name",alias:"Feine Spachtel",purchasePrice:10,salePrice:20,unit:"kg"});
  assert.equal(create.body.material.alias,"Feine Spachtel");
  const learn="post:/admin/api/materials/:materialId/learn-alias",id={materialId:"A1"};
  assert.equal((await call(learn,{alias:"Finish",confirmed:false},id)).status,400);
  authorized=false;assert.equal((await call(learn,{alias:"Finish",confirmed:true},id)).status,403);authorized=true;
  const learned=await call(learn,{alias:"Finish",confirmed:true,source:"Büro bestätigt Regieposition"},id);
  assert.equal(learned.body.material.alias,"Feine Spachtel; Finish");
  assert.equal(learned.body.material.product,"Offizieller Name");
  assert.equal(learned.body.material.purchasePrice,10);assert.equal(learned.body.material.salePrice,20);
  assert.equal((await call(learn,{alias:"finish",confirmed:true},id)).body.learned,false);
  assert.equal((await call(learn,{alias:"Offizieller Name",confirmed:true},id)).body.learned,false);
  const found=await call("get:/admin/api/materials",{},{},{q:"Finish"});
  assert(found.body.materials.some(m=>m.materialId==="A1"));
  await call("put:/admin/api/materials/:materialId",{alias:""},id);
  const deleted=await call("get:/admin/api/materials",{},{},{q:"Finish"});
  assert(!deleted.body.materials.some(m=>m.materialId==="A1"),"Deleting an alias removes it from the search index");
  await service.syncWinWorkerMaterials([{sourceId:"WW1",product:"WW Farbe",matchCode:"WW-MATCH",alias:"Gelernter Suchname",purchasePrice:3,salePrice:6}]);
  await service.syncWinWorkerMaterials([{sourceId:"WW1",product:"WW Farbe",matchCode:"WW-MATCH",purchasePrice:3,salePrice:6}]);
  const before=(await service.readMaterials()).find(m=>m.materialId==="WW1").alias;
  await service.syncWinWorkerMaterials([{sourceId:"WW1",product:"WW Farbe",matchCode:"WW-MATCH",purchasePrice:3,salePrice:6}]);
  const after=(await service.readMaterials()).find(m=>m.materialId==="WW1").alias;
  assert(before.includes("Gelernter Suchname"));assert.equal(after,before,"Repeated WW imports do not grow aliases");
  for(const manual of [undefined,""]){
   const unknown=await call("post:/kristine/api/material-unknown",{description:"Gemeldeter Name",searchAlias:"Baustellenname",unit:"kg"});
   const fields={product:"Geprüfter Name "+String(manual),group:"Material",purchasePrice:2,salePrice:4};if(manual!==undefined)fields.alias=manual;
   const approved=await call("post:/admin/api/material-inbox/:itemId/approve",fields,{itemId:unknown.body.item.id});
   assert.equal(approved.status,200);assert.equal(approved.body.material.alias,manual===undefined?"Baustellenname":"");
   assert.equal(approved.body.material.product,fields.product.trim());
  }
  console.log("PASS: aliases create/search/delete, confirmed learning, authorization, duplicate learning, fixed name/prices, WW persistence, inbox approval and opt-out");
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
