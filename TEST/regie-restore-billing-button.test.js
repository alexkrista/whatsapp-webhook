"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const hub=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-knowledge-hub.js"),"utf8");
const brain=fs.readFileSync(path.join(__dirname,"../brain_outgoing_invoices.py"),"utf8");
const billing=fs.readFileSync(path.join(__dirname,"../public/ui/regie-billing-state.js"),"utf8");
function extractDraftLink(){
  const start=hub.indexOf("  function regieInvoiceDraftHref("),end=hub.indexOf("  function mountRegieInvoiceStart(",start);
  assert.ok(start>0&&end>start,"Draft link helper in Regie tab");
  const num=n=>Number(n)||0;
  const linkedToken=object=>Buffer.from(JSON.stringify(object),"utf8").toString("base64url");
  const invoiceActionLink=(job,kind)=>"http://127.0.0.1:5051/outgoing/invoices?project="+encodeURIComponent(job.jobId)+"&action="+kind+"&projectContext=ctx";
  return new Function("num","linkedToken","invoiceActionLink",hub.slice(start,end)+"\nreturn regieInvoiceDraftHref;")(num,linkedToken,invoiceActionLink);
}
function example(){
  return [{id:"ww-01",reportDate:"2026-10-12",reportNumber:"26108001",totalHours:10,laborCost:750,materialCost:125,
    employeeDetails:[{name:"Manuel Faes",hours:10,cost:750}],materials:[{name:"Spachtelmasse",quantity:2,unit:"KG",unitPrice:62.5,cost:125}]},
    {id:"ww-02",reportDate:"2026-10-13",reportNumber:"26108002",totalHours:2,laborCost:150,materialCost:0}];
}
test("Regie tab exposes billing launch with TR and SR choice, not issuing invoices itself",()=>{
  assert.match(hub,/id="bkRegieInvoiceStart"/);
  assert.match(hub,/€ Regie abrechnen/);
  assert.match(hub,/data-krb-kind="TR"/);
  assert.match(hub,/data-krb-kind="SR"/);
  assert.match(hub,/data-bk-regie-kind="RE"/);
  assert.match(hub,/mountRegieInvoiceStart\(el,j,billingState,billing\)/);
  assert.match(hub,/WinWorker-Rechnungsabgleich unvollständig/);
  assert.match(hub,/const canReview=!!performance\?\.complete&&!performance\.aggregated&&!performance\.hasClosingInvoice&&!stale/);
  assert.match(hub,/rate\.insertAdjacentElement\("afterend",card\)/);
  assert.doesNotMatch(hub.slice(hub.indexOf("function mountRegieInvoiceStart("),hub.indexOf("function renderRegie(")),/\bfetch\(|\bPOST\b|\bPUT\b|\bPATCH\b/);
  assert.match(billing,/data-krb-review/);
  assert.match(brain,/createLinkedRegieDraft\(kind\)/);
});
test("Regie invoice links preload exact open report IDs and totals, TR/SR/RE kinds",()=>{
  const link=extractDraftLink(),reports=example();
  for(const kind of ["TR","SR","RE"]){
    const uri=link({jobId:"26108"},reports,kind,"summary"),u=new URL(uri);
    assert.equal(u.hostname,"127.0.0.1");
    assert.equal(u.searchParams.get("project"),"26108");
    assert.equal(u.searchParams.get("action"),kind);
    assert.equal(u.searchParams.get("regieMode"),"summary");
    assert.equal(Number(u.searchParams.get("regieHours")),12);
    assert.equal(Number(u.searchParams.get("laborTotal")),900);
    assert.equal(Number(u.searchParams.get("materialTotal")),125);
    const details=JSON.parse(Buffer.from(u.searchParams.get("regieDetail"),"base64url").toString("utf8"));
    assert.deepEqual(details.days.map(x=>x.reportNumber),["26108001","26108002"]);
    assert.deepEqual(details.days.map(x=>x.id),["ww-01","ww-02"]);
    assert.equal(details.days[0].materials[0].cost,125);
    assert.equal(u.searchParams.get("projectContext"),"ctx");
  }
  assert.equal(new URL(link({jobId:"26108"},reports,"RE","days")).searchParams.get("regieMode"),"days");
});
test("No delivery note or price-pending report can silently become an invoice draft",()=>{
  const link=extractDraftLink();
  const reports=[...example(),{id:"pending",documentType:"delivery_note",pricePending:true,totalHours:2,laborCost:100},
    {id:"blocked",reportNumber:"blocked",billingReady:false,totalHours:2,laborCost:100}];
  const uri=link({jobId:"26108"},reports,"RE","days"),obj=JSON.parse(Buffer.from(new URL(uri).searchParams.get("regieDetail"),"base64url").toString("utf8"));
  assert.equal(obj.days.length,2);
  assert.equal(link({jobId:"26108"},[{pricePending:true,reportDate:"2026-10-12"}],"TR"),"");
  assert.throws(()=>link({jobId:"26108"},reports,"GS"),/Ungültige Rechnungsart/);
});
