"use strict";
const assert=require("node:assert/strict"),fsp=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),Module=require("node:module");
const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==="pdf-lib")return{PDFDocument:{},StandardFonts:{},rgb(){}};return originalLoad.call(this,request,parent,isMain)};
const {registerKristine}=require("../kristine");Module._load=originalLoad;
function harness(){const app={};for(const method of ["get","post","put","patch","delete"])app[method]=()=>{};return app}
(async()=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),"stale-state-next-day-")),root=path.join(temp,"_kristine");await fsp.mkdir(root,{recursive:true});
  const date=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  await fsp.writeFile(path.join(root,"assignments.json"),JSON.stringify([{date,employeeId:"139",jobId:"26080",jobName:"Fink Loos",from:"07:00"}]));
  await fsp.writeFile(path.join(root,"tasks.json"),"[]");
  await fsp.writeFile(path.join(root,"states.json"),JSON.stringify({"139":{employeeId:"139",employeeName:"Clemens",mode:"working",pending:{type:"day_review_summary",createdAt:"2026-09-15T15:00:00.000Z"},activeJobOverride:{date:"2026-09-15",jobId:"OLD",jobName:"Alt"},timeline:[]}}));
  await fsp.writeFile(path.join(root,"time-events.json"),"[]");
  const api=registerKristine(harness(),{dataDir:temp,publicDir:temp,requireAdmin:()=>true,readEmployees:async()=>[]});
  try{
    const result=await api.handleMessage({employeeId:"139",employeeName:"Clemens",text:"Start",date});
    const events=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));
    assert.equal(events.length,1);
    assert.equal(events[0].type,"start");
    assert.equal(events[0].jobId,"26080");
    assert.match(result.reply,/Arbeitsbeginn/);
    assert.doesNotMatch(result.reply,/läuft bereits/);
    console.log("OK: Ein alter Arbeitsstatus blockiert den Start am Folgetag nicht.");
  }finally{await fsp.rm(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
