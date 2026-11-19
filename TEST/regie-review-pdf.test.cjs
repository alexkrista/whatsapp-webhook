"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {auditReport}=require("../regie-hours-check"),{createReviewPdf,reviewUrl,authorized}=require("../regie-review-pdf"),{registerRegieAssistant}=require("../regie-assistant");
(async()=>{
 const date="2026-11-18",person={id:"edi",name:"Edi Mock",hours:9.5},report={id:"one",jobId:"26082",jobName:"Hutter - Kellerraum",date,to:"17:00",createdAt:"2026-11-18T16:00:00Z",employees:[person],materials:[],description:"Wände vorbereiten"};
 const events=[{employeeId:"edi",date,jobId:"26082",type:"start",at:"07:00"},{employeeId:"edi",date,type:"mittag",at:"12:00"},{employeeId:"edi",date,jobId:"26082",type:"weiter",at:"12:30"}];
 const emptyArchive=[{employeeId:"edi",date,segments:[]}];
 let audit=auditReport(report,[],events,emptyArchive,[],new Date("2026-11-18T16:00:00Z"));assert(!audit.blocked);assert(!audit.missingTimes);
 audit=auditReport(report,[],[],emptyArchive);assert(!audit.blocked);assert(audit.missingTimes);assert(!audit.warnings.join().includes("höchstens 0"));
 audit=auditReport({...report,createdAt:null},[],events,[],[],new Date("2026-11-19T08:00:00Z"));assert(!audit.blocked);assert(audit.missingTimes,"Unbounded open historical work must not pretend to be complete");
 const closed=[...events,{employeeId:"edi",date,type:"ende",at:"17:00"}];assert(auditReport({...report,employees:[{...person,hours:10}]},[],closed,emptyArchive).blocked,"Real overrun remains blocked");
 let failDocumentation=false;
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"regie-review-")),routes=new Map(),app={};
 for(const method of ["get","post","delete"])app[method]=(p,h)=>routes.set(method+" "+p,h);
 registerRegieAssistant(app,{dataDir:root,publicDir:path.join(__dirname,"../public"),requireAdmin:(req,res)=>req.admin===true||(res.status(403).send("Forbidden"),false),readJobMeta:async()=>({name:"Hutter",regieHourlyRate:987.65}),readDocumentation:async()=>[],writeDocumentation:async()=>{if(failDocumentation)throw Error("simulated documentation failure")}});
 async function call(method,route,req){const res={code:200,headers:{},status(v){this.code=v;return this},json(v){this.body=v;return this},send(v){this.body=v;return this},type(v){this.mime=v;return this},setHeader(k,v){this.headers[k]=v}};await routes.get(method+" "+route)({params:{},query:{},body:{},...req},res);return res}
 try{
  await fs.mkdir(path.join(root,"_kristine"),{recursive:true});await fs.writeFile(path.join(root,"_kristine/time-events.json"),JSON.stringify(closed));
  const body={draft:false,date,segment:{jobId:"26082",jobName:"Hutter - Kellerraum",from:"07:00",to:"17:00"},people:[{id:"edi",name:"Edi Mock"}],employees:[{...person,from:"07:00",to:"17:00"}],description:"Wände vorbereiten",materials:[{product:"Grundierung",quantity:2,containerSize:5,unit:"l",salePrice:123.45,color:"Weiß"}]};
  const issued=await call("post","/kristine/api/regie",{body});assert.equal(issued.code,200);assert.equal(issued.body.submitted,true);const saved=issued.body.report;assert(saved.reviewPdfUrl);
  assert(authorized(saved,new URL(saved.reviewPdfUrl,"https://test").searchParams.get("key")));assert(!authorized({...saved,id:"other"},new URL(saved.reviewPdfUrl,"https://test").searchParams.get("key")));
  const params={id:saved.id},key=new URL(saved.reviewPdfUrl,"https://test").searchParams.get("key");
  assert.equal((await call("get","/kristine/regie-report/:id/review.pdf",{params,query:{key:"wrong"}})).code,403);
  const pdf=await call("get","/kristine/regie-report/:id/review.pdf",{params,query:{key}});assert.equal(pdf.code,200);assert.equal(pdf.mime,"application/pdf");assert(Buffer.isBuffer(pdf.body));assert.equal(pdf.body.subarray(0,5).toString(),"%PDF-");
  const {PDFParse}=require("pdf-parse"),parser=new PDFParse({data:new Uint8Array(pdf.body)});try{const content=(await parser.getText()).text;for(const s of ["Edi Mock","9,5","Grundierung","2 x 5 l","ohne Preise"])assert(content.includes(s),s);for(const s of ["987,65","123,45","Stundensatz","Netto:","Brutto:"])assert(!content.includes(s),"Price leaked: "+s)}finally{await parser.destroy()}
  const again=await call("post","/kristine/api/regie",{body:{...body,id:saved.id}});assert.equal(again.body.report.id,saved.id);assert(again.body.report.reviewPdfUrl);assert.equal(again.body.submitted,true);
  failDocumentation=true;
  const syncFailed=await call("post","/kristine/api/regie",{body:{...body,date:"2026-11-17",id:"",draft:true}});
  assert.equal(syncFailed.code,200);assert.equal(syncFailed.body.submitted,false);assert(syncFailed.body.officeWarning.includes("gespeichert"));assert(syncFailed.body.report.reviewPdfUrl);
  assert(JSON.parse(await fs.readFile(path.join(root,"_kristine/regie-reports.json"),"utf8")).some(r=>r.id===syncFailed.body.report.id));
  if(process.env.REGIE_REVIEW_QA_PATH)await fs.writeFile(process.env.REGIE_REVIEW_QA_PATH,pdf.body);
  console.log("PASS: open stamps, empty archive fallback, historical uncertainty, real overrun; issued receipt, report-scoped PDF authentication, idempotent receipt, PDF hours/material without any price fields.");
 }finally{await fs.rm(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
