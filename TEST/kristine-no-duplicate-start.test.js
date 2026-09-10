"use strict";
const assert=require("node:assert/strict"),fsp=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),Module=require("node:module");
const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==="pdf-lib")return{PDFDocument:{},StandardFonts:{},rgb(){}};return originalLoad.call(this,request,parent,isMain)};
const {registerKristine}=require("../kristine");Module._load=originalLoad;
function harness(){const app={};for(const method of ["get","post","put","patch","delete"])app[method]=()=>{};return app}
(async()=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),"no-duplicate-start-")),root=path.join(temp,"_kristine");await fsp.mkdir(root,{recursive:true});
  const date=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  await fsp.writeFile(path.join(root,"assignments.json"),JSON.stringify([{date,employeeId:"20",jobId:"PLAN",jobName:"Schwerzler/Halter",from:"07:00"}]));
  await fsp.writeFile(path.join(root,"states.json"),JSON.stringify({"20":{employeeId:"20",employeeName:"Johannes",mode:"working",activeAssignmentKey:`${date}|20|07:00|PLAN`,timeline:[]}}));
  await fsp.writeFile(path.join(root,"time-events.json"),JSON.stringify([{employeeId:"20",employeeName:"Johannes",date,type:"start",at:"07:00",actualAt:"06:55",adjusted:true,jobId:"IST",jobName:"Jansen Schwarzenberg",createdAt:new Date().toISOString()}]));
  const api=registerKristine(harness(),{dataDir:temp,publicDir:temp,requireAdmin:()=>true,readEmployees:async()=>[]});
  try{
    const result=await api.handleMessage({employeeId:"20",employeeName:"Johannes",text:"Start",date});
    const events=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));
    assert.equal(events.length,1);assert.equal(events[0].jobId,"IST");assert.equal(events[0].at,"07:00");assert.equal(events[0].actualAt,"06:55");
    assert.match(result.reply,/kein zweiter Start und kein Baustellenwechsel/);assert.equal(result.state.activeJobOverride.jobId,"IST");
    console.log("OK: Früher Start bleibt auf der gewählten Baustelle und erzeugt um 07:00 keinen zweiten Block");
  }finally{await fsp.rm(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
