"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {readCustomerInvoices,invoiceView,createInvoicePdfReader}=require("../customer-portal-invoices");
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),"customer-invoices-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test("only issued invoices from permitted project snapshots are shown, latest versions win, and absent sources are not zero invoices",async t=>{
  const dir=await fixture(t),folder=path.join(dir,"_system/ww-cache/billing");await fs.mkdir(folder,{recursive:true});
  const invoice={id:1,invoiceNumber:"RE100",issueDate:"2026-09-01",source:"WW",sourceId:"doc1",status:"issued",kind:"RE",net:100,gross:120,internalNote:"PRIVATE",pdfPath:"N:/internal"};
  for(const jobId of ["24177","25018"]){await fs.writeFile(path.join(folder,jobId+".json"),JSON.stringify({projectNumber:jobId,syncedAt:"2026-09-13T12:00:00Z",data:{projectNumber:jobId,projectIndex:100,found:true,invoices:[invoice,{...invoice,id:2,net:200,gross:240},{...invoice,id:3,status:"draft",invoiceNumber:"DRAFT"},{...invoice,id:4,status:"cancelled",invoiceNumber:"VOID"}]}}));}
  const result=await readCustomerInvoices(dir,[{jobId:"24177"},{jobId:"26018"}]);assert.equal(result.entries.length,1);assert.equal(result.entries[0].jobId,"24177");assert.equal(result.entries[0].raw.net,200);assert.equal(result.complete,false);assert.deepEqual(result.unavailable,[{jobId:"26018"}]);
  const view=invoiceView(result.entries[0],true);assert.equal(view.number,"RE100");assert.equal(view.gross,240);assert.match(view.url,/^\/kundenportal\/api\/invoice\/24177\/[a-f0-9]{32}$/);assert(!JSON.stringify(view).includes("PRIVATE"));assert(!JSON.stringify(view).includes("internal"));assert(!JSON.stringify(view).includes("doc1"));
});

test("invoice originals are resolved within the correct project and kept locally after first download",async t=>{
  const dir=await fixture(t),calls=[],entry={id:"a".repeat(32),jobId:"24177",projectNumber:"24177",projectIndex:100,raw:{sourceId:"doc1",invoiceNumber:"RE100"}};
  const reader=createInvoicePdfReader({dataDir:dir,baseUrl:"https://office.test",createPermit:route=>"PRIVATE-PERMIT:"+route,fetchImpl:async(url,init)=>{
    calls.push({url:new URL(url),init});assert.equal(init.redirect,"error");assert.equal(new URL(url).searchParams.has("permit"),false);
    if(new URL(url).pathname==="/project/documents")return Response.json({ok:true,project:{projectNumber:"24177",projectIndex:100},documents:[{bookNumber:"RE999",documentType:"Rechnung",path:"N:/other.pdf"},{bookNumber:"RE100",documentType:"Rechnung",wwDocIds:["doc1"],path:"N:/original.pdf",pdfFound:true}]});
    assert.equal(new URL(url).pathname,"/pdf");assert.equal(new URL(url).searchParams.get("path"),"N:/original.pdf");return new Response("%PDF-original-invoice",{headers:{"content-type":"application/pdf"}});
  }});
  assert.equal((await reader(entry)).toString(),"%PDF-original-invoice");assert.equal((await reader(entry)).toString(),"%PDF-original-invoice");assert.equal(calls.length,2);
  assert(calls.every(row=>row.init.headers["X-Krista-Brain-Permit"].startsWith("PRIVATE-PERMIT")));
});

test("wrong projects, ambiguous invoices and non-PDF replies cannot be exposed or cached",async t=>{
  const dir=await fixture(t),entry={id:"b".repeat(32),jobId:"24177",projectNumber:"24177",projectIndex:100,raw:{invoiceNumber:"RE100"}};
  let projectNumber="25018",duplicate=false,calledPdf=0;
  const reader=createInvoicePdfReader({dataDir:dir,baseUrl:"https://office.test",createPermit:()=>"permit",fetchImpl:async url=>{
    if(new URL(url).pathname==="/pdf"){calledPdf++;return new Response("not a PDF",{headers:{"content-type":"text/html"}});}
    return Response.json({ok:true,project:{projectNumber,projectIndex:100},documents:[{bookNumber:"RE100",documentType:"Rechnung",path:"N:/one.pdf"},...(duplicate?[{bookNumber:"RE100",documentType:"Rechnung",path:"N:/two.pdf"}]:[])]});
  }});
  await assert.rejects(reader(entry),e=>e.status===404);assert.equal(calledPdf,0);projectNumber="24177";duplicate=true;
  await assert.rejects(reader(entry),e=>e.status===404);assert.equal(calledPdf,0);duplicate=false;
  await assert.rejects(reader(entry),e=>e.status===502);await assert.rejects(fs.stat(path.join(dir,"24177/_customer-invoices",entry.id+".pdf")),e=>e.code==="ENOENT");
});
