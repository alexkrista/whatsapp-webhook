"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {JSDOM}=require("jsdom");
function harness(t,fetchImpl){
  const dom=new JSDOM('<div id="bkMasterData"></div><div id="bkProtocols"></div>',{url:"https://app.example.at/baustellen.html",runScripts:"outside-only"});t.after(()=>dom.window.close());
  dom.window.fetch=fetchImpl||(async()=>({ok:true,text:async()=>"{}"}));
  let source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-knowledge-hub.js"),"utf8");
  source=source.replace('if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();','');
  source=source.replace('window.BaustellenKnowledgeHub={','window.BaustellenKnowledgeHub={renderMasterDataEditor,renderMasterData,mailCard,askMailContacts,api,');
  dom.window.eval(source);
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};dom.window.HTMLDialogElement.prototype.close=function(){this.dispatchEvent(new dom.window.Event("close"))};
  return {window:dom.window,document:dom.window.document,ui:dom.window.BaustellenKnowledgeHub};
}
const job=()=>({jobId:"26101",name:"Musterauftrag",street:"Baustellenweg",houseNumber:"5",postalCode:"6800",city:"Feldkirch",wwAddressId:"4711",wwCustomerNumber:"1200",customerMaster:{wwAddressId:"4711",email:"person@example.at"},projectContacts:{owner:{ownerRole:"Firma",customer:"Beispiel",website:"https://example.at/",womanTitle:"Firma",womanLastName:"Beispiel",manLastName:"Beispiel",womanEmail:"person@example.at",phoneOwnerMan:"05555 123"},siteManager:{},architect:{}}});
test("Firmenmaske hat optionale Personen; Übernahme und Speichern bewahren Mail, WW-Link und Quelle",async t=>{
  const requests=[],company={legalName:"Beispiel GmbH",street:"Firmenweg",houseNumber:"24",postalCode:"6890",city:"Lustenau",uid:"ATU12345678",email:"office@example.at",phone:"05555 999",website:"https://example.at/",sourceUrl:"https://example.at/impressum",sourceCheckedAt:"2026-09-19T20:00:00Z",contacts:[{title:"DI",firstName:"Eva",lastName:"Muster",role:"Projektleitung",email:"eva@example.at",phone:"05555 777"}]};
  const {document:d,ui}=harness(t,async(url,options)=>{const body=options?.body?JSON.parse(options.body):null;requests.push({url,body});return {ok:true,text:async()=>JSON.stringify(url.includes("company-lookup")?{companies:[company]}:{meta:body})}});
  const j=job();ui.renderMasterDataEditor(j);
  assert.equal(d.getElementById("bkCompanyPeople").hidden,false);assert.equal(d.getElementById("bkCompanyPeople").open,false);
  assert.equal(d.getElementById("bkOwnerWomanLastName").value,"");assert.equal(d.getElementById("bkOwnerManLastName").value,"");assert.equal(d.getElementById("bkOwnerWomanPhone").value,"05555 123");
  await d.getElementById("bkOwnerLookupWeb").onclick();assert.equal(requests[0].body.query,"Beispiel");assert.equal(requests[0].body.website,"https://example.at/");
  d.querySelector("[data-company-index]").click();assert.equal(d.getElementById("bkOwnerCustomer").value,"Beispiel GmbH");assert.equal(d.getElementById("bkOwnerWomanEmail").value,"person@example.at");assert.equal(d.getElementById("bkOwnerWomanPhone").value,"05555 123");assert.equal(d.getElementById("bkHomeCity").value,"Lustenau");assert.equal(d.getElementById("bkOwnerManFirstName").value,"Eva");assert.equal(d.getElementById("bkOwnerManEmail").value,"eva@example.at");
  d.getElementById("bkOwnerWomanFirstName").value="Eva";d.getElementById("bkOwnerWomanLastName").value="Muster";
  await d.getElementById("bkSaveMaster").onclick();const saved=requests.at(-1).body;
  assert.equal(saved.wwAddressId,"4711");assert.equal(saved.contactName,"Beispiel GmbH");assert.equal(saved.contactEmail,"person@example.at");assert.equal(saved.projectContacts.owner.manLastName,"Muster");assert.equal(saved.projectContacts.owner.manEmail,"eva@example.at");assert.equal(saved.projectContacts.owner.womanFirstName,"Eva");assert.equal(saved.projectContacts.owner.uid,"ATU12345678");assert.equal(saved.customerMaster.uid,"ATU12345678");assert.equal(saved.projectContacts.owner.sourceUrl,company.sourceUrl);assert.equal(saved.street,"Baustellenweg");
  assert.match(d.getElementById("bkMasterData").textContent,/Firmenadresse/);assert.match(d.getElementById("bkMasterData").textContent,/Eva Muster/);
});
test("Andere Metadaten speichern verändert keine Kontakte; Wechsel Firma/Privat verliert keine Felder",async t=>{
  let sent;const {document:d,ui}=harness(t,async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,text:async()=>"{}"}});
  ui.renderMasterDataEditor(job());d.getElementById("bkOwnerRole").value="Familie";d.getElementById("bkOwnerRole").onchange();assert.equal(d.getElementById("bkCompanyPeople").hidden,true);assert.equal(d.getElementById("bkOwnerWomanEmail").value,"person@example.at");
  await ui.api("/admin/api/job/26101/meta",{method:"PUT",body:JSON.stringify({regieHourlyRate:80})});assert.deepEqual(sent,{regieHourlyRate:80});
});
test("Mailkarte verlinkt Word; bekannte Mailadresse ohne Nachfrage; neue erst nach Bestätigung",async t=>{
  const calls=[];const {document:d,ui}=harness(t,async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,text:async()=>JSON.stringify({meta:{contactEmail:"neu@example.at",projectContacts:{owner:{womanEmail:"neu@example.at"}}}})}});
  const mail={id:"m1",name:"Arbeiten.msg",url:"/mail.msg",fromEmail:"person@example.at",attachments:[{name:"Arbeiten.docx",url:"/Arbeiten.docx",kind:"attachment",size:1024}]},j=job();
  const holder=d.createElement("div");holder.innerHTML=ui.mailCard(mail,j);assert.ok(holder.querySelector('a[download="Arbeiten.docx"]'));assert.equal(holder.querySelector("[data-mail-save-address]"),null);
  await ui.askMailContacts(j,[mail]);assert.equal(d.querySelector("dialog"),null);assert.equal(calls.length,0);
  const pending=ui.askMailContacts(j,[{...mail,fromEmail:"neu@example.at"},{...mail,id:"m2",fromEmail:"neu@example.at"}]);assert.equal(d.querySelectorAll("[data-mail-contact-row]").length,1);assert.equal(calls.length,0);
  const button=d.querySelector("[data-mail-contact-save]");await button.onclick({currentTarget:button});await pending;assert.equal(calls[0].expectedEmail,"person@example.at");assert.equal(calls[0].confirmed,true);assert.equal(j.contactEmail,"neu@example.at");
});
test("Backend bildet aus Firma keine zwei Personen und erhält UID und Ansprechpartner",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8"),start=source.indexOf("function sanitizeProjectContacts("),end=source.indexOf("function cleanOperationalDate",start),context={cleanProjectContactExtras:rows=>rows||[]};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const result=context.sanitizeProjectContacts({owner:{ownerRole:"Firma",customer:"Beispiel",womanLastName:"Beispiel",manLastName:"Beispiel",uid:"ATU12345678"}});assert.equal(result.owner.sharedLastName,"");assert.equal(result.owner.womanLastName,"");assert.equal(result.owner.manLastName,"");assert.equal(result.owner.uid,"ATU12345678");
  const named=context.sanitizeProjectContacts({owner:{ownerRole:"Firma",customer:"Beispiel",womanFirstName:"Eva",womanLastName:"Beispiel"}});assert.equal(named.owner.womanLastName,"Beispiel");
});

test("Angebot und AB nennen bei Firmen die Firma vor optionalen Ansprechpartnern",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8"),start=source.indexOf("  function offerRecipientNames("),end=source.indexOf("\n  function offerAddressBlock",start),context={job:{}};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  assert.deepEqual(Array.from(context.offerRecipientNames({ownerRole:"Firma",customer:"Beispiel GmbH",womanFirstName:"Eva",womanLastName:"Muster"},{})),["Beispiel GmbH","z. H. Frau Eva Muster"]);
  assert.deepEqual(Array.from(context.offerRecipientNames({ownerRole:"Firma",customer:"Beispiel GmbH",womanLastName:"Beispiel GmbH",manLastName:"Beispiel GmbH"},{})),["Beispiel GmbH"]);
  assert.deepEqual(Array.from(context.offerRecipientNames({ownerRole:"Bauherrschaft",womanFirstName:"Brigitte",womanLastName:"Baldauf",manFirstName:"Brigitte",manLastName:"Baldauf"},{})),["Frau Brigitte Baldauf"]);
});
