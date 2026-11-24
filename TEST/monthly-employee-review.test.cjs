"use strict";
const assert=require("node:assert/strict"),fsp=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {registerKristine}=require("../kristine"),policy=require("../monthly-payroll-model");
const row=(days,from,to,extra={})=>({days,from,to,...extra});
const model=(id,targets,fixed=null)=>({id,name:id,officeModel:id!=="krista-standard",configured:true,blocks:{finkTarget:{rows:targets},finkFixed:{enabled:fixed!==null,rows:fixed||[]}}});
(async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),"monthly-review-")),dir=path.join(root,"_kristine");await fsp.mkdir(dir);await fsp.mkdir(path.join(root,"_system"));
 const employees=[{id:"a",name:"Alexander Krista",worktimeModelId:"krista-standard",employmentPercent:40},{id:"d",name:"Dunja Türtscher",worktimeModelId:"krista-standard",employmentPercent:20},{id:"g",name:"Gerald Gruber",worktimeModelId:"krista-standard",employmentPercent:13},{id:"j",name:"Judith Krista",worktimeModelId:"krista-standard",employmentPercent:50},{id:"b",name:"Bettina Eberle-Nigsch",worktimeModelId:"krista-standard",employmentPercent:40},{id:"p",name:"Produktiver Mitarbeiter",worktimeModelId:"krista-standard"},{id:"c",name:"Cathrin Grabherr",personnelNumber:"276",worktimeModelId:"krista-standard"}];
 const alex=[row([1,2,3,4,5],"07:00","15:48",{lunchFrom:"12:00",lunchTo:"14:00",activityLabel:"Baustelle ≥ 120 km"})];
 const models=[model("krista-standard",[row([1,2,3,4],"07:00","16:15"),row([5],"07:00","14:15")]),model("office-alex",alex,alex),model("office-dunja",[row([1,4],"08:00","12:00")]),model("office-geri",[row([2,4],"14:30","17:00")],[row([2,4],"14:30","17:00",{activityLabel:"Werkstatt",activityCode:"913"})]),model("office-judith",[row([1,5],"08:00","17:30",{lunchFrom:"12:00",lunchTo:"13:30"}),row([2],"08:00","12:00")],[row([1,5],"08:00","17:30",{lunchFrom:"12:00",lunchTo:"13:30",activityLabel:"Büro"}),row([2],"08:00","12:00",{activityLabel:"Büro"})]),model("office-bettina",[row([1,2,3,4,5],"08:00","11:12")])];
 await fsp.writeFile(path.join(root,"_system","worktime-models.json"),JSON.stringify(models));await fsp.writeFile(path.join(root,"_system","holidays.json"),JSON.stringify([{date:"2026-10-26",name:"Nationalfeiertag"}]));
 await fsp.writeFile(path.join(dir,"time-events.json"),JSON.stringify([{employeeId:"a",date:"2026-10-05",type:"up",at:"07:00",actualAt:"05:54",reason:"Büro"},{employeeId:"a",date:"2026-10-05",type:"ende",at:"12:34"},{employeeId:"b",date:"2026-10-06",type:"up",at:"07:30",reason:"Büro"},{employeeId:"b",date:"2026-10-06",type:"ende",at:"12:00"},{employeeId:"d",date:"2026-10-05",type:"up",at:"08:00",reason:"Büro"},{employeeId:"d",date:"2026-10-05",type:"ende",at:"12:00"}]));
 await fsp.writeFile(path.join(dir,"day-releases.json"),JSON.stringify([{employeeId:"a",date:"2026-10-05",released:true},{employeeId:"b",date:"2026-10-06",released:true},{employeeId:"d",date:"2026-10-05",released:true}]));
 const routes=new Map(),app={};for(const method of ["get","post","put","patch","delete"])app[method]=(url,fn)=>routes.set(method+" "+url,fn);
 let authorized=true;const instance=registerKristine(app,{dataDir:root,publicDir:root,requireAdmin:(req,res)=>{if(!authorized)res.status(403).json({error:"forbidden"});return authorized},readEmployees:async()=>employees});
 const call=async(method,url,{params={},query={},body={}}={})=>{const res={statusCode:200,status(n){this.statusCode=n;return this},json(b){this.body=b;return this}};await routes.get(method+" "+url)({params,query,body},res);return res};
 const days=async id=>(await call("get","/kristine/api/monthly-days/:employeeId",{params:{employeeId:id},query:{from:"2026-10-01",to:"2026-10-31"}})).body.days;
 try{
 await instance.startupReady;
 let a=await days("a");assert.equal(a.find(d=>d.date==="2026-10-05").targetMinutes,396);assert.equal(policy.workMinutes(a.find(d=>d.date==="2026-10-05").segments),396);assert.deepEqual(a.find(d=>d.date==="2026-10-05").segments.map(s=>[s.type,s.from,s.to]),[["up","07:00","13:36"]]);assert.equal(policy.workMinutes(a.find(d=>d.date==="2026-10-26").segments),0,"holiday is paid, never worked");
 const {vacationEntitlement}=require("../vacation-entitlement");
 const hired={employmentStart:"2006-11-20",vacationPriorServiceMonths:84,vacationPriorServiceConfirmed:true};
 assert.equal(vacationEntitlement(hired,"2026-11-19").monthlyDays,25/12);
 assert.equal(vacationEntitlement(hired,"2026-11-20").monthlyDays,2.5);
 assert.equal(vacationEntitlement({...hired,vacationPriorServiceConfirmed:false},"2026-11-20").annualDays,25);
 assert.equal(vacationEntitlement({...hired,vacationPriorServiceOverFive:false},"2026-11-20").annualDays,25);
 assert.equal(vacationEntitlement({employmentStart:hired.employmentStart,vacationPriorServiceOverFive:true},"2026-11-20").annualDays,30);
 assert.equal(vacationEntitlement({},"2026-11-20"),null);
 const october=Array.from({length:31},(_,i)=>"2026-10-"+String(i+1).padStart(2,"0"));
 const monthlyTarget=e=>october.reduce((n,date)=>n+policy.schedule(models,e,date).targetMinutes,0);
 assert.equal(monthlyTarget(employees[0]),145*60+12);
 assert.equal(monthlyTarget(employees[4]),73*60+20);
 assert.equal((await days("b")).find(d=>d.date==="2026-10-26").targetMinutes,200);
 assert.equal(monthlyTarget(employees[2]),22*60+30);
 assert.equal(monthlyTarget(employees[3]),88*60);
 for(const personnelNumber of ["20","39"]){
   const employee={personnelNumber,worktimeModelId:"krista-standard"};
   assert.equal(monthlyTarget(employee),173*60);
   assert.equal(policy.schedule(models,employee,"2026-10-01").contractOvertimeWeekMinutes,60);
 }
 const cathrin=await call("get","/kristine/api/monthly-days/:employeeId",{params:{employeeId:"c"},query:{from:"2026-10-01",to:"2026-10-31"}});
 assert.equal(cathrin.body.balances.newVacation,8.17);assert.equal(cathrin.body.balances.newTime,50.61);
 for(const date of ["2026-10-12","2026-10-13"]){const day=cathrin.body.days.find(d=>d.date===date);assert.equal(day.segments[0].unproductiveCode,"901");assert.equal(day.released,true);assert.equal(policy.workMinutes(day.segments),0);}
 const holiday=(await days("p")).find(d=>d.date==="2026-10-26");
 assert.equal(holiday.released,true);
 assert.equal(holiday.segments[0].unproductiveCode,"904");
 assert.equal(policy.minute(holiday.segments[0].to)-policy.minute(holiday.segments[0].from),holiday.targetMinutes);
 assert.equal(holiday.workingMinutes,0);
 const d=await days("d");assert.equal(d.find(d=>d.date==="2026-10-05").targetMinutes,240);assert.equal(d.find(d=>d.date==="2026-10-06").targetMinutes,0);assert.equal(d.find(d=>d.date==="2026-10-08").targetMinutes,240);
 const g=await days("g");assert.equal(g.find(d=>d.date==="2026-10-06").targetMinutes,150);assert.equal(g.find(d=>d.date==="2026-10-05").targetMinutes,0);assert.equal(policy.workMinutes(g.find(d=>d.date==="2026-10-06").segments),150);
 const j=await days("j");assert.equal(j.find(d=>d.date==="2026-10-05").targetMinutes,480);assert.equal(j.find(d=>d.date==="2026-10-06").targetMinutes,240);assert.equal(j.find(d=>d.date==="2026-10-08").targetMinutes,0);
 const b=await days("b");assert.equal(b.find(d=>d.date==="2026-10-06").segments[0].from,"07:30");assert.equal(policy.workMinutes(b.find(d=>d.date==="2026-10-06").segments),270);
 const workBlock={id:"morning",type:"work",from:"07:00",to:"12:00",jobId:"123"};
 const withPause=policy.withMorningPause([workBlock]);
 assert.deepEqual(withPause.map(s=>[s.type,s.from,s.to]),[["work","07:00","09:00"],["pause","09:00","09:15"],["work","09:15","12:00"]]);
 assert.equal(policy.workMinutes(withPause),285);
 assert.deepEqual(policy.withMorningPause(withPause),withPause);
 assert.equal(policy.workMinutes(b.find(d=>d.date==="2026-10-06").segments),270,"office bookings keep their full duration");
 assert.equal(policy.modelFor(models,employees[5]).id,"krista-standard");assert.equal(policy.modelFor(models,{...employees[0],worktimeModelId:"office-judith"}).id,"office-judith","explicit dedicated assignment wins");
 const makeReport=rows=>({employeeId:"a",name:"Alex",days:rows.map(d=>({date:d.date,actualMinutes:d.segments.filter(s=>["up","work"].includes(s.type)).reduce((sum,s)=>sum+policy.minute(s.to)-policy.minute(s.from),0)})),totals:{actualMinutes:rows.reduce((sum,d)=>sum+d.segments.filter(s=>["up","work"].includes(s.type)).reduce((n,s)=>n+policy.minute(s.to)-policy.minute(s.from),0),0)}});
 let res=await call("post","/kristine/api/month-close",{body:{month:"2026-10",people:[makeReport(a)]}});assert.equal(res.statusCode,200,JSON.stringify(res.body));
 const frozen=await fsp.readFile(path.join(dir,"month-closures.json"),"utf8");
 res=await call("put","/kristine/api/monthly-payroll/:employeeId/:date",{params:{employeeId:"a",date:"2026-10-05"},body:{reason:"Test Korrektur",segments:[]}});assert.equal(res.statusCode,409);
 for(const body of [{employeeId:"a",month:"2026-10",reason:"",reviewer:"Bettina",acknowledge:true},{employeeId:"a",month:"2026-10",reason:"Prüfung der Zeiten",reviewer:"Bettina"}]){res=await call("post","/kristine/api/month-reopen",{body});assert.equal(res.statusCode,400);assert.equal(await fsp.readFile(path.join(dir,"month-closures.json"),"utf8"),frozen)}
 authorized=false;res=await call("post","/kristine/api/month-reopen",{body:{employeeId:"a",month:"2026-10",reason:"Prüfung der Zeiten",reviewer:"Bettina",acknowledge:true}});assert.equal(res.statusCode,403);authorized=true;
 res=await call("post","/kristine/api/month-reopen",{body:{employeeId:"a",month:"2026-10",reason:"Prüfung der Zeiten",reviewer:"Bettina",acknowledge:true}});assert.equal(res.statusCode,200);
 const history=JSON.parse(await fsp.readFile(path.join(dir,"month-reopenings.json"),"utf8"));assert.equal(history.length,1);assert.equal(history[0].previousClosure.report.totals.actualMinutes,makeReport(a).totals.actualMinutes);assert.equal(history[0].reviewer,"Bettina");
 const projectsBefore=await fsp.readFile(path.join(dir,"project-time-archive.json"),"utf8");
 res=await call("put","/kristine/api/monthly-payroll/:employeeId/:date",{params:{employeeId:"a",date:"2026-10-05"},body:{reason:"Zeiten laut Kontrolle berichtigt",segments:[{type:"up",from:"08:00",to:"12:00",reason:"Büro"}]}});assert.equal(res.statusCode,200);
 a=await days("a");assert.equal(policy.workMinutes(a.find(d=>d.date==="2026-10-05").segments),240);
 res=await call("post","/kristine/api/month-close",{body:{month:"2026-10",people:[makeReport(a)]}});assert.equal(res.statusCode,200,JSON.stringify(res.body));
 assert.equal(await fsp.readFile(path.join(dir,"project-time-archive.json"),"utf8"),projectsBefore,"reopening/correcting/reclosing payroll never rewrites project times");
 console.log("PASS: correct five office models, fixed payroll with breaks, UP Von/Bis, holidays, no double part-time factor, closure lock, required acknowledgment/reason/admin, full prior snapshot and isolated corrections");
 }finally{await fsp.rm(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
