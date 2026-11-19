"use strict";
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),assert=require("node:assert/strict"),helpers=require("../holiday-calendar");
(async()=>{
 const first={from:"2026-12-07",to:"2026-12-07",reason:"Brueckentag"},winter={from:"2026-12-23",to:"2027-01-08",reason:"Betriebsurlaub"};
 assert.equal(helpers.mergeCompanyVacationRows([first],[winter]).length,2);
 assert.deepEqual(helpers.mergeCompanyVacationRows([first,winter],[],[first]),[winter]);
 const source=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8"),start=source.indexOf("let companyVacationWriteQueue ="),end=source.indexOf('app.get("/admin/api/worktime-models"',start),routes=new Map();let stored=[first];
 const context={app:{put:(p,h)=>routes.set(p,h)},requireAdmin:()=>true,require:()=>helpers,cleanCompanyVacationRows:x=>Array.isArray(x)?x:[],readJsonArrayFile:async()=>JSON.parse(JSON.stringify(stored)),writeJsonArrayFile:async(p,x)=>{await Promise.resolve();stored=x},companyVacationsPath:()=>"test"};
 vm.runInNewContext(source.slice(start,end),context);
 async function call(body){const res={code:200,status(v){this.code=v;return this},json(v){this.body=v;return this}};await routes.get("/kristine/api/company-vacations")({body},res);return res}
 assert.equal((await call({})).code,400);
 await Promise.all([call({vacations:[winter]}),call({vacations:[{from:"2027-08-01",to:"2027-08-14",reason:"Sommer"}]})]);assert.equal(stored.length,3);await call({vacations:[],deletedRanges:[first]});assert.equal(stored.length,2);
 const html=fs.readFileSync(path.join(__dirname,"../public/kristine.html"),"utf8");
 const names=["addHoliday","addCompanyVacation","saveHolidaysData","saveCompanyVacationsData","planningClosures","planningClosuresHtml","isModelFreeDay","dailySollHours","emptyPlanningCellHtml","sharedCalendarNoticesHtml"];
 const code=html.split(/\r?\n/).filter(line=>names.some(name=>line.startsWith("function "+name+"(")||line.startsWith("async function "+name+"("))).join("\n");assert.equal(code.split("\n").length,names.length);
 let planRenders=0;const opened=[],c={data:{holidays:[],companyVacations:[first],assignments:[]},hDate:{value:"2026-12-31"},hName:{value:"Silvester"},cvFrom:{value:winter.from},cvTo:{value:winter.to},cvReason:{value:winter.reason},alert:s=>{throw Error(s)},document:{getElementById:()=>({classList:{add:x=>opened.push(x)}})},renderHolidays(){},renderCompanyVacations(){},renderPlanning(){planRenders++},renderAnnualProductivePlanning(){},setSavedNote(){},esc:String,worktimeRule:()=>({targetHours:9.25,free:false}),employeeAnnualNotices:()=>[],siteStartNotices:()=>[],api:async(url,opt)=>{const b=JSON.parse(opt.body);return url.endsWith("holidays")?{holidays:helpers.mergeHolidayRows([],b.holidays,b.deletedDates)}:{vacations:helpers.mergeCompanyVacationRows([first],b.vacations,b.deletedRanges)}}};
 vm.runInNewContext(code,c);await c.saveCompanyVacationsData();assert.equal(c.data.companyVacations.length,2);assert.equal(c.cvFrom.value,"");assert.equal(opened[0],"open");assert.equal(c.dailySollHours("edi","2026-12-28"),0);assert.equal(c.dailySollHours("edi","2026-12-11"),9.25);assert.equal(c.isModelFreeDay("edi","2026-12-07"),true);assert(c.emptyPlanningCellHtml("2026-12-28","edi").includes("Betriebsurlaub"));assert(c.sharedCalendarNoticesHtml("2026-12-28").includes("Betriebsurlaub"));
 await c.saveHolidaysData();assert(c.data.holidays.some(x=>x.date==="2026-12-31"));assert.equal(planRenders,2);assert(c.planningClosuresHtml("2026-12-31").includes("Silvester"));
 console.log("PASS: vacation stale/concurrent preservation and explicit deletion, pending form fields saved, settings stay open, day/week/month closure notices, zero available planning hours without changing regular workdays");
})().catch(e=>{console.error(e);process.exitCode=1});
