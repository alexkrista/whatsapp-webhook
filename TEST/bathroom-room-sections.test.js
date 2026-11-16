"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const src=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8");
const backend=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
function harness(initial){
 const begin=src.indexOf("  function ensureBathSections(){"),end=src.indexOf("  function calculatedPrice(p)",begin);
 assert(begin>0&&end>begin);
 const draft=JSON.parse(JSON.stringify(initial)),called={render:0,area:0};
 const code=src.slice(begin,end)+"return {ensureBathSections,syncPositions};";
 const api=new Function("draft","positions","renderPositions","renderAreaResult",code)(draft,
 ()=>[{text:"Untergrund",quantity:18.19,unit:"m²",unitPrice:23.06},{text:"Anfahrt",quantity:1,unit:"Stk",unitPrice:150}],
 ()=>called.render++,()=>called.area++);
 return {draft,api,called};
}
test("existing bathroom offer gets one default section without losing price or quantity",()=>{
 const h=harness({offerType:"bathroom_compact",positions:[{text:"Untergrund",quantity:16.5,unit:"m²",unitPrice:42,workSteps:[{text:"Schleifen",minutes:10}]},{text:"Anfahrt",quantity:1,unit:"Stk",unitPrice:150}]});
 h.api.ensureBathSections();
 assert.equal(h.draft.bathSections.length,1);
 assert.equal(h.draft.positions[0].groupName,"Badezimmer");
 h.api.syncPositions(false);
 assert.equal(h.draft.positions[0].quantity,16.5);
 assert.equal(h.draft.positions[0].unitPrice,42);
 assert.equal(h.draft.positions[0].workSteps[0].text,"Schleifen");
});
test("separate room keeps assigned positions when calculations recalculate",()=>{
 const h=harness({offerType:"bathroom_compact",bathSections:[{id:"bath-section-1",name:"Bad"},{id:"bath-section-2",name:"Gäste-WC"}],positions:[{text:"Untergrund",quantity:18.19,unitPrice:23.06,groupId:"bath-section-2",groupName:"Gäste-WC"},{text:"Eigenleistung",quantity:2,unitPrice:250,isCustom:true,groupId:"bath-section-2",groupName:"Gäste-WC"}]});
 h.api.syncPositions(true);
 assert.equal(h.draft.positions.find(x=>x.text==="Untergrund").groupId,"bath-section-2");
 assert.equal(h.draft.positions.find(x=>x.text==="Eigenleistung").unitPrice,250);
 assert.equal(h.draft.positions.find(x=>x.text==="Anfahrt").groupId,"bath-section-1");
});
test("room group, assignment and persistent room metadata supported",()=>{
 for(const snippet of ["data-bath-add","data-bath-copy","data-bath-assign","koffer-bath-section"])assert(src.includes(snippet),snippet);
 assert(backend.includes("draft.bathSections="));
 assert(backend.includes("groupId:String(body.positions?.[i]?.groupId"));
});
