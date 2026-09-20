"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createCompanyLookup,parseCompanies}=require("../company-lookup");
const company={legalName:"Beispiel GmbH",street:"Marktstraße",houseNumber:"3",postalCode:"6800",city:"Feldkirch",country:"Österreich",uid:"ATU 12345678",email:"Office@Beispiel.at",phone:"+43 5555 123",website:"https://beispiel.at/",sourceUrl:"https://beispiel.at/impressum",contacts:[{title:"DI",firstName:"Eva",lastName:"Muster",role:"Projektleitung",email:"Eva@Beispiel.at",phone:"+43 1 2"}]};
const response=companies=>({output:[{type:"web_search_call",action:{sources:[{url:company.sourceUrl}]}},{type:"message",content:[{type:"output_text",text:JSON.stringify({companies})}]}]});
test("Firmensuche liefert belegte öffentliche Daten und verwirft unbelegte oder fremde Quellen",()=>{
  const result=parseCompanies(response([company,{...company,sourceUrl:"https://beispiel.at/erfunden"},{...company,website:"https://andere-firma.at"},{...company,sourceUrl:"javascript:alert(1)"}]));
  assert.equal(result.length,1);assert.equal(result[0].uid,"ATU12345678");assert.equal(result[0].email,"office@beispiel.at");assert.equal(result[0].contacts[0].email,"eva@beispiel.at");
  assert.equal(parseCompanies(response([{...company,uid:"ATU123"}]))[0].uid,"");
});
test("Websuche wird erzwungen; gleiche Suche wiederverwendet statt doppelt berechnet",async()=>{
  let calls=0;
  const lookup=createCompanyLookup({apiKey:"test-only",fetchImpl:async(url,options)=>{calls++;assert.equal(url,"https://api.openai.com/v1/responses");const request=JSON.parse(options.body),input=JSON.parse(request.input);assert.equal(request.store,false);assert.equal(request.tool_choice,"required");assert.equal(request.tools[0].type,"web_search");assert.equal(input.company,"Beispiel");assert.equal(input.officialWebsite,"https://beispiel.at/");return {ok:true,json:async()=>response([company])}}});
  const [a,b]=await Promise.all([lookup("Beispiel","Feldkirch","https://beispiel.at/"),lookup("Beispiel","Feldkirch","https://beispiel.at/")]);assert.deepEqual(a,b);await lookup("Beispiel","Feldkirch","https://beispiel.at/");assert.equal(calls,1);
});
test("Nicht verfügbare Suche und ungültige Eingaben liefern verständliche Fehler",async()=>{
  await assert.rejects(createCompanyLookup({apiKey:""})("Beispiel"),{status:503});
  await assert.rejects(createCompanyLookup({apiKey:"test-only"})(""),{status:400});
  await assert.rejects(createCompanyLookup({apiKey:"test-only",fetchImpl:async()=>({ok:false,status:429})})("Beispiel"),{status:429});
  assert.throws(()=>parseCompanies({output:[]}),{status:502});
});
