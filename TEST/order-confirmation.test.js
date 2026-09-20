"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const express = require("express");
const { JSDOM } = require("jsdom");
const { buildAcceptedOrder, applyAcceptedPaymentTerm } = require("../offer-order-workflow");
const { registerOrderConfirmation, buildConfirmationDraft, CLOSING } = require("../order-confirmation");

function fixture() {
  const draft = applyAcceptedPaymentTerm({
    offerNumber:"2609007", offerRevision:2, showQuantities:false, intro:"Guten Tag,", scopeDescription:"Wohnzimmer ausmalen",
    financials:{ priceMode:"gross", vatRate:20, discountPercent:5 }, groupDiscounts:{ Wohnzimmer:10 },
    positions:[
      { id:"wall", groupName:"Wohnzimmer", text:"Wände streichen", quantity:10, unit:"m²", unitPrice:24 },
      { id:"ceiling", groupName:"Wohnzimmer", text:"Gewählte Decke", quantity:5, unit:"m²", unitPrice:24, isAlternative:true },
      { id:"unselected", text:"Nicht beauftragt", quantity:1, unit:"PA", unitPrice:500, isAlternative:true },
    ],
  }, "deposit50");
  return {
    draft,
    order:buildAcceptedOrder({ draft, jobId:"26001", customer:"Testkunde", selectedAlternativeIds:["ceiling"], acceptedAt:"2026-09-19T10:00:00.000Z" }),
    schedule:{ status:"confirmed", confirmedDate:"2026-10-05", confirmedFrom:"07:00", confirmedTo:"17:00", appointmentId:"appointment-1", outlook:{status:"synced"} },
  };
}

async function service(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kristine-ab-")), data = fixture();
  data.meta={name:"Testbaustelle",street:"Musterweg",houseNumber:"1",postalCode:"6820",city:"Frastanz",customerMaster:{name:"Testkunde"}};
  await fs.mkdir(path.join(dataDir, "26001"));
  await fs.writeFile(path.join(dataDir, "26001", ".accepted-order.json"), JSON.stringify(data.order));
  let documents = [{id:"existing",type:"plan",name:"Bestandsplan.pdf"}], renders = 0;
  const renderOptions=[];
  const history = [], app = express();
  const api = registerOrderConfirmation(app, {
    dataDir,
    requireAdmin(req,res) { if(req.headers["x-admin-token"] === "test")return true;res.status(403).json({ok:false});return false; },
    readJobMeta:async()=>data.meta,
    readOrderSchedule:async()=>data.schedule,
    readDocumentation:async()=>documents,
    writeDocumentation:async(_id,rows)=>{documents=rows},
    appendJobHistory:async(_id,row)=>history.push(row),
    renderPdf:async (html,options)=>{renders++;renderOptions.push(options);if(data.onRender)await data.onRender(html,options);return Buffer.from("%PDF-1.4\nTest PDF");},
  });
  const server = await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s))});
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataDir,{recursive:true,force:true})});
  const request = async (route="",options={})=>{
    const response=await fetch(`${origin}/admin/api/job/26001/order-confirmation${route}`,{...options,headers:{"x-admin-token":"test",...(options.headers||{})}});
    return {status:response.status,...await response.json()};
  };
  const save=(view,extra={})=>request("/pdf",{method:"POST",headers:{"Content-Type":"text/html","X-Confirmation-Fingerprint":view.confirmation.fingerprint,"X-Confirmation-Date":view.confirmation.documentDate},body:`<html><div class="koffer-paper" data-order-confirmation="${view.confirmation.fingerprint}">Auftragsbestätigung</div></html>`,...extra});
  return {...api,data,dataDir,request,save,history,documents:()=>documents,renders:()=>renders,renderOptions:()=>renderOptions};
}

test("AB verwendet angenommene Preise, gewählte Alternativen und Zahlungsbedingungen",()=>{
  const {order,draft}=fixture(),snapshot=JSON.stringify(order);
  draft.positions[0].unitPrice=9999;draft.financials.vatRate=0;
  const printed=buildConfirmationDraft(order);
  assert.equal(printed.positions.length,2);
  assert.equal(printed.positions[0].unitPrice,24);
  assert.ok(printed.positions.every(row=>row.isAlternative===false));
  assert.equal(printed.financials.priceMode,"gross");
  assert.equal(printed.financials.paymentTerm,"deposit50");
  assert.equal(printed.orderConfirmationTotals.gross,307.8);
  assert.equal(printed.orderConfirmationTotals.prepaymentNet,130);
  assert.equal(printed.showQuantities,false);
  assert.equal(JSON.stringify(order),snapshot);
});

test("AB braucht einen bestätigten und intern gespeicherten Termin, aber keinen persönlichen Outlook-Termin",async t=>{
  const s=await service(t);
  assert.equal((await s.request("",{headers:{"x-admin-token":"wrong"}})).status,403);
  for(const status of ["none","requested","proposed"]){s.data.schedule.status=status;assert.equal((await s.request()).status,409)}
  s.data.schedule.status="confirmed";s.data.schedule.appointmentId="";s.data.schedule.outlook={};
  const view=await s.request();assert.equal(view.status,200);assert.equal(view.schedule.appointmentId,"");
  assert.match(view.confirmation.scheduleLabel,/05\.10\.2026.*07:00.*17:00/);
  assert.equal(s.renders(),0);
});

test("PDF-Ablage ist wiederholbar und erhält Dokumente, die während des Renderns hinzukommen",async t=>{
  const s=await service(t),view=await s.request();
  s.data.onRender=async()=>{s.documents().push({id:"concurrent",name:"Parallel abgelegt.pdf"})};
  const results=await Promise.all([s.save(view),s.save(view)]);
  assert.ok(results.every(row=>row.status===200));
  assert.equal(s.renders(),1);assert.equal(s.history.length,1);
  assert.deepEqual(s.renderOptions()[0],{jobId:"26001"});
  assert.equal(s.documents().length,3);assert.ok(s.documents().some(row=>row.id==="concurrent"));
  const item=results[0].item;
  assert.equal(item.type,"order");assert.equal(item.confirmationNumber,"AB-2609007");
  assert.equal(item.confirmedSchedule.date,"2026-10-05");
  assert.equal(await fs.readFile(path.join(s.dataDir,"26001","_documentation",item.storedName),"utf8"),"%PDF-1.4\nTest PDF");
  s.data.schedule.outlook={status:"synced",syncedAt:"later"};
  assert.equal((await s.request()).pdfUrl,item.url);
});

test("geänderte Empfänger-Stammdaten machen eine offene AB-Vorschau ungültig",async t=>{
  const s=await service(t),old=await s.request();
  s.data.meta={...s.data.meta,projectContacts:{owner:{ownerRole:"Bauherr",customer:"Max Neu"}}};
  const current=await s.request();
  assert.notEqual(current.confirmation.fingerprint,old.confirmation.fingerprint);
  assert.equal((await s.save(old)).status,409);assert.equal(s.renders(),0);
});

test("veraltete Vorschau und während des Renderns geänderter Termin werden nicht abgelegt",async t=>{
  const s=await service(t),view=await s.request();
  s.data.schedule.confirmedDate="2026-10-06";
  assert.equal((await s.save(view)).status,409);assert.equal(s.renders(),0);
  const fresh=await s.request();s.data.onRender=async()=>{s.data.schedule.confirmedDate="2026-10-07"};
  assert.equal((await s.save(fresh)).status,409);
  assert.equal(s.documents().length,1);assert.equal(s.history.length,0);
});

test("neuer bestätigter Termin erhält eine neue AB-Version; alte PDF bleibt erhalten",async t=>{
  const s=await service(t),first=await s.save(await s.request());
  s.data.schedule.confirmedDate="2026-10-06";
  const second=await s.save(await s.request());
  assert.equal(second.item.confirmationRevision,2);
  assert.notEqual(first.pdfUrl,second.pdfUrl);
  assert.ok(s.documents().some(row=>row.id===first.item.id));
  assert.ok(await fs.stat(path.join(s.dataDir,"26001","_documentation",first.item.storedName)));
});

async function renderer(t){
  const dom=new JSDOM('<div id="koffer"><div class="kcv2-savebar"></div></div><input id="kofferIntro" value="Nicht gespeicherter Text"><input id="kofferScope" value="Falscher Leistungsumfang"><input id="kofferShowQty" type="checkbox" checked><div id="kofferLiveBody"><p>Unveränderte Angebotsvorschau</p></div>',{url:"http://localhost/baustellen#26001",runScripts:"outside-only"});
  t.after(()=>dom.window.close());
  dom.window.MutationObserver=class {observe(){}disconnect(){}};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};
  dom.window.URL.createObjectURL=()=>"blob:test-ab-pdf";
  dom.window.URL.revokeObjectURL=()=>{};
  let source=await fs.readFile(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8");
  const startup='  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{init();mountFreePositionUi();watchLivePreview()},{once:true});else{init();mountFreePositionUi();watchLivePreview()}';
  assert.ok(source.includes(startup));
  source=source.replace(startup,'watchLivePreview();window.offerTest={renderOrderConfirmationHtml,openOrderConfirmation,orderScheduleAction,setState(value){draft=value.draft;job=value.job;jobId=value.jobId;acceptedOrder=value.order;orderSchedule=value.schedule;scheduleEmployees=[];const editor=document.getElementById("koffer");if(editor)editor.dataset.jobId=jobId},getDraft(){return draft}};');
  dom.window.KristaDocumentTemplate=require("../public/ui/document-template");
  dom.window.eval(source);return dom.window;
}

test("AB nutzt das Angebotslayout ohne Editorwerte zu übernehmen oder das Angebot zu verändern",async t=>{
  const s=await service(t),view=await s.request(),w=await renderer(t),editor={intro:"Editor",positions:[{unitPrice:9999}]};
  w.offerTest.setState({draft:editor,job:{},jobId:"26001",order:s.data.order,schedule:s.data.schedule});
  const before=w.document.getElementById("kofferLiveBody").innerHTML;
  const html=w.offerTest.renderOrderConfirmationHtml(view),paper=new JSDOM(html).window.document;
  assert.equal(paper.querySelector("h2").textContent,"Auftragsbestätigung");
  assert.equal(paper.querySelectorAll(".koffer-paper-company-footer").length,2);
  assert.match(paper.querySelector(".koffer-paper-finish").textContent,new RegExp(CLOSING.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.match(paper.body.textContent,/307,80/);assert.match(paper.body.textContent,/05\.10\.2026/);
  assert.match(paper.body.textContent,/Gewählte Decke/);assert.doesNotMatch(paper.body.textContent,/Nicht beauftragt|Nicht gespeicherter Text|Falscher Leistungsumfang/);
  assert.equal(paper.querySelectorAll("thead th").length,4);
  assert.ok(!paper.querySelector(".koffer-paper-portal"));
  assert.equal(w.offerTest.getDraft(),editor);assert.equal(w.document.getElementById("kofferLiveBody").innerHTML,before);
});

test("Termin bestätigen übernimmt genau den gespeicherten Termin in die AB und zeigt den gemeinsamen Kalender",async t=>{
  const s=await service(t),view=await s.request(),w=await renderer(t);
  s.data.schedule.outlook={status:"failed"};view.schedule=s.data.schedule;
  w.offerTest.setState({draft:s.data.draft,job:{},jobId:"26001",order:s.data.order,schedule:{status:"requested"}});
  w.document.getElementById("koffer").insertAdjacentHTML("beforeend",'<section id="kofferOrderSchedule"><input id="kofferScheduleDate" value="2026-10-05"><input id="kofferScheduleFrom" value="07:00"><input id="kofferScheduleTo" value="17:00"><button data-schedule-action="confirm"></button></section>');
  const requests=[];w.fetch=async(url,options={})=>{requests.push({url,options});return{ok:true,blob:async()=>new w.Blob(["%PDF-test"],{type:"application/pdf"}),text:async()=>JSON.stringify(String(url).endsWith("/confirm")?{schedule:s.data.schedule,planningCreated:0,outlookSynced:false}:view)}};
  await w.offerTest.orderScheduleAction("confirm");
  assert.equal(requests.filter(row=>row.url.endsWith("/confirm")).length,1);
  assert.equal(JSON.parse(requests[0].options.body).date,"2026-10-05");
  const dialog=w.document.getElementById("kofferConfirmationDialog");assert.ok(dialog?.open,w.document.body.textContent);
  assert.match(dialog.querySelector("[data-confirmation-calendar]").textContent,/gemeinsamen KRISTINE-Kalender/);
  assert.equal(dialog.querySelector("iframe").src,"blob:test-ab-pdf");
  assert.equal(dialog.querySelector("iframe").hasAttribute("srcdoc"),false);
  assert.equal(dialog.querySelector("[data-confirmation-save]").disabled,false);
  const preview=requests.find(row=>row.url.startsWith("/admin/api/document-layout/render"));assert.ok(preview);assert.match(preview.options.body,/Bestätigter Termin/);
  assert.equal(requests.filter(row=>row.url.endsWith("/pdf")).length,0);
});

test("gespeicherte AB wird als Original-PDF angezeigt; fehlerhafte Vorschau kann nicht abgelegt werden",async t=>{
  const s=await service(t),view=await s.request(),w=await renderer(t);
  w.offerTest.setState({draft:s.data.draft,job:{},jobId:"26001",order:s.data.order,schedule:s.data.schedule});
  const saved={...view,item:{id:"stored"},pdfUrl:"/admin/api/job/26001/documentation/file?name=ab.pdf"},requests=[];
  w.fetch=async(url,options={})=>{requests.push({url,options});return{ok:true,text:async()=>JSON.stringify(saved)}};
  await w.offerTest.openOrderConfirmation();
  assert.equal(requests.length,1);assert.match(w.document.querySelector("#kofferConfirmationDialog iframe").src,/documentation\/file\?name=ab\.pdf/);
  w.fetch=async url=>String(url).startsWith("/admin/api/document-layout/render")?{ok:false,json:async()=>({error:"Test Renderfehler"})}:{ok:true,text:async()=>JSON.stringify(view)};
  await w.offerTest.openOrderConfirmation();
  const dialog=w.document.getElementById("kofferConfirmationDialog");assert.equal(dialog.querySelector("[data-confirmation-save]").disabled,true);assert.match(dialog.querySelector("[data-confirmation-status]").textContent,/Test Renderfehler/);
});
