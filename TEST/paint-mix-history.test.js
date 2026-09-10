"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {registerPaintMixHistory}=require('../paint-mix-history');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mix-test-')),root=path.join(dir,'_kristine','paint');await fs.mkdir(root,{recursive:true});
 const articles=[{id:'A',product:'Matt',baseCode:'T',size:'1 L',stock:5}];await fs.writeFile(path.join(root,'articles.json'),JSON.stringify(articles));
 process.env.KRISTINE_LG_BRIDGE_TOKEN='test';const routes={};const app={get:(p,f)=>routes[p]=f,post:(p,f)=>routes[p]=f};registerPaintMixHistory(app,{dataDir:dir});
 async function call(route,body={},params={},query={}){const res={statusCode:200,status(s){this.statusCode=s;return this},json(d){this.body=d;return this}};await routes[route]({body,params,query,headers:{'x-lg-bridge-token':'test'}},res);return res;}
 const row={id:'event-1',completedAt:'2026-09-10T10:00:00Z',productName:'Matt',baseCode:'T',size:'1 L',quantity:1};
 const ingest=rows=>call('/admin/api/paint/bridge/history',{rows,createTasks:false});
 await Promise.all([ingest([row]),ingest([row])]);assert.equal((await call('/admin/api/paint/mix-history')).body.count,1);
 const resolve=id=>call('/admin/api/paint/mix-history/:id/resolve',{resolution:'sale'},{id});
 const results=await Promise.all([resolve(row.id),resolve(row.id)]);assert(results.every(r=>r.statusCode===200));
 let movements=(await fs.readFile(path.join(root,'movements.jsonl'),'utf8')).trim().split('\n');assert.equal(movements.length,1);assert.equal(JSON.parse(movements[0]).after,4);
 const historyPath=path.join(root,'mix-history.json');let history=JSON.parse(await fs.readFile(historyPath,'utf8'));history[0].status='open';await fs.writeFile(historyPath,JSON.stringify(history));await resolve(row.id);
 assert.equal((await fs.readFile(path.join(root,'movements.jsonl'),'utf8')).trim().split('\n').length,1);
 await ingest([{...row,id:'event-2',size:'5 L'}]);assert.equal((await resolve('event-2')).statusCode,409);
 assert.equal(await fs.stat(path.join(root,'job-materials.jsonl')).then(()=>true,()=>false),false);
 await ingest([{...row,id:'project-1'}]);
 const project=()=>call('/admin/api/paint/mix-history/:id/resolve',{resolution:'project',jobId:'26083',jobName:'Testbaustelle'},{id:'project-1'});
 await Promise.all([project(),project()]);
 const materials=(await fs.readFile(path.join(root,'job-materials.jsonl'),'utf8')).trim().split('\n');assert.equal(materials.length,1);assert.equal(JSON.parse(materials[0]).jobId,'26083');
 console.log('mix history duplicate, concurrent, recovery and exact-size tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
