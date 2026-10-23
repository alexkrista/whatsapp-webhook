"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {employeeRegieRequirements}=require("../kgo-regie-required");
test("KGO: report required for own booked hours on each Regie-only site, including earlier sites",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"kgo-regie-")),root=path.join(dir,"_kristine"),date="2026-10-22";
 try{
  await fs.mkdir(root);const employees=[{id:"r",name:"Ronny Hoffmann"},{id:"c",name:"Cathrin Anna Grabherr"}];
  const write=async(f,v)=>fs.writeFile(path.join(root,f),JSON.stringify(v));
  await write("employees.json",employees);await write("project-time-archive.json",[{employeeId:"r",date,segments:[{type:"work",jobId:"26104",from:"07:00",to:"12:00"},{type:"work",jobId:"26105",from:"13:00",to:"15:00"}]}]);
  const reports=[{id:"c",jobId:"26104",date,status:"prepared",description:"gemalt",employees:[{id:"c",name:employees[1].name,hours:8}]}];
  await write("regie-reports.json",reports);
  const opts={dataDir:dir,employeeId:"r",date,readJobMeta:async id=>({regieOnly:id==="26104",name:"Linher"}),now:new Date("2026-10-23T06:00:00Z")};
  let result=await employeeRegieRequirements(opts);assert.equal(result.missing.length,1);assert.equal(result.missing[0].booked,4.75);
  reports.push({id:"r",jobId:"26104",date,status:"draft",employees:[{id:"r",name:employees[0].name,hours:4.75}]});await write("regie-reports.json",reports);
  result=await employeeRegieRequirements(opts);assert.equal(result.missing.length,1);assert.equal(result.missing[0].draft,true);
  reports[1].status="prepared";reports[1].description="Wände gemalt";await write("regie-reports.json",reports);
  result=await employeeRegieRequirements(opts);assert.equal(result.missing.length,0);assert.equal(result.jobs[0].reported,4.75);
  const mixed=await employeeRegieRequirements({...opts,readJobMeta:async()=>({regieOnly:false})});assert.equal(mixed.jobs.length,0);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test("server refuses 'no regie' confirmation when required report is missing",async()=>{
 const {registerDayClose}=require("../day-close"),dir=await fs.mkdtemp(path.join(os.tmpdir(),"kgo-regie-close-")),root=path.join(dir,"_kristine"),date="2026-10-22";
 try{
  await fs.mkdir(root);await fs.mkdir(path.join(dir,"26104"));
  await fs.writeFile(path.join(dir,"26104",".meta.json"),JSON.stringify({name:"Linher",regieOnly:true}));
  await fs.writeFile(path.join(root,"employees.json"),JSON.stringify([{id:"r",name:"Ronny Hoffmann"}]));
  await fs.writeFile(path.join(root,"project-time-archive.json"),JSON.stringify([{employeeId:"r",date,segments:[{type:"work",jobId:"26104",from:"07:00",to:"12:00"}]}]));
  const routes={};registerDayClose({get:(p,h)=>routes["GET "+p]=h,post:(p,h)=>routes["POST "+p]=h},{dataDir:dir,requireAdmin:()=>true,readEmployees:async()=>[{id:"r",name:"Ronny Hoffmann"}],sendWhatsApp:async()=>{throw Error("must not send")}});
  const res={code:200,status(n){this.code=n;return this},json(data){this.data=data;return this}};
  await routes["POST /kristine/api/day-close"]({body:{employeeId:"r",date,confirmed:true,checks:{time:true,photos:true,material:true,regie:true,order:true}}},res);
  assert.equal(res.code,409);assert.equal(res.data.code,"REGIE_REQUIRED");assert.equal(res.data.jobs[0].jobId,"26104");
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
