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

const leitstandSource=fs.readFileSync(require.resolve("../public/kristine.html"),"utf8");
const leitstandFunction=(name,next)=>leitstandSource.slice(leitstandSource.indexOf(`function ${name}(`),leitstandSource.indexOf(next,leitstandSource.indexOf(`function ${name}(`)+1)).replace(/\nasync $/,"\n");
for(const closed of [false,true])test(`Leitstand daily release keeps projects editable until monthly close: closed=${closed}`,async()=>{
  const dom=new JSDOM(leitstandSource),d=dom.window.document;
  const row={id:"one",type:"work",from:"07:00",to:"12:00",jobId:"26080",jobName:"Jansen"};
  const ctx=vm.createContext({document:d,masterEmployees:[{id:"clemens",name:"Clemens Krista"}],masterJobs:[{jobId:"26080",name:"Jansen"}],data:{states:{}},selectedControlEmployeeId:"",timeEditorMonthClosed:false,timeEditorSegments:[],timeEditorJobGroups:new Map(),timeEditorCopiedFrom:null,
    selectedWorkDate:()=>"2026-10-13",api:async()=>({released:true,monthClosed:closed,segments:[row]}),esc:String,statusLabel:()=>"Feierabend",populateTimeCopyEmployees:()=>{},jobOptionGroup:()=>"running",JOB_OPTION_GROUPS:[{key:"running",label:"Laufend"}],jobOptions:()=>'<option value="26080" selected>Jansen</option>',hmToMinutes:v=>{if(!v)return null;const [h,m]=v.split(":").map(Number);return h*60+m},durationText:n=>`${n} min`});
  for(const id of ["employeeActionTitle","employeeActionInfo","employeeActionNote","employeeActionBackdrop","timeEditorTable"])ctx[id]=d.getElementById(id);
  vm.runInContext(leitstandFunction("timeEditorContextCell","\nfunction renderTimeEditor"),ctx);
  vm.runInContext(leitstandFunction("renderTimeEditor","\nfunction commitTimeEditorTime"),ctx);
  vm.runInContext("async "+leitstandFunction("openEmployeeActionModal","\nasync function saveTimeEditor"),ctx);
  await ctx.openEmployeeActionModal("clemens");
  assert.equal(ctx.timeEditorMonthClosed,closed);
  assert.equal(d.getElementById("timeEditorActions").hidden,closed);
  assert.equal(d.getElementById("timeEditorCopyBar").hidden,closed);
  if(closed){assert.equal(d.querySelectorAll('[data-time-job-select]').length,0);assert.ok([...d.getElementById("timeEditorTable").querySelectorAll("input,select,button")].every(el=>el.disabled));assert.match(d.getElementById("employeeActionInfo").textContent,/Monatsabschluss/)}
  else{assert.equal(d.querySelector('[data-time-job-select]').value,"26080");assert.equal(d.querySelector('[data-time-job-select]').disabled,false);assert.match(d.getElementById("employeeActionInfo").textContent,/bis zum Monatsabschluss verbunden/);assert.doesNotMatch(d.getElementById("employeeActionInfo").textContent,/unabhängige KRISZEIT-Kopie/)}
  dom.window.close();
});
