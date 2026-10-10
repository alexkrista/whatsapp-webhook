"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const { completeProjectContacts, mergeContactKnowledge } = require("../project-contact-knowledge");
const { resolveDocumentRecipient } = require("../document-recipient");
const server = fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
const sandbox = { cleanProjectContactExtras: rows => rows || [] };
vm.createContext(sandbox);
vm.runInContext(server.slice(server.indexOf("function sanitizeProjectContacts("),server.indexOf("function cleanOperationalDate(")),sandbox);
const master = {name:"Frau Hutter",phone:"+436645453667",email:"brigitte.hutter@vorarlberg.at",address:"In der Halde, 30, 6700 Bludenz"};
const blank = sandbox.sanitizeProjectContacts({},{});

test("Neue Baustelle übernimmt gespeicherten Kunden auch bei vorinitialisierten leeren Kontaktfeldern",()=>{
 const meta={customerMaster:master,projectContacts:blank};
 const contacts=sandbox.sanitizeProjectContacts(completeProjectContacts(blank,undefined,meta),meta);
 assert.equal(contacts.owner.customer,"Frau Hutter");assert.equal(contacts.owner.womanTitle,"Frau");assert.equal(contacts.owner.womanLastName,"Hutter");assert.equal(contacts.owner.womanFirstName,"");
 assert.equal(contacts.owner.phoneOwnerWoman,master.phone);assert.equal(contacts.owner.womanEmail,master.email);
 assert.equal(contacts.owner.residentialHouseNumber,"30");assert.equal(contacts.owner.residentialPostalCode,"6700");assert.equal(contacts.owner.residentialCity,"Bludenz");
 const recipient=resolveDocumentRecipient({...meta,projectContacts:contacts});
 assert.deepEqual([...recipient.nameLines],["Frau Hutter"]);assert.deepEqual([...recipient.addressLines],["In der Halde 30","6700 Bludenz"]);
});

test("Ergänzung bewahrt Kontakt-ID, vorhandene Angaben, getrennte Rollen und Empfängerauswahl",()=>{
 const old={owner:{masterContactId:"existing",customer:"Frau Hutter",womanFirstName:"Brigitte",womanLastName:"Hutter",phoneOwnerWoman:"known",residentialStreet:"Wohnweg",residentialHouseNumber:"8",residentialPostalCode:"6800",residentialCity:"Feldkirch"},architect:{company:"Planbüro",email:"a@example.at"},deliveryRecipients:{offer:{owner:false,architect:true}}};
 const contacts=completeProjectContacts(old,{owner:{customer:"",womanFirstName:"",womanLastName:"",womanEmail:"new@example.at"},architect:{company:"",email:""}}, {customerMaster:master});
 assert.equal(contacts.owner.masterContactId,"existing");assert.equal(contacts.owner.womanFirstName,"Brigitte");assert.equal(contacts.owner.phoneOwnerWoman,"known");assert.equal(contacts.owner.womanEmail,"new@example.at");assert.equal(contacts.owner.residentialStreet,"Wohnweg");assert.equal(contacts.owner.residentialPostalCode,"6800");assert.equal(contacts.architect.email,"a@example.at");assert.equal(contacts.deliveryRecipients.offer.owner,false);
 assert.equal(mergeContactKnowledge(master,{phone:"",email:"updated@example.at"}).phone,master.phone);
});

test("Eine Baustellenadresse allein wird nicht als abweichende Wohnadresse erfunden",()=>{
 const pc=completeProjectContacts({},undefined,{contactName:"Firma Muster",street:"Baustellenweg",houseNumber:"9",postalCode:"6700",city:"Bludenz"});
 assert.equal(pc.owner.residentialStreet,"");
 const other=completeProjectContacts({owner:{customer:"Andere Kundin"}},undefined,{customerMaster:master});assert.equal(other.owner.womanEmail,undefined);
});

test("Realer Speicherweg ergänzt die Bauherrschaft vor dem dauerhaften Kontaktstamm",async()=>{
 const writer=server.slice(server.indexOf("async function writeJobMeta("),server.indexOf("function sanitizeFileNamePart("));
 let captured, stored;
 Object.assign(sandbox,{completeProjectContacts,mergeContactKnowledge,isSafeJobId:()=>true,readJobMeta:async()=>({name:"Hutter",notes:"Wissen behalten",customerMaster:master,projectContacts:blank}),cleanOperationalDate:v=>v||"",cleanOrderScheduleMeta:v=>v||{},cleanSurfaceMaterialMeta:v=>v||[],cleanHoursOverlapKeys:v=>v||[],cleanCollectionMemberJobIds:v=>v||[],cleanWwProjectLinks:v=>v||[],sanitizeCustomerPortal:(_v,old)=>old||{},contactMasterStore:{captureJob:async(_id,meta)=>{captured=meta;return {owner:"existing-contact"}}},ensureDir:async()=>{},path,DATA_DIR:"/unused-test",metaPathForJob:()=>"/unused-test/meta.json",fsp:{writeFile:async(_path,data)=>{stored=JSON.parse(data)}}});
 vm.runInContext(writer,sandbox);
 await sandbox.writeJobMeta("26107",{projectContacts:{owner:{womanEmail:"updated@example.at"}}});
 assert.equal(captured.projectContacts.owner.residentialHouseNumber,"30");
 assert.equal(stored.projectContacts.owner.masterContactId,"existing-contact");
 assert.equal(stored.projectContacts.owner.womanEmail,"updated@example.at");
 assert.equal(stored.notes,"Wissen behalten");
 assert.equal(stored.name,"Hutter");
});
