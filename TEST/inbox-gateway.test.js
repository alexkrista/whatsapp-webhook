const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
for(const [file,end] of [['public/regie-workbench.html','let reports='],['public/ui/kristine-inbox-v2.js','  function pending()']])test(file+' handles gateway HTML and retries only reads',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8'),start=source.indexOf('async function api('),code=source.slice(start,source.indexOf(end,start));let calls=0;
 const context=vm.createContext({tokenUrl:x=>x,setTimeout:fn=>fn(),fetch:async()=>{calls++;return {status:502,ok:false,text:async()=>'<!DOCTYPE html><title>502</title>'}}});vm.runInContext(code,context);
 await assert.rejects(context.api('/inbox'),/Server ist kurz nicht erreichbar/);assert.equal(calls,3);calls=0;await assert.rejects(context.api('/save',{method:'POST'}),/Server ist kurz nicht erreichbar/);assert.equal(calls,1);
 calls=0;context.fetch=async()=>{calls++;return calls===1?{status:503,ok:false,text:async()=>'<html>Unavailable</html>'}:{status:200,ok:true,text:async()=>'{"items":[]}'}};assert.equal((await context.api('/inbox')).items.length,0);assert.equal(calls,2);
});
