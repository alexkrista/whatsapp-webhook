"use strict";
const assert=require("node:assert/strict"),fsp=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {registerMorningStatus}=require("../morning-status");
(async()=>{
 const dataDir=await fsp.mkdtemp(path.join(os.tmpdir(),"kgo-prompts-")),root=path.join(dataDir,"_kristine"),system=path.join(dataDir,"_system");await fsp.mkdir(root,{recursive:true});await fsp.mkdir(system,{recursive:true});
 const today=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),d=new Date(`${today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-1);const yesterday=d.toISOString().slice(0,10);
 const employees=[{id:"139",name:"Clemens Krista",phone:"0664000000",active:true,activityMode:"productive"}],sent=[];
 await fsp.writeFile(path.join(root,"time-events.json"),JSON.stringify([{employeeId:"139",date:today,type:"start",at:"07:00",createdAt:new Date().toISOString()}]));
 await fsp.writeFile(path.join(root,"day-closes.json"),JSON.stringify([{employeeId:"139",date:yesterday,note:"Bitte morgen Schleifpapier mitnehmen."}]));
 for(const file of ["assignments.json","absences.json","late-notices.json"])await fsp.writeFile(path.join(root,file),"[]");await fsp.writeFile(path.join(root,"scheduler-state.json"),"{}");
 const api=await registerMorningStatus({dataDir,readEmployees:async()=>employees,sendWhatsApp:async message=>{sent.push(message);return{}},chefPhone:"",phoneNumberId:"test",logger:{log(){},warn(){},error(){}}});
 try{
  const lunch=await api.runWorktimePrompt("lunch",today,true);assert.equal(lunch.sent,1);assert.deepEqual(sent.at(-1).buttons,["Mittag"]);
  await api.runSixFortyFive(today,true,"139");assert(sent.some(row=>String(row.reply).includes("Schleifpapier")),"Notiz muss am Folgemorgen versendet werden");
  console.log("OK: KGO erinnert an echte Zeitaktionen und liefert Tagesnotizen um 06:45 aus.");
 }finally{await fsp.rm(dataDir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
