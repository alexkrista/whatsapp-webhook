"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const {checkWwProjectIdentity} = require("../ww-project-identity");
const {registerOutgoingBillingBridge} = require("../outgoing-billing-bridge");

const ww = {projectNumber:"26094",projectIndex:2609102,title:"Wandveredler GmbH",company:"Wandveredler GmbH",customerIndex:10013};
const latzer = {name:"Latzer Oskar - Fenster malen",contactName:"Oskar Latzer"};

test("same number 26094 cannot connect Latzer to foreign Wandveredler", () => {
  const verdict=checkWwProjectIdentity(ww,latzer,"26094");
  assert.equal(verdict.ok,false);
  assert.match(verdict.reason,/Nummernkollision/);
  assert.equal(checkWwProjectIdentity(ww,{name:"Wandveredler GmbH"},"26094").ok,true);
  assert.equal(checkWwProjectIdentity(ww,{name:"Latzer",wwProjectIndex:2609102,
    wwProjectNumber:"26094"},"26094").ok,true);
  assert.equal(checkWwProjectIdentity(ww,{name:"Latzer",wwProjectIndex:2601104,
    wwProjectNumber:"26094"},"26094").ok,false);
});

test("remote billing prevents cross-customer historical sync before any write", async () => {
  let route,brainCalls=0;
  const app={post(p,f){if(p.endsWith("outgoing-sync"))route=f}};
  registerOutgoingBillingBridge(app,{
    readJobMeta:async()=>latzer,
    fetchImpl:async (url)=>{
      brainCalls++;
      assert.match(url,/project-search/);
      return {ok:true,status:200,json:async()=>({ok:true,projects:[ww]})};
    }
  });
  let response,code=200;
  await route({params:{jobId:"26094"}},{
    status(value){code=value;return this},
    json(value){response=value;return value}
  });
  assert.equal(code,409);
  assert.equal(response.identityConflict,true);
  assert.equal(brainCalls,1);
});

test("browser sources rejects foreign WW project, including stale cache", () => {
  const window={BaustellenData:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-sources.js"),"utf8"),{
    window,location:{search:"",origin:"https://protokoll.krista.at"},URL,URLSearchParams,
    fetch(){throw Error("No remote fetch in identity test")},setTimeout,AbortSignal,Date
  });
  const source=window.BaustellenSources;
  assert.equal(source.verifyWWIdentity({projectNumber:"26094",jobId:"26094",expectedName:latzer.name},ww,{quiet:true}),false);
  assert.throws(()=>source.verifyWWIdentity({projectNumber:"26094",jobId:"26094",expectedName:latzer.name},ww),/Nummernkollision/);
  assert.equal(source.verifyWWIdentity({projectNumber:"26094",jobId:"26094",expectedName:"Wandveredler GmbH"},ww),true);
  assert.equal(source.verifyWWIdentity({projectNumber:"26094",jobId:"26094",expectedName:"Latzer"},null,{quiet:true}),false);
});

test("Regie day comparison merges Edi and Edmund Mock under one employee", () => {
  const js=fs.readFileSync(path.join(__dirname,"../public/ui/baustellen-knowledge-hub.js"),"utf8");
  const prelude=js.slice(0,js.indexOf("\n(function(){"));
  const helpers=vm.runInNewContext(prelude+"\n({canonicalRegiePersonKey,groupRegieComparisonRows})",{});
  assert.equal(helpers.canonicalRegiePersonKey("Edi"),"edmundmock");
  assert.equal(helpers.canonicalRegiePersonKey("Edmund Mock"),"edmundmock");
  const combined=helpers.groupRegieComparisonRows([
    {date:"2026-10-13",name:"Edi",stamped:9.27,regie:4.5,number:"26094001"},
    {date:"2026-10-13",name:"Edmund Mock",stamped:9.27,regie:5.0,number:"26094001"}
  ]);
  assert.equal(combined.length,1);
  assert.equal(combined[0].name,"Edmund Mock");
  assert.equal(combined[0].stamped,9.27);
  assert.equal(combined[0].regie,9.50);
  assert.equal(Math.round(combined[0].diff*100),23);
});
