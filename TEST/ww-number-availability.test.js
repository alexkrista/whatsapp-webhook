"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const {createNumberChecker}=require("../ww-number-availability");
const response=projects=>({ok:true,json:async()=>({ok:true,projects,count:projects.length})});
test("blocks existing WW project number",async()=>{
 const check=createNumberChecker({baseUrl:"https://example.org",fetchImpl:async()=>response([{projectNumber:"26094",projectIndex:2609102,company:"Wandveredler GmbH"}])});
 const result=await check("26094");
 assert.equal(result.ok,true);assert.equal(result.available,false);assert.equal(result.matches[0].projectIndex,2609102);
});
test("accepts exact absence rather than fuzzy hits",async()=>{
 const check=createNumberChecker({baseUrl:"https://example.org",fetchImpl:async()=>response([{projectNumber:"260940"}])});
 assert.equal((await check("26094")).available,true);
});
test("never accepts missing service, failures or truncated results",async()=>{
 assert.equal((await createNumberChecker({})("26095")).ok,false);
 assert.equal((await createNumberChecker({baseUrl:"https://example.org",fetchImpl:async()=>{throw Error("offline")}})("26095")).ok,false);
 assert.equal((await createNumberChecker({baseUrl:"https://example.org",fetchImpl:async()=>response(Array(250).fill({projectNumber:"12345"}))})("26095")).ok,false);
});
