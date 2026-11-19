"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),{registerKristine}=require("../kristine");
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"employee-context-")),routes=new Map(),app={};for(const method of ["get","post","put","patch","delete"])app[method]=(route,handler)=>routes.set(method+" "+route,handler);
 const instance=registerKristine(app,{dataDir:root,publicDir:root,requireAdmin:(req,res)=>req.admin===true||(res.status(403).json({ok:false}),false),readEmployees:async()=>[{id:"a",name:"Anna",phone:"private"},{id:"b",name:"Bob"}],readJobMeta:async()=>{throw Error("Heavy project data must not be read")}});
 try{
  await instance.startupReady;const today=instance.localDateISO(),previous="2026-01-05",dir=path.join(root,"_kristine");await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,"states.json"),JSON.stringify({a:{mode:"finished_day",timeline:Array(500).fill({type:"heavy"}),activeJobOverride:{date:today,jobId:"26107"}}}));
  await fs.writeFile(path.join(dir,"time-events.json"),JSON.stringify([{employeeId:"a",date:today,type:"start",at:"08:00",jobId:"26107"},{employeeId:"a",date:previous,type:"start",at:"09:00",jobId:"26082"},{employeeId:"b",date:today,type:"start",at:"07:00",jobId:"other"}]));
  const call=async params=>{const res={code:200,status(v){this.code=v;return this},json(v){this.body=v;return this},setHeader(){}};await routes.get("get /kristine/api/employee-context/:employeeId/:date")({admin:true,params},res);return res};
  const result=await call({employeeId:"a",date:previous});assert.equal(result.code,200);assert.equal(result.body.states.a.mode,"working");assert.equal(result.body.states.a.activeJobOverride.jobId,"26107");assert.equal(result.body.timeEvents.length,1);assert.equal(result.body.timeEvents[0].date,previous);assert.equal(result.body.employees.length,1);assert(!JSON.stringify(result.body).includes("private"));assert(!result.body.states.a.timeline);assert(JSON.stringify(result.body).length<1500);assert(!result.body.tasks&&!result.body.projectTimeArchive);
  assert.equal((await call({employeeId:"a",date:"bad"})).code,400);assert.equal((await call({employeeId:"none",date:today})).code,404);
  console.log("PASS: employee/day context stays small, current mode from live stamps, historical dates scoped, no heavy bootstrap collections or other employees/private master fields.");
 }finally{await fs.rm(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
