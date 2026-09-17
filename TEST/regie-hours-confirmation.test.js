"use strict";
const assert=require("node:assert/strict"),fs=require("fs"),os=require("os"),path=require("path");
const {registerRegieAssistant}=require("../regie-assistant");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"regie-hours-confirm-")),routes=new Map();
const app={get:(route,handler)=>routes.set(`GET ${route}`,handler),post:(route,handler)=>routes.set(`POST ${route}`,handler),delete:(route,handler)=>routes.set(`DELETE ${route}`,handler)};
registerRegieAssistant(app,{dataDir:root,publicDir:path.join(__dirname,"..","public"),requireAdmin:()=>true,readJobMeta:async()=>({name:"Test"}),writeJobMeta:async()=>{},appendJobHistory:async()=>{},readDocumentation:async()=>[],writeDocumentation:async()=>{}});
const invoke=(handler,req)=>new Promise((resolve,reject)=>{const result={statusCode:200,body:null},res={status(code){result.statusCode=code;return this},json(body){result.body=body;resolve(result)},type(){return this},send(body){result.body=body;resolve(result)},sendFile(file){result.body=file;resolve(result)}};Promise.resolve(handler(req,res)).catch(reject)});
(async()=>{
 const dir=path.join(root,"_kristine");fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,"project-time-archive.json"),JSON.stringify([{employeeId:"clemens",date:"2026-09-17",segments:[{type:"work",jobId:"26082",from:"07:00",to:"10:30"}]}]));
 const save=routes.get("POST /kristine/api/regie-reports/save"),body={jobId:"26082",date:"2026-09-17",description:"Regie geprüft",employees:[{id:"clemens",name:"Clemens Krista",hours:9.75}],materials:[]};
 const draft=await invoke(save,{body:{...body,finish:false}});assert.equal(draft.statusCode,201);assert.equal(draft.body.report.hoursCheck.blocked,true);
 const blocked=await invoke(save,{body:{...draft.body.report,finish:true}});assert.equal(blocked.statusCode,400);assert.match(blocked.body.error,/Möglicherweise doppelt/);
 const accepted=await invoke(save,{body:{...draft.body.report,finish:true,hoursCheckConfirmed:true}});assert.equal(accepted.statusCode,201);assert.equal(accepted.body.report.status,"prepared");assert.ok(accepted.body.report.hoursCheckConfirmedAt);assert.ok(accepted.body.report.hoursCheckConfirmationKey);assert.equal(accepted.body.report.hoursCheck.accepted,true);
 const review=routes.get("POST /kristine/api/regie-reports/:id/review"),archived=await invoke(review,{params:{id:accepted.body.report.id},body:{decision:"archive"}});assert.equal(archived.statusCode,200);assert.equal(archived.body.report.status,"completed");
 console.log("OK: Regie hours warning can be consciously confirmed and remains auditable.");
})().catch(error=>{console.error(error);process.exitCode=1});
