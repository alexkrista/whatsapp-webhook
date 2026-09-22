"use strict";
const assert=require("node:assert/strict"),fsp=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),Module=require("node:module");
const {registerMorningStatus}=require("../morning-status");
const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==="pdf-lib")return{PDFDocument:{},StandardFonts:{},rgb(){}};return originalLoad.call(this,request,parent,isMain)};
const {registerKristine}=require("../kristine");Module._load=originalLoad;
function harness(){const app={};for(const method of ["get","post","put","patch","delete"])app[method]=()=>{};return app}
(async()=>{
 const dataDir=await fsp.mkdtemp(path.join(os.tmpdir(),"kgo-prompts-")),root=path.join(dataDir,"_kristine"),system=path.join(dataDir,"_system");await fsp.mkdir(root,{recursive:true});await fsp.mkdir(system,{recursive:true});
 const today=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),d=new Date(`${today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-1);const yesterday=d.toISOString().slice(0,10);
 const employees=[{id:"139",name:"Clemens Krista",phone:"0664000000",active:true,activityMode:"productive"},{id:"140",name:"Max Muster",phone:"0664000001",active:true,activityMode:"productive"}],sent=[];
 await fsp.writeFile(path.join(root,"time-events.json"),JSON.stringify(employees.map(row=>({employeeId:row.id,employeeName:row.name,date:today,type:"start",at:"07:00",jobId:"26082",jobName:"Baustelle",createdAt:new Date().toISOString()}))));
 await fsp.writeFile(path.join(root,"day-closes.json"),JSON.stringify([{employeeId:"139",date:yesterday,note:"Bitte morgen Schleifpapier mitnehmen."}]));
 for(const file of ["assignments.json","absences.json","late-notices.json","tasks.json"])await fsp.writeFile(path.join(root,file),"[]");await fsp.writeFile(path.join(root,"scheduler-state.json"),"{}");await fsp.writeFile(path.join(root,"states.json"),"{}");
 const api=await registerMorningStatus({dataDir,readEmployees:async()=>employees,sendWhatsApp:async message=>{sent.push(message);return{}},chefPhone:"",phoneNumberId:"test",logger:{log(){},warn(){},error(){}}});
 try{
  assert.equal(api.clampStartTime("06:55"),"07:00");assert.equal(api.clampStartTime("07:08"),"07:08");
  const lunch=await api.runWorktimePrompt("lunch",today,true);assert.equal(lunch.booked,2);assert.equal(lunch.sent,2);assert.deepEqual(sent.at(-1).buttons,["Nein"]);
  let events=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));assert.equal(events.filter(row=>row.type==="mittag"&&row.at==="12:00"&&row.source==="automatic_worktime").length,2);
  const kristine=registerKristine(harness(),{dataDir,publicDir:dataDir,requireAdmin:()=>true,readEmployees:async()=>employees});
  const declined=await kristine.handleMessage({employeeId:"139",employeeName:"Clemens Krista",text:"Nein",date:today});assert.match(declined.reply,/später selbst zu stempeln/);
  events=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));assert.equal(events.filter(row=>row.employeeId==="139"&&row.type==="mittag").length,0,"Nein muss die automatische Mittagsbuchung vollständig entfernen");
  const resume=await api.runWorktimePrompt("resume",today,true);assert.equal(resume.booked,1);
  events=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));assert.equal(events.filter(row=>row.employeeId==="139"&&row.type==="weiter"&&row.at==="12:30").length,0);assert.equal(events.filter(row=>row.employeeId==="140"&&row.type==="weiter"&&row.at==="12:30").length,1);
  const finish=await api.runWorktimePrompt("finish",today,true);assert.equal(finish.booked,2);assert.deepEqual(sent.at(-1).buttons,["Nein"]);
  const finishDeclined=await kristine.handleMessage({employeeId:"139",employeeName:"Clemens Krista",text:"Nein",date:today});assert.match(finishDeclined.reply,/später selbst „Ende“ stempeln/);events=JSON.parse(await fsp.readFile(path.join(root,"time-events.json"),"utf8"));assert.equal(events.filter(row=>row.employeeId==="139"&&row.type==="ende"&&row.at==="17:00").length,0);
  await api.runSixFortyFive(today,true,"139");assert(sent.some(row=>String(row.reply).includes("Schleifpapier")),"Notiz muss am Folgemorgen versendet werden");
  console.log("OK: KGO bucht Mittag, bedingtes Weiter und Feierabend automatisch; Nein verhindert 12:30 und Frühstarts werden korrekt gerundet.");
 }finally{await fsp.rm(dataDir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
