"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8");
test("Every bathroom section including first offers free, catalog and regie positions",()=>{
  const line=source.split("\n").find(x=>x.includes('data-bath-new-position>+ Freie Position'));
  assert.ok(line);
  for(const key of ["data-bath-new-position","data-bath-regie","data-bath-template","data-bath-add-template"])assert.ok(line.includes(key),key);
  assert.ok(line.indexOf("data-bath-regie")<line.indexOf("+(index?"),"Regie appears outside secondary-room-only branch");
  for(const key of ["unit:\"Std\"","isCustom:true,groupId:section.id","offerPositionTemplates[Number(templates.value)]","item.groupId=chosen.id","bathEditText"])assert.ok(source.includes(key),key);
});
test("Compact bathroom regie positions avoid automatic unwanted material pair",()=>{
 const start=source.indexOf("  function ensureRegiePairs(");
 const line=source.slice(start,start+180);
 assert.ok(line.includes('draft.offerType==="bathroom_compact"'));
});
