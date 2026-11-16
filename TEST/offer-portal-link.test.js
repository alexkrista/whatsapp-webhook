"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const file=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8");
const from=file.indexOf("  function offerDispatchText("),to=file.indexOf("  function normalizeOfferPhone(",from);
test("Offer email and WhatsApp always include project URL before login credentials",()=>{
 assert(from>=0&&to>from);
 const source=file.slice(from,to);
 const render=new Function("offerPortalCredentials","draft","scheduleDateLabel",source+";return offerDispatchText;");
 const make=render({loginName:"Gabriele Längle",startPassword:"TESTPASS"},{offerNumber:"2611003",offerSchedule:{mode:"customer_request"}},()=> "morgen");
 for(const mode of ["email","whatsapp"]){
   const body=make(mode,{name:"Frau Längle"});
   const i=body.indexOf("https://protokoll.krista.at/kundenportal");
   assert(i>0);
   assert(body.indexOf("Anmeldung zur Projektakte")<i);
   assert(i<body.indexOf("Benutzername: Gabriele Längle"));
   assert(body.includes("Startpasswort: TESTPASS"));
 }
});
test("Offer send UI indicates links really are included",()=>{
 assert(file.includes("E-Mail und WhatsApp enthalten den Link zur Projektakte."));
 assert(!file.includes("E-Mail ohne Link geöffnet."));
 assert(!file.includes("WhatsApp ohne Link geöffnet."));
});
