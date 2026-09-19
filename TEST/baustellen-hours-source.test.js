"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const H=require("../public/ui/baustellen-hours-core");
const D=require("../public/ui/baustellen-data");
const {createBaustellenHoursService}=require("../baustellen-hours-service");

const bootstrap={today:"2026-09-19",employees:[{id:"e1",name:"Anna",finkzeitPersonnelNumber:"17"}],states:{},timeEvents:[],projectTimeArchive:[{employeeId:"e1",date:"2026-09-18",segments:[{type:"work",jobId:"26100",from:"07:00",to:"15:15"}]}]};
const ww={found:true,rows:[{date:"2026-09-17",finkNumber:"17",employeeName:"Anna",hours:3},{date:"2026-09-18",finkNumber:"17",employeeName:"Anna",hours:8}]};
const payload={ok:true,jobs:[
  {jobId:"26100",status:"Auftrag",collectionParentJobIds:["S26100"],calculation:{calculatedHours:20,actualHours:8}},
  {jobId:"26101",status:"Laufend",collectionParentJobIds:["S26100"],calculation:{calculatedHours:10,actualHours:2,actualRegieHours:2}},
  {jobId:"25001",status:"Geschlossen",collectionParentJobIds:["S26100"],calculation:{calculatedHours:1000,actualHours:100}},
  {jobId:"25002",status:"Geschlossen",calculation:{calculatedHours:200,actualHours:5}},
],collections:[{jobId:"S26100",kind:"collection",status:"Laufend",collectionMemberJobIds:["26100","26101","25001"]}]};

test("offene Baustellen: Soll minus WW + KRISTINE, Überschneidungen und Sammelmitglieder nur einmal",()=>{
  const wwByMember=new Map([["26100",H.combineWw([{number:"26100",data:H.parseWwHours({hours:ww},"26100")}])]]);
  const result=H.createEngine({jobs:D.catalog(payload),bootstrap,wwByMember,now:new Date("2026-09-19T12:00:00Z")}).snapshot();
  assert.equal(result.targetHours,30);
  assert.equal(result.workedHours,13);
  assert.equal(result.remainingHours,17);
  assert.equal(result.byJob["26100"].ww,3);
  assert.equal(result.byJob["26100"].kristine,8);
  assert.equal(result.byJob["26100"].remaining,9);
});

test("gespeicherte WW-Korrekturen ändern den zentralen Stand sofort; unveränderte Daten teilen denselben Stand",async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"baustellen-hours-"));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const dir=path.join(dataDir,"_system/ww-cache/hours");await fs.mkdir(dir,{recursive:true});
  const file=path.join(dir,"26100.json");await fs.writeFile(file,JSON.stringify({data:ww}));
  const attach=createBaustellenHoursService({dataDir,readBootstrap:async()=>bootstrap,now:()=>new Date("2026-09-19T12:00:00Z")});
  const first=await attach(payload),second=await attach(payload);
  assert.equal(first.baustellenHours.remainingHours,17);
  assert.equal(first.baustellenHours,second.baustellenHours);
  await fs.writeFile(file,JSON.stringify({data:{...ww,rows:[{...ww.rows[0],hours:5},ww.rows[1]]}}));
  assert.equal((await attach(payload)).baustellenHours.remainingHours,15);
});

test("Überverbrauch bleibt sichtbar; geschlossene Sammelmappen haben keine Reststunden",()=>{
  const jobs=[{jobId:"1",status:"Auftrag",calculation:{calculatedHours:5,actualHours:8}},{jobId:"2",status:"Auftrag",collectionParentJobIds:["S2"],calculation:{calculatedHours:100}},{jobId:"S2",kind:"collection",status:"Geschlossen",collectionMemberJobIds:["2"]}];
  const result=H.createEngine({jobs}).snapshot();
  assert.equal(result.remainingHours,0);assert.equal(result.overrunHours,3);
});

test("leere Archivzeilen verdrängen keine Live-Buchung",()=>{
  const b={...bootstrap,projectTimeArchive:[{employeeId:"e1",date:"2026-09-18",segments:[]}],timeEvents:[{employeeId:"e1",date:"2026-09-18",at:"07:00",type:"start",jobId:"26100"},{employeeId:"e1",date:"2026-09-18",at:"15:15",type:"ende"}]};
  const result=H.createEngine({jobs:payload.jobs,bootstrap:b}).snapshot();assert.equal(result.byJob["26100"].total,8);
});
