"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {readJobOfferSource,readJobCalculation,scheduleWithOfferRequest,restoreCustomerAcceptedOrders}=require("../job-offer-source");
const {buildAcceptedOrder,buildOrderCalculation}=require("../offer-order-workflow");
const draft={offerNumber:"2609002",offerRevision:1,offerType:"regie_material",positions:[{id:"labor",text:"Regiearbeit",quantity:20,unit:"Std",unitPrice:75},{id:"material",text:"Material",quantity:1,unit:"PA",unitPrice:300}]};
const acceptance={status:"accepted",offerNumber:"2609002",offerRevision:1,acceptedAt:"2026-09-18T10:22:00Z",preferredDate:"2026-10-05",paymentTerm:"skonto5_2",customerName:"Beispiel"};
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),"job-offer-source-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,"26100/_offers"),{recursive:true});const write=(name,data)=>fs.writeFile(path.join(dir,"26100",name),JSON.stringify(data));await write(".meta.json",{status:"Auftrag"});return {dir,write}}

test("frühere Kundenannahme liefert Stunden und Termin aus unveränderlicher Angebotsfassung",async t=>{
  const {dir,write}=await fixture(t);await write("_offers/offer-2609002-v1.json",{...draft,customerAcceptance:acceptance});
  await write(".offer-draft.json",{...draft,offerRevision:2,positions:[{...draft.positions[0],quantity:99}]});
  const source=await readJobOfferSource(dir,"26100",{allowDraft:true}),calc=await readJobCalculation(dir,"26100");
  assert.equal(source.accepted,true);assert.equal(calc.positions[0].plannedHours,20);assert.equal(source.order.financials.paymentTerm,"skonto5_2");
  const schedule=scheduleWithOfferRequest({},source.order,"26100");assert.equal(schedule.requestedDate,"2026-10-05");assert.equal(schedule.status,"requested");assert.equal(schedule.appointmentId,"");
  assert.equal(scheduleWithOfferRequest({status:"confirmed",confirmedDate:"2026-10-08"},source.order,"26100").confirmedDate,"2026-10-08");
  assert.equal(scheduleWithOfferRequest({status:"proposed",proposedDate:"2026-10-09"},source.order,"26100").proposedDate,"2026-10-09");
  await assert.rejects(fs.stat(path.join(dir,"26100/.accepted-order.json")),{code:"ENOENT"});
});

test("manueller Auftrag erhält Angebotsstunden, ohne eine Kundenannahme zu erfinden",async t=>{
  const {dir,write}=await fixture(t);await write(".offer-draft.json",{...draft,positions:[{...draft.positions[0],quantity:18},draft.positions[1]]});
  assert.equal((await readJobCalculation(dir,"26100")).positions[0].plannedHours,18);
  assert.equal(await readJobOfferSource(dir,"26100"),null);
  await write(".meta.json",{status:"Angebot"});assert.equal(await readJobCalculation(dir,"26100"),null);
});

test("vorhandene Kalkulation und verbindlicher Auftrag bleiben führend",async t=>{
  const {dir,write}=await fixture(t);const order=buildAcceptedOrder({draft,jobId:"26100"});await write(".accepted-order.json",order);
  const calc=buildOrderCalculation(order);calc.positions[0].plannedHours=24;await write(".order-calculation.json",calc);
  await write(".offer-draft.json",{...draft,positions:[{...draft.positions[0],quantity:99}]});
  assert.equal((await readJobCalculation(dir,"26100")).positions[0].plannedHours,24);assert.equal((await readJobOfferSource(dir,"26100")).order.positions[0].quantity,20);
});

test("bestehende Kundenannahmen werden einmal vervollständigt; Status und manuelle Kalkulation bleiben erhalten",async t=>{
  const {dir,write}=await fixture(t);await write("_offers/offer-2609002-v1.json",{...draft,customerAcceptance:acceptance});
  await write(".meta.json",{status:"Laufend"});await write(".order-calculation.json",{netTotal:900,positions:[{id:"manual",plannedHours:24}]});
  assert.deepEqual(await restoreCustomerAcceptedOrders(dir),{restored:1});
  assert.deepEqual(await restoreCustomerAcceptedOrders(dir),{restored:0});
  const order=JSON.parse(await fs.readFile(path.join(dir,"26100/.accepted-order.json"),"utf8"));assert.equal(order.customerRequest.requestedDate,"2026-10-05");
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,"26100/.meta.json"),"utf8")).status,"Laufend");
  assert.equal((await readJobCalculation(dir,"26100")).positions[0].plannedHours,24);
});
