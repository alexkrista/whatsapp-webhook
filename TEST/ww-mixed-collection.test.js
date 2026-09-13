"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
function page(responder){
  const ids=["wwOrderImport","wwiList","wwiSearch","wwiImport","wwiCollect","wwiCollectionDialog","wwiCollectionTarget","wwiCollectionMembers","wwiCollectionStatus","wwiCollectionApply","wwiMessage","wwiShowOpen","wwiSearchAll"];
  const elements=Object.fromEntries(ids.map(id=>[id,{value:"",innerHTML:"",textContent:"",disabled:false,querySelectorAll(){return []},showModal(){this.open=true},focus(){}}]));
  const calls=[],document={readyState:"loading",getElementById:id=>elements[id],addEventListener(){}};
  const window={},location={origin:"https://protokoll.krista.at",search:"",href:""};
  const source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-ww-import.js"),"utf8").replace("  function boot(){",`  window.test={set(ww,local,groups=[]){wwProjects=ww;existingJobs=local;existingCollections=groups},allRows,visibleRows,selectedRows,render,selectVisible,openCollection,saveCollection,searchAll,select(row){selected.add(selectionKey(row))}};\n  function boot(){`);
  const fetch=async(raw,init={})=>{const url=new URL(raw,location.origin);calls.push({url,init});const value=await responder(url,init);return {ok:true,json:async()=>value}};
  vm.runInNewContext(source,{window,document,location,fetch,URL,URLSearchParams,Date,Map,Set,Number,console,setTimeout(){},clearTimeout(){}});
  return {api:window.test,elements,calls};
}
const ww=[{projectIndex:17,projectNumber:"24133",title:"Innenarbeiten",customer:"Christian Lutz"},{projectIndex:18,projectNumber:"2203133",title:"Lutz Christian Innenmalerarbeiten",customer:"Christian Lutz"}];
const local=[{jobId:"christian_lutz",name:"Christian Lutz",status:"Geschlossen"},{jobId:"24133",name:"Lutz Innenarbeiten",wwProjectIndex:17,status:"Auftrag"},{jobId:"system",name:"System"}];
test("Lutz: a closed KRISTINE file appears next to WW files and is included exactly once without import",async()=>{
  let written;const created=[];
  const {api,elements}=page((url,init)=>{
    if(url.pathname==="/admin/api/jobs"&&!init.method)return {jobs:structuredClone(local),collections:[{collectionMainJobId:"24133",collectionMemberJobIds:["24133","recent_member"]}]};
    if(url.pathname==="/admin/api/jobs"&&init.method==="POST"){created.push(JSON.parse(init.body));return {ok:true}};
    assert.equal(url.pathname,"/admin/api/job/24133/collection");written=JSON.parse(init.body);return {ok:true,collectionId:"S24133",collectionMemberJobIds:["24133","2203133","christian_lutz","recent_member"]};
  });
  api.set(ww,structuredClone(local));elements.wwiSearch.value="lutz";api.render();
  assert.equal(api.visibleRows().length,3);assert.match(elements.wwiList.innerHTML,/data-wwi-index="kr:christian_lutz"/);assert.match(elements.wwiList.innerHTML,/>KRISTINE</);assert.match(elements.wwiList.innerHTML,/Geschlossen/);
  assert.equal((elements.wwiList.innerHTML.match(/data-wwi-index="17"/g)||[]).length,1);assert(!elements.wwiList.innerHTML.includes('kr:24133'));
  api.selectVisible();assert.equal(api.selectedRows().length,3);assert.equal(elements.wwiCollect.textContent,"3 Akten sammeln");assert.equal(elements.wwiImport.textContent,"1 als Einzelakte(n) übernehmen");
  api.openCollection();assert.match(elements.wwiCollectionMembers.innerHTML,/3 ausgewählte Akten/);assert.match(elements.wwiCollectionMembers.innerHTML,/KRISTINE · #christian_lutz/);
  assert(elements.wwiCollectionTarget.innerHTML.indexOf('value="24133"')<elements.wwiCollectionTarget.innerHTML.indexOf('value="christian_lutz"'));
  elements.wwiCollectionTarget.value="24133";await api.saveCollection();
  assert.deepEqual(created.map(row=>row.jobId),["2203133"]);assert.equal(local[0].status,"Geschlossen");
  assert.deepEqual(new Set(written.memberJobIds),new Set(["2203133","christian_lutz","recent_member"]));
  assert.deepEqual(written.wwProjectLinks.map(row=>row.projectNumber),["24133","2203133"]);assert(!written.wwProjectLinks.some(row=>row.projectNumber==="christian_lutz"));
});
test("local-only selection cannot invoke a WW import, assigned files stay visibly unavailable, duplicate WW result preserves selection",()=>{
  const {api,elements}=page(()=>({}));
  api.set([], [...structuredClone(local),{jobId:"other_lutz",name:"Other Lutz",collectionParentJobIds:["S25018"]}]);elements.wwiSearch.value="lutz";
  api.render();assert.match(elements.wwiList.innerHTML,/In S25018/);api.selectVisible();assert.equal(api.selectedRows().length,2);assert.equal(elements.wwiImport.disabled,true);
  api.set(ww,structuredClone(local));api.render();assert.equal(api.selectedRows().length,2);assert.equal(api.selectedRows().filter(row=>row.localJobId).length,1);
  assert.equal(api.selectedRows().filter(row=>row.projectNumber==="24133").length,1);
});
test("an unavailable WW search still exposes the matching existing KRISTINE file",async()=>{
  const {api,elements}=page(url=>{if(url.pathname.includes("brain-permit"))return {permit:"test"};throw new Error("Office unavailable")});
  api.set([],structuredClone(local));elements.wwiSearch.value="Christian Lutz";await api.searchAll();
  assert.match(elements.wwiList.innerHTML,/Christian Lutz/);assert.match(elements.wwiList.innerHTML,/kr:christian_lutz/);assert.match(elements.wwiMessage.textContent,/bleiben auswählbar/);
});
