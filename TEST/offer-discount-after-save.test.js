"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{JSDOM}=require("jsdom");
test("Gesamtrabatt changes the current draft after a saved draft replaces the original",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8");
  const last=name=>source.split("\n").filter(line=>line.startsWith(`  function ${name}(`)).at(-1);
  const dom=new JSDOM('<div id="koffer"><div class="kcv2-savebar"></div></div>',{runScripts:"outside-only"});
  dom.window.eval(`let draft={positions:[{quantity:1,unitPrice:22876.45}],financials:{discountPercent:0,vatRate:20}};const groupSummary=()=>({discount:0});function renderLivePreview(){};${["syncOfferFinancialInputs","offerSums","renderOfferTotals","mountOfferTotals"].map(last).join("\n")};window.harness={mountOfferTotals,offerSums,replace(){draft=JSON.parse(JSON.stringify(draft))},get(){return draft},sync(){syncOfferFinancialInputs(draft,document.getElementById("koffer"))}};`);
  const api=dom.window.harness;api.mountOfferTotals();api.replace();
  const input=dom.window.document.querySelector('[data-finance="discountPercent"]');input.value="3";input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
  assert.equal(api.get().financials.discountPercent,3);assert.equal(api.offerSums().discount.toFixed(2),"686.29");assert.equal(api.offerSums().net.toFixed(2),"22190.16");assert.equal(api.offerSums().gross.toFixed(2),"26628.19");assert.match(dom.window.document.getElementById("kofferTotalsResult").textContent,/Gesamtrabatt 3 %/);
  api.replace();input.value="5";api.sync();assert.equal(api.get().financials.discountPercent,5);assert.equal(api.offerSums().discount.toFixed(2),"1143.82");dom.window.close();
});
