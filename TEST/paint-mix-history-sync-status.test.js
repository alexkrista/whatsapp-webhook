"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {registerPaintMixHistory}=require("../paint-mix-history");

function appStub(){
 const gets=new Map();
 return {gets,get(k,h){gets.set(k,h);},post(){}};
}
(async()=>{
 const priorToken=process.env.ADMIN_TOKEN;
 const RealDate=global.Date;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"mix-history-sync-status-"));
 const root=path.join(dir,"_kristine","paint");
 await fs.mkdir(root,{recursive:true});
 process.env.ADMIN_TOKEN="mix-status-test";
 const app=appStub();
 registerPaintMixHistory(app,{dataDir:dir});
 const route=app.gets.get("/admin/api/paint/mix-history/status");
 assert.equal(typeof route,"function");
 const virtual=(iso)=>{
   const now=RealDate.parse(iso);
   global.Date=class TestDate extends RealDate {
     constructor(...args){super(...(args.length?args:[now]));}
     static now(){return now;}
   };
 };
 async function readStatus(){
   const res={statusCode:200,body:null,status(n){this.statusCode=n;return this;},set(k,v){this[k]=v;return this;},json(body){this.body=body;return this;}};
   await route({method:"GET",path:"/admin/api/paint/mix-history/status",headers:{"x-admin-token":"mix-status-test"},query:{}},res);
   assert.equal(res.statusCode,200);
   return {body:res.body,res};
 }
 try{
   virtual("2026-11-03T12:05:00Z"); // 13:05 Uhr in Wien.
   let r=await readStatus();
   assert.equal(r.body.stale,true);
   assert.equal(r.body.expected,true);
   assert.equal(r.body.ageMinutes,null);
   assert.equal(r.body.open,0,"0 offene Mischungen muss als bekannt, nicht als aktuell gelten");
   assert.equal(r.res["Cache-Control"],"no-store");
   const syncFile=path.join(root,"mix-history-sync.json");
   await fs.writeFile(syncFile,JSON.stringify({lastSyncAt:"2026-11-03T11:57:00Z"}));
   r=await readStatus();
   assert.equal(r.body.stale,false,"Vor weniger als 10 Minuten ist HistorySync frisch");
   assert.equal(r.body.ageMinutes,8);
   await fs.writeFile(syncFile,JSON.stringify({lastSyncAt:"2026-11-02T14:08:18Z"}));
   r=await readStatus();
   assert.equal(r.body.stale,true,"Gestern nur ein Einmallauf: heute wieder rot");
   assert(r.body.ageMinutes>1000);
   virtual("2026-11-03T20:00:00Z"); // 21 Uhr Wien, ausserhalb Arbeitszeit.
   r=await readStatus();
   assert.equal(r.body.expected,false);
   assert.equal(r.body.stale,false,"Nach Feierabend keine irrefuehrende Warnung");

   console.log("Innovatint HistorySync stale/healthy/outside-hours API status ok");
 }finally{
   global.Date=RealDate;
   if(priorToken===undefined)delete process.env.ADMIN_TOKEN;
   else process.env.ADMIN_TOKEN=priorToken;
   await fs.rm(dir,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
