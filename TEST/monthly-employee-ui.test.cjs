"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),{JSDOM}=require("jsdom"),{PDFDocument}=require("pdf-lib"),{createKriszeitMonthlyPdf}=require("../kriszeit-monthly-pdf");
const html='<div id="monthlyReportModal"></div><button id="openKriszeitPdf"></button><button id="closeMonthlyReport"></button><button id="monthlySelectAll"></button><button id="monthlySelectNone"></button><input id="monthlyFrom" value="2026-10-01"><input id="monthlyTo" value="2026-10-31"><div id="monthlyPeople"><input type="checkbox" data-monthly-person value="a" checked><input data-za-old="a" value="0"><button data-person-review="a">Ansehen</button></div><div id="monthlySummary"></div><div id="monthlyReportStatus"></div><div id="zaOldLedger"></div><button id="closeKriszeitMonth"></button><button id="createMonthlyReport"></button>';
(async()=>{
 const dom=new JSDOM(html,{url:"https://example.test",runScripts:"outside-only"}),w=dom.window,context=dom.getInternalVMContext(),calls=[],saved=[],employee={id:"a",name:"Bettina Beispiel",personnelNumber:"1"},days=new Map();
 for(let d=new Date("2026-09-28T12:00:00Z");d<=new Date("2026-11-01T12:00:00Z");d.setUTCDate(d.getUTCDate()+1)){
 const date=d.toISOString().slice(0,10),wd=d.getUTCDay(),weekday=wd>0&&wd<6;let from="07:30",to=weekday?"17:30":"07:30";
 if(date==="2026-09-28")to="19:30";if(date==="2026-10-05")to="18:31";
 days.set(date,{date,employeeId:"a",segments:weekday?[{id:date,type:"up",from,to,reason:"Büro",unproductiveCategory:"other",unproductiveCode:""}]:[],released:true,targetMinutes:weekday?480:0,modelName:"Büro",source:"Buchungen",payrollFixed:false,workingMinutes:weekday?(date==="2026-09-28"?720:date==="2026-10-05"?661:600):0});
 }
 w.state={bootstrap:{employees:[employee],assignments:[],worktimeModels:[]}};w.CSS={escape:String};w.toast=()=>{};w.confirm=()=>true;w.prompt=()=>"Test Wiederöffnung";
 w.request=async(url,options={})=>{calls.push({url,options});if(url.startsWith("/kristine/api/month-closures"))return{closures:[]};if(url.startsWith("/kristine/api/monthly-days/")){const u=new URL(url,"https://x.test");return{days:[...days.values()].filter(d=>d.date>=u.searchParams.get("from")&&d.date<=u.searchParams.get("to"))}}
 if(url.startsWith("/kristine/api/segments/")){const date=url.split("/").at(-1),body=JSON.parse(options.body);saved.push(body);days.get(date).segments=body.segments;return{ok:true,segments:body.segments}}
 throw Error("Unexpected "+url)};
 for(const file of ["monthly-report.js","monthly-employee-review.js"])vm.runInContext(fs.readFileSync(require.resolve("../public/kristool-preview/"+file),"utf8"),context);
 const settle=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r))};
 w.document.querySelector("[data-person-review]").click();await settle();
 const modal=w.document.getElementById("monthlyEmployeeModal");assert.equal(modal.hidden,false);assert.match(modal.textContent,/07:30–17:30/);assert.match(modal.textContent,/Büro/);
 assert.match(modal.textContent,/Über 10 Std.: \+01:01/);assert.match(modal.textContent,/Über 50 Std.: \+02:00/,"full cross-month calendar week is marked");
 const row=[...modal.querySelectorAll("tr")].find(r=>r.textContent.includes("05.10."));assert(row.classList.contains("over-limit"));
 const exact=[...modal.querySelectorAll("tr")].find(r=>r.textContent.includes("06.10."));assert(!exact.classList.contains("over-limit"),"exactly ten hours is not over ten");
 modal.querySelector('[data-review-edit="2026-10-05"]').click();
 const editor=modal.querySelector("#review-editor-2026-10-05"),to=editor.querySelector('[data-field="to"]'),reason=editor.querySelector("textarea");
 to.value="12:00";to.dispatchEvent(new w.Event("input",{bubbles:true}));reason.value="Kontrolle laut Zeitnachweis";reason.dispatchEvent(new w.Event("input",{bubbles:true}));
 modal.querySelector("[data-review-save]").click();await settle();
 assert.equal(saved.length,1);assert.equal(saved[0].segments[0].from,"07:30");assert.equal(saved[0].segments[0].to,"12:00");assert.equal(saved[0].segments[0].reason,"Büro");assert.equal(saved[0].reason,"Kontrolle laut Zeitnachweis");assert.match(modal.textContent,/Alle Änderungen gespeichert/);
 // PDF with many paid UP rows must paginate instead of dropping the bottom of the timesheet.
 const report=await w.KrisMonthly.buildPerson(employee,"2026-10-01","2026-10-31",0);assert(report.days.find(d=>d.date==="2026-10-05").printBlocks.some(b=>b.from==="07:30"&&b.to==="12:00"),"UP Von/Bis must appear in PDF");
 const longDays=report.days.map(d=>({...d,printBlocks:Array.from({length:8},(_,i)=>({from:"07:00",to:"08:00",durationMinutes:60}))}));
 const pdf=await createKriszeitMonthlyPdf({from:"2026-10-01",to:"2026-10-31",people:[{...JSON.parse(JSON.stringify(report)),days:longDays}]});const parsed=await PDFDocument.load(pdf);assert(parsed.getPageCount()>1,"long time sheets require continuation pages");
 dom.window.close();console.log("PASS: individual editable view shows paid UP Von/Bis, strict 10h/50h limits incl. cross-month week, saved reason, same UP blocks in PDF and pagination");
})().catch(e=>{console.error(e);process.exitCode=1});
