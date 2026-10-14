"use strict";
const test=require("node:test"), assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-offer-builder.js"),"utf8");
const backend=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
function harness(positions){
  const begin=source.indexOf("  function generatedPositionKey(p)"),end=source.indexOf("  function basePositions()",begin);
  assert.ok(begin>=0&&end>begin,"Position suppression helpers exist");
  const draft={positions:JSON.parse(JSON.stringify(positions)),removedGeneratedPositionKeys:[]};
  const calls={renders:0,totals:0,previews:0},notice={textContent:""};
  const controller=new Function("draft","document","renderPositions","renderOfferTotals","renderLivePreview","ensureRegiePairs","basePositions",
      source.slice(begin,end)+";return {generatedPositionKey,positionSuppressed,removeOfferPositionAt,positions};")(
    draft,{getElementById:()=>notice},()=>calls.renders++,()=>calls.totals++,()=>calls.previews++,rows=>rows,
    ()=>[{groupId:"r1",text:"Wände streichen",quantity:10,unit:"m²",unitPrice:25},{groupId:"r1",text:"Spachteln",quantity:10,unit:"m²",unitPrice:30}]);
  return {draft,calls,notice,controller};
}
test("Automatically added position can be deleted without hiding other positions or reappearing",()=>{
  const h=harness([{groupId:"r1",text:"Wände streichen",quantity:10,unit:"m²",unitPrice:25},{groupId:"r1",text:"Spachteln",quantity:10,unit:"m²",unitPrice:30}]);
  h.controller.removeOfferPositionAt(0);
  assert.equal(h.draft.positions.length,1);
  assert.equal(h.draft.positions[0].text,"Spachteln");
  assert.equal(h.draft.removedGeneratedPositionKeys.length,1);
  assert.deepEqual(h.controller.positions().map(p=>p.text),["Spachteln"]);
  assert.deepEqual(h.calls,{renders:1,totals:1,previews:1});
  assert.match(h.notice.textContent,/bitte Angebot speichern/);
});
test("Custom position can be removed too, without suppressing a different default position",()=>{
  const h=harness([{groupId:"r1",text:"Freie Position",isCustom:true,quantity:1,unit:"PA",unitPrice:8}]);
  h.controller.removeOfferPositionAt(0);
  assert.equal(h.draft.positions.length,0);
  assert.equal(h.draft.removedGeneratedPositionKeys.length,0);
});
test("Rooms open, every position gets Remove, catalog plus Add visible, server persists suppression",()=>{
  assert.match(source,/draft\.collapsedGroups\[String\(room\.name\|\|""\)\]=false/);
  assert.match(source,/data-remove-position title="Diese Position entfernen"/);
  assert.match(source,/data-position-add>\+ Hinzufügen/);
  assert.match(source,/offerPositionTemplates\.push\(p\)/);
  assert.match(backend,/draft\.removedGeneratedPositionKeys=\(Array\.isArray\(body\.removedGeneratedPositionKeys\)/);
});
