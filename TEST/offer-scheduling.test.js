"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {JSDOM}=require("jsdom");
const {cleanOfferSchedule,customerOfferSchedule,applyAcceptedSchedule}=require("../offer-scheduling");
const {buildAcceptedOrder}=require("../offer-order-workflow");

test("Kundenwunsch erfordert ein Datum, ein vereinbarter Termin kommt ausschließlich aus dem Angebot",()=>{
  assert.throws(()=>customerOfferSchedule({offerSchedule:{mode:"customer_request"}},""),/Wunschtermin/);
  assert.throws(()=>cleanOfferSchedule({mode:"fixed",date:"2026-02-30",from:"07:00",to:"17:00"}),/gültigen/);
  const terms={mode:"fixed",date:"2026-10-05",from:"07:00",to:"17:00"};
  assert.deepEqual(customerOfferSchedule({offerSchedule:terms},"2026-12-01"),{offerSchedule:terms,preferredDate:""});
  assert.equal(customerOfferSchedule({},"").preferredDate,"");
});

test("Annahme übernimmt den vereinbarten Termin; Wünsche und bereits bestätigte Termine bleiben getrennt",async()=>{
  const order=buildAcceptedOrder({jobId:"26100",draft:{offerSchedule:{mode:"fixed",date:"2026-10-05",from:"07:00",to:"17:00"}},acceptedBy:{id:"customer-portal:customer"}}),calls=[];
  const deps={read:async()=>({status:"none"}),request:async(...args)=>{calls.push(["request",...args]);return {status:"requested"}},confirm:async(...args)=>{calls.push(["confirm",...args]);return {status:"confirmed"}}};
  assert.equal((await applyAcceptedSchedule(order,deps)).status,"confirmed");
  assert.equal(calls[0][2].date,"2026-10-05");assert.equal(calls[0][3].notifyCustomer,false);
  await applyAcceptedSchedule(order,{...deps,read:async()=>({status:"confirmed",confirmedDate:"2026-10-09"})});assert.equal(calls.length,1);
  await applyAcceptedSchedule({...order,offerSchedule:{mode:"customer_request"},customerRequest:{requestedDate:"2026-10-07"}},deps);
  assert.equal(calls[1][0],"request");assert.equal(calls[1][2],"2026-10-07");
});

function ui(t){
  const dom=new JSDOM('<!doctype html><div id="koffer"></div>',{url:"https://example.test/kristine/baustellen",runScripts:"outside-only"});t.after(async()=>{await new Promise(resolve=>setImmediate(resolve));dom.window.close()});
  const w=dom.window;w.MutationObserver=class {observe(){}disconnect(){}};w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(value){this.returnValue=value;this.open=false;this.dispatchEvent(new w.Event("close"))};
  let source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8");
  const startup='  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{init();mountFreePositionUi();watchLivePreview()},{once:true});else{init();mountFreePositionUi();watchLivePreview()}';
  source=source.replace('  async function acceptOffer(){','  window.chooseAcceptedForTest=chooseAcceptedAlternatives;\n  async function acceptOffer(){');
  assert.ok(source.includes(startup));source=source.replace(startup,'window.flowTest={chooseOfferSchedule,chooseAcceptedAlternatives:window.chooseAcceptedForTest,setState(value){draft=value.draft||{};scheduleEmployees=value.employees||[];orderSchedule=value.schedule||null}};');w.eval(source);return w;
}
test("Manuelle Übernahme fragt Datum, Uhrzeit und Mitarbeiter und trennt diese von Alternativpositionen",async t=>{
  const w=ui(t);w.flowTest.setState({employees:[{id:"person-1",name:"Test Mitarbeiter"}]});
  const pending=w.flowTest.chooseAcceptedAlternatives([{id:"alt-1",text:"Zusatzposition"}]),form=w.document.querySelector("#kofferAcceptDialog form");
  assert.match(form.textContent,/Wann führen wir den Auftrag aus/);assert.doesNotMatch(form.textContent,/Terminwunsch des Kunden/);
  form.elements.date.value="2026-10-12";form.elements.from.value="08:00";form.elements.to.value="16:00";
  form.dispatchEvent(new w.SubmitEvent("submit",{cancelable:true}));assert.match(form.textContent,/mindestens einen Mitarbeiter/);
  form.querySelector('[data-order-employee]').checked=true;form.querySelector('[data-order-alternative]').checked=true;
  form.dispatchEvent(new w.SubmitEvent("submit",{cancelable:true}));const result=JSON.parse(JSON.stringify(await pending));
  assert.deepEqual(result,{selectedAlternativeIds:["alt-1"],confirmedSchedule:{date:"2026-10-12",from:"08:00",to:"16:00",employeeIds:["person-1"]}});
});
test("Versand fragt ausdrücklich nach vereinbartem Termin oder Kundenwunsch und erlaubt Abbruch",async t=>{
  const w=ui(t);w.flowTest.setState({});const pending=w.flowTest.chooseOfferSchedule(),dialog=w.document.querySelector("dialog"),form=dialog.querySelector("form");
  assert.equal(form.querySelectorAll('[name="offerScheduleMode"]').length,2);assert.equal(form.querySelector('[name="offerScheduleMode"]:checked'),null);
  const fixed=form.querySelector('[value="fixed"]');fixed.checked=true;fixed.dispatchEvent(new w.Event("change",{bubbles:true}));
  form.elements.date.value="2026-10-05";form.elements.from.value="08:00";form.elements.to.value="07:00";form.dispatchEvent(new w.SubmitEvent("submit",{cancelable:true}));assert.match(dialog.textContent,/Endzeit muss nach/);
  dialog.close("cancel");assert.equal(await pending,null);
});
