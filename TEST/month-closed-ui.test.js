"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const {JSDOM}=require("jsdom");
const source=fs.readFileSync(require.resolve("../public/kristool-preview/kristool.js"),"utf8");
const extract=name=>{const start=source.indexOf(`function ${name}(`),end=source.indexOf("\nfunction ",start+1);return source.slice(start,end)};
test("closed Kriszeit displays fixed times without project assignments or editing controls",()=>{
  const dom=new JSDOM('<div id="kristineSegments"></div><div id="kristineTotal"></div><div id="checkKristine"></div><div id="correctionToolbar"></div><div id="segmentActions"></div><div id="correctionHistory"></div><div id="teamTransfer"></div>');
  const state={monthClosed:true,segments:[{type:"work",from:"07:00",to:"12:00",jobName:"Jansen"},{type:"lunch",from:"12:00",to:"12:30"},{type:"work",from:"12:30",to:"16:00",jobName:"Andere Baustelle"}]};
  const ctx=vm.createContext({state,$:id=>dom.window.document.getElementById(id),esc:String,segmentLabel:t=>({work:"Arbeit",lunch:"Mittag"})[t],minutes:v=>{const [h,m]=v.split(":").map(Number);return h*60+m},durationLabel:n=>`${n} min`,workMinutes:()=>510});
  vm.runInContext(extract("renderSegments"),ctx);vm.runInContext("renderSegments()",ctx);
  const d=dom.window.document;
  assert.match(d.getElementById("kristineSegments").textContent,/Monat abgeschlossen/);
  assert.match(d.getElementById("kristineSegments").textContent,/12:00–12:30Mittag/);
  assert.doesNotMatch(d.body.textContent,/Jansen|Andere Baustelle/);
  assert.equal(d.querySelectorAll("input,select,button").length,0);
  for(const id of ["correctionToolbar","segmentActions","correctionHistory","teamTransfer"])assert.equal(d.getElementById(id).hidden,true);
  vm.runInContext(extract("scheduleCorrectionSave"),ctx);vm.runInContext("scheduleCorrectionSave()",ctx); // no timer / automatic write after closure
  dom.window.close();
});
