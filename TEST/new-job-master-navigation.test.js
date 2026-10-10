"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const { JSDOM }=require("jsdom");

test("Neue Baustelle führt nach erfolgreichem Speichern zur Stammdatenmaske desselben Projekts",async()=>{
 const html=fs.readFileSync(path.join(__dirname,"../public/kristine.html"),"utf8");
 const fn=html.slice(html.indexOf("async function createAndAssignQuickJob(){"),html.indexOf("async function addAssignment(){"));
 const dom=new JSDOM(html);const doc=dom.window.document;
 const values={quickNewName:"Hutter",quickNewJobId:"26107",quickNewContact:"Frau Hutter",quickNewStreet:"In der Halde",quickNewHouse:"30",quickNewPostal:"6700",quickNewCity:"Bludenz"};
 for(const [id,value]of Object.entries(values))doc.getElementById(id).value=value;
 let saved;
 const context={document:doc,URL,location:{origin:"https://example.test",href:""},qs:new URLSearchParams(),quickPlanStandalone:true,quickPlanTarget:{date:""},quickFullAddress:()=>"In der Halde, 30, 6700 Bludenz",url:p=>p+"?token=test",showQuickPlanError:()=>assert.fail("unexpected error"),api:async(_url,opts)=>{saved=JSON.parse(opts.body);return{jobId:"26107"}}};
 vm.createContext(context);vm.runInContext(fn,context);await context.createAndAssignQuickJob();
 assert.equal(saved.contactName,"Frau Hutter");assert.equal(context.location.href,"/kristine/baustellen?token=test&editMaster=26107#26107");
});

test("Stammdaten öffnen einmalig und nur für die gerade neu angelegte Baustelle",()=>{
 const source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-knowledge-hub.js"),"utf8");
 const fn=source.slice(source.indexOf("  function openCreatedJobMaster("),source.indexOf("  async function loadJob("));
 const calls=[],context={URL,location:{href:"https://example.test/kristine/baustellen?token=test&editMaster=26107#26107"},history:{state:{},replaceState(_s,_t,url){context.location.href=new URL(url,context.location.href).href}},selectTab:t=>calls.push(t),renderMasterDataEditor:j=>calls.push(j.jobId)};
 vm.createContext(context);vm.runInContext(fn,context);context.openCreatedJobMaster({jobId:"other"});assert.equal(calls.length,0);
 context.openCreatedJobMaster({jobId:"26107"});assert.deepEqual(calls,["master","26107"]);assert.equal(new URL(context.location.href).searchParams.has("editMaster"),false);
 context.openCreatedJobMaster({jobId:"26107"});assert.equal(calls.length,2);
});

test("Auch die Admin-Neuanlage öffnet die Stammdaten des gespeicherten Projekts",async()=>{
 const html=fs.readFileSync(path.join(__dirname,"../public/admin.html"),"utf8"),dom=new JSDOM(html),doc=dom.window.document;
 doc.getElementById("newJobName").value="Hutter";
 const fn=html.slice(html.indexOf("async function createNewJob(){"),html.indexOf("async function api(url,"));
 const ctx={document:doc,location:{href:""},tokenJoin:p=>p,api:async()=>({jobId:"26107"})};vm.createContext(ctx);vm.runInContext(fn,ctx);await ctx.createNewJob();
 assert.equal(ctx.location.href,"/kristine/baustellen?editMaster=26107#26107");
});
