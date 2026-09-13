"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {registerJobSourceCache}=require("../job-source-cache");
test("cache requires authorization, validates project ownership and preserves the last valid snapshot",async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"job-source-cache-"));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));await fs.mkdir(path.join(dataDir,"24177"));
  const routes={};registerJobSourceCache({get:(url,fn)=>routes.GET=fn,put:(url,fn)=>routes.PUT=fn},{dataDir,requireAdmin:(req,res)=>{if(req.allowed)return true;res.status(403).json({ok:false});return false},readJobMeta:async()=>({wwProjectNumber:"24177"})});
  async function call(method,{data,projectNumber="24177",allowed=true,kind="hours"}={}){
    const req={params:{jobId:"24177",kind},query:{projectNumber},body:{data},allowed},res={code:200,status(code){this.code=code;return this},json(value){this.body=value},setHeader(){}};await routes[method](req,res);return res;
  }
  assert.equal((await call("PUT",{allowed:false})).code,403);
  assert.equal((await call("PUT",{projectNumber:"24178"})).code,400);
  const data={found:true,projectNumber:"24177",totalHours:25,rows:[{hours:25,date:"2026-09-01"}],days:[{hours:25,date:"2026-09-01"}]};
  assert.equal((await call("PUT",{data})).code,200);
  assert.equal((await call("PUT",{data:{found:false,projectNumber:"wrong",rows:[]}})).code,400);
  assert.equal((await call("GET")).body.snapshot.data.totalHours,25);
  assert.deepEqual((await fs.readdir(path.join(dataDir,"_system/ww-cache/hours"))),["24177.json"]);
});
