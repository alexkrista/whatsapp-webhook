"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {verifyRenumber}=require("../job-renumber-guard");
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"renumber-guard-"));fs.mkdirSync(path.join(dir,"26095"));fs.writeFileSync(path.join(dir,"26095",".meta.json"),JSON.stringify({name:"Violand Ingrid"}));return dir}
const empty=async url=>url.includes("project-search")?{ok:true,projects:[]}:{ok:true,runs:[]};
test("Violand: independent project can use a target verified free in all sources",async t=>{const dir=fixture();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const meta=await verifyRenumber({dataDir:dir,oldJobId:"26095",newJobId:"26120",expectedName:"Violand Ingrid",brainJson:empty});assert.equal(meta.name,"Violand Ingrid");assert(fs.existsSync(path.join(dir,"26095")));assert(!fs.existsSync(path.join(dir,"26120")))});
test("WW occupied target, unreachable verification and stale source identity are blocked",async t=>{const dir=fixture();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const args={dataDir:dir,oldJobId:"26095",newJobId:"26120",expectedName:"Violand Ingrid"};
 await assert.rejects(verifyRenumber({...args,brainJson:async url=>url.includes("q=26120")?{ok:true,projects:[{projectNumber:"26120"}]}:empty(url)}),/vergeben/);
 await assert.rejects(verifyRenumber({...args,brainJson:async()=>{throw Error("offline")}}),/offline/);
 await assert.rejects(verifyRenumber({...args,expectedName:"Wrong",brainJson:empty}),/geändert/);
 assert(fs.existsSync(path.join(dir,"26095")));
});
test("matching WW source and an issued native source invoice need individual review",async t=>{const dir=fixture();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const args={dataDir:dir,oldJobId:"26095",newJobId:"26120",expectedName:"Violand Ingrid"};
 await assert.rejects(verifyRenumber({...args,brainJson:async u=>u.includes("q=26095")?{ok:true,projects:[{projectNumber:"26095",projectIndex:5,title:"Violand Ingrid"}]}:empty(u)}),/gleichnamigen/);
 await assert.rejects(verifyRenumber({...args,brainJson:async u=>u.includes("projectNumber=26095")?{ok:true,runs:[{invoiceCount:1,project_title:"Violand Ingrid"}]}:empty(u)}),/Rechnungen/);
});
