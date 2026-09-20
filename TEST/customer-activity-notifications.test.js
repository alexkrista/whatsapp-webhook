"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {createActivityNotifications,documentChanges}=require("../customer-activity-notifications");
async function fixture(t,overrides={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"customer-notices-"));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));const sent=[];
  const options={dataDir,recipients:async(_id,event)=>[{name:event.audience==="office"?"Alex":"Testkunde",email:"test@example.test",phone:"+430000000"}],sendMail:async message=>{sent.push(message);return {accepted:[message.to]}},sendWhatsApp:async message=>sent.push(message),...overrides};
  return {sent,options,service:createActivityNotifications(options)};
}
test("Ein Ereignis wird bei parallelem Speichern und nach Neustart nur einmal versendet",async t=>{
  const f=await fixture(t),event={key:"order-confirmation:one",audience:"customer",title:"AB in Ihrer Akte",text:"Die AB ist verfügbar."};
  const results=await Promise.all([f.service.publish("26100",event),f.service.publish("26100",event)]);assert.equal(f.sent.length,1);assert.ok(results.every(row=>row.sent));
  await createActivityNotifications(f.options).publish("26100",event);assert.equal(f.sent.length,1);assert.equal((await f.service.list("26100")).length,1);
});
test("E-Mail-Fehler nutzt WhatsApp; fehlende Empfänger bleiben sichtbar und erhalten keine Nachricht",async t=>{
  const f=await fixture(t,{sendMail:async()=>{throw new Error("SMTP offline")}}),event={key:"schedule:1",audience:"customer",title:"Terminwunsch bestätigt"};
  const result=await f.service.publish("26100",event);assert.equal(result.sent,true);assert.deepEqual(result.channels,["WhatsApp"]);
  const blocked=await createActivityNotifications({...f.options,recipients:async()=>{throw new Error("Kundenportal ist nicht freigegeben")}}).publish("26100",{...event,key:"blocked"});
  assert.equal(blocked.sent,false);assert.match(blocked.error,/nicht freigegeben/);assert.equal(f.sent.length,1);
});
test("Neue freigegebene Dokumente melden, unveränderte und interne Dokumente nicht",()=>{
  const ab={id:"ab",type:"order",name:"Auftragsbestätigung.pdf",storedName:"ab.pdf",source:"order-confirmation",customerVisible:true,confirmationNumber:"AB-2609001",confirmationRevision:1,fingerprint:"one"};
  assert.equal(documentChanges([], [{...ab,customerVisible:false}]).length,0);
  assert.equal(documentChanges([ab], [{...ab,importedAt:"neuer Cachezeitpunkt"}]).length,0);
  const events=documentChanges([], [ab]);assert.equal(events.length,1);assert.equal(events[0].audience,"customer");assert.match(events[0].title,/Auftragsbestätigung/);
  assert.equal(documentChanges([ab], [{...ab,fingerprint:"two",renderedAt:"neuer Renderzeitpunkt"}]).length,0);
  assert.equal(documentChanges([ab], [{...ab,confirmationRevision:2}]).length,1);
  const generic={id:"plan",type:"pdf",name:"Farbplan.pdf",storedName:"farbplan.pdf",customerVisible:true,fingerprint:"one"};
  assert.equal(documentChanges([generic], [{...generic,fingerprint:"two"}]).length,1);
  assert.equal(documentChanges([generic], [{...generic,name:"Farbplan umbenannt.pdf",renderedAt:"neuer Cachezeitpunkt"}]).length,0);
  assert.equal(documentChanges([], [{...generic,customerVisible:false}]).length,0);
  assert.equal(documentChanges([], [{...generic,customerVisible:undefined}]).length,0);
  assert.equal(documentChanges([], [{id:"regie-1",type:"regie_report",name:"Regiebericht"}])[0].module,"regie");
  assert.equal(documentChanges([], [{id:"regie-intern",type:"regie_report",name:"Interner Regiebericht",customerVisible:false}]).length,0);
  assert.equal(documentChanges([], [ab,{...ab,id:"ab-duplicate",renderedAt:"später"}]).length,1);
});
test("Drei Render derselben Angebotsversion senden eine Mail, eine neue Revision genau eine weitere",async t=>{
  const f=await fixture(t),jobId="26101",offer={id:"offer",type:"offer",name:"Angebot 2609001.pdf",storedName:"angebot-2609001-v1.pdf",customerVisible:true,offerNumber:"2609001",offerRevision:1};
  let before=[];
  for(const [index,time] of ["10:00","10:01","10:02"].entries()){
    const after=[{...offer,source:index===2?"offer-approved-original":"offer-browser-render",renderedAt:`2026-09-20T${time}:00Z`,approvedAt:index===2?"2026-09-20T10:02:00Z":""}];
    await f.service.documents(jobId,before,after);before=after;
  }
  assert.equal(f.sent.length,1);
  const revised={...offer,offerRevision:2,storedName:"angebot-2609001-v2.pdf",renderedAt:"2026-09-20T11:00:00Z"};
  await f.service.documents(jobId,before,[revised]);assert.equal(f.sent.length,2);
  await createActivityNotifications(f.options).documents(jobId,[],[{...revised,renderedAt:"2026-09-20T11:05:00Z"}]);assert.equal(f.sent.length,2);
});
test("Drei Render derselben AB-Version senden eine Mail, eine neue Revision genau eine weitere",async t=>{
  const f=await fixture(t),jobId="26102",confirmation={id:"ab-one",type:"order",source:"order-confirmation",name:"Auftragsbestätigung AB-2609001.pdf",storedName:"auftragsbestaetigung-AB-2609001-v1.pdf",customerVisible:true,confirmationNumber:"AB-2609001",confirmationRevision:1,fingerprint:"first"};
  let before=[];
  for(let index=0;index<3;index++){
    const after=[{...confirmation,id:`ab-render-${index}`,fingerprint:`render-${index}`,renderedAt:`2026-09-20T12:0${index}:00Z`}];
    await f.service.documents(jobId,before,after);before=after;
  }
  assert.equal(f.sent.length,1);
  const revised={...confirmation,id:"ab-two",fingerprint:"second-version",confirmationRevision:2,storedName:"auftragsbestaetigung-AB-2609001-v2.pdf",renderedAt:"2026-09-20T13:00:00Z"};
  await f.service.documents(jobId,before,[revised]);assert.equal(f.sent.length,2);
  await f.service.documents(jobId,[revised],[{...revised,renderedAt:"2026-09-20T13:05:00Z"}]);assert.equal(f.sent.length,2);
});
test("Regieberichte bleiben über Synchronisierungen stabil und interne Dokumente lösen keine Mail aus",async t=>{
  const f=await fixture(t),jobId="26103",report={id:"ww-regie-local",type:"regie_report",source:"WW",sourceId:"rapport-77",reportNumber:"R-77",name:"Regiebericht R-77",syncedAt:"2026-09-20T14:00:00Z"};
  await f.service.documents(jobId,[],[report]);assert.equal(f.sent.length,1);
  const enriched={...report,source:"WW-Neu",sourceId:"rapport-enriched",syncedAt:"2026-09-20T14:05:00Z",changedAt:"2026-09-20T14:04:00Z",totalHours:8};
  await f.service.documents(jobId,[report],[enriched]);assert.equal(f.sent.length,1);
  const internal={id:"internal-note",type:"pdf",name:"Interne Notiz.pdf",storedName:"interne-notiz.pdf",customerVisible:false};
  await f.service.documents(jobId,[enriched],[enriched,internal]);assert.equal(f.sent.length,1);
});
test("Neue Kundenrückmeldung geht ausschließlich an den Büro-Empfänger",async t=>{
  const f=await fixture(t),result=await f.service.publish("26100",{key:"point:one",audience:"office",title:"Neuer Terminwunsch",text:"Bitte am 5. Oktober."});
  assert.equal(result.deliveries[0].recipient,"Alex");assert.match(f.sent[0].text,/Neue Kundenrückmeldung/);assert.equal(result.sent,true);
});
