"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { repairLegacyCollection } = require("../legacy-collection-repair");
const { listJobMedia, registerMediaMigration, reassignJobMedia } = require("../media-migration");
const { registerPhotoInbox } = require("../photo-inbox");
const SOURCE = "keckeis_gabi_harry", TARGET = "25018";

async function fixture(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-recovery-"));
  t.after(() => fsp.rm(dataDir, { recursive:true, force:true }));
  const write = async (name,value) => { await fsp.mkdir(path.dirname(path.join(dataDir,name)),{recursive:true});await fsp.writeFile(path.join(dataDir,name),JSON.stringify(value)); };
  const json = name => fsp.readFile(path.join(dataDir,name),"utf8").then(JSON.parse);
  await write(`${TARGET}/.meta.json`, {name:"Keckeis Gabriele - Fassade",status:"Auftrag",contractAmount:100,collectionMemberJobIds:[]});
  await write("26099/.meta.json",{name:"Other project"});
  return {dataDir,write,json};
}

test("repair moved photo paths, restore member, keep confirmed owners and serve collection photos", async t => {
  const {dataDir,write,json} = await fixture(t);
  const files = ["old-photo.jpg","other-owner.jpg","dismissed.jpg"];
  const items = {};
  for (const [index,name] of files.entries()) {
    const old = `${SOURCE}/2026/07/10/${name}`, moved = `${TARGET}/2026/07/10/${name}`;
    await fsp.mkdir(path.dirname(path.join(dataDir,moved)),{recursive:true});
    await fsp.writeFile(path.join(dataDir,moved),`original-${index}`);
    items[old] = {id:`photo-${index}`,file:old,jobId:index===1?"26099":SOURCE,jobName:"Keckeis Gabi und Harry",originalJobId:SOURCE,status:index===2?"dismissed":"confirmed",date:"2026-07-10",category:"photo"};
  }
  const central = "_kristine/media/2026-07-10/office/central.jpg";
  await fsp.mkdir(path.dirname(path.join(dataDir,central)),{recursive:true});await fsp.writeFile(path.join(dataDir,central),"central-original");
  items[central] = {id:"central",file:central,jobId:SOURCE,jobName:"Keckeis Gabi und Harry",status:"confirmed",date:"2026-07-10",category:"photo"};
  const originalInbox = {enabledAt:"2026-09-01",items};
  await write("_kristine/photo-inbox.json", originalInbox);
  await write("_kristine/day-review-entries.json", []);
  const result = await repairLegacyCollection({dataDir});
  assert.equal(result.status,"repaired");assert.equal(result.verifiedPhotos,2);assert.equal(result.movedFileReferences,3);
  assert.deepEqual((await json(`${TARGET}/.meta.json`)).collectionMemberJobIds,[SOURCE]);
  assert.equal((await json(`${TARGET}/.meta.json`)).contractAmount,100);
  assert.equal((await json(`${SOURCE}/.meta.json`)).name,"Keckeis Gabi und Harry");
  assert.equal((await json("_system/repairs/20260913-keckeis-25018/_kristine__photo-inbox.json")).items[`${SOURCE}/2026/07/10/old-photo.jpg`].jobId,SOURCE);
  const inbox=await json("_kristine/photo-inbox.json");
  assert.equal(inbox.items[`${TARGET}/2026/07/10/other-owner.jpg`].jobId,"26099");
  assert.equal(inbox.items[`${TARGET}/2026/07/10/dismissed.jpg`].status,"dismissed");
  const group = await listJobMedia({dataDir,jobId:TARGET});
  assert.equal(group.length,2);assert(group.every(item=>item.jobId===SOURCE));
  assert.equal((await listJobMedia({dataDir,jobId:TARGET,includeCollection:false})).length,0);
  assert.equal((await listJobMedia({dataDir,jobId:SOURCE})).length,2);
  const routes={};registerMediaMigration({get:(url,handler)=>routes[url]=handler,post(){}},{dataDir,requireAdmin:()=>true});
  for(const item of group){
    const res={statusCode:200,status(c){this.statusCode=c;return this;},send(){},setHeader(){},sendFile(file){this.file=file;}};
    await routes["/admin/api/job/:jobId/media-file"]({params:{jobId:SOURCE},query:{file:item.file}},res);
    assert.equal(res.statusCode,200);assert(res.file);
  }
  await reassignJobMedia({dataDir,jobId:TARGET,targetJobId:"26099",files:[central]});
  assert.equal((await listJobMedia({dataDir,jobId:TARGET})).length,1);
  assert.equal((await listJobMedia({dataDir,jobId:"26099"})).length,2);
  const movedLegacy = `${TARGET}/2026/07/10/old-photo.jpg`;
  await reassignJobMedia({dataDir,jobId:TARGET,targetJobId:"26099",files:[movedLegacy]});
  const res={statusCode:200,status(c){this.statusCode=c;return this;},send(){},setHeader(){},sendFile(file){this.file=file;}};
  await routes["/admin/api/job/:jobId/media-file"]({params:{jobId:"26099"},query:{file:movedLegacy}},res);
  assert.equal(res.statusCode,200);assert(res.file);
  assert.equal((await listJobMedia({dataDir,jobId:TARGET})).length,0);
  await write(`${TARGET}/.meta.json`,{name:"Keckeis Gabriele - Fassade",collectionMemberJobIds:[]});
  assert.equal((await repairLegacyCollection({dataDir})).status,"already_repaired");
  assert.deepEqual((await json(`${TARGET}/.meta.json`)).collectionMemberJobIds,[],"Do not reattach after user dissolves collection");
  for(const [index,name] of files.entries())assert.equal(await fsp.readFile(path.join(dataDir,`${TARGET}/2026/07/10/${name}`),"utf8"),`original-${index}`);
  assert.equal(await fsp.readFile(path.join(dataDir,central),"utf8"),"central-original");
});

test("background photo import waits for startup repair and preserves recovered confirmations",async t=>{
  const {dataDir,write,json}=await fixture(t);
  const central="_kristine/media/2026-07-10/office/photo.jpg";
  await fsp.mkdir(path.dirname(path.join(dataDir,central)),{recursive:true});await fsp.writeFile(path.join(dataDir,central),"photo");
  await write("_kristine/photo-inbox.json",{seen:[],enabledAt:"2026-09-01",historyImport:{completedAt:"2026-09-12"},items:{[central]:{file:central,jobId:SOURCE,jobName:"Keckeis",status:"confirmed",date:"2026-07-10",category:"photo"}}});
  let release;
  const ready=new Promise(resolve=>{release=resolve;});
  const inbox=registerPhotoInbox({get(){},post(){}},{dataDir,requireAdmin:()=>true,ready});
  let imports=0;
  const original=inbox.importHistory;inbox.importHistory=async()=>{imports++;return original();};
  await new Promise(resolve=>setImmediate(resolve));assert.equal(imports,0);
  assert.equal((await repairLegacyCollection({dataDir})).status,"repaired");
  release();await new Promise(resolve=>setImmediate(resolve));
  await inbox.sync();assert.equal(imports,1);
  assert.equal((await json("_kristine/photo-inbox.json")).items[central].status,"confirmed");
  assert.equal((await listJobMedia({dataDir,jobId:TARGET})).length,1);
});

test("missing evidence or an existing source never causes a guessed reassignment",async t=>{
  const {dataDir,write,json}=await fixture(t);
  const old=`${SOURCE}/2026/07/10/missing.jpg`;
  await write("_kristine/photo-inbox.json",{items:{[old]:{file:old,jobId:SOURCE,status:"confirmed"}}});
  assert.equal((await repairLegacyCollection({dataDir})).reason,"no_verified_source_photos");
  assert.deepEqual((await json(`${TARGET}/.meta.json`)).collectionMemberJobIds,[]);
  await write(`${SOURCE}/.meta.json`,{name:"Already restored"});
  assert.equal((await repairLegacyCollection({dataDir})).reason,"source_already_exists");
});

test("ambiguous filename collisions are not linked to a different photo",async t=>{
  const {dataDir,write,json}=await fixture(t),old=`${SOURCE}/2026/07/10/photo.jpg`;
  await write("_kristine/photo-inbox.json",{items:{[old]:{file:old,jobId:SOURCE,status:"confirmed"}}});
  await fsp.mkdir(path.join(dataDir,TARGET,"2026/07/10"),{recursive:true});
  await fsp.writeFile(path.join(dataDir,TARGET,"2026/07/10/photo.jpg"),"target-original");
  await fsp.writeFile(path.join(dataDir,TARGET,"2026/07/10/photo_merged_1.jpg"),"source-original");
  assert.equal((await repairLegacyCollection({dataDir})).reason,"no_verified_source_photos");
  assert.equal((await json("_kristine/photo-inbox.json")).items[old].file,old);
});
