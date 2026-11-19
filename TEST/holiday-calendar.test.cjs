"use strict";
const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict");
const {mergeHolidayRows,annualCompanyHolidays}=require("../holiday-calendar");
(async()=>{
 const a={date:"2026-01-01",name:"Neujahr"},b={date:"2027-01-01",name:"Neujahr"},custom={date:"2027-02-02",name:"Betrieb frei"};
 let rows=mergeHolidayRows([a,b,custom],[a,{date:"2026-12-24",name:"Heiliger Abend"}]);assert(rows.some(x=>x.date===b.date));assert(rows.some(x=>x.date===custom.date));
 rows=mergeHolidayRows(rows,[],[custom.date]);assert(!rows.some(x=>x.date===custom.date));assert(rows.some(x=>x.date===b.date));
 for(const year of [2026,2027,2028,2035,2100])for(const day of ["12-24","12-31"])assert(rows.some(x=>x.date===year+"-"+day));
 assert(!annualCompanyHolidays().some(x=>x.date.startsWith("2025-")));assert.equal(new Set(rows.map(x=>x.date)).size,rows.length);
 const source=fs.readFileSync(require("node:path").join(__dirname,"../server.js"),"utf8"),start=source.indexOf("let holidayWriteQueue ="),end=source.indexOf('app.get("/kristine/api/company-vacations"',start),routes=new Map();let stored=[a,b,custom];
 const app={get:(p,h)=>routes.set("get "+p,h),put:(p,h)=>routes.set("put "+p,h),post:(p,h)=>routes.set("post "+p,h)};
 const context={app,requireAdmin:()=>true,require:()=>({mergeHolidayRows}),cleanHolidayRows:x=>x||[],readJsonArrayFile:async()=>JSON.parse(JSON.stringify(stored)),writeJsonArrayFile:async(p,r)=>{await Promise.resolve();stored=r},holidaysPath:()=>"test",validDateISO:v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v)),austrianHolidays:y=>[{date:y+"-01-01",name:"Generated"}]};
 vm.runInNewContext(source.slice(start,end),context);
 async function call(method,body){const res={code:200,status(v){this.code=v;return this},json(v){this.body=v;return this}};await routes.get(method+" /kristine/api/holidays")({body},res);return res}
 assert.equal((await call("put",{})).code,400);assert.equal(stored.length,3);
 await call("put",{holidays:[a]});assert(stored.some(x=>x.date===b.date));assert(stored.some(x=>x.date===custom.date));
 await Promise.all([call("put",{holidays:[{date:"2027-02-03",name:"First"}]}),call("put",{holidays:[{date:"2027-02-04",name:"Second"}]})]);assert(stored.some(x=>x.name==="First"));assert(stored.some(x=>x.name==="Second"));
 const reload={status(){return this},json(v){this.body=v}};await routes.get("post /kristine/api/holidays/reload-austrian")({body:{year:2027}},reload);assert(stored.some(x=>x.date===custom.date));assert.equal(stored.find(x=>x.date===b.date).name,"Neujahr");
 await call("put",{holidays:[],deletedDates:[custom.date]});assert(!stored.some(x=>x.date===custom.date));
 console.log("PASS: stale browser and cross-year preservation, explicit deletion, simultaneous writes, manual days retained on reload, invalid payload protection, recurring 24/31 December for future years");
})().catch(e=>{console.error(e);process.exitCode=1});
