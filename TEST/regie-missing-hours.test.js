"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {missingHoursPlan}=require("../regie-missing-hours");
const linher=[
 ["2026-09-29","Clemens Krista",3,3.25],["2026-09-29","Manuel Faes",4.25,4.5],
 ["2026-09-30","Clemens Krista",.75,1],["2026-09-30","Ronny Hoffmann",8.52,0],
 ["2026-10-01","Clemens Krista",1.25,1.5],["2026-10-01","Manuel Faes",1.25,1.5],
 ["2026-10-01","Ronny Hoffmann",8.17,0],["2026-10-02","Ronny Hoffmann",4.75,0],
 ["2026-10-05","Cathrin Anna Grabherr",2.5,0],["2026-10-05","Ronny Hoffmann",7.92,0]
];
test("Linher: four missing days; overreported staff do not cover another employee",()=>{
 const p=missingHoursPlan({jobId:"26104",rows:linher.map(([date,name,hours])=>({date,name,hours})),documents:linher.filter(x=>x[3]).map(([reportDate,name,h,hours],i)=>({id:"ww"+i,type:"regie_report",reportDate,reportNumber:"26104"+i,employeeDetails:[{name,hours}]}))});
 assert.equal(p.days.filter(d=>d.create>.01).length,4);assert.equal(p.missing,31.86);assert.equal(p.reported,11.75);
 assert.equal(p.days.find(d=>d.date==="2026-10-05").employees.filter(e=>e.create>.01).length,2);
});
test("draft reserves hours without satisfying daily report; mirrored docs do not double count",()=>{
 const report={id:"draft1",jobId:"26104",date:"2026-10-05",status:"draft",employees:[{name:"Ronny Hoffmann",hours:7.92}]};
 const p=missingHoursPlan({jobId:"26104",rows:[{date:"2026-10-05",name:"Ronny Hoffmann",hours:7.92}],reports:[report],documents:[{id:"regie-office-draft1",type:"regie_report",reportDate:report.date,employeeDetails:report.employees}]});
 assert.equal(p.missing,7.92);assert.equal(p.days[0].create,0);assert.deepEqual(p.days[0].draftIds,["draft1"]);
});
test("API creates a single multi-employee draft per day and repeat creates none",async()=>{
 const {registerRegieAssistant}=require("../regie-assistant"),dir=fs.mkdtempSync(path.join(os.tmpdir(),"regie-missing-"));
 try{
  const root=path.join(dir,"_kristine");fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,"project-time-archive.json"),JSON.stringify([{employeeId:"r",employeeName:"Ronny",date:"2026-10-05",segments:[{type:"work",jobId:"26104",from:"07:00",to:"12:00"}]},{employeeId:"c",employeeName:"Cathrin",date:"2026-10-05",segments:[{type:"work",jobId:"26104",from:"07:00",to:"10:00"}]}]));
  fs.writeFileSync(path.join(root,"employees.json"),JSON.stringify([{id:"r",name:"Ronny"},{id:"c",name:"Cathrin"}]));
  fs.mkdirSync(path.join(dir,"26104"));const routes={};registerRegieAssistant({get:(p,h)=>routes["GET "+p]=h,post:(p,h)=>routes["POST "+p]=h,delete:(p,h)=>routes["DELETE "+p]=h},{dataDir:dir,publicDir:"public",requireAdmin:()=>true,readJobMeta:async()=>({name:"Linher",regieOnly:true}),readHoursBootstrap:async()=>({projectTimeArchive:JSON.parse(fs.readFileSync(path.join(root,"project-time-archive.json"))),employees:JSON.parse(fs.readFileSync(path.join(root,"employees.json"))),today:"2026-10-23"}),readDocumentation:async()=>[],writeDocumentation:async()=>{}});
  async function call(route,body){const res={code:200,status(n){this.code=n;return this},json(data){this.data=data;return this}};await routes[route]({body,query:{jobId:"26104"}},res);return res}
  const first=await call("POST /kristine/api/regie-reports/missing-hours",{jobId:"26104",rows:[{hours:999}]});
  assert.equal(first.code,201);assert.equal(first.data.created.length,1);assert.equal(first.data.created[0].hours,7.5);
  const saved=JSON.parse(fs.readFileSync(path.join(root,"regie-reports.json")));assert.equal(saved[0].description,"");assert.equal(saved[0].employees.length,2);assert.equal(saved[0].status,"draft");
  const again=await call("POST /kristine/api/regie-reports/missing-hours",{jobId:"26104"});assert.equal(again.data.created.length,0);const tasks=JSON.parse(fs.readFileSync(path.join(root,"tasks.json")));assert.equal(tasks.length,1);assert.equal(tasks[0].status,"open");assert.match(tasks[0].title,/Regiebericht fehlt/);
  const finish=await call("POST /kristine/api/regie-reports/save",{...saved[0],finish:true});assert.equal(finish.code,400);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
