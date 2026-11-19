"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),{JSDOM}=require("jsdom");
const html=fs.readFileSync(require.resolve("../public/regie-assistant.html"),"utf8"),start=html.indexOf('let lastReviewPdfUrl='),end=html.indexOf("$('finishAndDayClose').onclick",start),code=html.slice(start,end);
async function run({close=false,blocked=false,network=false,photo=false}={}){
 const dom=new JSDOM(html,{url:"https://regie.test/public/regie-assistant.html",runScripts:"outside-only"}),w=dom.window,context=dom.getInternalVMContext();
 let ended=0,posts=0;const draft={id:"r1",status:"draft",reportNumber:"26082001",photos:[],materials:[],reviewPdfUrl:"/kristine/regie-report/r1/review.pdf?key=scoped"};
 const ctx={$:id=>w.document.getElementById(id),stopSpeech(){},ensureUnknownMaterials:async()=>{},peopleData:[{id:"e1",name:"Edi",selected:true,hours:9.5}],employeeId:"e1",date:"2026-11-18",segment:{jobId:"26082"},hoursMode:"day",teamMode:"all",draftReport:null,chosen:[],photoFiles:photo?[{file:{}}]:[],existingPhotoCount:0,dailyJobs:[],materialPayload:()=>[],drawPhotos(){},returnTo:"/go",tokenUrl:u=>u,finishCurrentWork:async()=>{ended++},refreshRegieTimes:async()=>{},dayCloseUrl:()=>"/close",fail:message=>{w.document.getElementById("error").textContent=message},RegieUpload:{send:async()=>({...draft,reviewPdfUrl:undefined})},api:async(url,options)=>{posts++;const body=JSON.parse(options.body);if(!body.draft){if(blocked){const e=Error("hours check");e.response={submitted:false,report:draft};throw e}if(network)throw Error("network");return{ok:true,submitted:true,report:{...draft,status:"prepared"}}}return{ok:true,report:draft}}};
 Object.assign(context,ctx);w.document.getElementById("description").value="Kellerraum";vm.runInContext(code,context);
 try{
  await vm.runInContext("completeReport("+close+")",context);
  assert.equal(posts,2);assert.equal(ended,close?1:0);
  const text=w.document.getElementById("regieReceiptText").textContent,link=w.document.getElementById("regieReviewPdf");
  assert(!link.classList.contains("hidden"));assert(link.href.includes("review.pdf?key=scoped"));assert(link.textContent.includes("ohne Preise"));
  if(blocked)assert(text.includes("Noch nicht übergeben"));
  else if(network)assert(text.includes("Übergabe konnte nicht bestätigt"));
  else{assert(text.includes("wurde übergeben"));assert(w.document.getElementById("done").classList.contains("on"))}
  if(close&&!blocked&&!network){assert(w.document.getElementById("doneBack").href.endsWith("/close"));assert(w.location.pathname.includes("regie-assistant.html"),"PDF must remain available before day-close navigation")}
 }finally{w.close()}
}
(async()=>{await run();await run({close:true});await run({blocked:true});await run({network:true,photo:true});console.log("PASS: mobile receipt and PDF on submit; day-close stays on receipt; blocked reports marked draft; network uncertainty distinguished; PDF survives photo-upload response.")})().catch(e=>{console.error(e);process.exitCode=1});
