"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {readMaterialSources,collectCustomerMaterials}=require("../customer-portal-materials");

test("material names come from original sources, metadata supplies rooms, and WW/PDF copies count once",()=>{
  const report={type:"regie_report",reportNumber:"M01",reportDate:"2026-09-01",source:"WW",materials:[{sourceId:"line1",name:"Wandfarbe",quantity:5,unit:"l",purchaseCost:888,note:"INTERNAL"}]};
  const materials=collectCustomerMaterials({jobId:"24177",documents:[report,{...report,source:"PDF"}],
    metaRows:[{key:"wandfarbe|l",relevant:true,use:"Wohnzimmer"},{key:"manual:1",custom:true,relevant:false,name:"Spachtel",quantity:2,unit:"kg"}],
    days:[{day:"2026-09-01",regie:{materials:[{name:"Wandfarbe",quantity:"1,5",unit:"l"}],internalNote:"INTERNAL"}}],
    bookings:[{id:"b1",product:"Little Greene",colourTone:"French Grey",liters:2.5,source:"innovatint-history",component:"Küche",purchasePrice:999,salePrice:111}]});
  assert.equal(materials.length,3);const paint=materials.find(row=>row.name==="Wandfarbe");assert.equal(paint.use,"Wohnzimmer");assert.equal(paint.sources.length,2);assert.deepEqual(paint.sources.map(row=>row.quantity),[5,1.5]);
  assert.equal(materials.find(row=>row.name==="Spachtel").sources[0].quantity,2);
  assert.equal(materials.find(row=>row.colourTone==="French Grey").use,"Küche");
  assert(!JSON.stringify(materials).includes("INTERNAL"));assert(!JSON.stringify(materials).includes("purchase"));assert(!JSON.stringify(materials).includes("salePrice"));
  assert(!Object.hasOwn(paint,"quantity"),"stock evidence and report consumption must not be added into a made-up total");
});

test("the shared ledger is filtered to permitted projects, aliases and duplicate bookings; broken sources remain explicit",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"customer-materials-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const folder=path.join(dir,"_kristine/paint");await fs.mkdir(folder,{recursive:true});
  const booking={id:"b1",jobId:"old24177",product:"Farbe",quantity:2};
  await fs.writeFile(path.join(folder,"job-materials.jsonl"),[booking,booking,{id:"b2",jobId:"25018",product:"OTHER CUSTOMER"}].map(JSON.stringify).join("\n"));
  await fs.mkdir(path.join(dir,"24177"));await fs.writeFile(path.join(dir,"24177","2026-09-01.json"),JSON.stringify({materials:[{name:"Spachtel",quantity:"2,5",unit:"kg"}]}));
  const options={dataDir:dir,jobIds:["24177"],canonicalId:id=>id==="old24177"?"24177":id,listDaysForJob:async()=>["2026-09-01"],regiePathForDay:(id,day)=>path.join(dir,id,day+".json")};
  let result=await readMaterialSources(options);assert.equal(result.bookings.get("24177").length,1);assert.equal(result.days.get("24177").length,1);assert.equal(result.bookings.has("25018"),false);assert.equal(result.unavailable.length,0);
  await fs.writeFile(path.join(dir,"24177","2026-09-01.json"),"broken");result=await readMaterialSources(options);assert.equal(result.bookings.get("24177").length,1);assert.equal(result.unavailable[0].source,"Tageserfassungen");
});

test("missing amounts remain unknown and two projects never share material quantities",()=>{
  const input={metaRows:[{custom:true,key:"manual:1",name:"Farbton Altbestand"}]};
  const a=collectCustomerMaterials({...input,jobId:"24177"}),b=collectCustomerMaterials({...input,jobId:"26018"});
  assert.equal(a[0].sources[0].quantity,null);assert.equal(a[0].jobId,"24177");assert.equal(b[0].jobId,"26018");
});
