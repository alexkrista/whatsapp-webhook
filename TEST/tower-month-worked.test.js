"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const B=require("../public/ui/regie-billing-state.js");
const src=fs.readFileSync(require("node:path").join(__dirname,"../public/ui/tower-baustellen-signals.js"),"utf8");
const ctx={window:{KristaRegieBilling:B},location:{search:""},URLSearchParams,URL,Intl,Date,Map,Set};
vm.createContext(ctx);
vm.runInContext(src.replace("  if(document.readyState==='loading')", "  window.testMonth={monthRows,buildLiveMap,applyBillingSnapshot,currentMonth}; return;\n  if(document.readyState==='loading')"),ctx);
const api=ctx.window.testMonth,month=api.currentMonth(),day=month+"-02";
const jobs=[{jobId:"1",name:"Offen",calculation:{kristaAmount:1000,fixedCalculatedHours:10,actualHours:5}},{jobId:"2",name:"Fertig"},{jobId:"3",name:"Alt"},{jobId:"4",name:"Entwurf"}];
api.buildLiveMap({today:month+"-22",projectTimeArchive:[{employeeId:"a",date:day,segments:[{type:"work",jobId:"1",from:"07:00",to:"09:00"}]}]});
const billingByProject={
 "1":{summary:{recordedHoursNet:3,recordedMonthHoursNet:1,billedNet:100},invoices:[{status:"issued",kind:"TR",net:100}]},
 "2":{summary:{recordedHoursNet:10,recordedMonthHoursNet:2,billedNet:900},invoices:[{status:"issued",kind:"SR",net:900}]},
 "3":{summary:{recordedHoursNet:9,recordedMonthHoursNet:0,billedNet:100},invoices:[]},
 "4":{summary:{recordedHoursNet:1,recordedMonthHoursNet:1,billedNet:0},invoices:[{status:"draft",kind:"RE",net:100}]}
};
api.applyBillingSnapshot({ready:true,month,billingByProject});
let rows=api.monthRows(jobs);
assert.equal(rows.length,3);
assert.equal(rows.find(r=>r.job.jobId==="1").monthHours,2.75);
assert.equal(rows.find(r=>r.job.jobId==="1").invoiced,false);
assert.equal(rows.find(r=>r.job.jobId==="1").open,400);
assert.equal(rows.find(r=>r.job.jobId==="2").invoiced,true);
assert.equal(rows.find(r=>r.job.jobId==="2").open,0);
assert.equal(rows.find(r=>r.job.jobId==="2").billed,900);
assert.equal(rows.find(r=>r.job.jobId==="4").invoiced,false);
api.applyBillingSnapshot({ready:true,month:"2000-01",billingByProject});
rows=api.monthRows(jobs);
assert.equal(rows.length,1);
assert.equal(rows[0].open,null);
assert.equal(rows[0].billed,null);
console.log("OK month selection, archive hours, partial/final/draft invoices and stale snapshot");
