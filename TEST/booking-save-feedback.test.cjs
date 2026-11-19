"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {enrichAssignmentAddresses}=require("../assignment-addresses");
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
(async()=>{
 let reads=0,active=0,maxActive=0;
 const input=Array.from({length:200},(_,i)=>({jobId:String(i%12),address:"old",order:i}));
 const output=await enrichAssignmentAddresses(input,async id=>{reads++;active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setImmediate(r));active--;if(id==="3")throw Error("missing");return{street:"Street",houseNumber:id,postalCode:"6820",city:"Frastanz"}});
 assert.equal(reads,12);assert(maxActive<=8);assert.equal(output[0].address,"Street 0, 6820 Frastanz");assert.equal(output[3].address,"old");assert.equal(input[0].address,"old");assert.deepEqual(output.map(x=>x.order),input.map(x=>x.order));
 await enrichAssignmentAddresses([{jobId:"0"}],async()=>{reads++;return{address:"Changed"}});assert.equal(reads,13,"No stale cache across requests");
 const html=fs.readFileSync(path.join(__dirname,"../public/kristine.html"),"utf8");for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
 const start=html.indexOf("async function saveTimeEditor(){"),end=html.indexOf("async function sendEmployeeDayEndCheck",start),code=html.slice(start,end);
 function harness(){const save=defer(),refresh=defer(),note={textContent:""},button={disabled:false,textContent:"Änderungen speichern"};let puts=0,refreshes=0,prompts=0;
 const ctx={timeEditorSession:1,timeEditorSaving:false,timeEditorMonthClosed:false,selectedControlEmployeeId:"e1",masterEmployees:[{id:"e1",name:"Employee"}],timeEditorSegments:[{id:"s1",type:"work",from:"07:00",to:"12:00",jobId:"26082"}],timeEditorCopiedFrom:null,timeEditorJobGroups:new Map(),employeeActionNote:note,employeeActionBackdrop:{classList:{contains:()=>true}},selectedWorkDate:()=>"2026-11-11",hmToMinutes:v=>{const [h,m]=v.split(":").map(Number);return h*60+m},confirm:()=>{prompts++;return false},document:{getElementById:()=>button},renderTimeEditor(){},populateTimeCopyEmployees(){},sendEmployeeDayEndCheck:async()=>{},api:async()=>{puts++;return save.promise},loadSilent:()=>{refreshes++;return refresh.promise},AbortController,setTimeout:()=>1,clearTimeout(){}};
 vm.createContext(ctx);vm.runInContext(code,ctx);return{ctx,save,refresh,note,button,counts:()=>({puts,refreshes,prompts})}}
 const h=harness(),pending=h.ctx.saveTimeEditor();assert(h.button.disabled);await h.ctx.saveTimeEditor();assert.equal(h.counts().puts,1,"No duplicate write while saving");
 h.save.resolve({ok:true,segments:h.ctx.timeEditorSegments,movedLinkedEntries:0});await pending;assert(h.note.textContent.includes("gespeichert"));assert.equal(h.counts().refreshes,1);assert(!h.button.disabled,"Save returns without waiting for overview");
 h.refresh.reject(Error("overview failed"));await new Promise(r=>setImmediate(r));assert(h.note.textContent.includes("Änderungen sind gespeichert"));assert(!h.note.textContent.startsWith("Fehler"));
 const stale=harness(),p=stale.ctx.saveTimeEditor();stale.ctx.selectedControlEmployeeId="other";stale.note.textContent="Other employee";stale.save.resolve({ok:true,segments:[]});await p;assert.equal(stale.note.textContent,"Other employee");assert.equal(stale.counts().prompts,0);
 const reopened=harness(),rp=reopened.ctx.saveTimeEditor();reopened.ctx.timeEditorSession++;reopened.note.textContent="New dialog";reopened.save.resolve({ok:true,segments:[]});await rp;assert.equal(reopened.note.textContent,"New dialog");
 const failure=harness(),failed=failure.ctx.saveTimeEditor();failure.save.reject(Error("network"));await failed;assert(failure.note.textContent.startsWith("Keine Speicherbestätigung"));assert.equal(failure.counts().refreshes,0);assert(!failure.button.disabled);
 console.log("PASS: immediate save confirmation despite stalled overview, duplicate prevention, independent refresh error, stale-dialog guard, uncertain save feedback; unique bounded address reads and fresh per-request cache; UI syntax.");
})().catch(e=>{console.error(e);process.exitCode=1});
