"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {registerPaintMixHistory}=require('../paint-mix-history');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mix-session-')),root=path.join(dir,'_kristine','paint');
 const oldToken=process.env.ADMIN_TOKEN;process.env.ADMIN_TOKEN='session-test-secret';
 try{
  await fs.mkdir(root,{recursive:true});
  const rows=[{id:'mix-1',jobId:'26082',product:'Matt',colourTone:'RAL 9010',quantity:2},{id:'mix-2',jobId:'26083',product:'Other'}];
  await fs.writeFile(path.join(root,'job-materials.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const routes={};registerPaintMixHistory({get:(p,f)=>routes[p]=f,post:()=>{}},{dataDir:dir});
  async function read(headers={},query={jobId:'26082'}){const res={statusCode:200,status(c){this.statusCode=c;return this},json(body){this.body=body}};await routes['/admin/api/paint/job-materials']({headers,query},res);return res}
  assert.equal((await read()).statusCode,403);
  assert.equal((await read({cookie:'kristine_session=invalid'})).statusCode,403);
  const session=crypto.createHmac('sha256',process.env.ADMIN_TOKEN).update('kristine-browser-session-v1').digest('base64url');
  const result=await read({cookie:'other=x; kristine_session='+session});
  assert.equal(result.statusCode,200);assert.deepEqual(result.body.items,[rows[0]]);
  assert.equal((await read({'x-admin-token':process.env.ADMIN_TOKEN})).body.count,1);
  assert.equal((await read({}, {jobId:'26082',token:process.env.ADMIN_TOKEN})).body.count,1);
  assert.equal(await fs.readFile(path.join(root,'job-materials.jsonl'),'utf8'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  console.log('OK: Existing mix assignments load with a valid browser session; invalid sessions stay forbidden, project filter and token access remain intact.');
 }finally{if(oldToken===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=oldToken;await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
