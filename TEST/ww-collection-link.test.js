"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-ww-import.js"),"utf8");
const elements={wwiLinkDialog:{dataset:{wwiIndex:"18"}},wwiLinkSource:{value:"legacy"},wwiLinkStatus:{},wwiLinkApply:{}};
const requests=[];
const context={URL,URLSearchParams,location:{search:"",origin:"https://example.invalid"},document:{readyState:"loading",addEventListener(){},getElementById:id=>elements[id]},setTimeout(){},fetch:async(url,options={})=>{
  requests.push({url,options});
  return {ok:true,json:async()=>({ok:true,jobs:[{jobId:"25018",collectionMemberJobIds:["24010"],wwProjectLinks:[{projectNumber:"24010"}]}]})};
}};
vm.runInNewContext(source.replace("  function boot(){",'  globalThis.linkTest={linkExisting,set(){wwProjects=[{projectNumber:"25018",projectIndex:18}];existingJobs=[{jobId:"25018"},{jobId:"legacy"}];}};\n  function boot(){'),context);
(async()=>{
  context.linkTest.set();await context.linkTest.linkExisting();
  assert.equal(requests.length,2);assert.equal(requests[0].url,"/admin/api/jobs");
  assert.equal(requests[1].url,"/admin/api/job/25018/collection");assert.equal(requests[1].options.method,"PUT");
  const body=JSON.parse(requests[1].options.body);assert.deepEqual(body.memberJobIds,["24010","legacy"]);assert.deepEqual(body.wwProjectLinks,[{projectNumber:"24010"}]);
  assert.match(elements.wwiLinkStatus.textContent,/Beide Einzelakten bleiben erhalten/);
  assert(!requests.some(row=>row.url.includes("/merge")||row.options.method==="DELETE"));
  console.log("OK: Verbinden preserves both records and current collection membership.");
})().catch(error=>{console.error(error);process.exitCode=1;});
