"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),vm=require("node:vm"),{createRequire}=require("node:module");
const D=require("../public/ui/baustellen-data"),B=require("../public/ui/regie-billing-state"),root=path.resolve(__dirname,"..");
function job(jobId,target=100,actual=0){return {jobId,status:"Laufend",calculation:{contractAmount:target*85,calculatedHours:target,fixedCalculatedHours:target,laborAmount:target*85,actualHours:actual,orderHours:actual}}}
function frontend(name,extra={}){
  const window={BaustellenData:D,KristaRegieBilling:B,addEventListener(){},dispatchEvent(){},...extra.window};
  const document={readyState:"loading",addEventListener(){},dispatchEvent(){},...extra.document};
  const context={window,document,location:{search:"",origin:"https://protokoll.krista.at",pathname:"/kristine/baustellen",hash:""},URL,URLSearchParams,Map,Set,Date,Intl,AbortSignal,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},console,setTimeout,clearTimeout,queueMicrotask,...extra};
  context.window=window;context.document=document;
  vm.runInNewContext(fs.readFileSync(path.join(root,name),"utf8")+(extra.append||""),context);return context;
}

test("collection totals subtract all actual hours from all target hours",()=>{
  const a=job("24177",100,120),b=job("24178",100,50);a.collectionMemberJobIds=[b.jobId,b.jobId];
  a.collectionSummary={jobIds:[a.jobId,b.jobId],calculatedHours:0};
  D.recalculateCollections({jobs:[a,b]});
  assert.equal(a.collectionSummary.calculatedHours,200);assert.equal(a.collectionSummary.remainingOrderHours,30);assert.equal(a.collectionSummary.remainingHours,30);assert.equal(a.collectionSummary.overrunHours,0);
  a.calculation.calculatedHours=150;a.calculation.fixedCalculatedHours=150;D.recalculateCollections({jobs:[a,b]});assert.equal(a.collectionSummary.calculatedHours,250);
  assert.equal(D.remaining(job("25018",1323.53,1293.2)).toFixed(2),"30.33");
  const regie=job("25019",100,110);regie.calculation.actualRegieHours=20;regie.calculation.orderHours=90;assert.equal(D.remaining(regie),10);
});

test("the final preload rebuilds collection summary from saved V2 calculation",async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),"calculation-enrichment-"));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  await fsp.mkdir(path.join(dir,"25018"));await fsp.writeFile(path.join(dir,"25018/.order-calculation.json"),JSON.stringify({netTotal:150000,materialPercent:25,billingRate:85,positions:[]}));
  function load(name){const file=path.join(root,name),req=createRequire(file),module={exports:{}};vm.runInNewContext(fs.readFileSync(file,"utf8")+"\nmodule.exports={enrichJobsPayload};",{module,exports:module.exports,require:id=>id==="express"?{application:{get(){},use(){}}}:req(id),process:{env:{DATA_DIR:dir}},console,Buffer});return module.exports;}
  const head=job("25018",0,1293.2);head.collectionMemberJobIds=["old"];head.collectionSummary={jobIds:["25018","old"],calculatedHours:0};
  let data=await load("order-calculation-preload.js").enrichJobsPayload({jobs:[head,job("old",0,0)]});
  data=await load("order-calculation-v2-preload.js").enrichJobsPayload(data);
  assert.equal(data.jobs[0].collectionSummary.calculatedHours.toFixed(2),"1323.53");assert.equal(data.jobs[0].collectionSummary.remainingOrderHours.toFixed(2),"30.33");
});

test("39 member sources include every project exactly once and retain report identities",()=>{
  const jobs=Array.from({length:39},(_,i)=>job(String(24177+i)));jobs[0].collectionMemberJobIds=jobs.slice(1).map(row=>row.jobId);jobs[0].wwProjectLinks=[{projectNumber:"24178"}];
  assert.equal(D.projects(jobs[0],jobs).length,39);
  assert.equal(D.projects(jobs[0],jobs).find(ref=>ref.projectNumber==="24178").jobId,"24178");
  const reports=jobs.map(row=>({jobId:row.jobId,type:"regie_report",reportDate:"2026-09-01",sheetNumber:"1",reportNumber:"1",totalHours:2,source:"WW"}));
  assert.equal(B.dedupeReports(reports).length,39);
  const invoices=jobs.map(row=>({jobId:row.jobId,projectNumber:row.jobId,billing:{found:true,invoices:[{id:1,runId:1,status:"issued",net:100,gross:120}],payments:[],runs:[]}}));
  assert.equal(D.combineBilling(invoices).invoices.length,39);assert.equal(D.combineBilling(invoices).summary.billedNet,3900);
});

test("live hours do not reconcile the same employee across different member jobs",()=>{
  const name="public/ui/baustellen-live-hours.js",source=fs.readFileSync(path.join(root,name),"utf8");
  const injected=source.replace('  if(document.readyState===',`  window.testHours={set(rows,ww,kr){jobs=rows;wwByMember=new Map(ww);liveByJob=new Map(kr)},fusion,hoursSummary};\n  if(document.readyState===`);
  const context={window:{BaustellenData:D},document:{readyState:"loading",addEventListener(){}},location:{search:""},URLSearchParams,Map,Set,Date,Intl,console};vm.runInNewContext(injected,context);
  const a=job("24177",100,2),b=job("24178",100,0);a.collectionMemberJobIds=[b.jobId];a.collectionSummary={jobIds:[a.jobId,b.jobId],actualHours:2};
  const person={identity:"name:max",name:"Max",hours:2},ww={found:true,rows:[{key:"24178|2026-09-01|name:max",date:"2026-09-01",identity:"name:max",employeeName:"Max",hours:2}],days:new Map([["2026-09-01",2]])};
  const kr={totalHours:2,days:new Map([["2026-09-01",2]]),dayPeople:new Map([["2026-09-01",new Map([[person.identity,person]])]])};
  context.window.testHours.set([a,b],[[b.jobId,ww]],[[a.jobId,kr]]);
  assert.equal(context.window.testHours.fusion(a).total,4);assert.equal(context.window.testHours.hoursSummary(a.jobId).remaining,196);
  a.calculation.fixedCalculatedHours=1;a.calculation.calculatedHours=1;assert.equal(context.window.testHours.hoursSummary(a.jobId).remaining,97);
});

function hoursFrontend(rows,extra={}){
  const source=fs.readFileSync(path.join(root,"public/ui/baustellen-live-hours.js"),"utf8");
  const injected=source.replace('  if(document.readyState===',`  window.testHours={set(rows){jobs=rows},hoursSummary,openHours,patchBaseDetail,patchCockpit,patchEconomy};\n  if(document.readyState===`);
  const context={window:{BaustellenData:D,BaustellenSources:{performance(){return null}}},document:{readyState:"loading",addEventListener(){},...extra},location:{search:""},URLSearchParams,Map,Set,Date,Intl,console};
  vm.runInNewContext(injected,context);context.window.testHours.set(rows);return context.window.testHours;
}

test("25018: 510 target minus 494 actual leaves 16, including an overrun member",()=>{
  const head=job("25018",510,468),member=job("keckeis_gabi_harry",0,26);head.collectionMemberJobIds=[member.jobId];
  const jobs=[head,member];D.recalculateCollections({jobs});
  assert.equal(head.collectionSummary.remainingHours,16);assert.equal(head.collectionSummary.remainingOrderHours,16);
  assert.equal(D.openHours(head,jobs),16);
  const live=hoursFrontend(jobs);assert.equal(live.hoursSummary(head.jobId).remaining,16);assert.equal(live.openHours(head),16);
  member.status="Geschlossen";
  assert.equal(D.openHours(head,jobs),16,"The detail and list use the same members, including a closed member of an active collection");
  assert.equal(live.openHours(head),16);
  head.status="Geschlossen";assert.equal(D.openHours(head,jobs),0);assert.equal(live.openHours(head),0);
});

test("24177: all 39 members share the same 1323.53 minus 1293.2 balance",()=>{
  const jobs=Array.from({length:39},(_,i)=>job(String(24177+i),0,0)),head=jobs[0];
  head.calculation={...job(head.jobId,1323.53,322.43).calculation};jobs[1].calculation.actualHours=970.77;jobs[1].calculation.orderHours=970.77;
  head.collectionMemberJobIds=jobs.slice(1).map(row=>row.jobId);D.recalculateCollections({jobs});
  const live=hoursFrontend(jobs).hoursSummary(head.jobId);
  assert.equal(head.collectionSummary.remainingHours.toFixed(2),"30.33");assert.equal(live.remaining.toFixed(2),"30.33");
  assert.equal(live.remaining.toFixed(1),"30.3");assert.equal(live.overrun,0);
  assert.equal(live.target.toFixed(2),"1323.53");assert.equal(live.total.toFixed(1),"1293.2");
});

test("total hours include regie on both sides; a total overrun leaves zero open",()=>{
  const head=job("25018",100,95),member=job("25019",50,30);head.collectionMemberJobIds=[member.jobId];
  head.calculation.fixedCalculatedHours=80;head.calculation.plannedRegieHours=20;head.calculation.actualRegieHours=15;head.calculation.orderHours=80;
  const jobs=[head,member];let live=hoursFrontend(jobs).hoursSummary(head.jobId),stored=D.aggregateCalculation(jobs);
  assert.equal(live.target,150);assert.equal(live.total,125);assert.equal(live.remaining,25);assert.equal(stored.remainingHours,25);
  assert.equal(live.remainingOrder,20);assert.equal(stored.remainingOrderHours,20);
  member.calculation.actualHours=70;member.calculation.orderHours=70;
  live=hoursFrontend(jobs).hoursSummary(head.jobId);stored=D.aggregateCalculation(jobs);
  assert.equal(live.remaining,0);assert.equal(live.overrun,15);assert.equal(stored.overrunHours,15);
  assert.equal(live.remaining-live.overrun,live.target-live.total);
});

test("detail, cockpit and economy render the same total balance",()=>{
  const head=job("25018",510,468),member=job("keckeis_gabi_harry",0,26);head.collectionMemberJobIds=[member.jobId];
  const text=()=>({textContent:"",classList:{toggle(){}}});
  const card=label=>{const nodes={".bk-label":{textContent:label},".bk-value":text(),".bk-note":text()};return {nodes,querySelector:s=>nodes[s]||null}};
  const cards=[card("Kalkulierte Sollstunden"),card("Iststunden gesamt"),card("Noch offene Stunden")];
  const pulse=label=>{const nodes={span:{textContent:label},strong:text(),small:text()};return {textContent:label,nodes,querySelector:s=>nodes[s]||null}};
  const pulses=[pulse("Sollstunden gesamt"),pulse("Iststunden"),pulse("Reststunden")];
  const elements={detailHours:text(),detailHoursNote:text(),detailOpen:text(),detailOpenNote:text(),bcShell:{querySelectorAll(){return []}},bkEconomy:{dataset:{},querySelectorAll:s=>s===".bk-card"?cards:[]}};
  const live=hoursFrontend([head,member],{getElementById:id=>elements[id]||null,querySelectorAll:s=>s==="#bcShell .bc-pulse-item"?pulses:[]});
  live.patchBaseDetail(head.jobId);live.patchCockpit(head.jobId);live.patchEconomy(head.jobId);
  assert.equal(elements.detailHours.textContent,"494 h / 510 h");assert.equal(elements.detailOpen.textContent,"16 h");
  assert.equal(elements.detailOpenNote.textContent,"510 h Soll − 494 h Ist = 16 h");
  assert.equal(pulses[2].nodes.strong.textContent,"16 h");assert.equal(pulses[2].nodes.small.textContent,elements.detailOpenNote.textContent);
  assert.equal(cards[0].nodes[".bk-value"].textContent,"510 h");assert.equal(cards[1].nodes[".bk-value"].textContent,"494 h");assert.equal(cards[2].nodes[".bk-value"].textContent,"16 h");
  assert.equal(cards[2].nodes[".bk-note"].textContent,elements.detailOpenNote.textContent);
  member.calculation.actualHours=60;member.calculation.orderHours=60;
  live.patchBaseDetail(head.jobId);assert.equal(elements.detailOpen.textContent,"0 h");assert.equal(elements.detailOpenNote.textContent,"18 h über Soll · keine offenen Stunden");
});

test("collection loader reads all 39 document, regie and invoice sources without moving them",async()=>{
  const jobs=Array.from({length:39},(_,i)=>job(String(24177+i)));jobs[0].collectionMemberJobIds=jobs.slice(1).map(row=>row.jobId);
  jobs[1].calculation.actualHours=2;jobs[1].calculation.orderHours=2;
  const calls=[],saved=new Map(),response=data=>({ok:true,status:200,json:async()=>data});
  const fetch=async(raw,init={})=>{
    const url=new URL(raw,"https://protokoll.krista.at"),body=init.body?JSON.parse(init.body):{};calls.push({path:url.pathname,method:init.method||"GET",body});
    if(url.hostname==="127.0.0.1"){
      const id=body.projectNumber;
      if(url.pathname.endsWith("project-regie-reports"))return response({ok:true,reports:[{sourceId:id,reportNumber:"1",reportDate:"2026-09-01",totalHours:2,source:"WW"}]});
      return response({ok:true,billing:{found:true,projectNumber:id,invoices:[{id:Number(id),kind:id==="24177"?"SR":"TR",status:"issued",net:100}],payments:[],runs:[],summary:{}}});
    }
    const id=url.pathname.split("/")[4];
    if(url.pathname.includes("ww-cache"))return response({ok:true,syncedAt:"2026-09-13"});
    if(url.pathname.endsWith("/days"))return response({detailed:[{day:"2026-09-01"}]});
    if(url.pathname.endsWith("/regie"))return response({regie:{employees:[]}});
    if(url.pathname.endsWith("/regie-report-sync")){saved.set(id,body.reports);return response({ok:true,count:body.reports.length})}
    if(url.pathname.endsWith("/documentation"))return response({items:(saved.get(id)||[]).map(row=>({...row,type:"regie_report"}))});
    throw new Error("Unexpected path "+url.pathname);
  };
  const context=frontend("public/ui/baustellen-sources.js",{fetch}),result=await context.window.BaustellenSources.load(jobs[0],jobs);
  assert.equal(result.rows.length,39);assert.equal(result.documents.length,39);assert.equal(result.regies.length,39);assert.equal(result.billing.invoices.length,39);assert.equal(result.billing.partial,false);
  assert.equal(saved.size,39);assert(calls.every(call=>!call.path.includes("/merge")&&call.method!=="DELETE"));
  assert.equal(B.dedupeReports(result.documents).length,39);
  const performance=context.window.BaustellenSources.performance("24177");
  assert.equal(performance.hasClosingInvoice,false,"One closing invoice does not settle 39 projects");
});

test("failed WW sources keep stored reports and mark billing incomplete",async()=>{
  const jobs=[job("24177"),job("24178")];jobs[0].collectionMemberJobIds=["24178"];
  const response=data=>({ok:true,json:async()=>data});
  const context=frontend("public/ui/baustellen-sources.js",{fetch:async(raw,init={})=>{
    const url=new URL(raw,"https://protokoll.krista.at");
    if(url.hostname!=="protokoll.krista.at")throw new TypeError("Failed to fetch");
    if(url.pathname.endsWith("brain-permit"))return response({ok:true,permit:"permit"});
    if(url.pathname.endsWith("/days"))return response({detailed:[]});
    if(url.pathname.endsWith("/documentation"))return response({items:[{type:"regie_report",reportNumber:"1",totalHours:2}]});
    if(url.pathname.includes("ww-cache"))return response({snapshot:null});
    throw new Error("Unexpected write "+url.pathname);
  }});
  const result=await context.window.BaustellenSources.load(jobs[0],jobs);
  assert.equal(result.documents.length,2);assert.equal(result.billing.partial,true);
  assert.equal(result.rows.flatMap(row=>row.regieSources).filter(source=>source.error).length,2);
});

test("unreachable WW uses persisted hours and marks the stand as cached",async()=>{
  const snapshot={syncedAt:"2026-09-12T10:00:00Z",data:{found:true,projectNumber:"24177",totalHours:25,rows:[],days:[]}};
  const context=frontend("public/ui/baustellen-sources.js",{fetch:async url=>{
    if(String(url).includes("ww-cache"))return {ok:true,json:async()=>({ok:true,snapshot})};
    if(String(url).includes("brain-permit"))return {ok:true,json:async()=>({ok:true,permit:"test-permit"})};
    throw new TypeError("Failed to fetch");
  }});
  const result=await context.window.BaustellenSources.ww("hours",{jobId:"24177",projectNumber:"24177"});
  assert.equal(result.hours.totalHours,25);assert.equal(result.cached,true);assert.equal(result.syncedAt,snapshot.syncedAt);
});
