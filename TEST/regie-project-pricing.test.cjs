"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {registerRegieAssistant}=require("../regie-assistant");
(async()=>{
const root=await fs.mkdtemp(path.join(os.tmpdir(),"regie-pricing-")),routes=new Map(),app={};for(const m of ["get","post","delete"])app[m]=(p,h)=>routes.set(m+" "+p,h);
let meta={regieHourlyRate:81.28},docs=[{id:"regie-office-doclocked",billingStatus:"billed"}];
registerRegieAssistant(app,{dataDir:root,requireAdmin:(req,res)=>req.admin===true||(res.status(403).json({error:"Forbidden"}),false),readJobMeta:async()=>meta,writeJobMeta:async(id,value)=>{meta={...meta,...value}},appendJobHistory:async()=>{},readDocumentation:async()=>docs,writeDocumentation:async(id,value)=>{docs=value}});
async function call(method,body={},admin=true){const res={code:200,status(v){this.code=v;return this},json(v){this.body=v;return this}};await routes.get(method+" /kristine/api/regie-project/:jobId/pricing")({admin,params:{jobId:"26096"},body},res);return res}
const base={jobId:"26096",date:"2026-11-18",hourlyRate:81.28,status:"completed",billingStatus:"open",employees:[{name:"Edi",hours:10,hourlyRate:81.28,discountPercent:10}],materials:[],totals:{laborTotal:731.52},description:"Test"};
const initial=[{...base,id:"open"},{...base,id:"billed",billingStatus:"billed"},{...base,id:"doclocked"},{...base,id:"elsewhere",jobId:"12345"}];
const file=path.join(root,"_kristine/regie-reports.json");await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(initial));
try{
 assert.equal((await call("get",{},false)).code,403);
 let preview=await call("get");assert.equal(preview.body.count,1);assert.equal(preview.body.lockedCount,2);
 assert.equal((await call("post",{scope:"all",hourlyRate:75,materialMarkup:80,fingerprint:"stale"})).code,409);
 assert.equal((await call("post",{scope:"all",hourlyRate:-1,materialMarkup:80,fingerprint:preview.body.fingerprint})).code,400);
 let result=await call("post",{scope:"future",hourlyRate:75,materialMarkup:80});assert.equal(result.body.updatedCount,0);assert.equal(meta.regieHourlyRate,75);assert.deepEqual(JSON.parse(await fs.readFile(file)),initial);
 preview=await call("get");result=await call("post",{scope:"all",hourlyRate:75,materialMarkup:80,fingerprint:preview.body.fingerprint});assert.equal(result.code,200);assert.equal(result.body.updatedCount,1);assert(!result.body.warning);
 const rows=JSON.parse(await fs.readFile(file));assert.equal(rows[0].hourlyRate,75);assert.equal(rows[0].employees[0].hourlyRate,null);assert.equal(rows[0].employees[0].discountPercent,10);assert.equal(rows[0].totals.laborTotal,675);assert.equal(rows[0].pricingHistory[0].hourlyRate,81.28);
 assert.deepEqual(rows.slice(1),initial.slice(1));assert.equal(docs.find(d=>d.id==="regie-office-open").laborCost,675);
 assert.equal((await call("post",{scope:"all",hourlyRate:75,materialMarkup:80,fingerprint:preview.body.fingerprint})).code,409);
 console.log("PASS: future vs all, same-default retroactive application, billed and document-linked protection, employee overrides, discount/totals/history, stale preview, authentication and validation");
}finally{await fs.rm(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
