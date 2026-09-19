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
  const ab={id:"ab",name:"Auftragsbestätigung.pdf",storedName:"ab.pdf",source:"order-confirmation",customerVisible:true,fingerprint:"one"};
  assert.equal(documentChanges([], [{...ab,customerVisible:false}]).length,0);
  assert.equal(documentChanges([ab], [{...ab,importedAt:"neuer Cachezeitpunkt"}]).length,0);
  const events=documentChanges([], [ab]);assert.equal(events.length,1);assert.equal(events[0].audience,"customer");assert.match(events[0].title,/Auftragsbestätigung/);
  assert.equal(documentChanges([ab], [{...ab,fingerprint:"two"}]).length,1);
  assert.equal(documentChanges([], [{id:"regie-1",type:"regie_report",name:"Regiebericht"}])[0].module,"regie");
});
test("Neue Kundenrückmeldung geht ausschließlich an den Büro-Empfänger",async t=>{
  const f=await fixture(t),result=await f.service.publish("26100",{key:"point:one",audience:"office",title:"Neuer Terminwunsch",text:"Bitte am 5. Oktober."});
  assert.equal(result.deliveries[0].recipient,"Alex");assert.match(f.sent[0].text,/Neue Kundenrückmeldung/);assert.equal(result.sent,true);
});
