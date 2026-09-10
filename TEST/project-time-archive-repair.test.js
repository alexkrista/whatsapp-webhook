"use strict";
const assert=require("node:assert/strict"),fsp=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),Module=require("node:module");
const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==="pdf-lib")return{PDFDocument:{},StandardFonts:{},rgb(){}};return originalLoad.call(this,request,parent,isMain)};
const {registerKristine}=require("../kristine");Module._load=originalLoad;
function app(){const value={};for(const method of ["get","post","put","patch","delete"])value[method]=()=>{};return value}
(async()=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),"project-archive-repair-")),root=path.join(temp,"_kristine");await fsp.mkdir(root,{recursive:true});
  const original=[{id:"a",type:"work",from:"07:00",to:"12:00",jobId:"26073",jobName:"Jansen Schwarzenberg"},{id:"b",type:"lunch",from:"12:00",to:"12:30"},{id:"c",type:"work",from:"12:30",to:"17:00",jobId:"26082",jobName:"Schwerzler/Halter"}];
  await fsp.writeFile(path.join(root,"day-releases.json"),JSON.stringify([{id:"r",employeeId:"20",employeeName:"Johannes",date:"2026-09-09",released:true,releasedAt:"2026-09-09T17:10:00Z"}]));
  await fsp.writeFile(path.join(root,"day-corrections.json"),JSON.stringify([{employeeId:"20",date:"2026-09-09",originalSegments:original,history:[]}]));
  await fsp.writeFile(path.join(root,"time-events.json"),JSON.stringify([{employeeId:"20",date:"2026-09-09",type:"start",at:"07:00",jobId:null,jobName:"",detachedFromProject:true},{employeeId:"20",date:"2026-09-09",type:"ende",at:"17:00",jobId:null,jobName:"",detachedFromProject:true}]));
  await fsp.writeFile(path.join(root,"project-time-archive.json"),JSON.stringify([{id:"old",employeeId:"20",employeeName:"Johannes",date:"2026-09-09",segments:[]}]))
  registerKristine(app(),{dataDir:temp,publicDir:temp,requireAdmin:()=>true,readEmployees:async()=>[]});
  try{
    await new Promise(resolve=>setTimeout(resolve,100));
    const archive=JSON.parse(await fsp.readFile(path.join(root,"project-time-archive.json"),"utf8"));
    assert.deepEqual(archive[0].segments.filter(row=>row.type==="work").map(row=>row.jobId),["26073","26082"]);
    assert.ok(archive[0].repairedAt);
    const personal=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));
    assert(personal.every(row=>!row.jobId));
    console.log("OK: Leeres Baustellenarchiv wird aus dem Freigabestand repariert; KRISZEIT bleibt baustellenlos");
  }finally{await fsp.rm(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
