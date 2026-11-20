"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const billing=require("../public/ui/regie-billing-state.js");
const source=fs.readFileSync(path.join(__dirname,"../public/ui/tower-baustellen-signals.js"),"utf8");
const start=source.indexOf("  function pickCloudRegieReports(items,cutoff){");
const end=source.indexOf("  const cloudRegieCache=new Map();",start);
assert(start>=0&&end>start,"Project-document fallback missing");
const sandbox={window:{KristaRegieBilling:billing}};
vm.runInNewContext(source.slice(start,end),sandbox);
const pick=sandbox.pickCloudRegieReports;
test("Lagant 26096: 13 offene Projektaktenberichte nicht zu null reduzieren",()=>{
 const items=Array.from({length:13},(_,i)=>({
  id:"report"+i,type:"regie_report",reportNumber:"26096"+String(i+1).padStart(3,"0"),
  reportDate:"2026-11-"+String(i+7).padStart(2,"0"),
  source:"WW",billingStatus:"open",totalHours:i===12?19.25:17.5,
  totalNet:i===12?1019:1590.75,
 }));
 const selected=pick(items,"2026-11-19");
 assert.equal(selected.length,13);
 assert.equal(selected.filter(r=>r.billingStatus==="open").length,13);
 assert(selected.every(r=>r.type==="regie_report"));
 assert(selected.reduce((s,r)=>s+r.totalNet,0)>10000);
});
test("Heutige Berichte und sonstige Projektdateien verändern den Abrechnungsstand nicht",()=>{
 const items=[
  {type:"regie_report",reportNumber:"26096001",sourceId:"r1",reportDate:"2026-11-19",totalNet:100,totalHours:1},
  {type:"regie_report",reportNumber:"26096001",sourceId:"r1",reportDate:"2026-11-19",totalNet:100,totalHours:1},
  {type:"regie_report",reportNumber:"26096002",sourceId:"r2",reportDate:"2026-11-20",totalNet:200,totalHours:2},
  {type:"mail",reportNumber:"x",totalNet:2000,totalHours:20},
 ];
 const rows=pick(items,"2026-11-19");
 assert.equal(rows.length,1);
 assert.equal(rows[0].totalNet,100);
 assert.throws(()=>pick(null,"2026-11-19"),/unvollständig/);
});
