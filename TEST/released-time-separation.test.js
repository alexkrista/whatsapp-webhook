"use strict";
const assert=require("node:assert/strict"),fsp=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {registerKristine}=require("../kristine");
const {createEngine}=require("../public/ui/baustellen-hours-core");
const checks={times:true,regie:true,close:true,diet:true,fl:true,ch:true};
function harness(){const routes=new Map(),app={};for(const method of ["get","post","put","patch","delete"])app[method]=(route,handler)=>routes.set(`${method.toUpperCase()} ${route}`,handler);return{app,routes}}
async function invoke(handler,{params={},body={},query={}}={}){const res={statusCode:200,body:null,status(code){this.statusCode=code;return this},json(body){this.body=body;return this}};await handler({params,body,query},res);return res}
(async()=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),"month-time-separation-")),root=path.join(temp,"_kristine");await fsp.mkdir(root,{recursive:true});
  const params={employeeId:"139",date:"2026-09-08"},jobs=[{jobId:"26080",name:"Jansen"},{jobId:"26081",name:"Andere"}];
  await fsp.writeFile(path.join(root,"time-events.json"),JSON.stringify([
    {...params,employeeName:"Cathrin",type:"start",at:"07:00",jobId:"26080",jobName:"Jansen"},
    {...params,employeeName:"Cathrin",type:"ende",at:"16:00",jobId:"26080",jobName:"Jansen"}
  ]));
  const {app,routes}=harness(),instance=registerKristine(app,{dataDir:temp,publicDir:temp,requireAdmin:()=>true,readEmployees:async()=>[{id:"139",name:"Cathrin",personnelNumber:"139"},{id:"140",name:"Nicht freigegeben"}]});
  const call=(name,options)=>invoke(routes.get(name),options),read=file=>fsp.readFile(path.join(root,file),"utf8").then(JSON.parse);
  try{
    await instance.startupReady;
    let res=await call("PUT /kristine/api/day-release/:employeeId/:date",{params,body:{employeeName:"Cathrin",reviewer:"Bettina",checks}});
    assert.equal(res.statusCode,200);
    assert((await read("time-events.json")).every(row=>row.jobId==="26080"),"Daily release must retain project assignments");
    let personal=await call("GET /kristine/api/segments/:employeeId/:date",{params});
    assert.equal(personal.body.timeSeparated,false);assert.equal(personal.body.segments[0].jobId,"26080");
    const edit={employeeName:"Cathrin",segments:[{id:"a",type:"work",from:"08:00",to:"14:00",jobId:"26081",jobName:"Andere"}]};
    res=await call("PUT /kristine/api/segments/:employeeId/:date",{params,body:edit,query:{scope:"project"}});
    assert.equal(res.statusCode,200);assert.equal((await read("project-time-archive.json"))[0].segments[0].jobId,"26081");
    personal=await call("GET /kristine/api/segments/:employeeId/:date",{params});assert.equal(personal.body.segments[0].from,"08:00");assert.equal(personal.body.segments[0].jobId,"26081");
    let bootstrap=(await call("GET /kristine/api/bootstrap")).body;
    assert.equal(bootstrap.projectTimeEvents.filter(row=>row.jobId==="26081").length,2);
    let snapshot=createEngine({jobs,bootstrap}).snapshot();assert.equal(snapshot.byJob["26081"].kristine,5.75,"Shared time counted once with existing 15-minute deduction");
    const makeReport=(employeeId,minutes)=>({employeeId,name:employeeId==="139"?"Cathrin":"Nicht freigegeben",days:Array.from({length:30},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,"0")}`,actualMinutes:i===7?minutes:0})),totals:{actualMinutes:minutes}});
    const report=makeReport("139",360);
    // Closing is all-or-nothing and rejects unfinished months/unreleased days.
    res=await call("POST /kristine/api/month-close",{body:{month:"2099-01",people:[{employeeId:"139"}]}});assert.equal(res.statusCode,400);
    const events=await read("time-events.json");events.push({employeeId:"140",date:params.date,type:"start",at:"07:00",jobId:"26080"},{employeeId:"140",date:params.date,type:"ende",at:"08:00"});await fsp.writeFile(path.join(root,"time-events.json"),JSON.stringify(events));
    res=await call("POST /kristine/api/month-close",{body:{month:"2026-09",people:[report,makeReport("140",60)]}});assert.equal(res.statusCode,409);
    await assert.rejects(read("month-closures.json"),{code:"ENOENT"});
    res=await call("POST /kristine/api/month-close",{body:{month:"2026-09",people:[makeReport("139",0)]}});assert.equal(res.statusCode,409,"Stale overview must not freeze a wrong payroll report");
    res=await call("POST /kristine/api/month-close",{body:{month:"2026-09",people:[report]}});assert.equal(res.statusCode,200,JSON.stringify(res.body));
    const closedEvents=(await read("time-events.json")).filter(row=>row.employeeId==="139");assert(closedEvents.every(row=>!row.jobId&&row.detachedFromProject));
    personal=await call("GET /kristine/api/segments/:employeeId/:date",{params});assert.equal(personal.body.monthClosed,true);assert.equal(personal.body.segments[0].jobId,"");assert.equal(personal.body.segments[0].from,"08:00");
    res=await call("PUT /kristine/api/segments/:employeeId/:date",{params,body:edit});assert.equal(res.statusCode,409);
    res=await call("PUT /kristine/api/day-release/:employeeId/:date",{params,body:{reviewer:"Bettina",checks}});assert.equal(res.statusCode,409);
    res=await call("POST /kristine/api/day-control/:date/return",{params:{date:params.date},body:{employeeId:"139"}});assert.equal(res.statusCode,409);
    const projectEdit={...edit,segments:[{id:"b",type:"work",from:"09:00",to:"12:00",jobId:"26080",jobName:"Jansen"}]};
    res=await call("PUT /kristine/api/segments/:employeeId/:date",{params,body:projectEdit,query:{scope:"project"}});assert.equal(res.statusCode,200);
    assert.deepEqual((await read("time-events.json")).filter(row=>row.employeeId==="139"),closedEvents,"Project edit must never affect closed payroll");
    personal=await call("GET /kristine/api/segments/:employeeId/:date",{params});assert.equal(personal.body.segments[0].from,"08:00");
    const project=await call("GET /kristine/api/segments/:employeeId/:date",{params,query:{scope:"project"}});assert.equal(project.body.segments[0].from,"09:00");assert.equal(project.body.segments[0].jobId,"26080");
    bootstrap=(await call("GET /kristine/api/bootstrap")).body;assert(bootstrap.projectTimeEvents.some(row=>row.employeeId==="139"&&row.jobId==="26080"),"Closed project bookings remain visible");
    assert((await read("project-time-archive.json"))[0].history.some(row=>row.source==="project_correction_after_month_close"));
    res=await call("POST /kristine/api/month-close",{body:{month:"2026-09",people:[{...report,name:"Changed"}]}});assert.equal(res.statusCode,200);assert.equal(res.body.closures.length,1);assert.equal(res.body.closures[0].report.name,"Cathrin","Repeated close must not replace fixed report");
    // Deleting project blocks affects only project totals, even after restart.
    res=await call("PUT /kristine/api/segments/:employeeId/:date",{params,query:{scope:"project"},body:{employeeName:"Cathrin",segments:[]}});assert.equal(res.statusCode,200);
    const again=harness(),restarted=registerKristine(again.app,{dataDir:temp,publicDir:temp,requireAdmin:()=>true,readEmployees:async()=>[{id:"139",name:"Cathrin"}]});await restarted.startupReady;
    const after=await invoke(again.routes.get("GET /kristine/api/segments/:employeeId/:date"),{params,query:{scope:"project"}});assert.deepEqual(after.body.segments,[],"Restart must not resurrect deleted project blocks");
    console.log("OK: Daily release shares time; monthly close fixes payroll; project bookings remain visible and editable independently.");
  }finally{await fsp.rm(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
