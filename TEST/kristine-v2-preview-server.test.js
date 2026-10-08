'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createPreviewServer,safeTopbarScript,authenticated}=require('../tools/kristine-v2-preview-server');

const PASSWORD='preview-fixture-password-strong';
function request(port,pathname,{method='GET',password=PASSWORD}={}) {
  return new Promise((resolve,reject)=>{
    const headers={};
    if(password!==null) headers.authorization='Basic '+Buffer.from('v2:'+password).toString('base64');
    const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers},res=>{
      let body='';res.setEncoding('utf8');
      res.on('data',part=>body+=part);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });
    req.on('error',reject);req.end();
  });
}
async function withServer(fn){
  const server=createPreviewServer({password:PASSWORD});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{return await fn(server.address().port)}
  finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}
}

test('preview requires a dedicated password and rejects unauthenticated data access', async()=>{
  assert.throws(()=>createPreviewServer({password:''}),/password/);
  assert.throws(()=>createPreviewServer({password:'short'}),/password/);
  assert.equal(authenticated({headers:{}},PASSWORD),false);
  await withServer(async port=>{
    let response=await request(port,'/preview',{password:null});
    assert.equal(response.status,401);
    assert.match(response.headers['www-authenticate'],/KRISTINE 2.0 TEST/);
    assert.equal(response.headers['cache-control'],'no-store, max-age=0');
    response=await request(port,'/preview',{password:'invalid-strong-password'});
    assert.equal(response.status,401);
    response=await request(port,'/preview');
    assert.equal(response.status,200);
    assert.match(response.body,/ISOLIERTE TESTVORSCHAU/);
    assert.match(response.body,/Demodaten/);
    assert.doesNotMatch(response.body,/mailto:|https:\/\/protokoll\.krista\.at|Datenbank-URL|SECRET/);
  });
});

test('all mutation routes are disabled and no real KGO, finance or webhook API exists', async()=>{
  await withServer(async port=>{
    for(const method of ['POST','PUT','PATCH','DELETE']){
      const response=await request(port,'/kristine/api/message',{method});
      assert.equal(response.status,405,method);
    }
    for(const route of ['/kristine/api/bootstrap','/kristine/api/day-close','/admin/api/jobs','/api/finance','/kristine-go.html']){
      assert.equal((await request(port,route)).status,404,route);
    }
    const health=await request(port,'/healthz',{password:null});
    assert.equal(health.status,200);
    assert.deepEqual(JSON.parse(health.body),{ok:true,isolated:true});
  });
});

test('shared original header and CSS are served with only staging navigation targets',async()=>{
  const source=safeTopbarScript();
  assert.match(source,/KRISTOWER/);
  assert.match(source,/KRISZEIT/);
  assert.match(source,/KRISDRIVE/);
  assert.match(source,/THE BRAIN/);
  assert.doesNotMatch(source,/tail610122/);
  assert.doesNotMatch(source,/https:\/\/protokoll\.krista\.at/);
  assert.match(source,/KRISTINE_V2_SAFE_PREVIEW/);
  for(const key of ['kristower','kriszeit','krisdrive','brain','farben','kristine','krisadmin','tasks']){
    assert.ok(source.includes('/preview?world='+key),key);
  }
  await withServer(async port=>{
    const script=await request(port,'/public/ui/topbar.js');
    assert.equal(script.status,200);
    assert.equal(script.body,source);
    const css=await request(port,'/public/ui/krista-ui.css');
    assert.equal(css.status,200);
    assert.match(css.body,/position:sticky/);
    assert.match(css.headers['content-security-policy'],/connect-src 'none'/);
    const mobile=await request(port,'/preview?world=kriszeit');
    assert.match(mobile.body,/data-krista-active="kriszeit"/);
  });
});
