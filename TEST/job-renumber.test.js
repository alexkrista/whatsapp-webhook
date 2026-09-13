"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {MIGRATION,SOURCE_ID,regularNextNumber,rewriteReferences,createAliasResolver,renumberJansen}=require("../job-renumber");
const json=value=>JSON.stringify(value,null,2),hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"renumber-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),typeof value==="string"?value:json(value))};
  write(SOURCE_ID+"/.meta.json",{name:"Jansen, Testkunde",wwProjectNumber:SOURCE_ID,wwProjectIndex:12,contactName:"Testkunde",status:"Auftrag",customerPortal:{status:"prepared",customerEmail:"test@example.test"}});
  write(SOURCE_ID+"/.order-calculation.json",{netTotal:1234,projectNo:SOURCE_ID,positions:[{number:"01",amount:1234}],sourceDocument:{storedName:"offer.pdf"}});
  write(SOURCE_ID+"/_auftrag/offer.pdf","%PDF-1.7\noriginal offer");write(SOURCE_ID+"/2026/09/13/photo.jpg","image bytes");
  write(SOURCE_ID+"/_documentation/index.json",[{id:"report1",jobId:SOURCE_ID,projectNumber:SOURCE_ID,url:`/admin/api/job/${SOURCE_ID}/documentation/file?name=original.pdf&signature=keep`,totalHours:3}]);
  write("_kristine/time-events.json",[{jobId:SOURCE_ID,hours:3},{jobId:"26011",hours:7}]);
  write("_kristine/tasks.json",[{jobId:SOURCE_ID,description:"Original project "+SOURCE_ID}]);
  write("_kristine/states.json",{employee:{currentJobId:SOURCE_ID}});
  write("_system/ww-cache/hours/"+SOURCE_ID+".json",{projectNumber:SOURCE_ID,data:{totalHours:5}});
  write("26096/.meta.json",{name:"Existing"});write("26098/.meta.json",{name:"Existing two"});write("other/.meta.json",{name:"Unrelated"});
  return {dir,write,read:file=>JSON.parse(fs.readFileSync(path.join(dir,file),"utf8"))};
}
test("next regular number uses highest occupied 26xxx plus one and never enters another year",()=>{
  assert.equal(regularNextNumber(["26096","26098","2606109","S26999","27008"]),"26099");
  assert.equal(regularNextNumber([]),"26001");assert.throws(()=>regularNextNumber(["26999"]),/voll/);
});
test("Jansen moves once with complete backup, stable documents and updated time/task references",t=>{
  const f=fixture(t),originalPdf=hash(path.join(f.dir,SOURCE_ID,"_auftrag/offer.pdf")),unrelated=hash(path.join(f.dir,"other/.meta.json")),cache=hash(path.join(f.dir,"_system/ww-cache/hours",SOURCE_ID+".json"));
  const r=renumberJansen({dataDir:f.dir});assert.equal(r.newJobId,"26099");assert.equal(r.status,"renumbered");assert.equal(r.calculationPositions,1);
  assert.equal(hash(path.join(f.dir,"26099/_auftrag/offer.pdf")),originalPdf);assert.equal(hash(path.join(f.dir,SOURCE_ID,"_auftrag/offer.pdf")),originalPdf);
  assert.equal(hash(path.join(f.dir,"_system/repairs",MIGRATION,"source/_auftrag/offer.pdf")),originalPdf);assert.equal(hash(path.join(f.dir,"other/.meta.json")),unrelated);assert.equal(hash(path.join(f.dir,"_system/ww-cache/hours",SOURCE_ID+".json")),cache);
  assert.equal(f.read("26099/.meta.json").customerPortal.customerEmail,"test@example.test");assert.equal(f.read("26099/.meta.json").wwProjectNumber,SOURCE_ID);assert.equal(f.read("26099/.order-calculation.json").projectNo,SOURCE_ID);
  assert.equal(f.read("_kristine/time-events.json")[0].jobId,"26099");assert.equal(f.read("_kristine/time-events.json")[0].hours,3);assert.equal(f.read("_kristine/time-events.json")[1].jobId,"26011");assert.equal(f.read("_kristine/states.json").employee.currentJobId,"26099");
  assert.equal(f.read("26099/_documentation/index.json")[0].jobId,"26099");assert.equal(f.read("26099/_documentation/index.json")[0].projectNumber,SOURCE_ID);assert.match(f.read("26099/_documentation/index.json")[0].url,/2606109.*signature=keep/);
  const aliases=createAliasResolver(f.dir);assert.equal(aliases.canonical(SOURCE_ID),"26099");assert.equal(aliases.isAlias(SOURCE_ID),true);
  const visible=fs.readdirSync(f.dir).filter(id=>!aliases.isAlias(id)&&fs.statSync(path.join(f.dir,id)).isDirectory());assert(!visible.includes(SOURCE_ID));assert(visible.includes("26099"));
  f.write("26099/_auftrag/offer.pdf","%PDF-new user edit");assert.equal(renumberJansen({dataDir:f.dir}).status,"already_renumbered");assert.equal(fs.readFileSync(path.join(f.dir,"26099/_auftrag/offer.pdf"),"utf8"),"%PDF-new user edit");
});
for(const phase of ["prepared","moved","references_updated"])test("interrupted rename resumes the same reserved number after "+phase,t=>{
  const f=fixture(t);assert.throws(()=>renumberJansen({dataDir:f.dir,checkpoint:step=>{if(step===phase)throw new Error("interrupt")}}),/interrupt/);
  const result=renumberJansen({dataDir:f.dir});assert.equal(result.newJobId,"26099");assert.equal(f.read("_kristine/tasks.json")[0].jobId,"26099");assert.equal(fs.lstatSync(path.join(f.dir,SOURCE_ID)).isSymbolicLink(),true);
});
test("a changed record or occupied target after preparation is never overwritten",t=>{
  const f=fixture(t);assert.throws(()=>renumberJansen({dataDir:f.dir,checkpoint:()=>{throw new Error("interrupt")}}));
  f.write("_kristine/tasks.json",[{jobId:SOURCE_ID,description:"New user text"}]);assert.throws(()=>renumberJansen({dataDir:f.dir}),/changed after/);assert.equal(f.read("_kristine/tasks.json")[0].description,"New user text");assert(fs.lstatSync(path.join(f.dir,SOURCE_ID)).isDirectory());
  f.write("26099/.meta.json",{name:"Another project"});assert.throws(()=>renumberJansen({dataDir:f.dir}),/belegt/);assert.equal(f.read("26099/.meta.json").name,"Another project");
});
test("only the authorized standalone customer is eligible; collection membership and a mismatching identity remain unchanged",t=>{
  const f=fixture(t);f.write(SOURCE_ID+"/.meta.json",{name:"Someone else"});assert.equal(renumberJansen({dataDir:f.dir}).status,"blocked");assert(!fs.existsSync(path.join(f.dir,"26099")));
  f.write(SOURCE_ID+"/.meta.json",{name:"Jansen, Testkunde"});f.write("_system/sammelmappen.json",{collections:{S26096:{active:true,mainJobId:"26096",memberJobIds:["26096",SOURCE_ID]}}});assert.equal(renumberJansen({dataDir:f.dir}).status,"blocked");assert(fs.lstatSync(path.join(f.dir,SOURCE_ID)).isDirectory());
});
test("stale request references change identity fields only, preserving WW numbers, hours and text",()=>{
  const input={jobId:SOURCE_ID,projectNumber:SOURCE_ID,wwProjectNumber:SOURCE_ID,description:SOURCE_ID,memberJobIds:[SOURCE_ID,"26001"],rows:[{targetJobId:SOURCE_ID,hours:2}]};
  const result=rewriteReferences(input,SOURCE_ID,"26099");assert.equal(result.jobId,"26099");assert.equal(result.projectNumber,SOURCE_ID);assert.equal(result.description,SOURCE_ID);assert.deepEqual(result.memberJobIds,["26099","26001"]);assert.equal(result.rows[0].hours,2);assert.equal(input.jobId,SOURCE_ID);
});
test("renumbered gallery keeps confirmed, reassigned and pending photos distinct without importing duplicates",async t=>{
  const {listJobMedia,migrateLegacyMediaForDate,registerMediaMigration}=require("../media-migration");
  const f=fixture(t),day=SOURCE_ID+"/2026/09/13/",files=[day+"photo.jpg",day+"moved.jpg",day+"waiting.jpg"];
  for(const file of files)f.write(file,"image bytes");
  f.write("_kristine/day-review-entries.json",files.map((file,i)=>({id:"p"+i,file,jobId:i===1?"26096":SOURCE_ID,date:"2026-09-13",category:"photo",content:"Caption "+i})));
  f.write("_kristine/photo-inbox.json",{enabledAt:"2026-09-01",seen:files,items:Object.fromEntries(files.map((file,i)=>[file,{file,jobId:i===1?"26096":SOURCE_ID,previousJobId:SOURCE_ID,originalJobId:SOURCE_ID,status:i===2?"pending":"confirmed"}]))});
  f.write("_kristine/media-assignments.json",{[files[1]]:{jobId:"26096",originalJobId:SOURCE_ID}});
  renumberJansen({dataDir:f.dir});
  const media=await listJobMedia({dataDir:f.dir,jobId:"26099"});assert.equal(media.length,1);assert.equal(media[0].file,files[0]);assert.equal(media[0].content,"Caption 0");assert.equal(media[0].jobId,"26099");
  assert.equal((await listJobMedia({dataDir:f.dir,jobId:SOURCE_ID})).length,1);
  const moved=await listJobMedia({dataDir:f.dir,jobId:"26096"});assert.equal(moved.length,1);assert.equal(moved[0].file,files[1]);
  const imported=await migrateLegacyMediaForDate({dataDir:f.dir,date:"2026-09-13"});assert.equal(imported.scanned,3);assert.equal(imported.imported,0);
  f.write("26099/2026/09/13/new.jpg","new photo");
  const updated=await listJobMedia({dataDir:f.dir,jobId:"26099"});assert.equal(updated.length,2);assert(updated.some(row=>row.file==="26099/2026/09/13/new.jpg"));
  const app=require("express")();registerMediaMigration(app,{dataDir:f.dir,requireAdmin:(req,res)=>{if(req.headers["x-test-auth"]==="admin")return true;res.sendStatus(401);return false}});
  const server=await new Promise(resolve=>{const server=app.listen(0,"127.0.0.1",()=>resolve(server))});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const request=(id,file,auth=true)=>fetch(`http://127.0.0.1:${server.address().port}/admin/api/job/${id}/media-file?file=${encodeURIComponent(file)}`,{headers:auth?{"x-test-auth":"admin"}:{}});
  assert.equal((await request("26099",files[0],false)).status,401);
  for(const id of [SOURCE_ID,"26099"]){const response=await request(id,files[0]);assert.equal(response.status,200);assert.equal(await response.text(),"image bytes")}
  assert.equal((await request("26096",files[0])).status,404);assert.equal((await request("26099",files[1])).status,404);assert.equal((await request("26099",files[2])).status,404);
  assert.equal((await request("26099","26099/2026/09/13/new.jpg")).status,200);
});
