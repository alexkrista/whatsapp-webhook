"use strict";
const assert=require("node:assert/strict"),fsp=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),Module=require("node:module");
const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==="pdf-lib")return{PDFDocument:{},StandardFonts:{},rgb(){}};return originalLoad.call(this,request,parent,isMain)};
const {registerKristine}=require("../kristine");Module._load=originalLoad;
function harness(){const app={};for(const method of ["get","post","put","patch","delete"])app[method]=()=>{};return app}
(async()=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),"end-is-immediate-")),root=path.join(temp,"_kristine");await fsp.mkdir(root,{recursive:true});
  const date=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  await fsp.writeFile(path.join(root,"assignments.json"),"[]");
  await fsp.writeFile(path.join(root,"tasks.json"),"[]");
  await fsp.writeFile(path.join(root,"states.json"),JSON.stringify({"20":{employeeId:"20",employeeName:"Johannes",mode:"working",pending:null,timeline:[]}}));
  await fsp.writeFile(path.join(root,"time-events.json"),JSON.stringify([{employeeId:"20",employeeName:"Johannes",date,type:"start",at:"07:00",jobId:"26082",jobName:"Schwerzler/Halter",createdAt:new Date().toISOString()}]));
  const api=registerKristine(harness(),{dataDir:temp,publicDir:temp,requireAdmin:()=>true,readEmployees:async()=>[]});
  try{
    const first=await api.handleMessage({employeeId:"20",employeeName:"Johannes",text:"Ende",date});
    let events=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));
    assert.equal(events.filter(row=>row.type==="ende").length,1,"Ende muss schon vor den Kontrollfragen gespeichert sein");
    assert.match(first.reply,/Ende \d{2}:\d{2} ist gespeichert/);
    for(const answer of ["Ja","Ja","Ja","Nein","Nein"]) await api.handleMessage({employeeId:"20",employeeName:"Johannes",text:answer,date});
    events=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));
    assert.equal(events.filter(row=>row.type==="ende").length,1,"Der bestätigte Tagesabschluss darf kein zweites Ende erzeugen");
    console.log("OK: Ende wird sofort und auch nach allen Kontrollfragen nur einmal gespeichert");
  }finally{await fsp.rm(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
