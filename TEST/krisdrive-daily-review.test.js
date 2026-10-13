"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createDailyReview, mergeTasks } = require("../krisdrive-daily-review");
const day = stamp => new Intl.DateTimeFormat("sv-SE", {timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(stamp));
async function setup(t) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"daily-review-"));
  await fs.mkdir(path.join(dataDir,"_system"));
  await fs.writeFile(path.join(dataDir,"_system","employees.json"),JSON.stringify([{id:"alex",name:"Alexander Krista"},{id:"office",name:"Dunja"}]));
  let now=Date.parse("2026-10-13T06:00:00Z");
  const rows=[{vehicleId:"byd",id:"one",startedAt:"2026-10-12T07:00:00Z",closedAt:"2026-10-12T08:00:00Z",driver:{employeeId:"alex"},category:"private",distanceKm:4,odometerStartKm:100,odometerEndKm:104,missing:[]}];
  const options={dataDir,day,now:()=>now,collect:async()=>structuredClone(rows)};
  const service=createDailyReview(options);
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  return {dataDir,rows,service,options,advance:stamp=>now=Date.parse(stamp),alex:{id:"alex",name:"Alexander Krista"}};
}
test("one task per completed day across vehicles; today and old history do not flood the queue",async t=>{
 const h=await setup(t);h.rows.push({...h.rows[0],id:"two",vehicleId:"van"},{...h.rows[0],id:"today",startedAt:"2026-10-13T07:00:00Z"},{...h.rows[0],id:"old",startedAt:"2026-10-05T07:00:00Z"});
 const reviews=await h.service.update();assert.equal(reviews.length,1);assert.equal(reviews[0].count,2);
 await h.service.update();const tasks=await mergeTasks(h.dataDir,[{id:"unrelated",title:"Unrelated"}]);assert.equal(tasks.length,2);assert.equal(tasks[1].assigneeId,"alex");assert.equal(tasks[1].status,"open");
});
test("only Alex can approve a complete, unchanged day; approved state and snapshot survive restart",async t=>{
 const h=await setup(t);const [r]=await h.service.update();
 await assert.rejects(h.service.approve(r.date,r.fingerprint,{id:"office",name:"Dunja"}),{status:403});
 await assert.rejects(h.service.approve(r.date,"stale",h.alex),{status:409});
 const approved=await h.service.approve(r.date,r.fingerprint,h.alex);assert.equal(approved.status,"approved");
 const restarted=createDailyReview(h.options);assert.equal((await restarted.update())[0].status,"approved");
 const state=JSON.parse(await fs.readFile(path.join(h.dataDir,"_kristine","vehicle-tracking","daily-reviews.json")));assert.equal(state.history[0].snapshot[0].distanceKm,4);
 assert.equal((await mergeTasks(h.dataDir,[]))[0].status,"done");
});
test("missing information blocks approval; edits and late trips reopen the same task",async t=>{
 const h=await setup(t);h.rows[0].missing=["Fahrer"];let [r]=await h.service.update();await assert.rejects(h.service.approve(r.date,r.fingerprint,h.alex),{status:409});
 h.rows[0].missing=[];[r]=await h.service.update();await h.service.approve(r.date,r.fingerprint,h.alex);
 h.rows[0].distanceKm=5;[r]=await h.service.update();assert.equal(r.status,"open");await h.service.approve(r.date,r.fingerprint,h.alex);
 h.rows.push({...h.rows[0],id:"late"});[r]=await h.service.update();assert.equal(r.status,"open");assert.equal(r.count,2);assert.equal((await mergeTasks(h.dataDir,[])).length,1);
});
test("task deletion or a generic done flag cannot override daily approval; unrelated tasks survive",async t=>{
 const h=await setup(t);await h.service.update();const task=(await mergeTasks(h.dataDir,[]))[0];
 const tasks=await mergeTasks(h.dataDir,[{...task,status:"done"},{id:"unrelated",status:"done"}]);assert.equal(tasks.length,2);assert.equal(tasks.find(t=>t.id===task.id).status,"open");
 assert.equal(tasks.find(t=>t.id==="unrelated").status,"done");
});
test("next morning creates the next day without duplicating an earlier open task",async t=>{
 const h=await setup(t);await h.service.update();h.rows.push({...h.rows[0],id:"today",startedAt:"2026-10-13T07:00:00Z"});h.advance("2026-10-14T06:00:00Z");const rows=await h.service.update();assert.equal(rows.length,2);assert.equal((await mergeTasks(h.dataDir,[])).length,2);
});
test("ambiguous Alex and corrupt state fail rather than assign a guessed recipient or erase data",async t=>{
 const h=await setup(t);await h.service.update();const file=path.join(h.dataDir,"_kristine","vehicle-tracking","daily-reviews.json");await fs.writeFile(file,'{"broken":true}');await assert.rejects(h.service.update(),/Invalid daily/);assert.equal(await fs.readFile(file,"utf8"),'{"broken":true}');
 await fs.rm(file);await fs.writeFile(path.join(h.dataDir,"_system","employees.json"),JSON.stringify([{id:"a",name:"Alexander Krista"},{id:"b",name:"Alex Krista"}]));await assert.rejects(h.service.update(),{status:409});
});
